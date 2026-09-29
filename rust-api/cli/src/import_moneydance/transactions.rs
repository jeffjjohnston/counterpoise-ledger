//! Phase 2 (payees) and phase 3 (standard transactions).

use sqlx::{Connection, PgConnection};

use super::values::{
    Item, convert_date, field, int, is_transaction_reconciled, normalize_name,
    normalize_optional_text, split_indexes, text,
};
use super::{
    ImportContext, NewTransaction, RowError, describe, finish, insert_splits, insert_transaction,
    item_id, row_error,
};

#[derive(Default)]
pub struct PayeeStats {
    pub imported: usize,
    pub errors: usize,
}

/// The distinct normalized descriptions of every transaction, in order of
/// first appearance.
fn payee_names(transactions: &[&Item]) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    for transaction in transactions {
        let Some(description) = field(transaction, "desc") else {
            continue;
        };
        let name = normalize_name(&description);
        if !name.is_empty() && !names.contains(&name) {
            names.push(name);
        }
    }
    names
}

pub async fn import_payees(
    connection: &mut PgConnection,
    context: &mut ImportContext,
    transactions: &[&Item],
) -> Result<PayeeStats, sqlx::Error> {
    context.heading("👤 Phase 2: Importing Payees");
    let mut stats = PayeeStats::default();
    let names = payee_names(transactions);
    println!("Found {} unique payees", names.len());

    if context.options.dry_run {
        println!("  [DRY RUN] Would import payees:");
        for name in names.iter().take(10) {
            println!("    {name}");
        }
        if names.len() > 10 {
            println!("    ... and {} more", names.len() - 10);
        }
        stats.imported = names.len();
    } else {
        for (count, name) in names.iter().enumerate() {
            let mut savepoint = connection.begin().await?;
            let outcome = sqlx::query_scalar::<_, i32>(
                "INSERT INTO payees (book_id, name, created_at) VALUES ($1, $2, $3) RETURNING id",
            )
            .bind(context.book_id)
            .bind(name)
            .bind(context.now)
            .fetch_one(&mut *savepoint)
            .await
            .map_err(row_error);
            match finish(savepoint, outcome).await? {
                Ok(payee_id) => {
                    context.ids.payees.insert(name.clone(), payee_id);
                    if context.options.verbose {
                        println!("  ✓ {name}");
                    } else if (count + 1) % 100 == 0 {
                        println!("  Progress: {}/{} payees...", count + 1, names.len());
                    }
                    stats.imported += 1;
                }
                Err(message) => {
                    stats.errors += 1;
                    eprintln!("  ✗ Error importing payee \"{name}\": {message}");
                }
            }
        }
    }

    println!("\n📊 Payee Import Summary:");
    println!("  Payees imported: {}", stats.imported);
    println!("  Errors: {}", stats.errors);
    Ok(stats)
}

/// A cash transfer inside an investment account (`xfrtp_bank`), or a
/// transaction with no transfer type.
fn is_standard(transaction: &Item) -> bool {
    match field(transaction, "xfer_type") {
        Some(kind) => kind == "xfrtp_bank",
        None => true,
    }
}

/// The `validateTransaction` messages, empty when the transaction is valid.
pub fn validation_errors(transaction: &Item) -> Vec<&'static str> {
    let mut errors = Vec::new();
    if field(transaction, "id").is_none() {
        errors.push("Missing transaction ID");
    }
    if field(transaction, "dt").is_none() {
        errors.push("Missing transaction date");
    }
    if field(transaction, "acctid").is_none() && field(transaction, "0.acctid").is_none() {
        errors.push("Missing account ID");
    }
    errors
}

/// A numbered split that has an account and a `samt`.
struct Split {
    index: String,
    account: String,
    /// A double: an unreadable `samt` is a NaN that fails at the insert.
    amount: f64,
}

/// The `extractSplits` of `utils/validation.ts`.
fn extract_splits(transaction: &Item) -> Vec<Split> {
    split_indexes(transaction)
        .into_iter()
        .filter_map(|index| {
            let account = field(transaction, &format!("{index}.acctid"))?.into_owned();
            let amount = int(&field(transaction, &format!("{index}.samt"))?);
            Some(Split {
                index,
                account,
                amount,
            })
        })
        .collect()
}

