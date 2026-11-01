//! The synchronous database API: bound values, typed rows, and the
//! [`Sql`] methods that a [`Database`] and a [`Transaction`] share.
//!
//! The code that uses it names no engine. `engine.rs` holds the one backend
//! of each target: rusqlite on one connection natively, and later the
//! `SqlStorage` of a Cloudflare Durable Object. Both run a statement
//! synchronously, so a transaction is a closure that returns before the
//! commit, with no `.await` inside it:
//!
//! ```ignore
//! database.transaction(|tx| {
//!     let count: i64 = tx.query_row("SELECT COUNT(*) FROM payees WHERE book_id = ?1", &params![book_id])?;
//!     tx.execute("UPDATE books SET name = ?1 WHERE id = ?2", &params![name, book_id])?;
//!     Ok::<_, store::Error>(count)
//! })?;
//! ```
//!
//! Write the placeholders as `?1`, `?2`: the values bind by position. Never
//! write `BEGIN` or `COMMIT` in SQL; [`Database::transaction`] is the only
//! transaction, and a Durable Object refuses the statements.
//!
//! An integer past 2^53 - 1 in either direction fails to bind and fails to
//! read ([`Error::UnsafeInteger`]). A Durable Object passes each value
//! through a JavaScript number, which rounds such an integer without an
//! error, so the native backend refuses it where the object would corrupt it.

pub use crate::engine::{Database, Transaction};
use std::{fmt, ops::ControlFlow, sync::Arc};

/// Decodes a struct from a row by column name: see [`Row::column`].
pub use ledger_db_derive::FromRow;

/// The largest integer that a JavaScript number holds exactly
/// (`Number.MAX_SAFE_INTEGER`). [`Value::Integer`] stays within ±this.
pub const MAX_SAFE_INTEGER: i64 = (1 << 53) - 1;

/// One SQLite value, bound to a statement or read from a row.
#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Null,
    Integer(i64),
    Real(f64),
    Text(String),
    Blob(Vec<u8>),
}

impl Value {
    /// The value, or [`Error::UnsafeInteger`] for an integer that a Durable
    /// Object would round. A backend checks each value it binds and reads.
    pub fn checked(self) -> Result<Self, Error> {
        match self {
            Self::Integer(n) if !(-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&n) => {
                Err(Error::UnsafeInteger(n))
            }
            value => Ok(value),
        }
    }

    fn kind(&self) -> &'static str {
        match self {
            Self::Null => "NULL",
            Self::Integer(_) => "an integer",
            Self::Real(_) => "a real",
            Self::Text(_) => "text",
            Self::Blob(_) => "a blob",
        }
    }
}

macro_rules! integer_values {
    ($($t:ty),*) => {$(
        impl From<$t> for Value {
            fn from(n: $t) -> Self {
                Self::Integer(i64::from(n))
            }
        }
    )*};
}

integer_values!(i64, i32, u32, i16, u16, i8, u8, bool);

macro_rules! borrowed_values {
    ($($t:ty),*) => {$(
        impl From<&$t> for Value {
            fn from(value: &$t) -> Self {
                Self::from(*value)
            }
        }
    )*};
}

borrowed_values!(i64, i32, u32, i16, u16, i8, u8, bool, f64);

impl From<f64> for Value {
    fn from(x: f64) -> Self {
        Self::Real(x)
    }
}

impl From<&str> for Value {
    fn from(text: &str) -> Self {
        Self::Text(text.to_owned())
    }
}

impl From<String> for Value {
    fn from(text: String) -> Self {
        Self::Text(text)
    }
}

impl From<&String> for Value {
    fn from(text: &String) -> Self {
        Self::Text(text.clone())
    }
}

impl From<&&str> for Value {
    fn from(text: &&str) -> Self {
        Self::Text((*text).to_owned())
    }
}

impl From<&Option<String>> for Value {
    fn from(text: &Option<String>) -> Self {
        text.as_deref().into()
    }
}

/// The text of a timestamp, as earlier releases wrote it, so that old and
/// new rows compare and sort alike: `2026-10-21 16:30:05.123456`.
impl From<chrono::NaiveDateTime> for Value {
    fn from(at: chrono::NaiveDateTime) -> Self {
        Self::Text(at.format("%F %T%.f").to_string())
    }
}

