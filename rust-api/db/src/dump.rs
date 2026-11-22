//! A portable dump of the database: the applied migrations and the rows of
//! every table, as one JSON document. A Durable Object has no `VACUUM INTO`
//! and no file, so this is how the data moves between a native file and an
//! object, in either direction, and how an object is backed up.
//!
//! The dump holds no DDL: the loader builds the schema from its own
//! migration files, up to the last migration that the dump has, loads the
//! rows, and then applies the rest. A dump from an older release thus loads
//! into a newer one. A dump with a migration that the loader does not have,
//! or with another checksum, is refused.
//!
//! The format, version [`FORMAT`]:
//!
//! ```json
//! {"format": 1,
//!  "migrations": [{"version": 1, "checksum": "<SHA-384 hex>"}, ...],
//!  "tables": [{"name": "accounts", "columns": ["id", ...], "rows": [[1, ...], ...]}, ...]}
//! ```
//!
//! A value is a JSON integer, number, string or null, as SQLite stored it.
//! `sqlite_sequence` is a table of the dump too, so a loaded file does not
//! give again an ID that the source gave and then deleted.

use crate::{
    Database,
    migrations::{MIGRATIONS, MigrateError, Migration, migrate_with},
    store::{Error, Sql, Transaction, Value, params},
};
use serde::Deserialize;
use serde_json::{Value as Json, json, value::RawValue};
use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::ops::ControlFlow;

/// The version of the format that [`dump`] writes and [`load`] reads.
pub const FORMAT: i64 = 1;

/// The most bytes of JSON rows that one insert binds. A Durable Object
/// takes a bound value of up to 2 MB.
const CHUNK_BYTES: usize = 512 * 1024;

/// Tables that a dump leaves out: the runner's own record, which the
/// loader writes as it migrates, and the record of the sqlx releases.
const SKIPPED: [&str; 2] = ["schema_migrations", "_sqlx_migrations"];

const SEQUENCE: &str = "sqlite_sequence";

#[derive(Debug)]
pub enum DumpError {
    Database(Error),
    /// The dump is not one that this loader can read, or does not fit the
    /// schema.
    Invalid(String),
    /// The target already has rows.
    NotEmpty(String),
    Migrate(MigrateError),
}

impl fmt::Display for DumpError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Database(cause) => write!(f, "{cause}"),
            Self::Invalid(message) => write!(f, "invalid dump: {message}"),
            Self::NotEmpty(table) => write!(f, "the target is not empty: {table} has rows"),
            Self::Migrate(cause) => write!(f, "{cause}"),
        }
    }
}

impl std::error::Error for DumpError {}

impl From<Error> for DumpError {
    fn from(cause: Error) -> Self {
        Self::Database(cause)
    }
}

impl From<MigrateError> for DumpError {
    fn from(cause: MigrateError) -> Self {
        Self::Migrate(cause)
    }
}

fn invalid(message: impl Into<String>) -> DumpError {
    DumpError::Invalid(message.into())
}

/// The names of the tables of the schema that a dump holds, in name order:
/// every table but SQLite's own and [`SKIPPED`]. `sqlite_sequence` is
/// listed apart.
fn tables(sql: &impl Sql) -> Result<Vec<String>, Error> {
    let names: Vec<String> = sql.query(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
         ORDER BY name",
        &[],
    )?;
    Ok(names
        .into_iter()
        .filter(|name| !SKIPPED.contains(&name.as_str()) && !runtime_table(name))
        .collect())
}

/// A table of the Durable Object runtime in the object's file: Cloudflare
/// keeps `_cf_KV` and `_cf_METADATA`, and refuses to let them be read, and
/// `wrangler dev` adds `__miniflare_do_name`. None is the app's data.
fn runtime_table(name: &str) -> bool {
    name.starts_with("_cf_") || name.starts_with("__miniflare_")
}

fn columns(sql: &impl Sql, table: &str) -> Result<Vec<String>, Error> {
    sql.query(
        "SELECT name FROM pragma_table_info(?1) ORDER BY cid",
        &params![table],
    )
}

/// The primary key of `table`, else its `rowid`: an order that the same
/// rows always give.
fn order_of(sql: &impl Sql, table: &str) -> Result<String, Error> {
    let key: Vec<String> = sql.query(
        "SELECT name FROM pragma_table_info(?1) WHERE pk > 0 ORDER BY pk",
        &params![table],
    )?;
    Ok(if key.is_empty() {
        "rowid".to_owned()
    } else {
        key.iter()
            .map(|column| quoted(column))
            .collect::<Vec<_>>()
            .join(", ")
    })
}

