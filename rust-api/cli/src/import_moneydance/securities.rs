//! Phase 5 (security prices) and phase 6 (stock splits).

use sqlx::{Connection, PgConnection, Postgres, QueryBuilder};

use super::values::{
    Item, convert_date, convert_price_to_micros, field, int8, integer_text,
    parse_stock_split_ratio, text,
};
use super::{
    ImportContext, NewInvestmentSplit, NewTransaction, finish, insert_investment_split,
    insert_transaction, row_error,
};

/// A price insert holds at most this many rows.
const BATCH_SIZE: usize = 1_000;

fn of_type<'a>(items: &[&'a Item], kind: &str) -> Vec<&'a Item> {
    items
        .iter()
        .copied()
        .filter(|item| text(item, "obj_type").as_deref() == Some(kind))
        .collect()
}

fn text_or_undefined(item: &Item, key: &str) -> String {
    text(item, key).map_or_else(|| "undefined".to_owned(), |value| value.into_owned())
}

#[derive(Default)]
pub struct PhaseStats {
    pub imported: usize,
    pub skipped: usize,
    pub errors: usize,
}

pub async fn import_security_prices(
    connection: &mut PgConnection,
    context: &mut ImportContext,
    items: &[&Item],
) -> Result<PhaseStats, sqlx::Error> {
    context.heading("💰 Phase 5: Importing Security Prices");
    let mut stats = PhaseStats::default();
    let snapshots = of_type(items, "csnap");
    println!("Found {} security price snapshots", snapshots.len());
    if snapshots.is_empty() {
        println!("No security prices to import");
        return Ok(stats);
    }

    if context.options.dry_run {
        println!("  [DRY RUN] Would import prices:");
        for snapshot in snapshots.iter().take(5) {
            let currency = text_or_undefined(snapshot, "curr");
            let security = context
                .ids
                .securities
                .get(&currency)
                .map_or(currency.clone(), ToString::to_string);
            println!(
                "    Security {security}: {} = {}",
                text_or_undefined(snapshot, "dt"),
                text_or_undefined(snapshot, "relrt")
            );
        }
        if snapshots.len() > 5 {
            println!("    ... and {} more", snapshots.len() - 5);
        }
        stats.imported = snapshots.len();
    } else {
        let mut rows: Vec<(i32, String, f64)> = Vec::new();
        for snapshot in &snapshots {
            let currency = text_or_undefined(snapshot, "curr");
            let Some(&security_id) = context.ids.securities.get(&currency) else {
                stats.skipped += 1;
                context.verbose(format!("  ⊘ Skipped: Security not found for ID {currency}"));
                continue;
            };
            let price = convert_date(field(snapshot, "dt").as_deref()).and_then(|date| {
                Ok((
                    date,
                    convert_price_to_micros(field(snapshot, "relrt").as_deref())?,
                ))
            });
            match price {
                Ok((date, price_micros)) => rows.push((security_id, date, price_micros)),
                Err(message) => {
                    stats.errors += 1;
                    context.verbose(format!(
                        "  ✗ Error converting price for {currency} on {}: {message}",
                        text_or_undefined(snapshot, "dt")
                    ));
                }
            }
        }

        for (index, chunk) in rows.chunks(BATCH_SIZE).enumerate() {
            let start = index * BATCH_SIZE;
            // One bad price fails the whole statement, as it does in the TypeScript.
            let prices = chunk
                .iter()
                .map(|(security_id, date, price)| Ok((*security_id, date, int8(*price)?)))
                .collect::<Result<Vec<_>, String>>();
            let outcome = match prices {
                Err(message) => Err(message),
                Ok(prices) => {
                    let mut savepoint = connection.begin().await?;
                    let mut insert: QueryBuilder<Postgres> = QueryBuilder::new(
                        "INSERT INTO security_prices (security_id, book_id, price_date, price_micros, source) ",
                    );
                    insert.push_values(prices, |mut row, (security_id, date, price)| {
                        row.push_bind(security_id)
                            .push_bind(context.book_id)
                            .push_bind(date)
                            .push_bind(price)
                            .push_bind("moneydance_import");
                    });
                    insert.push(" ON CONFLICT DO NOTHING");
                    let outcome = insert
                        .build()
                        .execute(&mut *savepoint)
                        .await
                        .map(|_| ())
                        .map_err(row_error);
                    finish(savepoint, outcome).await?
                }
            };
            match outcome {
                Ok(()) => stats.imported += chunk.len(),
                Err(message) => {
                    eprintln!(
                        "  ✗ Batch insert failed (rows {start}-{}): {message}",
                        start + chunk.len()
                    );
                    stats.errors += chunk.len();
                }
            }
            println!(
                "  Progress: {}/{} prices inserted...",
                (start + BATCH_SIZE).min(rows.len()),
                rows.len()
            );
        }
    }

    println!("\n📊 Security Prices Import Summary:");
    println!("  Total snapshots: {}", snapshots.len());
    println!("  Imported: {}", stats.imported);
    println!("  Skipped: {}", stats.skipped);
    println!("  Errors: {}", stats.errors);
    Ok(stats)
}