/// `2026-10-21`.
impl From<chrono::NaiveDate> for Value {
    fn from(date: chrono::NaiveDate) -> Self {
        Self::Text(date.format("%F").to_string())
    }
}

impl From<Vec<u8>> for Value {
    fn from(bytes: Vec<u8>) -> Self {
        Self::Blob(bytes)
    }
}

impl<T: Into<Value>> From<Option<T>> for Value {
    fn from(value: Option<T>) -> Self {
        value.map_or(Self::Null, Into::into)
    }
}

/// The bound values of a statement, in placeholder order:
/// `params![book_id, name]` for `?1` and `?2`.
#[macro_export]
macro_rules! params {
    ($($value:expr),* $(,)?) => {
        [$($crate::store::Value::from($value)),*]
    };
}

pub use params;

/// A database error, the same on every backend.
#[derive(Debug)]
pub enum Error {
    /// The engine refused the statement. `message` is its text, such as
    /// `UNIQUE constraint failed: payees.book_id, payees.name_fold`.
    Sql { message: String },
    /// A query that must return a row returned none.
    NoRow,
    /// A column held a value that the requested type cannot hold.
    Decode {
        column: usize,
        expected: &'static str,
        found: &'static str,
    },
    /// A row was read at a column that the result does not have, such as a
    /// two-value tuple from a one-column `SELECT`.
    NoColumn { column: usize, columns: usize },
    /// A row was read by a column name that the result does not have.
    NoColumnNamed(String),
    /// An integer past ±[`MAX_SAFE_INTEGER`], bound or read.
    UnsafeInteger(i64),
    /// A stored value that the app refuses, such as an unknown enum name.
    Invalid(String),
}

impl Error {
    /// A `UNIQUE` constraint refused the write.
    pub fn is_unique_violation(&self) -> bool {
        matches!(self, Self::Sql { message } if message.starts_with("UNIQUE constraint failed"))
    }

    /// A `FOREIGN KEY` constraint refused the write.
    pub fn is_foreign_key_violation(&self) -> bool {
        matches!(self, Self::Sql { message } if message.starts_with("FOREIGN KEY constraint failed"))
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Sql { message } => f.write_str(message),
            Self::NoRow => f.write_str("the query returned no row"),
            Self::Decode {
                column,
                expected,
                found,
            } => write!(f, "column {column} holds {found}, not {expected}"),
            Self::NoColumn { column, columns } => {
                write!(f, "no column {column}: the result has {columns}")
            }
            Self::NoColumnNamed(name) => write!(f, "the result has no column {name:?}"),
            Self::Invalid(message) => f.write_str(message),
            Self::UnsafeInteger(n) => write!(
                f,
                "the integer {n} is past 2^53 - 1, which a Durable Object cannot hold exactly"
            ),
        }
    }
}

impl std::error::Error for Error {}

/// One row of a result, its values in column order, with the names of the
/// columns (shared by the rows of one statement).
#[derive(Clone, Debug, PartialEq)]
pub struct Row {
    columns: Arc<[String]>,
    values: Vec<Value>,
}

impl Row {
    /// A row of `values`, named by `columns` in the same order. A backend
    /// builds one for each row it reads.
    pub fn new(columns: Arc<[String]>, values: Vec<Value>) -> Self {
        Self { columns, values }
    }

    /// The value of the column named `name` as `T`: the first column of
    /// that name, as `SELECT a.id, b.id` would give two. `#[derive(FromRow)]`
    /// reads each field with it.
    pub fn column<T: FromValue>(&self, name: &str) -> Result<T, Error> {
        let index = self
            .columns
            .iter()
            .position(|column| column == name)
            .ok_or_else(|| Error::NoColumnNamed(name.to_owned()))?;
        self.get(index)
    }

    /// The value of column `index` (from 0) as `T`.
    pub fn get<T: FromValue>(&self, index: usize) -> Result<T, Error> {
        let value = self.values.get(index).ok_or(Error::NoColumn {
            column: index,
            columns: self.values.len(),
        })?;
        T::from_value(value).ok_or_else(|| Error::Decode {
            column: index,
            expected: T::EXPECTED,
            found: value.kind(),
        })
    }

    pub fn len(&self) -> usize {
        self.values.len()
    }

    pub fn is_empty(&self) -> bool {
        self.values.is_empty()
    }
}

