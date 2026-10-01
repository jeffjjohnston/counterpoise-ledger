//! SQL fragments that differ between engines. The rest of the SQL is the
//! subset that PostgreSQL and SQLite both accept:
//!
//! - `CAST(x AS type)`, never `x::type`;
//! - a list parameter is a JSON array, matched with [`in_integers`] or
//!   [`in_texts`], never `= ANY($1)`;
//! - no date arithmetic and no clock in SQL except [`today!`]: the Rust code
//!   computes the value and binds it;
//! - a JSON column is bound with [`json`] and read with `CAST(column AS TEXT)`.
//!
//! On SQLite, `lower()`, `LIKE`, `cp_today()` and `cp_merchant_key()` are
//! the functions that `crate::functions` registers on each connection.

use crate::engine::Db;
use serde::Serialize;
use sqlx::QueryBuilder;

/// Today's date in the app's time zone, as `YYYY-MM-DD` text. A macro, so
/// that `concat!` can build a constant around it.
#[macro_export]
macro_rules! today {
    () => {
        "cp_today()"
    };
}

/// The effective date of a transaction row aliased `t`: today while it
/// floats, else its date.
pub const EFFECTIVE_DATE: &str = concat!(
    "(CASE WHEN t.is_floating THEN ",
    today!(),
    " ELSE t.date END)"
);

/// `IN (...)`: the integers of the JSON array bound at `param` (`"$2"`).
/// Bind the array with [`json_array`].
pub fn in_integers(param: &str) -> String {
    format!("IN (SELECT value FROM json_each({param}))")
}

/// Pushes `IN (...)` over `ids` onto a query builder, as [`in_integers`].
pub fn push_in_integers(builder: &mut QueryBuilder<'_, Db>, ids: &[i32]) {
    builder
        .push("IN (SELECT value FROM json_each(")
        .push_bind(json_array(ids))
        .push("))");
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

/// The merchant key of a staged Plaid row aliased `r`, as
/// `ledger_core::names::merchant_key` computes it.
pub const MERCHANT_KEY: &str = "cp_merchant_key(r.merchant_name, r.name)";

/// The JSON array text to bind for [`in_integers`] or [`in_texts`].
pub fn json_array<T: Serialize>(values: &[T]) -> String {
    serde_json::to_string(values).expect("a list of plain values serializes")
}