pub async fn import_stock_splits(
    connection: &mut PgConnection,
    context: &mut ImportContext,
    items: &[&Item],
) -> Result<PhaseStats, sqlx::Error> {
    context.heading("📊 Phase 6: Importing Stock Splits");
    let mut stats = PhaseStats::default();
    let splits = of_type(items, "csplit");
    println!("Found {} stock splits", splits.len());
    if splits.is_empty() {
        println!("No stock splits to import");
        return Ok(stats);
    }
    let ratio_of = |split: &Item| {
        parse_stock_split_ratio(
            field(split, "oldshrs").as_deref(),
            field(split, "newshrs").as_deref(),
            field(split, "ratio").as_deref(),
        )
    };

    if context.options.dry_run {
        println!("  [DRY RUN] Would import stock splits:");
        // Every ratio is checked, not only the sample, and a bad one counts as
        // an error. The full import refuses the same split, so the dry run
        // must not report it as imported.
        for (index, split) in splits.iter().enumerate() {
            let ratio = ratio_of(split);
            if index < 5 {
                let currency = text_or_undefined(split, "curr");
                let security = context
                    .ids
                    .securities
                    .get(&currency)
                    .map_or(currency.clone(), ToString::to_string);
                let text = match &ratio {
                    Ok((numerator, denominator)) => {
                        format!(
                            "{}-for-{}",
                            integer_text(*numerator),
                            integer_text(*denominator)
                        )
                    }
                    Err(_) => "invalid ratio".to_owned(),
                };
                println!(
                    "    Security {security}: {} - {text} ({}:{}, ratio={})",
                    text_or_undefined(split, "dt"),
                    text_or_undefined(split, "oldshrs"),
                    text_or_undefined(split, "newshrs"),
                    text_or_undefined(split, "ratio")
                );
            }
            match ratio {
                Ok(_) => stats.imported += 1,
                Err(message) => {
                    stats.errors += 1;
                    eprintln!(
                        "  ✗ Invalid split for {} on {}: {message}",
                        text_or_undefined(split, "curr"),
                        text_or_undefined(split, "dt")
                    );
                }
            }
        }
        if splits.len() > 5 {
            println!("    ... and {} more", splits.len() - 5);
        }
    } else {
        for (count, split) in splits.iter().enumerate() {
            let currency = text_or_undefined(split, "curr");
            let Some(&security_id) = context.ids.securities.get(&currency) else {
                stats.skipped += 1;
                context.verbose(format!("  ⊘ Skipped: Security not found for ID {currency}"));
                continue;
            };
            let parsed = convert_date(field(split, "dt").as_deref())
                .and_then(|date| Ok((date, ratio_of(split)?)));
            let outcome = match parsed {
                Err(message) => Err(message),
                Ok((date, (numerator, denominator))) => {
                    let mut savepoint = connection.begin().await?;
                    let outcome = async {
                        let transaction_id = insert_transaction(
                            &mut savepoint,
                            context.book_id,
                            context.now,
                            &NewTransaction {
                                date: date.clone(),
                                description: Some(format!(
                                    "Stock split {}-for-{}",
                                    integer_text(numerator),
                                    integer_text(denominator)
                                )),
                                check_number: None,
                                payee_id: None,
                                is_reconciled: false,
                            },
                        )
                        .await?;
                        // A stock split has no account: it applies to every
                        // account that holds the security.
                        insert_investment_split(
                            &mut savepoint,
                            context.book_id,
                            &NewInvestmentSplit {
                                transaction_id,
                                account_id: None,
                                security_id,
                                action: "split",
                                shares_micros: 0.0,
                                price_micros: 0.0,
                                fees_cents: 0.0,
                                split_ratio: Some((numerator, denominator)),
                            },
                        )
                        .await
                    }
                    .await;
                    finish(savepoint, outcome)
                        .await?
                        .map(|()| (date, numerator, denominator))
                }
            };
            match outcome {
                Ok((date, numerator, denominator)) => {
                    stats.imported += 1;
                    if context.options.verbose {
                        println!(
                            "  ✓ {date}: {}-for-{} split for security {security_id}",
                            integer_text(numerator),
                            integer_text(denominator)
                        );
                    } else if (count + 1) % 10 == 0 {
                        println!("  Progress: {}/{}...", count + 1, splits.len());
                    }
                }
                Err(message) => {
                    stats.errors += 1;
                    context.verbose(format!(
                        "  ✗ Error importing split for {currency} on {}: {message}",
                        text_or_undefined(split, "dt")
                    ));
                }
            }
        }
    }

    println!("\n📊 Stock Splits Import Summary:");
    println!("  Total splits: {}", splits.len());
    println!("  Imported: {}", stats.imported);
    println!("  Skipped: {}", stats.skipped);
    println!("  Errors: {}", stats.errors);
    Ok(stats)
}