/// A type that one column decodes to.
pub trait FromValue: Sized {
    /// What the type holds, for [`Error::Decode`].
    const EXPECTED: &'static str;

    /// The value as `Self`, or `None` when it cannot hold it.
    fn from_value(value: &Value) -> Option<Self>;
}

macro_rules! integer_from_values {
    ($($t:ty),*) => {$(
        impl FromValue for $t {
            const EXPECTED: &'static str = stringify!($t);

            fn from_value(value: &Value) -> Option<Self> {
                match value {
                    Value::Integer(n) => <$t>::try_from(*n).ok(),
                    _ => None,
                }
            }
        }
    )*};
}

integer_from_values!(i64, i32, u32, i16, u16, i8, u8);

impl FromValue for bool {
    const EXPECTED: &'static str = "a boolean (0 or 1)";

    fn from_value(value: &Value) -> Option<Self> {
        match value {
            Value::Integer(0) => Some(false),
            Value::Integer(1) => Some(true),
            _ => None,
        }
    }
}

impl FromValue for f64 {
    const EXPECTED: &'static str = "a number";

    /// An integer column read as a number: SQLite stores a whole REAL as an
    /// integer when the column has no REAL affinity.
    fn from_value(value: &Value) -> Option<Self> {
        match value {
            Value::Real(x) => Some(*x),
            Value::Integer(n) => Some(*n as f64),
            _ => None,
        }
    }
}

impl FromValue for String {
    const EXPECTED: &'static str = "text";

    fn from_value(value: &Value) -> Option<Self> {
        match value {
            Value::Text(text) => Some(text.clone()),
            _ => None,
        }
    }
}

/// A timestamp column: UTC text, `YYYY-MM-DD HH:MM:SS[.fff]`, as the app
/// binds it. A `T` for the space and an RFC 3339 offset also decode, as rows
/// that earlier releases wrote may hold them.
impl FromValue for chrono::NaiveDateTime {
    const EXPECTED: &'static str = "a timestamp";

    fn from_value(value: &Value) -> Option<Self> {
        let Value::Text(text) = value else {
            return None;
        };
        ["%F %T%.f", "%FT%T%.f"]
            .iter()
            .find_map(|format| chrono::NaiveDateTime::parse_from_str(text, format).ok())
            .or_else(|| {
                chrono::DateTime::parse_from_rfc3339(text)
                    .ok()
                    .map(|time| time.naive_utc())
            })
    }
}

/// A date column: `YYYY-MM-DD`.
impl FromValue for chrono::NaiveDate {
    const EXPECTED: &'static str = "a date";

    fn from_value(value: &Value) -> Option<Self> {
        match value {
            Value::Text(text) => chrono::NaiveDate::parse_from_str(text, "%F").ok(),
            _ => None,
        }
    }
}

impl FromValue for Vec<u8> {
    const EXPECTED: &'static str = "a blob";

    fn from_value(value: &Value) -> Option<Self> {
        match value {
            Value::Blob(bytes) => Some(bytes.clone()),
            _ => None,
        }
    }
}

impl FromValue for Value {
    const EXPECTED: &'static str = "a value";

    fn from_value(value: &Value) -> Option<Self> {
        Some(value.clone())
    }
}

impl<T: FromValue> FromValue for Option<T> {
    const EXPECTED: &'static str = T::EXPECTED;

    fn from_value(value: &Value) -> Option<Self> {
        match value {
            Value::Null => Some(None),
            value => T::from_value(value).map(Some),
        }
    }
}

/// A type that one row decodes to: a single column's type for a one-column
/// query, a tuple for several, or the [`Row`] itself.
pub trait FromRow: Sized {
    fn from_row(row: &Row) -> Result<Self, Error>;
}

impl FromRow for Row {
    fn from_row(row: &Row) -> Result<Self, Error> {
        Ok(row.clone())
    }
}

macro_rules! single_column_rows {
    ($($t:ty),*) => {$(
        impl FromRow for $t {
            fn from_row(row: &Row) -> Result<Self, Error> {
                row.get(0)
            }
        }

        impl FromRow for Option<$t> {
            fn from_row(row: &Row) -> Result<Self, Error> {
                row.get(0)
            }
        }
    )*};
}

