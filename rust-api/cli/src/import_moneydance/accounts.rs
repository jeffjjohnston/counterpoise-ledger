//! Phase 1 (accounts and securities) and phase 1.5 (opening balances).

use std::collections::HashMap;

use chrono::NaiveDate;
use ledger_core::formatters::to_date_string;
use sqlx::{Connection, PgConnection};

use super::values::{Item, field, int, is_true, owned, text, timestamp_date};
use super::{ImportContext, RowError, finish, row_error};

/// A Moneydance account type as a Counterpoise type and subtype.
enum Mapping {
    Account(&'static str, Option<&'static str>),
    Security,
    Skip,
}

fn map_account_type(kind: Option<&str>) -> Result<Mapping, String> {
    Ok(match kind {
        Some("a") => Mapping::Account("asset", Some("other")),
        Some("b") => Mapping::Account("asset", Some("bank")),
        Some("c") => Mapping::Account("liability", Some("credit_card")),
        Some("e") => Mapping::Account("expense", None),
        Some("i") => Mapping::Account("income", None),
        Some("l" | "o") => Mapping::Account("liability", Some("loan")),
        Some("v") => Mapping::Account("asset", Some("investment")),
        Some("s") => Mapping::Security,
        Some("r") => Mapping::Skip,
        other => {
            return Err(format!(
                "Unknown account type: {}",
                other.unwrap_or("undefined")
            ));
        }
    })
}

fn name_of(item: &Item) -> String {
    text(item, "name")
        .map(|name| name.into_owned())
        .unwrap_or_default()
}

/// The `Parent:Child` path of an account, up to but not including the root.
/// A cycle in `parentid` stops the walk instead of looping for ever.
fn full_path(account: &Item, accounts: &[&Item]) -> String {
    let mut names = vec![name_of(account)];
    let mut current = account;
    while let Some(parent_id) = field(current, "parentid") {
        let parent = accounts
            .iter()
            .find(|candidate| text(candidate, "id").as_deref() == Some(&*parent_id));
        let Some(parent) = parent else { break };
        if text(parent, "type").as_deref() == Some("r") || names.len() > accounts.len() {
            break;
        }
        names.push(name_of(parent));
        current = parent;
    }
    names.reverse();
    names.join(":")
}

/// An account with a nonzero `sbal`. Phase 1.5 gives it an opening balance.
pub struct AccountWithBalance {
    md_account_id: String,
    account_id: i32,
    name: String,
    subtype: Option<&'static str>,
    /// A double, so a NaN from an unreadable `sbal` fails at the insert.
    initial_balance: f64,
    creation_date: Option<String>,
}

#[derive(Default)]
pub struct AccountStats {
    pub imported: usize,
    pub skipped: usize,
    pub securities: usize,
    pub errors: usize,
    pub with_balances: Vec<AccountWithBalance>,
}

/// `sbal` when it is set and not zero. NaN counts as not zero.
fn initial_balance(item: &Item) -> Option<f64> {
    let balance = int(&field(item, "sbal")?);
    (balance != 0.0).then_some(balance)
}

