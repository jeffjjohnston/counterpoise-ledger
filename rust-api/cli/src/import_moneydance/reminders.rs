//! Phase 7: Moneydance reminders as recurring rules.

use chrono::NaiveDate;
use ledger_core::{formatters::to_date_string, recurring::RecurrenceConfig};
use ledger_db::engine::{Db, DbConnection};

use super::values::{
    Item, convert_date, field, int, int_or_zero, int4, integer_text, normalize_name, text,
};
use super::{ImportContext, RowError, finish, item_id, row_error};

const MAX_AUTO_CREATE_DAYS: f64 = 30.0;
const MAX_NEXT_DATE_ADVANCE_STEPS: usize = 10_000;

/// A recurrence whose interval and day are still doubles, so that a value
/// out of range fails at the insert as it does in the TypeScript.
struct Frequency {
    frequency: &'static str,
    interval: f64,
    day_of_month: Option<f64>,
}

/// The recurrence of the frequency flags, or `None` when no flag is known.
fn parse_frequency(reminder: &Item) -> Option<Frequency> {
    let flag = |key| int_or_zero(reminder, key);
    let (yearly, monthly_days, monthly_mod, daily, weekly_mod) = (
        flag("yearly"),
        flag("monthlydays"),
        flag("monthlymod"),
        flag("daily"),
        flag("weeklymod"),
    );
    let frequency = |frequency, interval| Frequency {
        frequency,
        interval,
        day_of_month: None,
    };
    if yearly == 1.0 {
        return Some(frequency("yearly", 1.0));
    }
    if monthly_days > 0.0 {
        return Some(Frequency {
            frequency: "monthly",
            interval: if monthly_mod > 1.0 { monthly_mod } else { 1.0 },
            day_of_month: Some(monthly_days),
        });
    }
    if daily > 0.0 {
        if weekly_mod > 0.0 {
            return Some(frequency("weekly", weekly_mod));
        }
        if daily % 7.0 == 0.0 {
            return Some(frequency("weekly", daily / 7.0));
        }
        return Some(frequency("daily", daily));
    }
    None
}

struct Template {
    description: Option<String>,
    /// `(Moneydance account, amount)`. The parent account comes first, with
    /// the sum of the child `pamt` values.
    splits: Vec<(String, f64)>,
}

/// The template transaction in the `txn.*` fields, or `None` when it has no
/// parent account or no usable child split.
fn extract_template(reminder: &Item) -> Option<Template> {
    let parent = field(reminder, "txn.acctid")?.into_owned();
    let mut indexes: Vec<f64> = Vec::new();
    for key in reminder.keys() {
        let Some(rest) = key.strip_prefix("txn.") else {
            continue;
        };
        let Some((digits, _)) = rest.split_once('.') else {
            continue;
        };
        if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
            continue;
        }
        let index = int(digits);
        if !indexes.contains(&index) {
            indexes.push(index);
        }
    }
    indexes.sort_by(f64::total_cmp);

    let mut children = Vec::new();
    let mut parent_amount = 0.0;
    for index in indexes {
        let get = |name: &str| field(reminder, &format!("txn.{}.{name}", integer_text(index)));
        let (Some(account), Some(samt)) = (get("acctid"), get("samt")) else {
            continue;
        };
        let samt = int(&samt);
        if samt.is_nan() {
            continue;
        }
        children.push((account.into_owned(), samt));
        if let Some(pamt) = get("pamt") {
            let pamt = int(&pamt);
            if !pamt.is_nan() {
                parent_amount += pamt;
            }
        }
    }
    if children.is_empty() {
        return None;
    }
    let mut splits = vec![(parent, parent_amount)];
    splits.extend(children);
    Some(Template {
        description: field(reminder, "txn.desc").map(|text| text.into_owned()),
        splits,
    })
}

/// A stale acknowledgement date moves to the first occurrence on or after
/// `today`, so the rule starts at the next occurrence.
fn normalize_next_date(
    start: &str,
    ack: &str,
    config: &RecurrenceConfig,
    today: &str,
) -> Result<String, String> {
    let mut next = if ack < start { start } else { ack }.to_owned();
    let mut steps = 0;
    while next.as_str() < today && steps < MAX_NEXT_DATE_ADVANCE_STEPS {
        let candidate = ledger_core::recurring::next_date(&next, config)?;
        if candidate <= next {
            break;
        }
        next = candidate;
        steps += 1;
    }
    Ok(next)
}

#[derive(Default)]
pub struct ReminderStats {
    pub imported: usize,
    pub skipped: usize,
    pub errors: usize,
}