single_column_rows!(
    i64,
    i32,
    u32,
    i16,
    u16,
    i8,
    u8,
    bool,
    f64,
    String,
    Vec<u8>,
    Value,
    chrono::NaiveDateTime,
    chrono::NaiveDate
);

macro_rules! tuple_rows {
    ($(($($t:ident $i:tt),+)),+) => {$(
        impl<$($t: FromValue),+> FromRow for ($($t,)+) {
            fn from_row(row: &Row) -> Result<Self, Error> {
                Ok(($(row.get::<$t>($i)?,)+))
            }
        }
    )+};
}

tuple_rows!(
    (A 0),
    (A 0, B 1),
    (A 0, B 1, C 2),
    (A 0, B 1, C 2, D 3),
    (A 0, B 1, C 2, D 3, E 4),
    (A 0, B 1, C 2, D 3, E 4, F 5),
    (A 0, B 1, C 2, D 3, E 4, F 5, G 6),
    (A 0, B 1, C 2, D 3, E 4, F 5, G 6, H 7),
    (A 0, B 1, C 2, D 3, E 4, F 5, G 6, H 7, I 8),
    (A 0, B 1, C 2, D 3, E 4, F 5, G 6, H 7, I 8, J 9),
    (A 0, B 1, C 2, D 3, E 4, F 5, G 6, H 7, I 8, J 9, K 10),
    (A 0, B 1, C 2, D 3, E 4, F 5, G 6, H 7, I 8, J 9, K 10, L 11)
);

/// The statements of a [`Database`] or of an open [`Transaction`]. Code that
/// runs in either takes `&impl Sql`.
pub trait Sql {
    /// Runs one statement and passes each row to `each`, in order, until
    /// `each` returns `Break`; the rest of the result is not read. The
    /// backend implements this; the other methods build on it.
    fn for_each_row(
        &self,
        sql: &str,
        params: &[Value],
        each: &mut dyn FnMut(Row) -> Result<ControlFlow<()>, Error>,
    ) -> Result<(), Error>;

    /// Runs one statement and returns the number of rows it changed.
    fn execute(&self, sql: &str, params: &[Value]) -> Result<u64, Error>;

    /// Runs several statements with no bound values, such as a schema.
    fn exec_batch(&self, sql: &str) -> Result<(), Error>;

    /// Every row, decoded.
    fn query<T: FromRow>(&self, sql: &str, params: &[Value]) -> Result<Vec<T>, Error> {
        let mut rows = Vec::new();
        self.for_each_row(sql, params, &mut |row| {
            rows.push(T::from_row(&row)?);
            Ok(ControlFlow::Continue(()))
        })?;
        Ok(rows)
    }

    /// The first row, decoded, or [`Error::NoRow`].
    fn query_row<T: FromRow>(&self, sql: &str, params: &[Value]) -> Result<T, Error> {
        self.query_optional(sql, params)?.ok_or(Error::NoRow)
    }

    /// The first row, decoded, or `None` when there is none. The rows after
    /// it are not read.
    fn query_optional<T: FromRow>(&self, sql: &str, params: &[Value]) -> Result<Option<T>, Error> {
        let mut first = None;
        self.for_each_row(sql, params, &mut |row| {
            first = Some(T::from_row(&row)?);
            Ok(ControlFlow::Break(()))
        })?;
        Ok(first)
    }
}

/// An `Arc<Database>` (the server's state) runs statements as its database.
impl<T: Sql + ?Sized> Sql for Arc<T> {
    fn for_each_row(
        &self,
        sql: &str,
        params: &[Value],
        each: &mut dyn FnMut(Row) -> Result<ControlFlow<()>, Error>,
    ) -> Result<(), Error> {
        (**self).for_each_row(sql, params, each)
    }

    fn execute(&self, sql: &str, params: &[Value]) -> Result<u64, Error> {
        (**self).execute(sql, params)
    }

    fn exec_batch(&self, sql: &str) -> Result<(), Error> {
        (**self).exec_batch(sql)
    }
}

/// A statement built in pieces, for SQL whose shape depends on the request
/// (optional filters, a page anchor). [`push`](Self::push) adds text and
/// [`push_bind`](Self::push_bind) adds the next `?N` placeholder with its
/// value, so the placeholders and the values cannot drift apart.
#[derive(Debug, Default)]
pub struct Builder {
    sql: String,
    params: Vec<Value>,
}

