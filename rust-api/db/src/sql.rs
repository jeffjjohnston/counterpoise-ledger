//! SQL fragments that differ between engines. The rest of the SQL is the
//! subset that PostgreSQL and SQLite both accept:
//!
//! - `CAST(x AS type)`, never `x::type`;
//! - a list parameter is a JSON array, matched with [`in_integers`] or
//!   [`in_texts`], never `= ANY($1)`;
//! - no date arithmetic and no clock in SQL: the Rust code computes the
//!   value and binds it, or puts today's date in as a literal
//!   ([`today_literal`], [`EFFECTIVE_DATE`]);
//! - a JSON column is bound with [`json`] and read with `CAST(column AS TEXT)`.
//!
//! - a comparison without letter case reads a `*_fold` column
//!   ([`crate::folds`]), never `lower()` of a column.
//!
//! No connection registers an SQL function: a Durable Object has none, so
//! the SQL uses only SQLite's own.

use serde::Serialize;

/// Today's date in the app's zone (`crate::clock`) as a SQL text literal,
/// `'YYYY-MM-DD'`. The date is formatted here, so the literal holds nothing
/// but digits and dashes.
pub fn today_literal() -> String {
    date_literal(crate::clock::today())
}

/// A date as a SQL text literal, `'YYYY-MM-DD'`.
pub fn date_literal(date: chrono::NaiveDate) -> String {
    format!("'{}'", date.format("%Y-%m-%d"))
}

/// The effective date of a transaction row aliased `t`: today while it
/// floats, else its date. It is a value that prints the SQL, not a constant
/// string: each `format!("{EFFECTIVE_DATE}")` reads today's date in the
/// app's zone, so no SQL function is needed. Build the statement when it
/// runs; a statement kept from an earlier day would hold that day.
pub const EFFECTIVE_DATE: EffectiveDate = EffectiveDate;

/// See [`EFFECTIVE_DATE`].
#[derive(Clone, Copy, Debug)]
pub struct EffectiveDate;

impl EffectiveDate {
    /// The SQL for a fixed `today`, for a statement that must agree with a
    /// date the caller already holds.
    pub fn on(self, today: chrono::NaiveDate) -> String {
        format!(
            "(CASE WHEN t.is_floating THEN {} ELSE t.date END)",
            date_literal(today)
        )
    }
}

impl std::fmt::Display for EffectiveDate {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.on(crate::clock::today()))
    }
}

/// `IN (...)`: the integers of the JSON array bound at `param` (`"?2"`).
/// Bind the array with [`json_array`].
pub fn in_integers(param: &str) -> String {
    format!("IN (SELECT value FROM json_each({param}))")
}

/// `IN (...)`: the strings of the JSON array bound at `param`.
pub fn in_texts(param: &str) -> String {
    format!("IN (SELECT value FROM json_each({param}))")
}

/// A JSON column value, bound as JSON text at `param`. `json()` checks the
/// text and stores it minified.
pub fn json(param: &str) -> String {
    format!("json({param})")
}

/// `SELECT <columns> FROM json_each(<param>) WHERE true ORDER BY key`: one row for each
/// row of the JSON array of arrays bound at `param`, in array order. In
/// `columns`, `#N` is the N-th value of the row (`value ->> N`); anything else
/// is SQL, such as another bound parameter. Bind the rows with [`json_array`].
///
/// A bulk insert binds one parameter this way, whatever the number of rows:
/// a Durable Object refuses a statement with more than 100
/// (`crate::limits::LIMITS` holds every native connection to the same).
/// The `WHERE true` lets an `ON CONFLICT` clause follow: without a `WHERE`,
/// SQLite reads its `ON` as a join constraint.
pub fn json_rows(columns: &[&str], param: &str) -> String {
    let columns = columns
        .iter()
        .map(|column| match column.strip_prefix('#') {
            Some(index) if index.parse::<usize>().is_ok() => format!("value ->> {index}"),
            _ => (*column).to_owned(),
        })
        .collect::<Vec<_>>()
        .join(", ");
    format!("SELECT {columns} FROM json_each({param}) WHERE true ORDER BY key")
}

/// The JSON array text to bind for [`in_integers`], [`in_texts`] or
/// [`json_rows`].
pub fn json_array<T: Serialize>(values: &[T]) -> String {
    serde_json::to_string(values).expect("a list of plain values serializes")
}
