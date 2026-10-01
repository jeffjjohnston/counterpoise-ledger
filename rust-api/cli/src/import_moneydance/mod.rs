//! The Moneydance importer, ported from `scripts/import-moneydance/`.
//!
//! The phases run in the order of `runImport` in `index.ts`: accounts,
//! opening balances, payees, standard transactions, investment transactions,
//! security prices, stock splits, the lot rebuild, and recurring reminders.
//! The lot rebuild must come after the stock splits. A sell after an imported
//! split needs the split row on the books first, or the FIFO replay matches
//! it against the share count before the split.
//!
//! The rows, their order and so their serial IDs are the same as the
//! TypeScript importer writes. `tests/http/moneydance-import.test.ts` compares
//! a dump of both. Two things differ on purpose:
//!
//! - One database transaction holds the whole run, `--overwrite` included,
//!   and the file is read before it starts. A failed run leaves the book as
//!   it was. The TypeScript cleared the book before it read the file, and it
//!   kept every row written before a failure.
//! - A row that fails does not stop the run, as in the TypeScript. Each unit
//!   that the TypeScript wrote in one statement or one transaction runs in a
//!   savepoint here, so a failed unit rolls back alone.
//! - An investment transaction with no `dt` key is a skipped row here. The
//!   TypeScript sort throws on it and stops the run.

mod accounts;
mod investments;
mod reminders;
mod securities;
mod transactions;
mod values;

use ledger_db::engine::{Db, DbConnection};
use std::collections::HashMap;

use chrono::{NaiveDate, NaiveDateTime};
use serde_json::Value;
use sqlx::QueryBuilder;

use values::{Item, int4, int8, text};

/// The message of a row that failed. The run records it and goes on.
pub type RowError = String;

pub fn row_error(cause: sqlx::Error) -> RowError {
    cause.to_string()
}