fn quoted(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn to_json(value: Value, table: &str, column: &str) -> Result<Json, DumpError> {
    Ok(match value {
        Value::Null => Json::Null,
        Value::Integer(integer) => json!(integer),
        Value::Real(real) => serde_json::Number::from_f64(real)
            .map(Json::Number)
            .ok_or_else(|| invalid(format!("{table}.{column} holds {real}")))?,
        Value::Text(text) => Json::String(text),
        Value::Blob(_) => return Err(invalid(format!("{table}.{column} holds a blob"))),
    })
}

/// The dump of the database that `sql` reads. Run it in a read transaction,
/// so that every table comes from one snapshot.
pub fn dump(sql: &impl Sql) -> Result<Json, DumpError> {
    let text = dump_json(sql)?;
    serde_json::from_slice(&text).map_err(|cause| invalid(format!("the dump is not JSON: {cause}")))
}

/// The dump of the database that `sql` reads, as JSON text, written a row at
/// a time: a Durable Object has 128 MB for all of its memory, and a tree of
/// JSON values takes several times the size of its text. Run it in a read
/// transaction, so that every table comes from one snapshot.
pub fn dump_json(sql: &impl Sql) -> Result<Vec<u8>, DumpError> {
    let migrations: Vec<(i64, Vec<u8>)> = sql.query(
        "SELECT version, checksum FROM schema_migrations ORDER BY version",
        &[],
    )?;
    let mut out = Vec::new();
    out.extend_from_slice(format!("{{\"format\":{FORMAT},\"migrations\":").as_bytes());
    write_value(
        &mut out,
        &migrations
            .iter()
            .map(|(version, checksum)| json!({"version": version, "checksum": hex(checksum)}))
            .collect::<Vec<_>>(),
    );
    out.extend_from_slice(b",\"tables\":[");
    let mut names = tables(sql)?;
    names.push(SEQUENCE.to_owned());
    for (index, table) in names.iter().enumerate() {
        let columns = if table == SEQUENCE {
            vec!["name".to_owned(), "seq".to_owned()]
        } else {
            columns(sql, table)?
        };
        let order = if table == SEQUENCE {
            "name".to_owned()
        } else {
            order_of(sql, table)?
        };
        if index > 0 {
            out.push(b',');
        }
        out.extend_from_slice(b"{\"name\":");
        write_value(&mut out, table);
        out.extend_from_slice(b",\"columns\":");
        write_value(&mut out, &columns);
        out.extend_from_slice(b",\"rows\":[");
        let mut first = true;
        let mut failed = None;
        sql.for_each_row(
            &format!(
                "SELECT {} FROM {} ORDER BY {order}",
                columns
                    .iter()
                    .map(|column| quoted(column))
                    .collect::<Vec<_>>()
                    .join(", "),
                quoted(table)
            ),
            &[],
            &mut |row| {
                let mut values = Vec::with_capacity(columns.len());
                for (index, column) in columns.iter().enumerate() {
                    match to_json(row.get::<Value>(index)?, table, column) {
                        Ok(value) => values.push(value),
                        Err(cause) => {
                            failed = Some(cause);
                            return Ok(ControlFlow::Break(()));
                        }
                    }
                }
                if !first {
                    out.push(b',');
                }
                first = false;
                write_value(&mut out, &values);
                Ok(ControlFlow::Continue(()))
            },
        )?;
        if let Some(cause) = failed {
            return Err(cause);
        }
        out.extend_from_slice(b"]}");
    }
    out.extend_from_slice(b"]}");
    Ok(out)
}

/// Appends `value` as JSON. Writing into a `Vec` does not fail, and these
/// values are strings, numbers and arrays of them.
fn write_value(out: &mut Vec<u8>, value: &impl serde::Serialize) {
    serde_json::to_writer(out, value).expect("a JSON value writes into memory");
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// A dump as its text holds it. Each row stays the text that it is in the
/// dump: a tree of JSON values takes several times the memory of its text,
/// and a Durable Object has 128 MB in all.
#[derive(Deserialize)]
struct Document<'a> {
    format: Option<i64>,
    #[serde(borrow)]
    migrations: Option<Vec<Listed<'a>>>,
    #[serde(borrow)]
    tables: Option<Vec<Dumped<'a>>>,
}

#[derive(Deserialize)]
struct Listed<'a> {
    version: Option<i64>,
    #[serde(borrow)]
    checksum: Option<Cow<'a, str>>,
}

#[derive(Deserialize)]
struct Dumped<'a> {
    #[serde(borrow)]
    name: Option<Cow<'a, str>>,
    #[serde(borrow)]
    columns: Option<Vec<Cow<'a, str>>>,
    #[serde(borrow)]
    rows: Option<Vec<&'a RawValue>>,
}

/// One table of a dump, as [`parse`] reads it.
struct Table<'a> {
    name: &'a str,
    columns: Vec<&'a str>,
    rows: &'a [&'a RawValue],
}