pub async fn import_accounts(
    connection: &mut PgConnection,
    context: &mut ImportContext,
    accounts: &[&Item],
    all_items: &[&Item],
) -> Result<AccountStats, sqlx::Error> {
    context.heading("📁 Phase 1: Importing Accounts");
    let mut stats = AccountStats::default();
    let options = context.options;
    let mut to_import = Vec::new();
    let mut securities: Vec<&Item> = Vec::new();

    for &account in accounts {
        let kind = text(account, "type");
        let reason = if kind.as_deref() == Some("r") {
            Some("Root account")
        } else if !options.import_inactive && is_true(field(account, "is_inactive").as_deref()) {
            Some("Inactive account")
        } else if !options.import_hidden && is_true(field(account, "hide").as_deref()) {
            Some("Hidden account")
        } else {
            None
        };
        if let Some(reason) = reason {
            context.verbose(format!("  ⊗ Skipping: {} ({reason})", name_of(account)));
            stats.skipped += 1;
            continue;
        }
        match map_account_type(kind.as_deref()) {
            Ok(Mapping::Skip) => stats.skipped += 1,
            Ok(Mapping::Security) => securities.push(account),
            Ok(Mapping::Account(kind, subtype)) => to_import.push((account, kind, subtype)),
            Err(message) => {
                stats.errors += 1;
                eprintln!("  ✗ Error processing {}: {message}", name_of(account));
            }
        }
    }

    println!("\nImporting {} accounts...", to_import.len());
    if options.dry_run {
        println!("  [DRY RUN] Would import accounts:");
        for &(account, kind, subtype) in &to_import {
            let path = full_path(account, accounts);
            println!("    {path} ({kind}/{})", subtype.unwrap_or("none"));
            if let Some(balance) = initial_balance(account) {
                let placeholder = -(stats.with_balances.len() as i32 + 1);
                stats.with_balances.push(AccountWithBalance {
                    md_account_id: owned(account, "id").unwrap_or_default(),
                    account_id: placeholder,
                    name: path,
                    subtype,
                    initial_balance: balance,
                    creation_date: owned(account, "creation_date"),
                });
            }
        }
        stats.imported = to_import.len();
    } else {
        for &(account, kind, subtype) in &to_import {
            let path = full_path(account, accounts);
            let is_active = !is_true(field(account, "is_inactive").as_deref());
            // The account and its cash child are two statements, as in the
            // TypeScript: a failed cash insert keeps the account and its mapping.
            let mut savepoint = connection.begin().await?;
            let outcome = upsert_account(
                &mut savepoint,
                context.book_id,
                context.now,
                &NewAccount {
                    name: &path,
                    kind,
                    subtype,
                    parent_id: None,
                    is_active,
                },
            )
            .await;
            let account_id = match finish(savepoint, outcome).await? {
                Ok(account_id) => account_id,
                Err(message) => {
                    stats.errors += 1;
                    eprintln!("  ✗ Error importing {path}: {message}");
                    continue;
                }
            };
            let md_id = owned(account, "id").unwrap_or_default();
            context.ids.accounts.insert(md_id.clone(), account_id);
            if let Some(balance) = initial_balance(account) {
                stats.with_balances.push(AccountWithBalance {
                    md_account_id: md_id.clone(),
                    account_id,
                    name: path.clone(),
                    subtype,
                    initial_balance: balance,
                    creation_date: owned(account, "creation_date"),
                });
                context.verbose(format!("  ⓘ Has initial balance: ${:.2}", balance / 100.0));
            }
            let subtype_text = subtype.unwrap_or("none");
            if subtype != Some("investment") {
                context.verbose(format!("  ✓ {path} ({kind}/{subtype_text})"));
                stats.imported += 1;
                continue;
            }
            let mut savepoint = connection.begin().await?;
            let outcome = upsert_account(
                &mut savepoint,
                context.book_id,
                context.now,
                &NewAccount {
                    name: &format!("{path} - Cash"),
                    kind: "asset",
                    subtype: Some("cash"),
                    parent_id: Some(account_id),
                    is_active,
                },
            )
            .await;
            match finish(savepoint, outcome).await? {
                Ok(cash_id) => {
                    context
                        .ids
                        .accounts
                        .insert(format!("{md_id}_CASH"), cash_id);
                    context.verbose(format!("  ✓ {path} ({kind}/{subtype_text}) + cash account"));
                    stats.imported += 1;
                }
                Err(message) => {
                    stats.errors += 1;
                    eprintln!("  ✗ Error importing {path}: {message}");
                }
            }
        }

        println!("\nSetting up account hierarchy...");
        for &(account, _, _) in &to_import {
            let (Some(md_id), Some(parent_md_id)) =
                (field(account, "id"), field(account, "parentid"))
            else {
                continue;
            };
            let (Some(&child), Some(&parent)) = (
                context.ids.accounts.get(&*md_id),
                context.ids.accounts.get(&*parent_md_id),
            ) else {
                continue;
            };
            let mut savepoint = connection.begin().await?;
            let outcome = sqlx::query("UPDATE accounts SET parent_id = $1 WHERE id = $2")
                .bind(parent)
                .bind(child)
                .execute(&mut *savepoint)
                .await
                .map(|_| ())
                .map_err(row_error);
            let path = full_path(account, accounts);
            match finish(savepoint, outcome).await? {
                Ok(()) => context.verbose(format!("  ↳ {path} → parent set")),
                Err(message) => eprintln!("  ✗ Error setting parent for {path}: {message}"),
            }
        }
    }

    import_securities(connection, context, &mut stats, &securities, all_items).await?;

    println!("\n📊 Account Import Summary:");
    println!("  Accounts imported: {}", stats.imported);
    println!("  Securities imported: {}", stats.securities);
    println!("  Skipped: {}", stats.skipped);
    println!("  Errors: {}", stats.errors);
    Ok(stats)
}