pub async fn import_reminders(
    connection: &mut DbConnection,
    context: &mut ImportContext,
    reminders: &[&Item],
    today: NaiveDate,
) -> Result<ReminderStats, sqlx::Error> {
    context.heading("🔄 Phase 7: Importing Recurring Reminders");
    let mut stats = ReminderStats::default();
    println!("Found {} reminders", reminders.len());
    let today = to_date_string(today);
    let name_of = |reminder: &Item| {
        text(reminder, "desc").map_or_else(|| "undefined".to_owned(), |name| name.into_owned())
    };

    if context.options.dry_run {
        println!("  [DRY RUN] Would import reminders:");
        for reminder in reminders.iter().take(5) {
            let (frequency, interval) = parse_frequency(reminder)
                .map_or(("unknown", "?".to_owned()), |parsed| {
                    (parsed.frequency, integer_text(parsed.interval))
                });
            println!(
                "    {} ({frequency}, interval {interval})",
                name_of(reminder)
            );
        }
        if reminders.len() > 5 {
            println!("    ... and {} more", reminders.len() - 5);
        }
        stats.imported = reminders.len();
    } else {
        for reminder in reminders {
            let Some(frequency) = parse_frequency(reminder) else {
                context.verbose(format!(
                    "  ⊗ Skipping {}: Unrecognizable frequency pattern",
                    name_of(reminder)
                ));
                stats.skipped += 1;
                continue;
            };
            let Some(template) = extract_template(reminder) else {
                context.verbose(format!(
                    "  ⊗ Skipping {}: No valid template transaction",
                    name_of(reminder)
                ));
                stats.skipped += 1;
                continue;
            };
            let accounts = &context.ids.accounts;
            let mapped: Option<Vec<(i32, f64)>> = template
                .splits
                .iter()
                .map(|(account, amount)| {
                    accounts
                        .get(account)
                        .or_else(|| accounts.get(&format!("{account}_CASH")))
                        .map(|id| (*id, *amount))
                })
                .collect();
            let Some(mapped) = mapped else {
                context.verbose(format!(
                    "  ⊗ Skipping {}: Referenced accounts not imported",
                    name_of(reminder)
                ));
                stats.skipped += 1;
                continue;
            };
            let auto_create = int_or_zero(reminder, "acdays").clamp(0.0, MAX_AUTO_CREATE_DAYS);
            let payee_id = template
                .description
                .as_deref()
                .map(normalize_name)
                .filter(|name| !name.is_empty())
                .and_then(|name| context.ids.payees.get(&name).copied());

            let dates = convert_date(field(reminder, "sdt").as_deref()).and_then(|start| {
                let ack = convert_date(field(reminder, "ackdt").as_deref())?;
                let config = RecurrenceConfig {
                    frequency: frequency.frequency.to_owned(),
                    interval: int4(frequency.interval)?.into(),
                    days_of_week: None,
                    week_of_month: None,
                    days_of_month: frequency
                        .day_of_month
                        .map(|day| int4(day).map(|day| vec![i64::from(day)]))
                        .transpose()?,
                };
                let next = normalize_next_date(&start, &ack, &config, &today)?;
                Ok((start, next))
            });
            let outcome = match dates {
                Err(message) => Err(message),
                Ok((start, next)) => {
                    let mut savepoint = ledger_db::locks::savepoint(connection).await?;
                    let rule = NewRule {
                        name: text(reminder, "desc").map(|name| name.into_owned()),
                        frequency: &frequency,
                        start_date: &start,
                        next_date: &next,
                        auto_create_days_before: auto_create,
                        template_description: template.description.as_deref(),
                        payee_id,
                    };
                    let outcome = insert_rule(&mut savepoint, context, &rule, &mapped).await;
                    finish(savepoint, outcome).await?
                }
            };
            match outcome {
                Ok(()) => {
                    context.verbose(format!(
                        "  ✓ {} ({}, interval {}, {} splits)",
                        name_of(reminder),
                        frequency.frequency,
                        integer_text(frequency.interval),
                        mapped.len()
                    ));
                    stats.imported += 1;
                }
                Err(message) => {
                    stats.errors += 1;
                    eprintln!(
                        "  ✗ Error importing reminder {} ({}): {message}",
                        name_of(reminder),
                        item_id(reminder)
                    );
                }
            }
        }
    }

    println!("\n📊 Recurring Reminder Import Summary:");
    println!("  Imported: {}", stats.imported);
    println!("  Skipped: {}", stats.skipped);
    println!("  Errors: {}", stats.errors);
    Ok(stats)
}

struct NewRule<'a> {
    name: Option<String>,
    frequency: &'a Frequency,
    start_date: &'a str,
    next_date: &'a str,
    auto_create_days_before: f64,
    template_description: Option<&'a str>,
    payee_id: Option<i32>,
}