/// Reads the text of a dump.
fn document(text: &str) -> Result<Document<'_>, DumpError> {
    serde_json::from_str(text).map_err(|cause| invalid(format!("it is not a dump: {cause}")))
}

/// The migrations of `dump` as files of this build, and its tables. Refuses
/// a format, a migration or a checksum that this build does not have.
fn parse<'a>(dump: &'a Document<'a>) -> Result<(&'static [Migration], Vec<Table<'a>>), DumpError> {
    let format = dump.format;
    if format != Some(FORMAT) {
        return Err(invalid(format!(
            "format {} is not {FORMAT}",
            format.map_or_else(|| "missing".to_owned(), |format| format.to_string())
        )));
    }
    let listed = dump
        .migrations
        .as_ref()
        .ok_or_else(|| invalid("no migrations"))?;
    if listed.len() > MIGRATIONS.len() {
        return Err(invalid(format!(
            "it has {} migrations; this build has {}",
            listed.len(),
            MIGRATIONS.len()
        )));
    }
    for (entry, file) in listed.iter().zip(MIGRATIONS) {
        if entry.version != Some(file.version)
            || entry.checksum.as_deref() != Some(&hex(&file.checksum()))
        {
            return Err(invalid(format!(
                "migration {} does not match this build's {}",
                entry
                    .version
                    .map_or_else(|| "?".to_owned(), |version| version.to_string()),
                file.version
            )));
        }
    }
    let tables = dump
        .tables
        .as_ref()
        .ok_or_else(|| invalid("no tables"))?
        .iter()
        .map(|table| {
            let name = table
                .name
                .as_deref()
                .ok_or_else(|| invalid("a table without a name"))?;
            let columns = table
                .columns
                .as_ref()
                .map(|columns| columns.iter().map(|column| column.as_ref()).collect())
                .ok_or_else(|| invalid(format!("{name} has no columns")))?;
            let rows = table
                .rows
                .as_deref()
                .ok_or_else(|| invalid(format!("{name} has no rows")))?;
            Ok(Table {
                name,
                columns,
                rows,
            })
        })
        .collect::<Result<Vec<_>, DumpError>>()?;
    Ok((&MIGRATIONS[..listed.len()], tables))
}

/// The tables in an order where each comes after the tables that its
/// foreign keys name. A table that names itself (an account's parent) does
/// not wait for itself.
fn foreign_key_order(sql: &impl Sql, names: &[String]) -> Result<Vec<String>, Error> {
    let mut parents: HashMap<&str, HashSet<String>> = HashMap::new();
    for name in names {
        let referenced: Vec<String> = sql.query(
            "SELECT DISTINCT \"table\" FROM pragma_foreign_key_list(?1)",
            &params![name.as_str()],
        )?;
        parents.insert(
            name,
            referenced
                .into_iter()
                .filter(|parent| parent != name)
                .collect(),
        );
    }
    let mut ordered: Vec<String> = Vec::new();
    while ordered.len() < names.len() {
        let next = names
            .iter()
            .filter(|name| !ordered.contains(name))
            .find(|name| {
                parents[name.as_str()]
                    .iter()
                    .all(|parent| ordered.contains(parent))
            })
            .ok_or_else(|| Error::Invalid("the foreign keys form a cycle".to_owned()))?;
        ordered.push(next.clone());
    }
    Ok(ordered)
}

/// What [`load`] wrote.
#[derive(Debug, Default, PartialEq)]
pub struct Loaded {
    pub tables: usize,
    pub rows: usize,
}