/// The parent account, then the account of each split, are all imported.
fn has_valid_accounts(context: &ImportContext, transaction: &Item, splits: &[Split]) -> bool {
    let accounts = &context.ids.accounts;
    let parent = text(transaction, "acctid")
        .map(|id| id.into_owned())
        .unwrap_or_else(|| "undefined".to_owned());
    let has_parent = accounts.contains_key(&parent)
        || (field(transaction, "xfer_type").as_deref() == Some("xfrtp_bank")
            && accounts.contains_key(&format!("{parent}_CASH")));
    has_parent
        && splits
            .iter()
            .all(|split| accounts.contains_key(&split.account))
}

/// A mapped account, or its cash child when it is an investment account.
fn cash_or_account(context: &ImportContext, md_id: &str) -> Option<i32> {
    let accounts = &context.ids.accounts;
    accounts
        .get(&format!("{md_id}_CASH"))
        .or_else(|| accounts.get(md_id))
        .copied()
}

/// The payee of a transaction description, when the description has one.
pub fn payee_of(context: &ImportContext, transaction: &Item) -> Option<i32> {
    let name = normalize_name(&field(transaction, "desc")?);
    if name.is_empty() {
        return None;
    }
    context.ids.payees.get(&name).copied()
}

#[derive(Default)]
pub struct TransactionStats {
    pub imported: usize,
    pub skipped: usize,
    pub splits: usize,
    pub errors: usize,
}

pub async fn import_transactions(
    connection: &mut PgConnection,
    context: &mut ImportContext,
    transactions: &[&Item],
) -> Result<TransactionStats, sqlx::Error> {
    context.heading("💸 Phase 3: Importing Standard Transactions");
    let mut stats = TransactionStats::default();
    let standard: Vec<&Item> = transactions
        .iter()
        .copied()
        .filter(|item| is_standard(item))
        .collect();
    println!(
        "Found {} standard transactions ({} investment transactions skipped)",
        standard.len(),
        transactions.len() - standard.len()
    );

    if context.options.dry_run {
        println!("  [DRY RUN] Would import transactions:");
        for transaction in standard.iter().take(5) {
            println!(
                "    {} - {} ({} splits)",
                text(transaction, "dt").as_deref().unwrap_or("undefined"),
                describe(transaction),
                extract_splits(transaction).len()
            );
        }
        if standard.len() > 5 {
            println!("    ... and {} more", standard.len() - 5);
        }
        stats.imported = standard.len();
    } else {
        for (count, transaction) in standard.iter().enumerate() {
            let errors = validation_errors(transaction);
            if !errors.is_empty() {
                stats.errors += 1;
                stats.skipped += 1;
                continue;
            }
            let splits = extract_splits(transaction);
            if !has_valid_accounts(context, transaction, &splits) {
                context.verbose(format!(
                    "  ⊗ Skipping {}: Referenced accounts not imported",
                    field(transaction, "desc").unwrap_or_else(|| item_id(transaction).into())
                ));
                stats.skipped += 1;
                continue;
            }
            if splits.is_empty() {
                stats.errors += 1;
                stats.skipped += 1;
                continue;
            }
            let date = match convert_date(field(transaction, "dt").as_deref()) {
                Ok(date) => date,
                Err(message) => {
                    stats.errors += 1;
                    eprintln!(
                        "  ✗ Error importing transaction {}: {message}",
                        item_id(transaction)
                    );
                    continue;
                }
            };
            let new_transaction = NewTransaction {
                date: date.clone(),
                description: field(transaction, "desc").map(|text| text.into_owned()),
                check_number: normalize_optional_text(text(transaction, "chk").as_deref()),
                payee_id: payee_of(context, transaction),
                is_reconciled: is_transaction_reconciled(transaction),
            };
            let mut savepoint = connection.begin().await?;
            let outcome = write_transaction(
                &mut savepoint,
                context,
                transaction,
                &new_transaction,
                &splits,
            )
            .await;
            match finish(savepoint, outcome).await? {
                Ok(written) => {
                    stats.splits += written;
                    if context.options.verbose {
                        println!(
                            "  ✓ {date} - {} ({} splits)",
                            describe(transaction),
                            splits.len() + 1
                        );
                    } else if (count + 1) % 500 == 0 {
                        println!(
                            "  Progress: {}/{} ({:.1}%) transactions...",
                            count + 1,
                            standard.len(),
                            (count + 1) as f64 / standard.len() as f64 * 100.0
                        );
                    }
                    stats.imported += 1;
                }
                Err(message) => {
                    stats.errors += 1;
                    eprintln!(
                        "  ✗ Error importing transaction {}: {message}",
                        item_id(transaction)
                    );
                }
            }
        }
    }

    println!("\n📊 Transaction Import Summary:");
    println!("  Transactions imported: {}", stats.imported);
    println!("  Splits created: {}", stats.splits);
    println!("  Skipped: {}", stats.skipped);
    println!("  Errors: {}", stats.errors);
    Ok(stats)
}

