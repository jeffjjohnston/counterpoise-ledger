//! `ledger-cli import-postgres --from <postgres-url> --to <path>`: converts
//! the PostgreSQL database of the last PostgreSQL release into a new SQLite
//! file, and proves the copy before it names it.
//!
//! - It holds the server lock of the target (`<path>.lock`) for the whole
//!   run, so that no server and no second converter uses the target or the
//!   partial file meanwhile.
//! - It refuses a target that exists (or its `-wal` file), and a source that
//!   is not at the last PostgreSQL migration.
//! - It writes `<path>.partial`. Only after every check passes, and after a
//!   complete checkpoint leaves no WAL data, does it link the file to
//!   `<path>`, which never replaces a file with that name. After a failure
//!   the partial file stays for inspection.
//! - It keeps every ID and every sequence position, so links, API keys,
//!   sessions, Plaid cursors and native-client caches stay valid, and an ID
//!   is never given twice.
//! - Timestamps keep their naive UTC value; no zone is converted. JSON keeps
//!   the text that PostgreSQL gave.
//!
//! The checks: the row count and every row of every table, compared value by
//! value; the split sum of each book (zero) and the balance of each account;
//! the copied lots against a fresh rebuild (which also proves the positions
//! that the lots hold); `PRAGMA foreign_key_check`; `PRAGMA integrity_check`.
//!
//! Lots are derived state. The lots of a pair with a floating investment
//! split hold the effective date of the day of their last rebuild, so they
//! are not compared: the copy gets a fresh rebuild of those pairs, and the
//! summary names them. Every other pair must equal a fresh rebuild.

use chrono::NaiveDateTime;
use ledger_db::{engine::DbPool, lots::LotPair};
use sqlx::{
    Column, PgPool, QueryBuilder, Row, Sqlite, TypeInfo, ValueRef,
    postgres::{PgPoolOptions, PgRow},
    sqlite::SqliteRow,
};
use std::{
    collections::BTreeMap,
    fmt::Write as _,
    path::{Path, PathBuf},
};

/// The last Drizzle migration of the last PostgreSQL release: 0027,
/// `book_members_owner`. The converter reads no other schema.
const FINAL_MIGRATION_COUNT: i64 = 28;
const FINAL_MIGRATION_HASH: &str =
    "c0c6cd2bcad0a8df13e1dd873558935375aaafad5868f01e9137743281660bc6";

/// The tables in an order that satisfies the foreign keys. The foreign keys
/// are also deferred to the commit, so a row may refer to a later one.
const TABLES: [&str; 24] = [
    "users",
    "sessions",
    "api_keys",
    "issue_reports",
    "books",
    "book_members",
    "accounts",
    "payees",
    "recurring_rules",
    "recurring_template_splits",
    "transactions",
    "transaction_splits",
    "securities",
    "security_prices",
    "investment_splits",
    "investment_lots",
    "investment_lot_allocations",
    "plaid_tokens",
    "plaid_accounts",
    "plaid_transaction_reconciliation",
    "typesafe_evaluations",
    "typesafe_decisions",
    "typesafe_quotas",
    "typesafe_aggregates",
];

/// Rows per INSERT. Each row binds at most 26 values; SQLite takes 32766.
const CHUNK: usize = 500;

pub const USAGE: &str =
    "usage: ledger-cli import-postgres --from <postgres-url> --to <path> [--allow-unbalanced]

Converts the PostgreSQL database of Counterpoise's last PostgreSQL release
into a new SQLite file at <path>, then checks the copy row by row. The file
appears only when every check passes. The source is only read.

A book whose splits do not sum to zero in the source is refused; the
summary names it. After you inspect it, --allow-unbalanced converts it as
it is.";

pub struct Args {
    pub from: String,
    pub to: PathBuf,
    /// Accept a source book whose splits do not sum to zero. The copy keeps
    /// the same sums; without this flag such a source is refused.
    pub allow_unbalanced: bool,
}

pub fn parse_args(args: &[String]) -> Result<Args, String> {
    let value = |flag: &str| {
        args.iter()
            .position(|arg| arg == flag)
            .and_then(|index| args.get(index + 1))
            .cloned()
    };
    match (value("--from"), value("--to")) {
        (Some(from), Some(to)) => Ok(Args {
            from,
            to: PathBuf::from(to),
            allow_unbalanced: args.iter().any(|arg| arg == "--allow-unbalanced"),
        }),
        _ => Err(USAGE.to_owned()),
    }
}

/// The kind of value of a column, from its PostgreSQL type.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Kind {
    Integer,
    Boolean,
    Text,
    Timestamp,
    Json,
}

struct Table {
    name: &'static str,
    columns: Vec<(String, Kind)>,
    /// The primary key, for a fixed row order.
    order: String,
}

/// One value of one row, in the form both engines are compared in.
#[derive(Clone, Debug, PartialEq)]
enum Value {
    Null,
    Integer(i64),
    Boolean(bool),
    Text(String),
    Timestamp(NaiveDateTime),
}

pub struct Summary {
    pub text: String,
    pub ok: bool,
}

fn quoted(name: &str) -> String {
    format!("\"{name}\"")
}

/// The path with `suffix` added to the file name.
fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

