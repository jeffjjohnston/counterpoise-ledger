//! The recurring rules of a dataset. Each rule starts strictly after
//! `today`. Otherwise the hourly job posts it into each new demo book.

use std::collections::HashMap;

use chrono::{Datelike, Months, NaiveDate};

use super::window::{date, format_date, last_day_of_month};
use super::{SeedResult, Seeder, Split};

/// The next `day_of_month` strictly after `today`. The day must be 28 or less.
pub(super) fn next_monthly_date(today: NaiveDate, day_of_month: u32) -> NaiveDate {
    let candidate = date(today.year(), today.month(), day_of_month);
    if candidate <= today {
        candidate + Months::new(1)
    } else {
        candidate
    }
}

/// The first of `days` strictly after `today`. -1 is the last day of the
/// month. A day after the end of the month is the last day.
pub(super) fn next_monthly_days_date(today: NaiveDate, days: &[i32]) -> NaiveDate {
    let first = today.with_day(1).expect("every month has a day 1");
    (0..2)
        .flat_map(|offset| {
            let month = first + Months::new(offset);
            let last = last_day_of_month(month.year(), month.month());
            days.iter().map(move |day| {
                let day = if *day == -1 {
                    last
                } else {
                    (*day as u32).min(last)
                };
                date(month.year(), month.month(), day)
            })
        })
        .filter(|candidate| *candidate > today)
        .min()
        .expect("the next month has a day after today")
}

pub(super) struct RuleSeed {
    pub name: &'static str,
    pub schedule: Schedule,
    pub payee: &'static str,
    pub template_description: &'static str,
    pub auto_create_days_before: i32,
    pub business_days_only: bool,
    pub splits: Vec<Split>,
}

pub(super) enum Schedule {
    Monthly(u32),
    /// Several days of each month. -1 is the last day.
    MonthlyDays(&'static [i32]),
    /// Every two weeks, on the weekday of `next`. `next` is the next date of a
    /// cadence that the seed already follows, and it is after `today`.
    Biweekly {
        next: NaiveDate,
    },
}

/// Writes `rules` and their template splits.
pub(super) async fn write_rules(
    seeder: &mut Seeder<'_>,
    rules: Vec<RuleSeed>,
    payees: &HashMap<&'static str, i32>,
    today: NaiveDate,
) -> SeedResult<()> {
    let count = rules.len();
    for RuleSeed {
        name,
        schedule,
        payee: payee_name,
        template_description,
        auto_create_days_before,
        business_days_only,
        splits,
    } in rules
    {
        // Both day columns hold JSON text, as the API writes them.
        let (frequency, interval, days_of_month, days_of_week, next) = match schedule {
            Schedule::Monthly(day) => (
                "monthly",
                1,
                Some(format!("[{day}]")),
                None,
                next_monthly_date(today, day),
            ),
            Schedule::MonthlyDays(days) => (
                "monthly",
                1,
                Some(format!(
                    "[{}]",
                    days.iter()
                        .map(i32::to_string)
                        .collect::<Vec<_>>()
                        .join(",")
                )),
                None,
                next_monthly_days_date(today, days),
            ),
            Schedule::Biweekly { next } => (
                "weekly",
                2,
                None,
                Some(format!("[{}]", next.weekday().num_days_from_sunday())),
                next,
            ),
        };
        let next = format_date(next);
        let rule_id: i32 = sqlx::query_scalar(
            "INSERT INTO recurring_rules
               (book_id, name, frequency, interval, days_of_month, days_of_week, start_date,
                next_date, auto_create_days_before, template_description, payee_id, is_active,
                business_days_only, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9, $10, true, $11, $12)
             RETURNING id",
        )
        .bind(seeder.book_id)
        .bind(name)
        .bind(frequency)
        .bind(interval)
        .bind(days_of_month)
        .bind(days_of_week)
        .bind(&next)
        .bind(auto_create_days_before)
        .bind(template_description)
        .bind(payees.get(payee_name).copied())
        .bind(business_days_only)
        .bind(seeder.now)
        .fetch_one(&mut *seeder.connection)
        .await?;
        for template in splits {
            sqlx::query(
                "INSERT INTO recurring_template_splits (book_id, recurring_rule_id, account_id, amount)
                 VALUES ($1, $2, $3, $4)",
            )
            .bind(seeder.book_id)
            .bind(rule_id)
            .bind(template.account_id)
            .bind(template.amount as i32)
            .execute(&mut *seeder.connection)
            .await?;
        }
    }
    (seeder.log)(&format!("  Recurring rules: {count}"));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn monthly_rule_is_strictly_after_today() {
        let month_end = date(2026, 8, 31);
        assert_eq!(next_monthly_date(month_end, 1), date(2026, 9, 1));
        assert_eq!(next_monthly_date(date(2026, 9, 5), 5), date(2026, 10, 5));
        assert_eq!(next_monthly_date(date(2026, 9, 4), 5), date(2026, 9, 5));
        assert_eq!(next_monthly_date(date(2026, 12, 20), 12), date(2027, 1, 12));
    }

    #[test]
    fn monthly_days_rule_is_strictly_after_today() {
        let days = [15, -1];
        assert_eq!(
            next_monthly_days_date(date(2026, 9, 14), &days),
            date(2026, 9, 15)
        );
        assert_eq!(
            next_monthly_days_date(date(2026, 9, 15), &days),
            date(2026, 9, 30)
        );
        assert_eq!(
            next_monthly_days_date(date(2026, 9, 30), &days),
            date(2026, 10, 15)
        );
        assert_eq!(
            next_monthly_days_date(date(2028, 2, 20), &days),
            date(2028, 2, 29)
        );
        assert_eq!(
            next_monthly_days_date(date(2026, 12, 31), &days),
            date(2027, 1, 15)
        );
    }
}