struct NewAccount<'a> {
    name: &'a str,
    kind: &'a str,
    subtype: Option<&'a str>,
    /// Set only on a cash child, which is an investment-cash account.
    parent_id: Option<i32>,
    is_active: bool,
}

/// Inserts one account, or updates the row that an earlier import wrote. A
/// re-import updates the type of a plain account and the parent of a cash
/// child, as the TypeScript upserts do.
async fn upsert_account(
    connection: &mut PgConnection,
    book_id: i32,
    now: chrono::NaiveDateTime,
    account: &NewAccount<'_>,
) -> Result<i32, RowError> {
    let update = if account.parent_id.is_some() {
        "parent_id = EXCLUDED.parent_id, is_active = EXCLUDED.is_active"
    } else {
        "type = EXCLUDED.type, subtype = EXCLUDED.subtype, is_active = EXCLUDED.is_active"
    };
    sqlx::query_scalar(&format!(
        "INSERT INTO accounts
           (book_id, name, type, subtype, parent_id, is_active, is_investment_cash, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
         ON CONFLICT (name, book_id) DO UPDATE SET {update}
         RETURNING id"
    ))
    .bind(book_id)
    .bind(account.name)
    .bind(account.kind)
    .bind(account.subtype)
    .bind(account.parent_id)
    .bind(account.is_active)
    .bind(account.parent_id.is_some())
    .bind(now)
    .fetch_one(&mut *connection)
    .await
    .map_err(row_error)
}

/// Imports one `securities` row per underlying Moneydance security. Several
/// security accounts can hold the same security.
async fn import_securities(
    connection: &mut PgConnection,
    context: &mut ImportContext,
    stats: &mut AccountStats,
    securities: &[&Item],
    all_items: &[&Item],
) -> Result<(), sqlx::Error> {
    if securities.is_empty() {
        return Ok(());
    }
    // A later record with the same key replaces an earlier one, as Map.set does.
    let mut currencies: HashMap<String, &Item> = HashMap::new();
    for &item in all_items {
        if text(item, "obj_type").as_deref() == Some("curr") {
            if let Some(id) = text(item, "id") {
                currencies.insert(id.into_owned(), item);
            }
            if let Some(currency_id) = owned(item, "currid") {
                currencies.insert(currency_id, item);
            }
        }
    }
    context.verbose(format!(
        "  Found {} currency record(s) for ticker lookup",
        currencies.len()
    ));

    // Groups in order of first appearance, as a Map keeps them.
    let mut groups: Vec<Vec<&Item>> = Vec::new();
    let mut group_of: HashMap<String, usize> = HashMap::new();
    for &account in securities {
        let reference = field(account, "curr")
            .or_else(|| field(account, "currid"))
            .or_else(|| text(account, "id"))
            .map(|reference| reference.into_owned())
            .unwrap_or_default();
        let index = *group_of.entry(reference).or_insert_with(|| {
            groups.push(Vec::new());
            groups.len() - 1
        });
        groups[index].push(account);
    }
    println!(
        "\nImporting {} unique securities ({} total references)...",
        groups.len(),
        securities.len()
    );

    let ticker_of = |primary: &Item| {
        let currency_id = field(primary, "currid").or_else(|| field(primary, "curr"));
        let record = currency_id.as_deref().and_then(|id| currencies.get(id));
        let ticker = record
            .and_then(|record| owned(record, "ticker"))
            .or_else(|| owned(primary, "ticker"));
        (ticker, currency_id.map(|id| id.into_owned()))
    };

    if context.options.dry_run {
        println!("  [DRY RUN] Would import securities:");
        for group in &groups {
            let primary = group[0];
            let name = name_of(primary);
            let (ticker, currency_id) = ticker_of(primary);
            match ticker.filter(|ticker| *ticker != name) {
                Some(ticker) => println!("    {name} [{ticker}] - {} reference(s)", group.len()),
                None => println!(
                    "    ⚠ {name} (no distinct ticker{}) - {} reference(s)",
                    currency_id
                        .map(|id| format!(", currency ID: {id}"))
                        .unwrap_or_default(),
                    group.len()
                ),
            }
        }
        stats.securities = groups.len();
        return Ok(());
    }

    for group in &groups {
        let primary = group[0];
        let name = text(primary, "name").map(|name| name.into_owned());
        let display = name.clone().unwrap_or_default();
        let (ticker, currency_id) = ticker_of(primary);
        if ticker.as_deref().is_none_or(|ticker| ticker == display) {
            context.verbose(format!(
                "  ⚠ Security \"{display}\" has no distinct ticker symbol{}",
                currency_id
                    .map(|id| format!(" (currency ID: {id})"))
                    .unwrap_or_default()
            ));
        }
        let security_type = match text(primary, "sec_type").as_deref() {
            Some("2") => "mutual_fund",
            Some("1") => "etf",
            _ => "stock",
        };
        let symbol = ticker.clone().or_else(|| name.clone());
        let mut savepoint = connection.begin().await?;
        let outcome = sqlx::query_scalar::<_, i32>(
            "INSERT INTO securities (book_id, name, symbol, security_type, created_at)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (name, symbol, book_id) DO UPDATE SET security_type = $4
             RETURNING id",
        )
        .bind(context.book_id)
        .bind(&name)
        .bind(&symbol)
        .bind(security_type)
        .bind(context.now)
        .fetch_one(&mut *savepoint)
        .await
        .map_err(row_error);
        match finish(savepoint, outcome).await? {
            Ok(security_id) => {
                for account in group {
                    if let Some(id) = text(account, "id") {
                        context.ids.securities.insert(id.into_owned(), security_id);
                    }
                }
                // A stock split names its security by the currency ID.
                if let Some(currency_id) = owned(primary, "currid") {
                    context.ids.securities.insert(currency_id, security_id);
                }
                let ticker_info = ticker
                    .filter(|ticker| *ticker != display)
                    .map(|ticker| format!(" [{ticker}]"))
                    .unwrap_or_default();
                context.verbose(format!(
                    "  ✓ {display}{ticker_info} ({security_type}) - {} reference(s)",
                    group.len()
                ));
                stats.securities += 1;
            }
            Err(message) => {
                stats.errors += 1;
                eprintln!("  ✗ Error importing security {display}: {message}");
            }
        }
    }
    Ok(())
}

#[derive(Default)]
pub struct OpeningBalanceStats {
    pub created: usize,
    pub errors: usize,
}

/// The "Imported Balance" expense account of this book, created when absent.
async fn imported_balance_account(
    connection: &mut PgConnection,
    context: &ImportContext,
) -> Result<i32, sqlx::Error> {
    let existing: Option<i32> = sqlx::query_scalar(
        "SELECT id FROM accounts WHERE book_id = $1 AND name = 'Imported Balance'",
    )
    .bind(context.book_id)
    .fetch_optional(&mut *connection)
    .await?;
    if let Some(id) = existing {
        return Ok(id);
    }
    sqlx::query_scalar(
        "INSERT INTO accounts
           (book_id, name, type, subtype, parent_id, is_active, is_investment_cash, created_at, updated_at)
         VALUES ($1, 'Imported Balance', 'expense', NULL, NULL, true, false, $2, $2)
         RETURNING id",
    )
    .bind(context.book_id)
    .bind(context.now)
    .fetch_one(&mut *connection)
    .await
}

/// One reconciled transaction per account with an initial balance, against
/// the "Imported Balance" account. An investment account's balance goes to
/// its cash child.
pub async fn create_opening_balances(
    connection: &mut PgConnection,
    context: &mut ImportContext,
    accounts: &[AccountWithBalance],
    today: NaiveDate,
) -> Result<OpeningBalanceStats, sqlx::Error> {
    context.heading("🏦 Phase 1.5: Creating Opening Balances");
    let mut stats = OpeningBalanceStats::default();
    if accounts.is_empty() {
        println!("No accounts with initial balances found");
        return Ok(stats);
    }
    println!("Found {} account(s) with initial balance", accounts.len());

    let describe = |account: &AccountWithBalance| {
        let date = timestamp_date(account.creation_date.as_deref(), today);
        let sign = if account.initial_balance >= 0.0 {
            "+"
        } else {
            "-"
        };
        (
            to_date_string(date),
            format!(
                "{}: {sign}${:.2}",
                account.name,
                account.initial_balance.abs() / 100.0
            ),
        )
    };

    if context.options.dry_run {
        println!("  [DRY RUN] Would create opening balances for:");
        for account in accounts {
            let (date, text) = describe(account);
            println!("    {text} on {date}");
        }
        stats.created = accounts.len();
        return Ok(stats);
    }

    let offset_account = imported_balance_account(connection, context).await?;
    println!("Using Imported Balance account (ID: {offset_account})");

    for account in accounts {
        let (date, text) = describe(account);
        let mut target = account.account_id;
        if account.subtype == Some("investment")
            && let Some(&cash_id) = context
                .ids
                .accounts
                .get(&format!("{}_CASH", account.md_account_id))
        {
            target = cash_id;
            context.verbose(format!(
                "  ⓘ Routing balance to cash account for {}",
                account.name
            ));
        }
        let mut savepoint = connection.begin().await?;
        let outcome = async {
            let transaction_id = super::insert_transaction(
                &mut savepoint,
                context.book_id,
                context.now,
                &super::NewTransaction {
                    date: date.clone(),
                    description: Some(format!("Opening Balance - {}", account.name)),
                    check_number: None,
                    payee_id: None,
                    is_reconciled: true,
                },
            )
            .await?;
            super::insert_splits(
                &mut savepoint,
                context.book_id,
                transaction_id,
                &[
                    (target, account.initial_balance),
                    (offset_account, -account.initial_balance),
                ],
            )
            .await
        }
        .await;
        match finish(savepoint, outcome).await? {
            Ok(()) => {
                context.verbose(format!("  ✓ {text} on {date}"));
                stats.created += 1;
            }
            Err(message) => {
                stats.errors += 1;
                eprintln!(
                    "  ✗ Error creating opening balance for {}: {message}",
                    account.name
                );
            }
        }
    }

    println!("\n📊 Opening Balance Summary:");
    println!("  Account balances created: {}", stats.created);
    println!("  Errors: {}", stats.errors);
    Ok(stats)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn item(value: serde_json::Value) -> Item {
        value.as_object().unwrap().clone()
    }

    #[test]
    fn full_path_walks_to_the_root_and_survives_a_cycle() {
        let root = item(json!({"id": "r", "type": "r", "name": "Book"}));
        let parent = item(json!({"id": "p", "type": "e", "name": "Auto", "parentid": "r"}));
        let child = item(json!({"id": "c", "type": "e", "name": "Fuel", "parentid": "p"}));
        let accounts = [&root, &parent, &child];
        assert_eq!(full_path(&child, &accounts), "Auto:Fuel");

        let first = item(json!({"id": "a", "type": "e", "name": "A", "parentid": "b"}));
        let second = item(json!({"id": "b", "type": "e", "name": "B", "parentid": "a"}));
        let cycle = [&first, &second];
        assert!(full_path(&first, &cycle).ends_with("B:A"));
    }

    #[test]
    fn initial_balance_keeps_nan_and_drops_zero() {
        assert_eq!(
            initial_balance(&item(json!({"sbal": "1250"}))),
            Some(1250.0)
        );
        assert_eq!(initial_balance(&item(json!({"sbal": "0"}))), None);
        assert_eq!(initial_balance(&item(json!({}))), None);
        assert!(
            initial_balance(&item(json!({"sbal": "x"})))
                .unwrap()
                .is_nan()
        );
    }
}