pub async fn run(args: &Args) -> Result<Summary, String> {
    if let Some(parent) = args.to.parent().filter(|dir| !dir.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent)
            .map_err(|cause| format!("cannot create {}: {cause}", parent.display()))?;
    }
    // The server lock of the destination (`<path>.lock`), for the whole
    // conversion. A server cannot open the destination while the converter
    // writes it, and a second converter cannot use the same partial file.
    let _lock = ledger_db::lock_server(&args.to).map_err(|cause| {
        format!("{cause}. Stop the server or the other conversion, then convert again")
    })?;
    refuse_existing(&args.to)?;
    let partial = with_suffix(&args.to, ".partial");
    // Only a failed conversion leaves these files, and the lock keeps every
    // other converter away from them.
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(with_suffix(&partial, suffix));
    }

    let source = PgPoolOptions::new()
        .max_connections(2)
        .connect(&args.from)
        .await
        .map_err(|cause| format!("cannot connect to the PostgreSQL source: {cause}"))?;
    check_source_version(&source).await?;
    let tables = read_tables(&source).await?;

    let target = ledger_db::connect(&partial, true).map_err(|cause| cause.to_string())?;
    ledger_db::migrate(&target)
        .await
        .map_err(|cause| format!("cannot create the SQLite schema: {cause}"))?;
    check_target_columns(&target, &tables).await?;

    let mut text = String::new();
    let _ = writeln!(text, "Converting into {}", partial.display());
    copy(&source, &target, &tables, &mut text).await?;
    let ok = verify(&source, &target, &tables, args.allow_unbalanced, &mut text).await?;
    // Put every page in the main file, so that it is complete alone.
    let checkpointed = match target.acquire().await {
        Ok(mut connection) => checkpoint(&mut connection).await,
        Err(cause) => Err(format!("checkpoint failed: {cause}")),
    };
    target.close().await;
    source.close().await;
    checkpointed?;
    if ok {
        publish(&partial, &args.to)?;
        let _ = writeln!(text, "All checks passed. Wrote {}.", args.to.display());
    } else {
        let _ = writeln!(
            text,
            "A check FAILED. {} is left for inspection; {} was not written.",
            partial.display(),
            args.to.display()
        );
    }
    Ok(Summary { text, ok })
}

/// Refuses a destination that exists, and a WAL file without it: SQLite
/// would apply that old WAL to the new file when it opens it.
fn refuse_existing(to: &Path) -> Result<(), String> {
    for name in [to.to_path_buf(), with_suffix(to, "-wal")] {
        if name.exists() {
            return Err(format!(
                "{} exists; the converter writes a new file only",
                name.display()
            ));
        }
    }
    Ok(())
}

/// `PRAGMA wal_checkpoint(TRUNCATE)`, and a check of its result row: `busy`
/// must be 0 and every frame of the log must be in the main file. A busy
/// checkpoint returns a row, not an error, so the row must be read.
async fn checkpoint(connection: &mut sqlx::SqliteConnection) -> Result<(), String> {
    let (busy, log, checkpointed): (i64, i64, i64) =
        sqlx::query_as("PRAGMA wal_checkpoint(TRUNCATE)")
            .fetch_one(connection)
            .await
            .map_err(|cause| format!("checkpoint failed: {cause}"))?;
    if busy != 0 || log != checkpointed {
        return Err(format!(
            "the checkpoint did not complete (busy {busy}, {log} frames in the log, \
             {checkpointed} checkpointed); the file was not written"
        ));
    }
    Ok(())
}

/// Gives the closed, checked partial file the destination name. It refuses
/// when a WAL file with data is still beside the partial file: the pages in
/// it are not in the main file. It never replaces a destination that another
/// process made meanwhile ([`ledger_db::database::publish_file`]).
fn publish(partial: &Path, to: &Path) -> Result<(), String> {
    let wal = with_suffix(partial, "-wal");
    match std::fs::metadata(&wal) {
        Ok(metadata) if metadata.len() > 0 => {
            return Err(format!(
                "{} still holds {} bytes after the checkpoint; the file was not written",
                wal.display(),
                metadata.len()
            ));
        }
        Ok(_) => std::fs::remove_file(&wal)
            .map_err(|cause| format!("cannot remove {}: {cause}", wal.display()))?,
        Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => {}
        Err(cause) => return Err(format!("cannot read {}: {cause}", wal.display())),
    }
    let _ = std::fs::remove_file(with_suffix(partial, "-shm"));
    refuse_existing(to)?;
    ledger_db::database::publish_file(partial, to)
}

/// Refuses a source that is not at the last PostgreSQL migration.
async fn check_source_version(source: &PgPool) -> Result<(), String> {
    let refuse = |found: String| {
        format!(
            "the source is not at the last PostgreSQL migration (0027_book_members_owner): {found}. \
             Upgrade to the last PostgreSQL release first, then convert."
        )
    };
    let rows: Vec<(i64, String)> = sqlx::query_as(
        "SELECT CAST(COUNT(*) OVER () AS bigint), hash FROM drizzle.__drizzle_migrations
         ORDER BY created_at DESC, id DESC LIMIT 1",
    )
    .fetch_all(source)
    .await
    .map_err(|cause| refuse(format!("no migration table ({cause})")))?;
    match rows.first() {
        Some((count, hash)) if *count == FINAL_MIGRATION_COUNT && hash == FINAL_MIGRATION_HASH => {
            Ok(())
        }
        Some((count, hash)) => Err(refuse(format!("{count} migrations, last hash {hash}"))),
        None => Err(refuse("no migration".to_owned())),
    }
}