/// Writes one transaction: the parent account split, which is the sum of the
/// `pamt` values, then one split per numbered split from its `samt`. Returns
/// the count of splits.
async fn write_transaction(
    connection: &mut PgConnection,
    context: &ImportContext,
    transaction: &Item,
    new_transaction: &NewTransaction,
    splits: &[Split],
) -> Result<usize, RowError> {
    let transaction_id =
        insert_transaction(connection, context.book_id, context.now, new_transaction).await?;
    let parent = text(transaction, "acctid")
        .map(|id| id.into_owned())
        .unwrap_or_else(|| "undefined".to_owned());
    let parent_account = cash_or_account(context, &parent)
        .ok_or_else(|| format!("Parent account mapping not found for {parent}"))?;
    let parent_amount: f64 = splits
        .iter()
        .filter_map(|split| field(transaction, &format!("{}.pamt", split.index)))
        .map(|pamt| int(&pamt))
        .sum();
    // One statement per split, as the TypeScript writes them.
    insert_splits(
        connection,
        context.book_id,
        transaction_id,
        &[(parent_account, parent_amount)],
    )
    .await?;
    for split in splits {
        let account = cash_or_account(context, &split.account)
            .ok_or_else(|| format!("Account mapping not found for {}", split.account))?;
        insert_splits(
            connection,
            context.book_id,
            transaction_id,
            &[(account, split.amount)],
        )
        .await?;
    }
    Ok(splits.len() + 1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn item(value: serde_json::Value) -> Item {
        value.as_object().unwrap().clone()
    }

    #[test]
    fn payee_names_are_distinct_and_normalized() {
        let first = item(json!({"desc": "Green Grocer"}));
        let second = item(json!({"desc": "  Green   Grocer "}));
        let blank = item(json!({"desc": "   "}));
        let third = item(json!({"desc": "Joe\u{2019}s"}));
        assert_eq!(
            payee_names(&[&first, &second, &blank, &third]),
            ["Green Grocer", "Joe's"]
        );
    }

    #[test]
    fn extract_splits_needs_an_account_and_an_amount() {
        let row = item(json!({
            "0.acctid": "a", "0.samt": "5",
            "1.acctid": "b",
            "10.acctid": "c", "10.samt": "x",
        }));
        let splits = extract_splits(&row);
        assert_eq!(splits.len(), 2);
        assert_eq!((splits[0].index.as_str(), splits[0].amount), ("0", 5.0));
        assert_eq!(splits[1].index, "10");
        assert!(splits[1].amount.is_nan());
    }

    #[test]
    fn standard_means_no_transfer_type_or_a_bank_transfer() {
        assert!(is_standard(&item(json!({}))));
        assert!(is_standard(&item(json!({"xfer_type": "xfrtp_bank"}))));
        assert!(!is_standard(&item(json!({"xfer_type": "xfrtp_buysell"}))));
    }
}