/// Releases the savepoint when `outcome` is a success, and rolls it back
/// when it is a failure. Only an error of the savepoint itself is fatal.
async fn finish<T>(
    savepoint: sqlx::Transaction<'_, Db>,
    outcome: Result<T, RowError>,
) -> Result<Result<T, RowError>, sqlx::Error> {
    match outcome {
        Ok(value) => {
            savepoint.commit().await?;
            Ok(Ok(value))
        }
        Err(message) => {
            savepoint.rollback().await?;
            Ok(Err(message))
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ImportOptions {
    pub dry_run: bool,
    pub import_inactive: bool,
    pub import_hidden: bool,
    pub verbose: bool,
}

#[derive(Debug, PartialEq)]
pub struct ImportArgs {
    pub file_path: String,
    pub book_id: i32,
    pub overwrite: bool,
    pub options: ImportOptions,
}

pub const USAGE: &str = "
Moneydance Import

Usage:
  ledger-cli import-moneydance <path-to-json> --book-id <id> [options]

Options:
  --book-id <id>         Book ID to import into (required)
  --dry-run              Parse and validate without writing to database
  --overwrite            Remove existing data in the target book before import
  --no-inactive          Skip inactive accounts
  --no-hidden            Skip hidden accounts
  --verbose              Show detailed progress
  --help, -h             Show this help message
";

pub fn should_show_help(args: &[String]) -> bool {
    args.first()
        .is_none_or(|first| first == "--help" || first == "-h")
}

/// The arguments after `import-moneydance`, read as `parseImportArgs` reads
/// them. The first argument is the file.
pub fn parse_args(args: &[String]) -> Result<ImportArgs, String> {
    let file_path = match args.first() {
        Some(first) if !first.is_empty() && !first.starts_with("--") => first.clone(),
        _ => return Err("Error: <path-to-json> is required".to_owned()),
    };
    let value = args
        .iter()
        .position(|arg| arg == "--book-id")
        .and_then(|index| args.get(index + 1))
        .filter(|value| !value.is_empty())
        .ok_or("Error: --book-id <id> is required")?;
    let book_id = ledger_core::js::parse_int(value, false)
        .filter(|id| *id > 0)
        .and_then(|id| i32::try_from(id).ok())
        .ok_or("Error: --book-id must be a positive integer")?;
    let flag = |name: &str| args.iter().any(|arg| arg == name);
    Ok(ImportArgs {
        file_path,
        book_id,
        overwrite: flag("--overwrite"),
        options: ImportOptions {
            dry_run: flag("--dry-run"),
            import_inactive: !flag("--no-inactive"),
            import_hidden: !flag("--no-hidden"),
            verbose: flag("--verbose"),
        },
    })
}

/// Maps Moneydance IDs to Counterpoise IDs. The cash child of investment
/// account `X` is under the key `X_CASH`.
#[derive(Default)]
pub struct IdMapper {
    pub accounts: HashMap<String, i32>,
    pub payees: HashMap<String, i32>,
    pub securities: HashMap<String, i32>,
}

/// What every phase shares, apart from the connection. The connection stays
/// a separate argument, so a savepoint can borrow it while a phase reads the
/// context.
pub struct ImportContext {
    pub book_id: i32,
    pub options: ImportOptions,
    pub ids: IdMapper,
    /// The `created_at` of every row: UTC wall clock, as `new Date()` is.
    pub now: NaiveDateTime,
}

impl ImportContext {
    fn heading(&self, title: &str) {
        println!("\n{title}");
        println!("{}", "=".repeat(60));
    }

    fn verbose(&self, line: impl AsRef<str>) {
        if self.options.verbose {
            println!("{}", line.as_ref());
        }
    }
}

pub struct NewTransaction {
    pub date: String,
    pub description: Option<String>,
    pub check_number: Option<String>,
    pub payee_id: Option<i32>,
    pub is_reconciled: bool,
}

async fn insert_transaction(
    connection: &mut DbConnection,
    book_id: i32,
    now: NaiveDateTime,
    transaction: &NewTransaction,
) -> Result<i32, RowError> {
    sqlx::query_scalar(
        "INSERT INTO transactions
           (book_id, date, description, check_number, payee_id, is_reconciled, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
         RETURNING id",
    )
    .bind(book_id)
    .bind(&transaction.date)
    .bind(&transaction.description)
    .bind(&transaction.check_number)
    .bind(transaction.payee_id)
    .bind(transaction.is_reconciled)
    .bind(now)
    .fetch_one(connection)
    .await
    .map_err(row_error)
}

/// Inserts `(account, amount)` splits in one statement, in the order given.
/// Every amount is checked first, so a bad amount writes none of them.
async fn insert_splits(
    connection: &mut DbConnection,
    book_id: i32,
    transaction_id: i32,
    splits: &[(i32, f64)],
) -> Result<(), RowError> {
    let amounts = splits
        .iter()
        .map(|(account_id, amount)| Ok((*account_id, int4(*amount)?)))
        .collect::<Result<Vec<_>, RowError>>()?;
    let mut insert: QueryBuilder<Db> = QueryBuilder::new(
        "INSERT INTO transaction_splits (book_id, transaction_id, account_id, amount) ",
    );
    insert.push_values(amounts, |mut row, (account_id, amount)| {
        row.push_bind(book_id)
            .push_bind(transaction_id)
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

pub struct NewInvestmentSplit {
    pub transaction_id: i32,
    pub account_id: Option<i32>,
    pub security_id: i32,
    pub action: &'static str,
    pub shares_micros: f64,
    pub price_micros: f64,
    pub fees_cents: f64,
    pub split_ratio: Option<(f64, f64)>,
}

async fn insert_investment_split(
    connection: &mut DbConnection,
    book_id: i32,
    split: &NewInvestmentSplit,
) -> Result<(), RowError> {
    let ratio = split
        .split_ratio
        .map(|(numerator, denominator)| Ok::<_, RowError>((int4(numerator)?, int4(denominator)?)))
        .transpose()?;
    sqlx::query(
        "INSERT INTO investment_splits
           (book_id, transaction_id, account_id, security_id, action, shares_micros, price_micros,
            fees_cents, split_numerator, split_denominator)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
    )
    .bind(book_id)
    .bind(split.transaction_id)
    .bind(split.account_id)
    .bind(split.security_id)
    .bind(split.action)
    .bind(int8(split.shares_micros)?)
    .bind(int8(split.price_micros)?)
    .bind(int4(split.fees_cents)?)
    .bind(ratio.map(|(numerator, _)| numerator))
    .bind(ratio.map(|(_, denominator)| denominator))
    .execute(connection)
    .await
    .map_err(row_error)?;
    Ok(())
}

/// A parsed export file.
pub struct Export {
    items: Vec<Item>,
}

impl Export {
    /// Checks the structure of an export, as `validateExport` does, and
    /// prints its metadata.
    pub fn from_json(document: Value) -> Result<Self, String> {
        let Value::Object(mut document) = document else {
            return Err("Invalid export: missing metadata".to_owned());
        };
        let metadata = match document.remove("metadata") {
            Some(Value::Object(metadata)) => metadata,
            Some(value) if is_truthy(&value) => serde_json::Map::new(),
            _ => return Err("Invalid export: missing metadata".to_owned()),
        };
        let Some(Value::Array(all_items)) = document.remove("all_items") else {
            return Err("Invalid export: missing or invalid all_items array".to_owned());
        };
        println!("\n📋 Export Metadata:");
        println!("  Exporter: {}", display(metadata.get("exporter")));
        println!("  Export Date: {}", display(metadata.get("export_date")));
        println!("  Total Items: {}", all_items.len());
        // A value that is not an object has no obj_type, so every phase
        // ignores it.
        let items = all_items
            .into_iter()
            .filter_map(|item| match item {
                Value::Object(item) => Some(item),
                _ => None,
            })
            .collect();
        Ok(Self { items })
    }
}

fn is_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|number| number != 0.0),
        Value::String(text) => !text.is_empty(),
        _ => true,
    }
}

fn display(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(value) => value.to_string(),
        None => "undefined".to_owned(),
    }
}

/// The count of each phase, for the final summary.
pub struct ImportSummary {
    pub lines: Vec<String>,
    pub errors: usize,
}

/// Deletes the importable rows of one book, children first.
pub async fn overwrite_book(
    connection: &mut DbConnection,
    book_id: i32,
) -> Result<(), sqlx::Error> {
    for table in [
        "plaid_transaction_reconciliation",
        "plaid_accounts",
        "plaid_tokens",
        "investment_splits",
        "investment_lots",
        "security_prices",
        "transaction_splits",
        "transactions",
        "recurring_template_splits",
        "recurring_rules",
        "securities",
        "payees",
        "accounts",
    ] {
        sqlx::query(&format!("DELETE FROM {table} WHERE book_id = $1"))
            .bind(book_id)
            .execute(&mut *connection)
            .await?;
    }
    Ok(())
}

/// Runs every phase against `export`. A database error stops the run, and
/// the caller rolls its transaction back. `today` dates an opening balance that
/// has no creation date and moves stale reminders forward.
pub async fn run_import(
    connection: &mut DbConnection,
    export: &Export,
    book_id: i32,
    options: ImportOptions,
    today: NaiveDate,
) -> Result<ImportSummary, sqlx::Error> {
    let mut by_type: Vec<(&str, usize)> = Vec::new();
    let (mut accounts, mut transactions, mut reminders) = (Vec::new(), Vec::new(), Vec::new());
    for item in &export.items {
        let kind = item
            .get("obj_type")
            .and_then(Value::as_str)
            .unwrap_or("undefined");
        match by_type.iter_mut().find(|(name, _)| *name == kind) {
            Some((_, count)) => *count += 1,
            None => by_type.push((kind, 1)),
        }
        match kind {
            "acct" => accounts.push(item),
            "txn" => transactions.push(item),
            "reminder" => reminders.push(item),
            _ => {}
        }
    }
    println!("\n📊 Content Analysis:");
    by_type.sort_by_key(|(_, count)| std::cmp::Reverse(*count));
    for (kind, count) in &by_type {
        println!("  {kind:<10} {count}");
    }
    let all_items: Vec<&Item> = export.items.iter().collect();

    let mut context = ImportContext {
        book_id,
        options,
        ids: IdMapper::default(),
        now: chrono::Utc::now().naive_utc(),
    };

    let account_stats =
        accounts::import_accounts(connection, &mut context, &accounts, &all_items).await?;
    let balance_stats = accounts::create_opening_balances(
        connection,
        &mut context,
        &account_stats.with_balances,
        today,
    )
    .await?;
    let payee_stats = transactions::import_payees(connection, &mut context, &transactions).await?;
    let transaction_stats =
        transactions::import_transactions(connection, &mut context, &transactions).await?;
    let investment_stats = investments::import_investment_transactions(
        connection,
        &mut context,
        &transactions,
        &all_items,
    )
    .await?;
    let price_stats =
        securities::import_security_prices(connection, &mut context, &all_items).await?;
    let split_stats = securities::import_stock_splits(connection, &mut context, &all_items).await?;

    context.heading("🔁 Phase 6.5: Rebuilding Investment Lots");
    let mut pairs = 0;
    if options.dry_run {
        println!("  [DRY RUN] Would rebuild investment lots for all (account, security) pairs");
    } else {
        let found = ledger_db::lots::find_all_lot_pairs(&mut *connection, book_id).await?;
        for pair in &found {
            ledger_db::lots::rebuild_lots(
                &mut *connection,
                book_id,
                pair.account_id,
                pair.security_id,
            )
            .await?;
        }
        pairs = found.len();
        println!("  Rebuilt {pairs} (account, security) pair(s)");
    }

    let reminder_stats =
        reminders::import_reminders(connection, &mut context, &reminders, today).await?;

    let lines = vec![
        "  Accounts:".to_owned(),
        format!("    Imported: {}", account_stats.imported),
        format!("    Securities: {}", account_stats.securities),
        format!("    Skipped: {}", account_stats.skipped),
        format!(
            "    With initial balances: {}",
            account_stats.with_balances.len()
        ),
        format!("    Errors: {}", account_stats.errors),
        "  Opening Balances:".to_owned(),
        format!("    Created: {}", balance_stats.created),
        format!("    Errors: {}", balance_stats.errors),
        "  Payees:".to_owned(),
        format!("    Imported: {}", payee_stats.imported),
        format!("    Errors: {}", payee_stats.errors),
        "  Transactions:".to_owned(),
        format!("    Imported: {}", transaction_stats.imported),
        format!("    Splits: {}", transaction_stats.splits),
        format!("    Skipped: {}", transaction_stats.skipped),
        format!("    Errors: {}", transaction_stats.errors),
        "  Investment Transactions:".to_owned(),
        format!("    Imported: {}", investment_stats.imported),
        format!("    Buys: {}", investment_stats.buys),
        format!("    Sells: {}", investment_stats.sells),
        format!("    Dividends: {}", investment_stats.dividends),
        format!("    Errors: {}", investment_stats.errors.len()),
        "  Security Prices:".to_owned(),
        format!("    Imported: {}", price_stats.imported),
        format!("    Skipped: {}", price_stats.skipped),
        format!("    Errors: {}", price_stats.errors),
        "  Stock Splits:".to_owned(),
        format!("    Imported: {}", split_stats.imported),
        format!("    Skipped: {}", split_stats.skipped),
        format!("    Errors: {}", split_stats.errors),
        "  Lot Rebuild:".to_owned(),
        format!("    Pairs rebuilt: {pairs}"),
        "  Recurring Reminders:".to_owned(),
        format!("    Imported: {}", reminder_stats.imported),
        format!("    Skipped: {}", reminder_stats.skipped),
        format!("    Errors: {}", reminder_stats.errors),
        String::new(),
        "  ID Mappings:".to_owned(),
        format!("    Accounts: {}", context.ids.accounts.len()),
        format!("    Securities: {}", context.ids.securities.len()),
        format!("    Payees: {}", context.ids.payees.len()),
    ];
    let errors = account_stats.errors
        + balance_stats.errors
        + payee_stats.errors
        + transaction_stats.errors
        + investment_stats.errors.len()
        + price_stats.errors
        + split_stats.errors
        + reminder_stats.errors;
    Ok(ImportSummary { lines, errors })
}

/// The description of a transaction, for log lines.
fn describe(item: &Item) -> String {
    values::field(item, "desc")
        .map(|text| text.into_owned())
        .unwrap_or_else(|| "(no description)".to_owned())
}

/// The `id` of an item, for error lines.
fn item_id(item: &Item) -> String {
    text(item, "id")
        .map(|id| id.into_owned())
        .unwrap_or_else(|| "undefined".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    #[test]
    fn parse_args_reads_the_typescript_flags() {
        let parsed = parse_args(&args(&[
            "export.json",
            "--book-id",
            "7",
            "--dry-run",
            "--no-hidden",
            "--overwrite",
        ]))
        .unwrap();
        assert_eq!(
            parsed,
            ImportArgs {
                file_path: "export.json".to_owned(),
                book_id: 7,
                overwrite: true,
                options: ImportOptions {
                    dry_run: true,
                    import_inactive: true,
                    import_hidden: false,
                    verbose: false,
                },
            }
        );
        assert_eq!(
            parse_args(&args(&["x.json", "--book-id", "12abc"]))
                .unwrap()
                .book_id,
            12
        );
    }

    #[test]
    fn parse_args_refuses_what_the_typescript_refuses() {
        let message = |values: &[&str]| parse_args(&args(values)).unwrap_err();
        assert_eq!(
            message(&["--book-id", "1"]),
            "Error: <path-to-json> is required"
        );
        assert_eq!(message(&["x.json"]), "Error: --book-id <id> is required");
        assert_eq!(
            message(&["x.json", "--book-id"]),
            "Error: --book-id <id> is required"
        );
        assert_eq!(
            message(&["x.json", "--book-id", "0"]),
            "Error: --book-id must be a positive integer"
        );
        assert_eq!(
            message(&["x.json", "--book-id", "two"]),
            "Error: --book-id must be a positive integer"
        );
        assert!(should_show_help(&[]));
        assert!(should_show_help(&args(&["-h"])));
        assert!(!should_show_help(&args(&["x.json", "--help"])));
    }

    #[test]
    fn export_needs_metadata_and_an_item_array() {
        let parse = |value: Value| Export::from_json(value).map(|export| export.items.len());
        assert!(parse(serde_json::json!({"all_items": []})).is_err());
        assert!(parse(serde_json::json!({"metadata": {}, "all_items": {}})).is_err());
        assert_eq!(
            parse(serde_json::json!({"metadata": {}, "all_items": [{}, 3, {}]})),
            Ok(2)
        );
    }
}