/// The columns of each table of [`TABLES`] in the source, and its key.
async fn read_tables(source: &PgPool) -> Result<Vec<Table>, String> {
    let mut tables = Vec::new();
    let found: Vec<String> = sqlx::query_scalar(
        "SELECT table_name::text FROM information_schema.tables
         WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1",
    )
    .fetch_all(source)
    .await
    .map_err(|cause| cause.to_string())?;
    let mut expected: Vec<String> = TABLES.iter().map(|t| (*t).to_owned()).collect();
    expected.sort();
    if found != expected {
        return Err(format!(
            "the source tables differ from the last PostgreSQL release: {found:?}"
        ));
    }
    for name in TABLES {
        let columns: Vec<(String, String)> = sqlx::query_as(
            "SELECT column_name::text, data_type::text FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position",
        )
        .bind(name)
        .fetch_all(source)
        .await
        .map_err(|cause| cause.to_string())?;
        let columns = columns
            .into_iter()
            .map(|(column, data_type)| {
                let kind = match data_type.as_str() {
                    "integer" | "bigint" | "smallint" => Kind::Integer,
                    "boolean" => Kind::Boolean,
                    "text" | "character varying" => Kind::Text,
                    "timestamp without time zone" => Kind::Timestamp,
                    "jsonb" | "json" => Kind::Json,
                    other => {
                        return Err(format!("{name}.{column} has the type {other}, which the converter does not know"));
                    }
                };
                Ok((column, kind))
            })
            .collect::<Result<Vec<_>, String>>()?;
        let key: Vec<String> = sqlx::query_scalar(
            "SELECT a.attname::text FROM pg_index i
             JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
             WHERE i.indrelid = ('public.' || $1)::regclass AND i.indisprimary
             ORDER BY array_position(i.indkey, a.attnum)",
        )
        .bind(name)
        .fetch_all(source)
        .await
        .map_err(|cause| cause.to_string())?;
        if key.is_empty() {
            return Err(format!("{name} has no primary key"));
        }
        tables.push(Table {
            name,
            columns,
            order: key
                .iter()
                .map(|column| quoted(column))
                .collect::<Vec<_>>()
                .join(", "),
        });
    }
    Ok(tables)
}

/// Refuses a SQLite schema whose columns are not the source columns.
async fn check_target_columns(target: &DbPool, tables: &[Table]) -> Result<(), String> {
    for table in tables {
        let columns: Vec<String> =
            sqlx::query_scalar("SELECT name FROM pragma_table_info($1) ORDER BY cid")
                .bind(table.name)
                .fetch_all(target)
                .await
                .map_err(|cause| cause.to_string())?;
        let mut source: Vec<&str> = table
            .columns
            .iter()
            .map(|(name, _)| name.as_str())
            .collect();
        let mut target: Vec<&str> = columns.iter().map(String::as_str).collect();
        source.sort_unstable();
        target.sort_unstable();
        if source != target {
            return Err(format!(
                "the columns of {} differ: PostgreSQL {source:?}, SQLite {target:?}",
                table.name
            ));
        }
    }
    Ok(())
}

/// `SELECT` of every column in key order, JSON as its text.
fn select(table: &Table) -> String {
    let list = table
        .columns
        .iter()
        .map(|(name, kind)| match kind {
            Kind::Json => format!("CAST({} AS TEXT) AS {}", quoted(name), quoted(name)),
            _ => quoted(name),
        })
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "SELECT {list} FROM {} ORDER BY {}",
        quoted(table.name),
        table.order
    )
}

fn pg_value(row: &PgRow, index: usize, kind: Kind) -> Result<Value, String> {
    let fail = |cause: sqlx::Error| cause.to_string();
    Ok(match kind {
        Kind::Integer => {
            let column = row.column(index);
            let value: Option<i64> = match column.type_info().name() {
                "INT2" => row
                    .try_get::<Option<i16>, _>(index)
                    .map_err(fail)?
                    .map(i64::from),
                "INT4" => row
                    .try_get::<Option<i32>, _>(index)
                    .map_err(fail)?
                    .map(i64::from),
                _ => row.try_get::<Option<i64>, _>(index).map_err(fail)?,
            };
            value.map_or(Value::Null, Value::Integer)
        }
        Kind::Boolean => row
            .try_get::<Option<bool>, _>(index)
            .map_err(fail)?
            .map_or(Value::Null, Value::Boolean),
        Kind::Text | Kind::Json => row
            .try_get::<Option<String>, _>(index)
            .map_err(fail)?
            .map_or(Value::Null, Value::Text),
        Kind::Timestamp => row
            .try_get::<Option<NaiveDateTime>, _>(index)
            .map_err(fail)?
            .map_or(Value::Null, Value::Timestamp),
    })
}

fn sqlite_value(row: &SqliteRow, index: usize, kind: Kind) -> Result<Value, String> {
    let fail = |cause: sqlx::Error| cause.to_string();
    if row.try_get_raw(index).map_err(fail)?.is_null() {
        return Ok(Value::Null);
    }
    Ok(match kind {
        Kind::Integer => Value::Integer(row.try_get(index).map_err(fail)?),
        Kind::Boolean => Value::Boolean(row.try_get(index).map_err(fail)?),
        Kind::Text | Kind::Json => Value::Text(row.try_get(index).map_err(fail)?),
        Kind::Timestamp => Value::Timestamp(row.try_get(index).map_err(fail)?),
    })
}