impl Builder {
    pub fn new(sql: impl fmt::Display) -> Self {
        Self {
            sql: sql.to_string(),
            params: Vec::new(),
        }
    }

    pub fn push(&mut self, sql: impl fmt::Display) -> &mut Self {
        use fmt::Write;
        write!(self.sql, "{sql}").expect("writing to a String does not fail");
        self
    }

    pub fn push_bind(&mut self, value: impl Into<Value>) -> &mut Self {
        self.params.push(value.into());
        let placeholder = format!("?{}", self.params.len());
        self.push(placeholder)
    }

    /// `IN (...)` over the integers `ids`, bound as one JSON array.
    pub fn push_in_integers<T: serde::Serialize>(&mut self, ids: &[T]) -> &mut Self {
        self.push("IN (SELECT value FROM json_each(")
            .push_bind(crate::sql::json_array(ids))
            .push("))")
    }

    pub fn sql(&self) -> &str {
        &self.sql
    }

    pub fn params(&self) -> &[Value] {
        &self.params
    }

    pub fn query<T: FromRow>(&self, on: &impl Sql) -> Result<Vec<T>, Error> {
        on.query(&self.sql, &self.params)
    }

    pub fn query_row<T: FromRow>(&self, on: &impl Sql) -> Result<T, Error> {
        on.query_row(&self.sql, &self.params)
    }

    pub fn query_optional<T: FromRow>(&self, on: &impl Sql) -> Result<Option<T>, Error> {
        on.query_optional(&self.sql, &self.params)
    }