/// Inserts the rule and its template splits together, so a failure cannot
/// leave a rule with too few splits.
async fn insert_rule(
    connection: &mut DbConnection,
    context: &ImportContext,
    rule: &NewRule<'_>,
    splits: &[(i32, f64)],
) -> Result<(), RowError> {
    let days_of_month = rule
        .frequency
        .day_of_month
        .map(|day| format!("[{}]", integer_text(day)));
    let rule_id: i32 = sqlx::query_scalar(
        "INSERT INTO recurring_rules
           (book_id, name, frequency, interval, days_of_month, days_of_week, week_of_month, start_date,
            next_date, auto_create_days_before, template_description, payee_id, is_active, created_at)
         VALUES ($1, $2, $3, $4, $5, NULL, NULL, $6, $7, $8, $9, $10, true, $11)
         RETURNING id",
    )
    .bind(context.book_id)
    .bind(&rule.name)
    .bind(rule.frequency.frequency)
    .bind(int4(rule.frequency.interval)?)
    .bind(days_of_month)
    .bind(rule.start_date)
    .bind(rule.next_date)
    .bind(int4(rule.auto_create_days_before)?)
    .bind(rule.template_description)
    .bind(rule.payee_id)
    .bind(context.now)
    .fetch_one(&mut *connection)
    .await
    .map_err(row_error)?;
    let amounts = splits
        .iter()
        .map(|(account_id, amount)| Ok((*account_id, int4(*amount)?)))
        .collect::<Result<Vec<_>, RowError>>()?;
    let mut insert: sqlx::QueryBuilder<Db> = sqlx::QueryBuilder::new(
        "INSERT INTO recurring_template_splits (book_id, recurring_rule_id, account_id, amount) ",
    );
    insert.push_values(amounts, |mut row, (account_id, amount)| {
        row.push_bind(context.book_id)
            .push_bind(rule_id)
            .push_bind(account_id)
            .push_bind(amount);
    });
    insert
        .build()
        .execute(connection)
        .await
        .map_err(row_error)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn item(value: serde_json::Value) -> Item {
        value.as_object().unwrap().clone()
    }

    fn frequency(value: serde_json::Value) -> Option<(&'static str, f64, Option<f64>)> {
        parse_frequency(&item(value))
            .map(|parsed| (parsed.frequency, parsed.interval, parsed.day_of_month))
    }

    #[test]
    fn frequency_flags_map_to_a_recurrence() {
        assert_eq!(
            frequency(json!({"yearly": "1"})),
            Some(("yearly", 1.0, None))
        );
        assert_eq!(
            frequency(json!({"monthlydays": "20", "monthlymod": "3"})),
            Some(("monthly", 3.0, Some(20.0)))
        );
        assert_eq!(
            frequency(json!({"monthlydays": "5", "monthlymod": "x"})),
            Some(("monthly", 1.0, Some(5.0)))
        );
        assert_eq!(
            frequency(json!({"daily": "14"})),
            Some(("weekly", 2.0, None))
        );
        assert_eq!(
            frequency(json!({"daily": "7", "weeklymod": "2"})),
            Some(("weekly", 2.0, None))
        );
        assert_eq!(frequency(json!({"daily": "3"})), Some(("daily", 3.0, None)));
        assert_eq!(frequency(json!({"weekly": "1"})), None);
    }

    #[test]
    fn template_puts_the_parent_first_with_the_pamt_sum() {
        let reminder = item(json!({
            "txn.acctid": "checking",
            "txn.desc": "Power",
            "txn.10.acctid": "b", "txn.10.samt": "300", "txn.10.pamt": "-300",
            "txn.2.acctid": "a", "txn.2.samt": "100", "txn.2.pamt": "-100",
            "txn.3.acctid": "c", "txn.3.samt": "bad", "txn.3.pamt": "-7",
        }));
        let template = extract_template(&reminder).unwrap();
        assert_eq!(template.description.as_deref(), Some("Power"));
        assert_eq!(
            template.splits,
            [
                ("checking".to_owned(), -400.0),
                ("a".to_owned(), 100.0),
                ("b".to_owned(), 300.0)
            ]
        );
        assert!(extract_template(&item(json!({"txn.acctid": "x"}))).is_none());
    }

    #[test]
    fn stale_dates_move_to_today_or_later() {
        let config = RecurrenceConfig {
            frequency: "monthly".to_owned(),
            interval: 1,
            days_of_week: None,
            week_of_month: None,
            days_of_month: Some(vec![20]),
        };
        assert_eq!(
            normalize_next_date("2024-01-20", "2024-03-20", &config, "2024-06-01").unwrap(),
            "2024-06-20"
        );
        assert_eq!(
            normalize_next_date("2024-05-20", "2024-03-20", &config, "2024-01-01").unwrap(),
            "2024-05-20"
        );
    }
}