async fn copy(
    source: &PgPool,
    target: &DbPool,
    tables: &[Table],
    text: &mut String,
) -> Result<(), String> {
    let fail = |cause: sqlx::Error| cause.to_string();
    let mut transaction = ledger_db::locks::begin_pool(target).await.map_err(fail)?;
    sqlx::query("PRAGMA defer_foreign_keys = ON")
        .execute(transaction.as_mut())
        .await
        .map_err(fail)?;
    for table in tables {
        if table.name == "book_members" {
            // The books trigger added the creator of each book as owner.
            // Copy the members exactly instead.
            sqlx::query("DELETE FROM book_members")
                .execute(transaction.as_mut())
                .await
                .map_err(fail)?;
        }
        let rows = sqlx::query(&select(table))
            .fetch_all(source)
            .await
            .map_err(|cause| format!("cannot read {}: {cause}", table.name))?;
        for chunk in rows.chunks(CHUNK) {
            let mut values = Vec::with_capacity(chunk.len());
            for row in chunk {
                let mut record = Vec::with_capacity(table.columns.len());
                for (index, (_, kind)) in table.columns.iter().enumerate() {
                    record.push(pg_value(row, index, *kind)?);
                }
                values.push(record);
            }
            let names = table
                .columns
                .iter()
                .map(|(name, _)| quoted(name))
                .collect::<Vec<_>>()
                .join(", ");
            let mut insert = QueryBuilder::<Sqlite>::new(format!(
                "INSERT INTO {} ({names}) ",
                quoted(table.name)
            ));
            insert.push_values(values, |mut builder, record| {
                for value in record {
                    match value {
                        Value::Null => builder.push_bind(None::<String>),
                        Value::Integer(number) => builder.push_bind(number),
                        Value::Boolean(flag) => builder.push_bind(flag),
                        Value::Text(text) => builder.push_bind(text),
                        Value::Timestamp(time) => builder.push_bind(time),
                    };
                }
            });
            insert
                .build()
                .execute(transaction.as_mut())
                .await
                .map_err(|cause| format!("cannot write {}: {cause}", table.name))?;
        }
        let _ = writeln!(text, "  {:<34} {:>8} rows", table.name, rows.len());
    }
    copy_sequences(source, &mut transaction, tables).await?;
    // The copy moved the live-update counts. They count from here.
    sqlx::query("DELETE FROM change_marks")
        .execute(transaction.as_mut())
        .await
        .map_err(fail)?;
    // The copy also logged each transaction for the delta sync. Only the
    // floor marker of the migration (book 0) stays: a native client
    // downloads the full book first.
    sqlx::query("DELETE FROM transaction_changes WHERE book_id <> 0")
        .execute(transaction.as_mut())
        .await
        .map_err(fail)?;
    transaction.commit().await.map_err(|cause| {
        format!("the copy does not satisfy a foreign key, or cannot commit: {cause}")
    })
}

/// Sets the next ID of each table to the next value of its PostgreSQL
/// sequence, so that no ID is given twice.
async fn copy_sequences(
    source: &PgPool,
    transaction: &mut sqlx::Transaction<'static, Sqlite>,
    tables: &[Table],
) -> Result<(), String> {
    let fail = |cause: sqlx::Error| cause.to_string();
    for table in tables {
        let sequence: Option<String> =
            sqlx::query_scalar("SELECT pg_get_serial_sequence('public.' || $1, 'id')")
                .bind(table.name)
                .fetch_one(source)
                .await
                .unwrap_or(None);
        let Some(sequence) = sequence else { continue };
        let (last, called): (i64, bool) =
            sqlx::query_as(&format!("SELECT last_value, is_called FROM {sequence}"))
                .fetch_one(source)
                .await
                .map_err(fail)?;
        let used = if called { last } else { last - 1 };
        let current: Option<i64> =
            sqlx::query_scalar("SELECT seq FROM sqlite_sequence WHERE name = $1")
                .bind(table.name)
                .fetch_optional(transaction.as_mut())
                .await
                .map_err(fail)?;
        match current {
            Some(current) if current >= used => {}
            Some(_) => {
                sqlx::query("UPDATE sqlite_sequence SET seq = $2 WHERE name = $1")
                    .bind(table.name)
                    .bind(used)
                    .execute(transaction.as_mut())
                    .await
                    .map_err(fail)?;
            }
            None if used > 0 => {
                sqlx::query("INSERT INTO sqlite_sequence (name, seq) VALUES ($1, $2)")
                    .bind(table.name)
                    .bind(used)
                    .execute(transaction.as_mut())
                    .await
                    .map_err(fail)?;
            }
            None => {}
        }
    }
    Ok(())
}