    pub fn execute(&self, on: &impl Sql) -> Result<u64, Error> {
        on.execute(&self.sql, &self.params)
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_builder_numbers_its_placeholders_in_order() {
        let database = crate::Database::open_in_memory().unwrap();
        let mut builder = super::Builder::new("SELECT ");
        builder
            .push_bind(2)
            .push(" + ")
            .push_bind(40)
            .push(" WHERE 1 ")
            .push_in_integers(&[1, 2]);
        assert_eq!(
            builder.sql(),
            "SELECT ?1 + ?2 WHERE 1 IN (SELECT value FROM json_each(?3))"
        );
        assert_eq!(builder.query_row::<i64>(&database).unwrap(), 42);
    }

    use super::*;
    use crate::testing::TempDatabase;

    fn memory() -> Database {
        Database::open_in_memory().unwrap()
    }

    #[test]
    fn values_bind_by_position_and_decode_by_type() {
        let database = memory();
        database
            .exec_batch("CREATE TABLE t (id INTEGER PRIMARY KEY, n INTEGER, x REAL, s TEXT, b BLOB, flag INTEGER)")
            .unwrap();
        let changed = database
            .execute(
                "INSERT INTO t (n, x, s, b, flag) VALUES (?1, ?2, ?3, ?4, ?5), (?1, NULL, NULL, NULL, ?6)",
                &params![42_i64, 1.5, "Café", vec![1_u8, 2], true, false],
            )
            .unwrap();
        assert_eq!(changed, 2);
        type Stored = (i64, i64, Option<f64>, Option<String>, Option<Vec<u8>>, bool);
        let rows: Vec<Stored> = database
            .query("SELECT id, n, x, s, b, flag FROM t ORDER BY id", &[])
            .unwrap();
        assert_eq!(
            rows,
            [
                (
                    1,
                    42,
                    Some(1.5),
                    Some("Café".to_owned()),
                    Some(vec![1, 2]),
                    true
                ),
                (2, 42, None, None, None, false),
            ]
        );
        let none: Option<String> = None;
        let count: i64 = database
            .query_row(
                "SELECT COUNT(*) FROM t WHERE s IS ?1 OR s = ?2",
                &params![none, "Café"],
            )
            .unwrap();
        assert_eq!(count, 2);
    }

    #[derive(FromRow, Debug, PartialEq)]
    struct Named {
        id: i64,
        r#type: String,
        #[row(rename = "created_at")]
        created: chrono::NaiveDateTime,
        day: Option<chrono::NaiveDate>,
    }

    #[test]
    fn a_struct_decodes_by_column_name() {
        let database = memory();
        let rows: Vec<Named> = database
            .query(
                "SELECT '2026-10-21' AS day, 'bug' AS type, 7 AS id,
                        '2026-10-21 17:00:01.250' AS created_at
                 UNION ALL SELECT NULL, 'other', 8, '2026-10-21T17:00:02Z'",
                &[],
            )
            .unwrap();
        let at = |text: &str| chrono::NaiveDateTime::parse_from_str(text, "%F %T%.f").unwrap();
        assert_eq!(
            rows,
            [
                Named {
                    id: 7,
                    r#type: "bug".to_owned(),
                    created: at("2026-10-21 17:00:01.250"),
                    day: chrono::NaiveDate::from_ymd_opt(2026, 10, 21),
                },
                Named {
                    id: 8,
                    r#type: "other".to_owned(),
                    created: at("2026-10-21 17:00:02"),
                    day: None,
                },
            ]
        );
        let missing = database.query::<Named>("SELECT 1 AS id", &[]);
        assert!(
            matches!(&missing, Err(Error::NoColumnNamed(name)) if name == "type"),
            "{missing:?}"
        );
        let wrong = database.query::<Named>(
            "SELECT 1 AS id, 'x' AS type, 'not a time' AS created_at, NULL AS day",
            &[],
        );
        assert!(
            matches!(wrong, Err(Error::Decode { column: 2, .. })),
            "{wrong:?}"
        );
    }

    #[test]
    fn query_row_and_query_optional_on_an_empty_result() {
        let database = memory();
        let missing = database.query_row::<i64>("SELECT 1 WHERE 0", &[]);
        assert!(matches!(missing, Err(Error::NoRow)), "{missing:?}");
        let optional: Option<i64> = database.query_optional("SELECT 1 WHERE 0", &[]).unwrap();
        assert_eq!(optional, None);
        let null: Option<i64> = database.query_row("SELECT NULL", &[]).unwrap();
        assert_eq!(null, None);
        // Only the first row is read: the second, which the API refuses to
        // read, does not fail the query.
        let first: i64 = database
            .query_row(
                &format!("SELECT 1 UNION ALL SELECT {}", MAX_SAFE_INTEGER + 1),
                &[],
            )
            .unwrap();
        assert_eq!(first, 1);
    }

    #[test]
    fn a_value_of_the_wrong_type_is_a_decode_error() {
        let database = memory();
        let error = database.query_row::<i64>("SELECT 'text'", &[]).unwrap_err();
        assert!(
            matches!(
                error,
                Error::Decode {
                    column: 0,
                    found: "text",
                    ..
                }
            ),
            "{error:?}"
        );
        let error = database
            .query_row::<i32>("SELECT 3000000000", &[])
            .unwrap_err();
        assert!(matches!(error, Error::Decode { .. }), "{error:?}");
        // A tuple wider than the result: the missing column is an error,
        // not a NULL.
        let error = database
            .query_row::<(i64, Option<String>)>("SELECT 1", &[])
            .unwrap_err();
        assert!(
            matches!(
                error,
                Error::NoColumn {
                    column: 1,
                    columns: 1
                }
            ),
            "{error:?}"
        );
    }

    /// A Durable Object hands each integer to JavaScript as a number, which
    /// rounds past 2^53 - 1 without an error. The native backend refuses the
    /// integer instead, in a bound value and in a read.
    #[test]
    fn an_integer_past_2_53_fails_to_bind_and_to_read() {
        let database = memory();
        for n in [MAX_SAFE_INTEGER, -MAX_SAFE_INTEGER] {
            let read: i64 = database.query_row("SELECT ?1", &params![n]).unwrap();
            assert_eq!(read, n);
        }
        for n in [MAX_SAFE_INTEGER + 1, i64::MAX, i64::MIN] {
            let bound = database.query_row::<i64>("SELECT ?1", &params![n]);
            assert!(
                matches!(bound, Err(Error::UnsafeInteger(m)) if m == n),
                "{bound:?}"
            );
            let read = database.query_row::<i64>(&format!("SELECT {n}"), &[]);
            assert!(
                matches!(read, Err(Error::UnsafeInteger(m)) if m == n),
                "{read:?}"
            );
        }
        // Arithmetic in SQL that passes the limit fails on the read.
        let read = database.query_row::<i64>("SELECT ?1 + 1", &params![MAX_SAFE_INTEGER]);
        assert!(matches!(read, Err(Error::UnsafeInteger(_))), "{read:?}");
    }

    #[test]
    fn a_transaction_commits_on_ok_and_rolls_back_on_err() {
        let database = memory();
        database
            .exec_batch("CREATE TABLE t (n INTEGER UNIQUE)")
            .unwrap();
        let committed = database.transaction(|tx| {
            tx.execute("INSERT INTO t (n) VALUES (?1)", &params![1])?;
            tx.query_row::<i64>("SELECT COUNT(*) FROM t", &[])
        });
        assert_eq!(committed.unwrap(), 1);
        let refused = database.transaction(|tx| {
            tx.execute("INSERT INTO t (n) VALUES (?1)", &params![2])?;
            tx.execute("INSERT INTO t (n) VALUES (?1)", &params![1])
        });
        let error = refused.unwrap_err();
        assert!(error.is_unique_violation(), "{error}");
        let stored: Vec<i64> = database.query("SELECT n FROM t ORDER BY n", &[]).unwrap();
        assert_eq!(stored, [1]);

        // A caller's own error type rolls back too.
        #[derive(Debug)]
        struct Refused;
        impl From<Error> for Refused {
            fn from(_: Error) -> Self {
                Refused
            }
        }
        let refused = database.transaction(|tx| {
            tx.execute("INSERT INTO t (n) VALUES (?1)", &params![3])?;
            Err::<(), _>(Refused)
        });
        assert!(refused.is_err());
        let count: i64 = database.query_row("SELECT COUNT(*) FROM t", &[]).unwrap();
        assert_eq!(count, 1);
    }

    /// A savepoint rolls back its own writes and keeps the transaction's.
    #[test]
    fn a_savepoint_rolls_back_only_its_own_writes() {
        let database = memory();
        database
            .exec_batch("CREATE TABLE unit (value integer)")
            .unwrap();
        database
            .transaction(|tx| {
                tx.execute("INSERT INTO unit VALUES (1)", &[])?;
                let failed = tx.savepoint(|sp| {
                    sp.execute("INSERT INTO unit VALUES (2)", &[])?;
                    Err::<(), _>(Error::Invalid("skip".into()))
                })?;
                assert!(failed.is_err());
                let kept = tx.savepoint(|sp| {
                    sp.execute("INSERT INTO unit VALUES (3)", &[])?;
                    // A nested unit that fails leaves the outer one's write.
                    sp.savepoint(|inner| {
                        inner.execute("INSERT INTO unit VALUES (4)", &[])?;
                        Err::<(), _>(Error::Invalid("skip".into()))
                    })?
                    .unwrap_err();
                    Ok::<_, Error>(())
                })?;
                assert!(kept.is_ok());
                Ok::<_, Error>(())
            })
            .unwrap();
        let values: Vec<i64> = database
            .query("SELECT value FROM unit ORDER BY value", &[])
            .unwrap();
        assert_eq!(values, [1, 3]);
    }

    /// A panic inside the closure rolls the transaction back, and the
    /// database stays usable.
    #[test]
    fn a_panic_in_a_transaction_rolls_back() {
        let database = memory();
        database.exec_batch("CREATE TABLE t (n INTEGER)").unwrap();
        let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            database.transaction(|tx| {
                tx.execute("INSERT INTO t (n) VALUES (1)", &[])?;
                panic!("inside the transaction");
                #[allow(unreachable_code)]
                Ok::<_, Error>(())
            })
        }));
        assert!(panicked.is_err());
        let count: i64 = database.query_row("SELECT COUNT(*) FROM t", &[]).unwrap();
        assert_eq!(count, 0);
    }

    /// The native file has the pragmas and the Durable Object's limits.
    #[test]
    fn a_native_database_has_the_pragmas_and_the_limits() {
        let file = TempDatabase::new();
        let database = Database::open(file.path(), false).unwrap();
        let pragmas: (i64, String, i64, i64) = database
            .query_row(
                "SELECT (SELECT foreign_keys FROM pragma_foreign_keys),
                        (SELECT journal_mode FROM pragma_journal_mode),
                        (SELECT timeout FROM pragma_busy_timeout),
                        (SELECT synchronous FROM pragma_synchronous)",
                &[],
            )
            .unwrap();
        assert_eq!(pragmas, (1, "wal".to_owned(), 5000, 2));
        let mmap_size: i64 = database.query_row("PRAGMA mmap_size", &[]).unwrap();
        assert_eq!(mmap_size, crate::database::MMAP_SIZE);
        let list = |count: usize| {
            (1..=count)
                .map(|index| format!("?{index}"))
                .collect::<Vec<_>>()
                .join(", ")
        };
        let values = |count: usize| (0..count as i64).map(Value::from).collect::<Vec<_>>();
        let sql = |count: usize| {
            format!(
                "SELECT COUNT(*) FROM (SELECT 1 WHERE 1 IN ({}))",
                list(count)
            )
        };
        assert!(database.query_row::<i64>(&sql(100), &values(100)).is_ok());
        let error = database
            .query_row::<i64>(&sql(101), &values(101))
            .unwrap_err()
            .to_string();
        assert!(error.contains("between ?1 and ?100"), "{error}");
    }

    /// The native transaction is `BEGIN IMMEDIATE`: it takes the write lock
    /// at the start, so a second writer (another connection here, as the MCP
    /// stdio process or `ledger-cli` would be) waits for it and never sees a
    /// half-done write. A deferred transaction would let the other writer in
    /// between its read and its write.
    #[test]
    fn a_native_transaction_takes_the_write_lock_at_the_start() {
        let file = TempDatabase::new();
        let database = Database::open(file.path(), false).unwrap();
        let path = file.path().to_owned();
        database
            .transaction(|tx| {
                tx.query_row::<i64>("SELECT COUNT(*) FROM users", &[])?;
                // The lock is held before any write: another connection's
                // write transaction is refused at once.
                let other = try_write_lock(&path);
                assert!(other.contains("locked"), "{other}");
                Ok::<_, Error>(())
            })
            .unwrap();
        assert_eq!(try_write_lock(&path), "ok");
    }

    /// Opens a second connection with no busy timeout and tries to take the
    /// write lock.
    fn try_write_lock(path: &std::path::Path) -> String {
        let other = Database::open_with(path, false, std::time::Duration::ZERO).unwrap();
        match other.transaction(|_| Ok::<_, Error>(())) {
            Ok(()) => "ok".to_owned(),
            Err(error) => error.to_string(),
        }
    }

    /// Every integer that the sample data stores reads back through the API:
    /// none is past 2^53 - 1, so none would round on a Durable Object. The
    /// change log's `seq` (a time in microseconds) is the largest.
    #[test]
    fn the_largest_stored_integers_read_back() {
        let file = TempDatabase::new();
        let database = file.database();
        database
            .exec_batch(
                "INSERT INTO users (id, username, password_hash, created_at)
                   VALUES (1, 'u', 'x', '2026-01-01 00:00:00');
                 INSERT INTO books (id, user_id, name, created_at, updated_at)
                   VALUES (1, 1, 'B', '2026-01-01 00:00:00', '2026-01-01 00:00:00');",
            )
            .unwrap();
        database
            .transaction(|tx| {
                crate::seed::seed_book(
                    tx,
                    1,
                    crate::seed::DemoDataset::Household,
                    chrono::NaiveDate::from_ymd_opt(2025, 12, 31).unwrap(),
                    &mut |_| {},
                )
            })
            .unwrap();

        let tables: Vec<String> = database
            .query(
                "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'",
                &[],
            )
            .unwrap();
        let mut largest = (0_i64, String::new());
        for table in &tables {
            let columns: Vec<String> = database
                .query(
                    "SELECT name FROM pragma_table_info(?1)",
                    &params![table.as_str()],
                )
                .unwrap();
            for column in columns {
                // Every value of the column, not only the integer-typed
                // ones: SQLite stores an integer in any column.
                let sql = format!(
                    "SELECT max(abs(\"{column}\")) FROM \"{table}\" WHERE typeof(\"{column}\") = 'integer'"
                );
                let max: Option<i64> = database
                    .query_row(&sql, &[])
                    .unwrap_or_else(|error| panic!("{table}.{column}: {error}"));
                if let Some(max) = max.filter(|max| *max > largest.0) {
                    largest = (max, format!("{table}.{column}"));
                }
            }
        }
        assert!(tables.len() > 20, "{tables:?}");
        assert_eq!(largest.1, "transaction_changes.seq", "{largest:?}");
    }
}