/// Loads `dump` into `tx`, a database whose schema is at the dump's last
/// migration and which has no rows: only the floor marker that migration 3
/// writes, which the dump's own log replaces.
///
/// The triggers are dropped while the rows go in and made again after, so
/// that they neither write the change logs again nor add a book's owner a
/// second time. The rows go in by table in foreign-key order, each table in
/// inserts of one JSON parameter. Then the loader checks the foreign keys,
/// and adds a floor marker to the change log, as a restore of a backup does,
/// so that a native client downloads its book again.
fn load_rows(
    tx: &Transaction<'_>,
    tables_in: &[Table<'_>],
    chunk_bytes: usize,
) -> Result<Loaded, DumpError> {
    let names = tables(tx)?;
    let dumped: HashMap<&str, &Table<'_>> =
        tables_in.iter().map(|table| (table.name, table)).collect();
    for table in tables_in {
        if table.name != SEQUENCE && !names.iter().any(|name| name == table.name) {
            return Err(invalid(format!("this schema has no table {}", table.name)));
        }
    }
    for name in &names {
        let rows: i64 = tx.query_row(
            &format!(
                "SELECT COUNT(*) FROM {} {}",
                quoted(name),
                if name == "transaction_changes" {
                    format!("WHERE book_id <> {}", crate::sync_floor::SYNC_FLOOR_BOOK_ID)
                } else {
                    String::new()
                }
            ),
            &[],
        )?;
        if rows > 0 {
            return Err(DumpError::NotEmpty(name.clone()));
        }
        if !dumped.contains_key(name.as_str()) {
            return Err(invalid(format!("it has no table {name}")));
        }
    }
    tx.execute("DELETE FROM transaction_changes", &[])?;

    // The AFTER triggers write the change marks, the change log and a
    // book's owner row, which the dump already holds, so they stay off
    // while the rows go in. The BEFORE triggers stay on: they refuse a row
    // that names another book's row, which no foreign key catches.
    let triggers: Vec<(String, String)> = tx
        .query::<(String, String)>(
            "SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' ORDER BY name",
            &[],
        )?
        .into_iter()
        .filter(|(_, sql)| is_after_trigger(sql))
        .collect();
    for (name, _) in &triggers {
        tx.exec_batch(&format!("DROP TRIGGER {}", quoted(name)))?;
    }

    // The table order puts each parent table first, but a table that names
    // itself (an account's parent) can hold a child row before its parent,
    // in another chunk. The checks wait for the commit; the check below
    // reports a row that is still missing its parent.
    tx.exec_batch("PRAGMA defer_foreign_keys = ON")?;
    let mut loaded = Loaded::default();
    for name in foreign_key_order(tx, &names)? {
        let table = dumped[name.as_str()];
        let target = columns(tx, &name)?;
        let mut given: Vec<&str> = table.columns.clone();
        given.sort_unstable();
        let mut wanted: Vec<&str> = target.iter().map(String::as_str).collect();
        wanted.sort_unstable();
        if given != wanted {
            return Err(invalid(format!(
                "the columns of {name} are not this schema's"
            )));
        }
        insert_rows(tx, table, chunk_bytes)?;
        loaded.tables += 1;
        loaded.rows += table.rows.len();
    }
    // Without the sequence, SQLite would start each AUTOINCREMENT from the
    // largest ID left, and could hand out again an ID that was deleted.
    let sequence = dumped
        .get(SEQUENCE)
        .ok_or_else(|| invalid(format!("it has no table {SEQUENCE}")))?;
    tx.execute("DELETE FROM sqlite_sequence", &[])?;
    insert_rows(tx, sequence, chunk_bytes)?;

    for (_, sql) in &triggers {
        tx.exec_batch(sql)?;
    }
    let violation: Option<String> = tx.query_optional(
        "SELECT \"table\" FROM pragma_foreign_key_check LIMIT 1",
        &[],
    )?;
    if let Some(table) = violation {
        return Err(invalid(format!("a row of {table} names a missing row")));
    }
    crate::sync_floor::insert(tx)?;
    Ok(loaded)
}

/// True for `CREATE TRIGGER name AFTER ...`.
fn is_after_trigger(sql: &str) -> bool {
    sql.split_whitespace()
        .nth(3)
        .is_some_and(|word| word.eq_ignore_ascii_case("AFTER"))
}

/// Inserts the rows of `table`, in chunks of up to `chunk_bytes`.
fn insert_rows(
    tx: &Transaction<'_>,
    table: &Table<'_>,
    chunk_bytes: usize,
) -> Result<(), DumpError> {
    let width = table.columns.len();
    let picks: Vec<String> = (0..width).map(|index| format!("#{index}")).collect();
    let picks: Vec<&str> = picks.iter().map(String::as_str).collect();
    let insert = format!(
        "INSERT INTO {} ({}) {}",
        quoted(table.name),
        table
            .columns
            .iter()
            .map(|column| quoted(column))
            .collect::<Vec<_>>()
            .join(", "),
        crate::sql::json_rows(&picks, "?1")
    );
    let mut chunk = String::from("[");
    let flush = |chunk: &mut String| -> Result<(), DumpError> {
        if chunk.len() > 1 {
            chunk.push(']');
            tx.execute(&insert, &params![chunk.as_str()])?;
        }
        *chunk = String::from("[");
        Ok(())
    };
    for row in table.rows {
        // One row at a time: its values, to check, and then its text.
        let values = serde_json::from_str::<Vec<Json>>(row.get())
            .ok()
            .filter(|values| values.len() == width)
            .ok_or_else(|| invalid(format!("a row of {} has the wrong width", table.name)))?;
        if values
            .iter()
            .any(|value| value.is_array() || value.is_object())
        {
            return Err(invalid(format!("a row of {} holds a list", table.name)));
        }
        let text = row.get();
        if chunk.len() > 1 && chunk.len() + text.len() > chunk_bytes {
            flush(&mut chunk)?;
        }
        if chunk.len() > 1 {
            chunk.push(',');
        }
        chunk.push_str(text);
    }
    flush(&mut chunk)
}

/// Loads `dump` into `database`, a file that has no schema yet: it applies
/// the dump's migrations, loads the rows in one write transaction, and then
/// applies the migrations that the dump does not have.
pub fn load(database: &Database, dump: &str) -> Result<Loaded, DumpError> {
    load_in_chunks(database, dump, CHUNK_BYTES)
}

fn load_in_chunks(
    database: &Database,
    dump: &str,
    chunk_bytes: usize,
) -> Result<Loaded, DumpError> {
    let document = document(dump)?;
    let (migrations, tables) = parse(&document)?;
    let applied: i64 = database.query_row(
        "SELECT COUNT(*) FROM sqlite_schema WHERE name = 'schema_migrations'",
        &[],
    )?;
    if applied > 0 {
        return Err(DumpError::NotEmpty("schema_migrations".to_owned()));
    }
    migrate_with(database, migrations)?;
    let loaded = database.transaction(|tx| load_rows(tx, &tables, chunk_bytes))?;
    crate::migrate(database)?;
    Ok(loaded)
}

/// Loads `dump` into `database`, whose schema is already at this build's
/// last migration: the file of a Durable Object, which migrates when it
/// starts. The dump must be at the same migration. `database` must hold no
/// user and no book; the rows that a started server writes with neither
/// (the job records, the rate limits) are cleared first. All of it is one
/// write transaction, so a dump that fails leaves `database` as it was.
pub fn import(database: &Database, dump: &str) -> Result<Loaded, DumpError> {
    let document = document(dump)?;
    let (migrations, dumped) = parse(&document)?;
    let applied: i64 = database.query_row("SELECT COUNT(*) FROM schema_migrations", &[])?;
    if usize::try_from(applied).ok() != Some(migrations.len()) {
        return Err(invalid(format!(
            "it has {} migrations; this server has applied {applied}. Load it into a file \
             with `ledger-cli load`, start that file's server once, and dump it again",
            migrations.len()
        )));
    }
    database.transaction(|tx| {
        for owner in ["users", "books"] {
            let rows: i64 = tx.query_row(&format!("SELECT COUNT(*) FROM {owner}"), &[])?;
            if rows > 0 {
                return Err(DumpError::NotEmpty(owner.to_owned()));
            }
        }
        empty(tx)?;
        load_rows(tx, &dumped, CHUNK_BYTES)
    })
}

/// Removes every row of every table that a dump holds, in one write
/// transaction: the undoing of an [`import`] whose rows the server could
/// not then ready, so that the file is empty again and takes another dump.
pub fn clear(database: &Database) -> Result<(), Error> {
    database.transaction(empty)
}

fn empty(tx: &Transaction<'_>) -> Result<(), Error> {
    tx.exec_batch("PRAGMA defer_foreign_keys = ON")?;
    for name in tables(tx)? {
        tx.execute(&format!("DELETE FROM {}", quoted(&name)), &[])?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TempDatabase;

    fn seeded() -> TempDatabase {
        let file = TempDatabase::new();
        let database = file.database();
        database
            .exec_batch(
                "INSERT INTO users (id, username, password_hash, created_at)
                   VALUES (1, 'u', 'h', '2025-01-01 00:00:00');
                 INSERT INTO books (id, user_id, name, created_at, updated_at)
                   VALUES (1, 1, 'B', '2025-01-01 00:00:00', '2025-01-01 00:00:00');",
            )
            .unwrap();
        database
            .transaction(|tx| {
                crate::seed::seed_book(
                    tx,
                    1,
                    crate::seed::DemoDataset::Household,
                    chrono::NaiveDate::from_ymd_opt(2026, 9, 15).unwrap(),
                    &mut |_| {},
                )
            })
            .unwrap();
        // A deleted row leaves its ID behind in sqlite_sequence.
        database
            .exec_batch(
                "INSERT INTO payees (book_id, name, created_at) VALUES (1, 'Gone', '2025-01-01 00:00:00');
                 DELETE FROM payees WHERE name = 'Gone';",
            )
            .unwrap();
        file
    }

    fn table<'a>(dump: &'a Json, name: &str) -> &'a Json {
        dump["tables"]
            .as_array()
            .unwrap()
            .iter()
            .find(|table| table["name"] == name)
            .unwrap()
    }

    fn empty_file() -> (Database, std::path::PathBuf) {
        let path = std::env::temp_dir().join(format!(
            "counterpoise-load-{}-{}.db",
            std::process::id(),
            rand_suffix()
        ));
        let _ = std::fs::remove_file(&path);
        (Database::open(&path, true).unwrap(), path)
    }

    fn rand_suffix() -> u64 {
        use std::sync::atomic::{AtomicU64, Ordering};
        static NEXT: AtomicU64 = AtomicU64::new(0);
        NEXT.fetch_add(1, Ordering::Relaxed)
    }

    /// An account can sort before its parent. With one row in each chunk,
    /// the child's insert runs before the parent's, and the load still
    /// succeeds; a row whose parent is missing is still refused.
    #[test]
    fn a_child_row_may_come_before_its_parent() {
        let source = seeded();
        source
            .database()
            .exec_batch(
                "INSERT INTO accounts (id, book_id, name, type, parent_id, created_at, updated_at)
                   VALUES (9001, 1, 'Parent', 'asset', NULL, '2025-01-01', '2025-01-01');
                 INSERT INTO accounts (id, book_id, name, type, parent_id, created_at, updated_at)
                   VALUES (9000, 1, 'Child', 'asset', 9001, '2025-01-01', '2025-01-01');",
            )
            .unwrap();
        let dump = source.database().read_transaction(|tx| dump(tx)).unwrap();
        let (target, path) = empty_file();
        load_in_chunks(&target, &dump.to_string(), 1).unwrap();
        let parent: Option<i64> = target
            .query_row("SELECT parent_id FROM accounts WHERE id = 9000", &[])
            .unwrap();
        assert_eq!(parent, Some(9001));
        drop(target);
        let _ = std::fs::remove_file(&path);

        let mut orphan = dump.clone();
        let accounts = orphan["tables"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|table| table["name"] == "accounts")
            .unwrap();
        let rows = accounts["rows"].as_array_mut().unwrap();
        rows.retain(|row| row[0] != 9001);
        let (target, path) = empty_file();
        let refused = load_in_chunks(&target, &orphan.to_string(), 1).unwrap_err();
        assert!(refused.to_string().contains("accounts"), "{refused}");
        drop(target);
        let _ = std::fs::remove_file(&path);
    }

    /// A transaction that names another book's payee passes the foreign
    /// key, which has one column. The book check of the schema's triggers
    /// still refuses it during a load.
    #[test]
    fn a_row_that_names_another_books_row_is_refused() {
        let source = seeded();
        source
            .database()
            .exec_batch(
                "INSERT INTO books (id, user_id, name, created_at, updated_at)
                   VALUES (2, 1, 'Other', '2025-01-01 00:00:00', '2025-01-01 00:00:00');
                 INSERT INTO payees (id, book_id, name, created_at)
                   VALUES (9000, 2, 'Elsewhere', '2025-01-01 00:00:00');",
            )
            .unwrap();
        let mut dump = source.database().read_transaction(|tx| dump(tx)).unwrap();
        let transactions = dump["tables"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|table| table["name"] == "transactions")
            .unwrap();
        let column = transactions["columns"]
            .as_array()
            .unwrap()
            .iter()
            .position(|column| column == "payee_id")
            .unwrap();
        transactions["rows"][0][column] = json!(9000);
        let (target, path) = empty_file();
        let refused = load(&target, &dump.to_string()).unwrap_err();
        assert!(refused.to_string().contains("payee"), "{refused}");
        drop(target);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_dump_without_the_sequence_is_refused() {
        let source = seeded();
        let mut dump = source.database().read_transaction(|tx| dump(tx)).unwrap();
        dump["tables"]
            .as_array_mut()
            .unwrap()
            .retain(|table| table["name"] != SEQUENCE);
        let (target, path) = empty_file();
        let refused = load(&target, &dump.to_string()).unwrap_err();
        assert!(refused.to_string().contains(SEQUENCE), "{refused}");
        drop(target);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn only_after_triggers_are_dropped() {
        assert!(is_after_trigger(
            "CREATE TRIGGER t_mark AFTER INSERT ON t BEGIN SELECT 1; END"
        ));
        assert!(!is_after_trigger(
            "CREATE TRIGGER t_in_book BEFORE INSERT ON t WHEN 1 BEGIN SELECT 1; END"
        ));
    }

    #[test]
    fn the_tables_of_the_object_runtime_are_left_out() {
        let file = crate::testing::TempDatabase::new();
        let database = file.database();
        database
            .exec_batch(
                "CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value BLOB);
                 CREATE TABLE __miniflare_do_name (name TEXT);
                 INSERT INTO __miniflare_do_name VALUES ('ledger');",
            )
            .unwrap();
        let names: Vec<String> = dump(database).unwrap()["tables"]
            .as_array()
            .unwrap()
            .iter()
            .map(|table| table["name"].as_str().unwrap().to_owned())
            .collect();
        assert!(names.contains(&"accounts".to_owned()), "{names:?}");
        assert!(!names.iter().any(|name| runtime_table(name)), "{names:?}");
    }

    #[test]
    fn a_value_with_no_json_form_stops_the_dump() {
        let file = crate::testing::TempDatabase::new();
        file.database()
            .exec_batch("CREATE TABLE notes (id INTEGER PRIMARY KEY, body); INSERT INTO notes VALUES (1, 'a'), (2, x'00');")
            .unwrap();
        let refused = dump_json(file.database()).unwrap_err();
        assert!(
            refused.to_string().contains("notes.body holds a blob"),
            "{refused}"
        );
    }

    /// A migrated database with no user takes a dump of the same migration,
    /// and dumps it again.
    #[test]
    fn a_started_database_with_no_user_imports_a_dump() {
        let source = seeded();
        let text = String::from_utf8(dump_json(source.database()).unwrap()).unwrap();
        let target = TempDatabase::new();
        // A started server's own rows, which the import clears.
        target
            .database()
            .exec_batch("INSERT INTO job_requests (job, requested_at) VALUES ('prune', '2026-10-22 00:00:00')")
            .unwrap();
        let loaded = import(target.database(), &text).unwrap();
        assert!(loaded.rows > 0, "{loaded:?}");
        let again = dump(target.database()).unwrap();
        for name in [
            "accounts",
            "transactions",
            "transaction_splits",
            "job_requests",
        ] {
            assert_eq!(
                table(&again, name)["rows"],
                table(&dump(source.database()).unwrap(), name)["rows"],
                "{name}"
            );
        }
    }

    #[test]
    fn an_import_refuses_a_user_and_a_dump_of_another_migration() {
        let source = seeded();
        let text = String::from_utf8(dump_json(source.database()).unwrap()).unwrap();
        assert!(matches!(
            import(source.database(), &text),
            Err(DumpError::NotEmpty(table)) if table == "users"
        ));

        let mut older: Json = serde_json::from_str(&text).unwrap();
        older["migrations"].as_array_mut().unwrap().pop();
        let target = TempDatabase::new();
        let refused = import(target.database(), &older.to_string()).unwrap_err();
        assert!(refused.to_string().contains("ledger-cli load"), "{refused}");
    }

    /// A row that names a missing row fails the import at its end, and the
    /// rows that went in before it are gone with it.
    #[test]
    fn a_failed_import_leaves_the_database_as_it_was() {
        let source = seeded();
        let mut broken: Json = serde_json::from_str(
            &String::from_utf8(dump_json(source.database()).unwrap()).unwrap(),
        )
        .unwrap();
        let splits = broken["tables"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|table| table["name"] == "transaction_splits")
            .unwrap();
        let account = splits["columns"]
            .as_array()
            .unwrap()
            .iter()
            .position(|column| column == "account_id")
            .unwrap();
        splits["rows"][0][account] = json!(9000);
        let target = TempDatabase::new();
        target
            .database()
            .exec_batch("INSERT INTO job_requests (job, requested_at) VALUES ('prune', '2026-10-22 00:00:00')")
            .unwrap();
        let refused = import(target.database(), &broken.to_string()).unwrap_err();
        assert!(
            refused.to_string().contains("names a missing row"),
            "{refused}"
        );
        let left: i64 = target
            .database()
            .query_row(
                "SELECT (SELECT COUNT(*) FROM accounts) + (SELECT COUNT(*) FROM job_requests)",
                &[],
            )
            .unwrap();
        assert_eq!(left, 1, "only the job request that was there before");
    }

    #[test]
    fn a_cleared_import_takes_the_dump_again() {
        let source = seeded();
        let text = String::from_utf8(dump_json(source.database()).unwrap()).unwrap();
        let target = TempDatabase::new();
        let first = import(target.database(), &text).unwrap();
        clear(target.database()).unwrap();
        let users: i64 = target
            .database()
            .query_row("SELECT COUNT(*) FROM users", &[])
            .unwrap();
        assert_eq!(users, 0);
        let again = import(target.database(), &text).unwrap();
        assert_eq!((again.tables, again.rows), (first.tables, first.rows));
    }

    /// A loaded dump gives the same dump again, but for the floor marker
    /// that the load adds, and every book's balances and lots with it.
    #[test]
    fn a_loaded_dump_dumps_the_same_rows() {
        let source = seeded();
        let first = source.database().read_transaction(|tx| dump(tx)).unwrap();
        let (target, path) = empty_file();
        let loaded = load(&target, &first.to_string()).unwrap();
        assert!(loaded.rows > 1_000, "{loaded:?}");
        let mut second = target.read_transaction(|tx| dump(tx)).unwrap();

        // The load adds one floor marker above the dump's newest change.
        let changes = second["tables"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|table| table["name"] == "transaction_changes")
            .unwrap();
        let rows = changes["rows"].as_array_mut().unwrap();
        let marker = rows.pop().unwrap();
        assert_eq!(marker[1], json!(crate::sync_floor::SYNC_FLOOR_BOOK_ID));
        // And its sequence moves with it.
        let sequence = second["tables"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|table| table["name"] == SEQUENCE)
            .unwrap();
        let entry = sequence["rows"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|row| row[0] == "transaction_changes")
            .unwrap();
        assert_eq!(entry[1], marker[0]);
        entry[1] = table(&first, SEQUENCE)["rows"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row[0] == "transaction_changes")
            .unwrap()[1]
            .clone();
        assert_eq!(first, second);

        let sequence = table(&second, SEQUENCE)["rows"].as_array().unwrap().clone();
        let payees = sequence.iter().find(|row| row[0] == "payees").unwrap();
        let max_id: i64 = target.query_row("SELECT MAX(id) FROM payees", &[]).unwrap();
        assert_eq!(payees[1], json!(max_id + 1), "the deleted ID stays used");
        // The triggers are back: a new row writes the change log.
        let before: i64 = target
            .query_row("SELECT COUNT(*) FROM transaction_changes", &[])
            .unwrap();
        target
            .exec_batch(
                "INSERT INTO transactions (book_id, date, created_at, updated_at)
                 VALUES (1, '2026-09-16', '2026-09-16 00:00:00', '2026-09-16 00:00:00')",
            )
            .unwrap();
        let after: i64 = target
            .query_row("SELECT COUNT(*) FROM transaction_changes", &[])
            .unwrap();
        assert_eq!(after, before + 1);
        drop(target);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn a_dump_with_an_unknown_migration_is_refused() {
        let source = seeded();
        let mut first = source.database().read_transaction(|tx| dump(tx)).unwrap();
        first["migrations"][0]["checksum"] = json!("00");
        let (target, path) = empty_file();
        let error = load(&target, &first.to_string()).unwrap_err().to_string();
        assert!(error.contains("migration 1 does not match"), "{error}");
        drop(target);
        let _ = std::fs::remove_file(path);
    }

    /// A dump from a release with fewer migrations loads, and the loader
    /// then applies the rest.
    #[test]
    fn an_older_dump_loads_and_then_migrates() {
        let source = seeded();
        let mut first = source.database().read_transaction(|tx| dump(tx)).unwrap();
        // Migration 16 made the rate limits table, and 17 replaced an index.
        // A dump from before 16 has neither their rows nor the table.
        let rate_limits = MIGRATIONS.iter().find(|m| m.version == 16).unwrap();
        assert!(
            rate_limits.sql.contains("rate_limits"),
            "{}",
            rate_limits.description
        );
        first["migrations"]
            .as_array_mut()
            .unwrap()
            .retain(|migration| migration["version"].as_i64().unwrap() < 16);
        first["tables"]
            .as_array_mut()
            .unwrap()
            .retain(|table| table["name"] != "rate_limits");
        // Migration 18 added `job_slots.attempts`, the last column. The
        // older dump does not have it.
        let slots = first["tables"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|table| table["name"] == "job_slots")
            .unwrap();
        assert_eq!(
            slots["columns"].as_array_mut().unwrap().pop(),
            Some(json!("attempts"))
        );
        for row in slots["rows"].as_array_mut().unwrap() {
            row.as_array_mut().unwrap().pop();
        }
        // Migration 20 added `plaid_transaction_reconciliation.linked_account_id`,
        // the last column.
        let staged = first["tables"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|table| table["name"] == "plaid_transaction_reconciliation")
            .unwrap();
        assert_eq!(
            staged["columns"].as_array_mut().unwrap().pop(),
            Some(json!("linked_account_id"))
        );
        for row in staged["rows"].as_array_mut().unwrap() {
            row.as_array_mut().unwrap().pop();
        }
        let (target, path) = empty_file();
        load(&target, &first.to_string()).unwrap();
        let attempts: i64 = target
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('job_slots') WHERE name = 'attempts'",
                &[],
            )
            .unwrap();
        assert_eq!(attempts, 1);
        let linked_account: i64 = target
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('plaid_transaction_reconciliation')
                 WHERE name = 'linked_account_id'",
                &[],
            )
            .unwrap();
        assert_eq!(linked_account, 1);
        let versions: i64 = target
            .query_row("SELECT COUNT(*) FROM schema_migrations", &[])
            .unwrap();
        assert_eq!(versions, MIGRATIONS.len() as i64);
        let covering: i64 = target
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type = 'index' AND name = 'idx_transactions_payee_date_id_floating'",
                &[],
            )
            .unwrap();
        assert_eq!(covering, 1);
        drop(target);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn a_file_with_rows_is_refused() {
        let source = seeded();
        let first = source.database().read_transaction(|tx| dump(tx)).unwrap();
        let error = load(source.database(), &first.to_string())
            .unwrap_err()
            .to_string();
        assert!(error.contains("not empty"), "{error}");
    }
}