async fn verify(
    source: &PgPool,
    target: &DbPool,
    tables: &[Table],
    allow_unbalanced: bool,
    text: &mut String,
) -> Result<bool, String> {
    let fail = |cause: sqlx::Error| cause.to_string();
    let mut ok = true;
    let _ = writeln!(text, "Checks:");
    let mut check = |name: &str, passed: bool, detail: String| {
        ok &= passed;
        let mark = if passed { "ok  " } else { "FAIL" };
        let _ = writeln!(text, "  [{mark}] {name}{detail}");
    };

    // Every row of every table, value by value.
    let mut rows_total = 0;
    let mut differences = Vec::new();
    for table in tables {
        let pg_rows = sqlx::query(&select(table))
            .fetch_all(source)
            .await
            .map_err(fail)?;
        let names = table
            .columns
            .iter()
            .map(|(name, _)| quoted(name))
            .collect::<Vec<_>>()
            .join(", ");
        let sqlite_rows = sqlx::query(&format!(
            "SELECT {names} FROM {} ORDER BY {}",
            quoted(table.name),
            table.order
        ))
        .fetch_all(target)
        .await
        .map_err(fail)?;
        if pg_rows.len() != sqlite_rows.len() {
            differences.push(format!(
                "{}: {} rows in PostgreSQL, {} in SQLite",
                table.name,
                pg_rows.len(),
                sqlite_rows.len()
            ));
            continue;
        }
        rows_total += pg_rows.len();
        for (pg_row, sqlite_row) in pg_rows.iter().zip(&sqlite_rows) {
            for (index, (column, kind)) in table.columns.iter().enumerate() {
                let before = pg_value(pg_row, index, *kind)?;
                let after = sqlite_value(sqlite_row, index, *kind)?;
                if before != after {
                    differences.push(format!(
                        "{}.{column}: {before:?} became {after:?}",
                        table.name
                    ));
                    break;
                }
            }
            if differences.len() > 20 {
                break;
            }
        }
    }
    check(
        "every row and value equal",
        differences.is_empty(),
        if differences.is_empty() {
            format!(" ({rows_total} rows in {} tables)", tables.len())
        } else {
            format!(": {}", differences.join("; "))
        },
    );

    // The split sum of each book: the same as in the source, and zero.
    let pg_sums: BTreeMap<i64, i64> = sqlx::query_as::<_, (i64, i64)>(
        "SELECT CAST(book_id AS bigint), CAST(SUM(amount) AS bigint) FROM transaction_splits GROUP BY book_id",
    )
    .fetch_all(source)
    .await
    .map_err(fail)?
    .into_iter()
    .collect();
    let sqlite_sums: BTreeMap<i64, i64> = sqlx::query_as::<_, (i64, i64)>(
        "SELECT book_id, SUM(amount) FROM transaction_splits GROUP BY book_id",
    )
    .fetch_all(target)
    .await
    .map_err(fail)?
    .into_iter()
    .collect();
    check(
        "the split sum of each book equals the source",
        pg_sums == sqlite_sums,
        format!(" ({} books)", sqlite_sums.len()),
    );
    let unbalanced: Vec<(i64, i64)> = sqlite_sums
        .iter()
        .filter(|(_, sum)| **sum != 0)
        .map(|(book, sum)| (*book, *sum))
        .collect();
    let described = unbalanced
        .iter()
        .map(|(book, sum)| format!("book {book}: {sum} cents"))
        .collect::<Vec<_>>()
        .join(", ");
    if unbalanced.is_empty() || !allow_unbalanced {
        check(
            "the splits of each book sum to zero",
            unbalanced.is_empty(),
            if unbalanced.is_empty() {
                String::new()
            } else {
                format!(
                    ": {described}. The source is unbalanced; inspect it, then run again with --allow-unbalanced to convert it as it is"
                )
            },
        );
    } else {
        check(
            "the splits of each book sum to zero (unbalanced in the source, accepted)",
            true,
            format!(": {described}"),
        );
    }
    let pg_balances: BTreeMap<i64, i64> = sqlx::query_as::<_, (i64, i64)>(
        "SELECT CAST(account_id AS bigint), CAST(SUM(amount) AS bigint) FROM transaction_splits GROUP BY account_id",
    )
    .fetch_all(source)
    .await
    .map_err(fail)?
    .into_iter()
    .collect();
    let sqlite_balances: BTreeMap<i64, i64> = sqlx::query_as::<_, (i64, i64)>(
        "SELECT account_id, SUM(amount) FROM transaction_splits GROUP BY account_id",
    )
    .fetch_all(target)
    .await
    .map_err(fail)?
    .into_iter()
    .collect();
    check(
        "the balance of each account",
        pg_balances == sqlite_balances,
        format!(" ({} accounts)", sqlite_balances.len()),
    );

    // The copied lots against a fresh rebuild, rolled back afterwards. The
    // pairs with a floating investment split are rebuilt in the copy instead.
    let lots = check_lots(target).await?;
    let mut detail = format!(" ({} account and security pairs)", lots.pairs);
    if !lots.differing.is_empty() {
        let _ = write!(
            detail,
            ": they differ for {}",
            describe_pairs(&lots.differing)
        );
    } else if !lots.floating.is_empty() {
        rebuild_pairs(target, &lots.floating).await?;
        let _ = write!(
            detail,
            "; rebuilt {} pairs that have floating transactions: {}",
            lots.floating.len(),
            describe_pairs(&lots.floating)
        );
    }
    check(
        "the lots equal a fresh rebuild",
        lots.differing.is_empty(),
        detail,
    );

    let violations: Vec<(String, i64)> =
        sqlx::query_as("SELECT \"table\", rowid FROM pragma_foreign_key_check")
            .fetch_all(target)
            .await
            .map_err(fail)?;
    check(
        "PRAGMA foreign_key_check",
        violations.is_empty(),
        if violations.is_empty() {
            String::new()
        } else {
            format!(": {violations:?}")
        },
    );
    let integrity: Vec<String> = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_all(target)
        .await
        .map_err(fail)?;
    check(
        "PRAGMA integrity_check",
        integrity == ["ok"],
        if integrity == ["ok"] {
            String::new()
        } else {
            format!(": {}", integrity.join("; "))
        },
    );
    Ok(ok)
}

/// One (account, security) pair of one book.
type BookPair = (i32, LotPair);

/// What [`check_lots`] found.
struct LotCheck {
    /// The number of pairs that have a buy or a sell.
    pairs: usize,
    /// The pairs with a floating investment split, or with a floating stock
    /// split of their security. Their stored lots hold the effective date of
    /// the day of their last rebuild (see `rust-api/db/src/lots.rs`), so a
    /// rebuild today can give a different acquired date and FIFO order. They
    /// are not compared; the copy gets a fresh rebuild of them.
    floating: Vec<BookPair>,
    /// The other pairs whose copied lots or allocations differ from a fresh
    /// rebuild.
    differing: Vec<BookPair>,
}

fn describe_pairs(pairs: &[BookPair]) -> String {
    pairs
        .iter()
        .map(|(book, pair)| {
            format!(
                "book {book} account {} security {}",
                pair.account_id, pair.security_id
            )
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// The lots and allocations of each pair, by content (no IDs), before and
/// after a rebuild inside a transaction that then rolls back. A pair without
/// a floating investment split must be equal; see [`LotCheck`] for the others.
async fn check_lots(target: &DbPool) -> Result<LotCheck, String> {
    let fail = |cause: sqlx::Error| cause.to_string();
    // Each row as a JSON array, grouped by its pair: the comparison needs the
    // values, not their types.
    async fn contents(
        connection: &mut sqlx::SqliteConnection,
    ) -> Result<BTreeMap<(i32, i32, i32), Vec<String>>, sqlx::Error> {
        let lots: Vec<(i32, i32, i32, String)> = sqlx::query_as(
            "SELECT book_id, account_id, security_id,
                    'lot ' || json_array(acquired_date,
                    opened_split_id, opened_transaction_id, closed_transaction_id,
                    original_shares_micros, original_basis_cents, remaining_shares_micros,
                    remaining_basis_cents)
             FROM investment_lots ORDER BY book_id, account_id, security_id, opened_split_id, acquired_date",
        )
        .fetch_all(&mut *connection)
        .await?;
        let allocations: Vec<(i32, i32, i32, String)> = sqlx::query_as(
            "SELECT a.book_id, l.account_id, l.security_id,
                    'allocation ' || json_array(a.sell_split_id, a.transaction_id,
                    l.opened_split_id, a.shares_micros, a.basis_cents, a.proceeds_cents)
             FROM investment_lot_allocations a JOIN investment_lots l ON l.id = a.lot_id
             ORDER BY a.book_id, a.sell_split_id, l.opened_split_id, a.id",
        )
        .fetch_all(&mut *connection)
        .await?;
        let mut grouped: BTreeMap<(i32, i32, i32), Vec<String>> = BTreeMap::new();
        for (book, account, security, row) in lots.into_iter().chain(allocations) {
            grouped
                .entry((book, account, security))
                .or_default()
                .push(row);
        }
        Ok(grouped)
    }
    let mut transaction = ledger_db::locks::begin_pool(target).await.map_err(fail)?;
    let before = contents(transaction.as_mut()).await.map_err(fail)?;
    let books: Vec<i32> = sqlx::query_scalar("SELECT id FROM books ORDER BY id")
        .fetch_all(transaction.as_mut())
        .await
        .map_err(fail)?;
    let mut pairs = 0;
    let mut floating = Vec::new();
    for book_id in books {
        let found = ledger_db::lots::find_all_lot_pairs(transaction.as_mut(), book_id)
            .await
            .map_err(fail)?;
        pairs += found.len();
        for pair in &found {
            // The same splits that the rebuild of the pair reads.
            let floats: bool = sqlx::query_scalar(
                "SELECT EXISTS (SELECT 1 FROM investment_splits s
                                JOIN transactions t ON t.id = s.transaction_id
                                WHERE s.book_id = $1 AND s.security_id = $2
                                  AND (s.account_id = $3
                                       OR (s.account_id IS NULL AND s.action = 'split'))
                                  AND t.is_floating = 1)",
            )
            .bind(book_id)
            .bind(pair.security_id)
            .bind(pair.account_id)
            .fetch_one(transaction.as_mut())
            .await
            .map_err(fail)?;
            if floats {
                floating.push((book_id, *pair));
            }
        }
        ledger_db::lots::rebuild_lots_for_pairs(transaction.as_mut(), book_id, &found)
            .await
            .map_err(fail)?;
    }
    let after = contents(transaction.as_mut()).await.map_err(fail)?;
    transaction.rollback().await.map_err(fail)?;
    let skipped = |key: &(i32, i32, i32)| {
        floating
            .iter()
            .any(|(book, pair)| (*book, pair.account_id, pair.security_id) == *key)
    };
    let differing = before
        .keys()
        .chain(after.keys())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .filter(|key| !skipped(key) && before.get(*key) != after.get(*key))
        .map(|&(book, account_id, security_id)| {
            (
                book,
                LotPair {
                    account_id,
                    security_id,
                },
            )
        })
        .collect();
    Ok(LotCheck {
        pairs,
        floating,
        differing,
    })
}

/// Rebuilds the lots of `pairs` in the copy, in one transaction that
/// commits, with the same code as every write path.
async fn rebuild_pairs(target: &DbPool, pairs: &[BookPair]) -> Result<(), String> {
    let fail = |cause: sqlx::Error| format!("cannot rebuild the floating pairs: {cause}");
    let mut transaction = ledger_db::locks::begin_pool(target).await.map_err(fail)?;
    for (book_id, pair) in pairs {
        ledger_db::lots::rebuild_lots_for_pairs(transaction.as_mut(), *book_id, &[*pair])
            .await
            .map_err(fail)?;
    }
    transaction.commit().await.map_err(fail)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ledger_db::testing::TempDatabase;

    fn strings(args: &[&str]) -> Vec<String> {
        args.iter().map(|arg| (*arg).to_owned()).collect()
    }

    #[test]
    fn parse_args_reads_the_flags_in_any_order() {
        let args = parse_args(&strings(&["--to", "out.db", "--from", "postgres://x"])).unwrap();
        assert_eq!(args.from, "postgres://x");
        assert_eq!(args.to, PathBuf::from("out.db"));
        assert!(!args.allow_unbalanced);
        let args = parse_args(&strings(&[
            "--allow-unbalanced",
            "--from",
            "postgres://x",
            "--to",
            "out.db",
        ]))
        .unwrap();
        assert!(args.allow_unbalanced);
    }

    #[test]
    fn parse_args_refuses_a_missing_flag_or_value() {
        for args in [
            vec![],
            strings(&["--from", "postgres://x"]),
            strings(&["--to", "out.db"]),
            strings(&["--from", "postgres://x", "--to"]),
        ] {
            assert_eq!(parse_args(&args).err().as_deref(), Some(USAGE));
        }
    }

    #[test]
    fn the_partial_file_is_next_to_the_target() {
        assert_eq!(
            with_suffix(Path::new("/data/counterpoise.db"), ".partial"),
            PathBuf::from("/data/counterpoise.db.partial")
        );
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "counterpoise-convert-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The lock comes before the connection to PostgreSQL, so the port here
    /// (nothing listens on it) is never reached.
    #[tokio::test]
    async fn a_held_server_lock_refuses_the_conversion() {
        let dir = scratch("lock");
        let to = dir.join("counterpoise.db");
        let held = ledger_db::lock_server(&to).unwrap();
        let args = Args {
            from: "postgres://counterpoise@127.0.0.1:1/none".to_owned(),
            to: to.clone(),
            allow_unbalanced: false,
        };
        let refused = run(&args).await.err().unwrap_or_default();
        assert!(refused.contains("is locked"), "{refused}");
        assert!(!to.exists());
        assert!(!with_suffix(&to, ".partial").exists());
        drop(held);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn an_existing_destination_or_wal_is_refused() {
        let dir = scratch("exists");
        let to = dir.join("counterpoise.db");
        for name in [to.clone(), with_suffix(&to, "-wal")] {
            std::fs::write(&name, b"keep").unwrap();
            let args = Args {
                from: "postgres://counterpoise@127.0.0.1:1/none".to_owned(),
                to: to.clone(),
                allow_unbalanced: false,
            };
            let refused = run(&args).await.err().unwrap_or_default();
            assert!(refused.contains("writes a new file only"), "{refused}");
            assert_eq!(std::fs::read(&name).unwrap(), b"keep");
            std::fs::remove_file(&name).unwrap();
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// A destination that another process made after the start is not
    /// replaced, and the checked partial file stays.
    #[test]
    fn publish_does_not_replace_a_destination_made_meanwhile() {
        let dir = scratch("publish");
        let to = dir.join("counterpoise.db");
        let partial = with_suffix(&to, ".partial");
        std::fs::write(&partial, b"converted").unwrap();
        std::fs::write(&to, b"made meanwhile").unwrap();
        assert!(publish(&partial, &to).is_err());
        assert_eq!(std::fs::read(&to).unwrap(), b"made meanwhile");
        assert_eq!(std::fs::read(&partial).unwrap(), b"converted");

        std::fs::remove_file(&to).unwrap();
        // A WAL with data beside the partial file: its pages are not in the
        // main file.
        std::fs::write(with_suffix(&partial, "-wal"), b"frames").unwrap();
        let refused = publish(&partial, &to).err().unwrap_or_default();
        assert!(refused.contains("after the checkpoint"), "{refused}");
        assert!(!to.exists());

        std::fs::write(with_suffix(&partial, "-wal"), b"").unwrap();
        publish(&partial, &to).unwrap();
        assert_eq!(std::fs::read(&to).unwrap(), b"converted");
        assert!(!partial.exists());
        assert!(!with_suffix(&partial, "-wal").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// A reader that holds a snapshot blocks a TRUNCATE checkpoint. The
    /// pragma then returns busy = 1 in its row, not an error.
    #[tokio::test]
    async fn a_busy_checkpoint_is_refused() {
        let database = TempDatabase::new(2).await;
        let insert = |name: &'static str| {
            sqlx::query(
                "INSERT INTO users (username, password_hash, created_at)
                 VALUES ($1, 'h', '2026-01-01 00:00:00')",
            )
            .bind(name)
        };
        let mut reader = database.pool().acquire().await.unwrap();
        let mut writer = database.pool().acquire().await.unwrap();
        insert("a").execute(&mut *writer).await.unwrap();
        sqlx::query("BEGIN").execute(&mut *reader).await.unwrap();
        let _: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
            .fetch_one(&mut *reader)
            .await
            .unwrap();
        insert("b").execute(&mut *writer).await.unwrap();
        sqlx::query("PRAGMA busy_timeout = 50")
            .execute(&mut *writer)
            .await
            .unwrap();
        let refused = checkpoint(&mut writer).await.err().unwrap_or_default();
        assert!(refused.contains("did not complete"), "{refused}");
        sqlx::query("COMMIT").execute(&mut *reader).await.unwrap();
        checkpoint(&mut writer).await.unwrap();
    }

    /// Two pairs in one book: a settled buy of security 20, and a floating
    /// buy of security 21 that was entered, and last rebuilt, on an earlier
    /// day. Then the lots are rebuilt today.
    async fn floating_fixture(pool: &DbPool) {
        sqlx::raw_sql(
            "INSERT INTO users (id, username, password_hash, created_at)
               VALUES (1, 'u', 'h', '2025-01-01 00:00:00');
             INSERT INTO books (id, user_id, name, created_at, updated_at)
               VALUES (1, 1, 'B', '2025-01-01 00:00:00', '2025-01-01 00:00:00');
             INSERT INTO accounts (id, book_id, name, type, created_at, updated_at) VALUES
               (10, 1, 'Brokerage', 'asset', '2025-01-01 00:00:00', '2025-01-01 00:00:00'),
               (11, 1, 'Cash', 'asset', '2025-01-01 00:00:00', '2025-01-01 00:00:00');
             INSERT INTO securities (id, book_id, name, symbol, security_type, created_at) VALUES
               (20, 1, 'Settled', 'SET', 'stock', '2025-01-01 00:00:00'),
               (21, 1, 'Floating', 'FLT', 'stock', '2025-01-01 00:00:00');
             INSERT INTO transactions (id, book_id, date, is_floating, created_at, updated_at) VALUES
               (30, 1, '2025-01-02', 0, '2025-01-02 00:00:00', '2025-01-02 00:00:00'),
               (31, 1, '2025-01-03', 1, '2025-01-03 00:00:00', '2025-01-03 00:00:00');
             INSERT INTO transaction_splits (book_id, transaction_id, account_id, amount) VALUES
               (1, 30, 10, 1000), (1, 30, 11, -1000), (1, 31, 10, 2000), (1, 31, 11, -2000);
             INSERT INTO investment_splits
               (id, book_id, transaction_id, account_id, security_id, action, shares_micros, price_micros)
               VALUES (40, 1, 30, 10, 20, 'buy', 1000000, 10000000),
                      (41, 1, 31, 10, 21, 'buy', 2000000, 10000000);",
        )
        .execute(pool)
        .await
        .unwrap();
        ledger_db::lots::backfill_lots(pool, true).await.unwrap();
    }

    async fn acquired(pool: &DbPool, security_id: i32) -> Vec<String> {
        sqlx::query_scalar("SELECT acquired_date FROM investment_lots WHERE security_id = $1")
            .bind(security_id)
            .fetch_all(pool)
            .await
            .unwrap()
    }

    const FLOATING: BookPair = (
        1,
        LotPair {
            account_id: 10,
            security_id: 21,
        },
    );
    const SETTLED: BookPair = (
        1,
        LotPair {
            account_id: 10,
            security_id: 20,
        },
    );

    /// A floating buy whose stored lot holds the day of its last rebuild is
    /// valid: the check accepts it and the copy gets a fresh rebuild.
    #[tokio::test]
    async fn a_floating_lot_from_an_earlier_day_is_rebuilt_not_refused() {
        let database = TempDatabase::new(2).await;
        floating_fixture(database.pool()).await;
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        assert_eq!(acquired(database.pool(), 21).await, [today.as_str()]);
        sqlx::query(
            "UPDATE investment_lots SET acquired_date = '2025-01-03' WHERE security_id = 21",
        )
        .execute(database.pool())
        .await
        .unwrap();

        let lots = check_lots(database.pool()).await.unwrap();
        assert_eq!(lots.pairs, 2);
        assert_eq!(lots.floating, [FLOATING]);
        assert!(lots.differing.is_empty(), "{:?}", lots.differing);
        // The check rolls back: the stale lot is still there.
        assert_eq!(acquired(database.pool(), 21).await, ["2025-01-03"]);

        rebuild_pairs(database.pool(), &lots.floating)
            .await
            .unwrap();
        assert_eq!(acquired(database.pool(), 21).await, [today]);
        assert_eq!(acquired(database.pool(), 20).await, ["2025-01-02"]);
    }

    /// A pair with no floating split must still equal a fresh rebuild.
    #[tokio::test]
    async fn a_settled_lot_that_differs_is_refused() {
        let database = TempDatabase::new(2).await;
        floating_fixture(database.pool()).await;
        sqlx::query(
            "UPDATE investment_lots SET remaining_basis_cents = remaining_basis_cents + 1
             WHERE security_id = 20",
        )
        .execute(database.pool())
        .await
        .unwrap();
        let lots = check_lots(database.pool()).await.unwrap();
        assert_eq!(lots.differing, [SETTLED]);
        assert_eq!(lots.floating, [FLOATING]);
    }

    /// A floating stock split of a security changes the order of every pair
    /// that holds it, so those pairs count as floating too.
    #[tokio::test]
    async fn a_floating_stock_split_makes_its_pairs_floating() {
        let database = TempDatabase::new(2).await;
        floating_fixture(database.pool()).await;
        sqlx::raw_sql(
            "INSERT INTO transactions (id, book_id, date, is_floating, created_at, updated_at)
               VALUES (32, 1, '2025-01-04', 1, '2025-01-04 00:00:00', '2025-01-04 00:00:00');
             INSERT INTO investment_splits
               (book_id, transaction_id, account_id, security_id, action, shares_micros,
                price_micros, split_numerator, split_denominator)
               VALUES (1, 32, NULL, 20, 'split', 0, 0, 2, 1);",
        )
        .execute(database.pool())
        .await
        .unwrap();
        ledger_db::lots::backfill_lots(database.pool(), true)
            .await
            .unwrap();
        let lots = check_lots(database.pool()).await.unwrap();
        assert_eq!(lots.floating, [SETTLED, FLOATING]);
        assert!(lots.differing.is_empty());
    }

    /// A table that the baseline adds and `TABLES` does not name is not
    /// copied. `change_marks` and `transaction_changes` are derived state:
    /// the converter clears them. The OAuth tables (migration 0004) came
    /// after the last PostgreSQL release, so the source has none.
    #[tokio::test]
    async fn tables_names_every_table_of_the_baseline() {
        let database = TempDatabase::new(1).await;
        let mut baseline: Vec<String> = sqlx::query_scalar(
            "SELECT name FROM sqlite_master WHERE type = 'table'
               AND substr(name, 1, 7) <> 'sqlite_'
               AND substr(name, 1, 6) <> 'oauth_'
               AND name NOT IN ('_sqlx_migrations', 'change_marks', 'transaction_changes')",
        )
        .fetch_all(database.pool())
        .await
        .unwrap();
        baseline.sort();
        let mut named: Vec<String> = TABLES.iter().map(|name| (*name).to_owned()).collect();
        named.sort();
        assert_eq!(named, baseline);
    }
}
