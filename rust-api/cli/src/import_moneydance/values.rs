//! Moneydance export values, read as the TypeScript importer reads them.
//!
//! The exporter writes every value as a string. JavaScript does arithmetic on
//! those strings through `parseInt` and `parseFloat` in doubles, so this
//! module does the same in `f64`. A NaN stays a NaN until a value goes into a
//! database column, and [`int4`] and [`int8`] refuse it there, at the same
//! statement where the TypeScript insert fails.

use std::borrow::Cow;

use chrono::{Local, NaiveDate, TimeZone};
use ledger_core::js::{is_js_whitespace, parse_float, parse_int};
use serde_json::{Map, Value};

/// One object of `all_items`.
pub type Item = Map<String, Value>;

/// The value at `key` as text. A number reads as its decimal text. `None` is
/// a missing key or a value that is not a string or a number.
pub fn text<'a>(item: &'a Item, key: &str) -> Option<Cow<'a, str>> {
    match item.get(key)? {
        Value::String(value) => Some(Cow::Borrowed(value)),
        Value::Number(value) => Some(Cow::Owned(value.to_string())),
        _ => None,
    }
}

/// The value at `key` when JavaScript treats it as truthy: `None` for a
/// missing key, an empty string, or the number zero.
pub fn field<'a>(item: &'a Item, key: &str) -> Option<Cow<'a, str>> {
    match item.get(key)? {
        Value::Number(value) if value.as_f64() == Some(0.0) => None,
        _ => text(item, key).filter(|value| !value.is_empty()),
    }
}

/// `field` as an owned string, for values that outlive the item borrow.
pub fn owned(item: &Item, key: &str) -> Option<String> {
    field(item, key).map(Cow::into_owned)
}

/// JavaScript `parseInt(value)`: NaN when no digits lead.
pub fn int(value: &str) -> f64 {
    parse_int(value, true).map_or(f64::NAN, |number| number as f64)
}

/// JavaScript `parseFloat(value)`.
pub fn float(value: &str) -> f64 {
    parse_float(value).unwrap_or(f64::NAN)
}

/// JavaScript `parseInt(item[key] ?? "0") || 0`.
pub fn int_or_zero(item: &Item, key: &str) -> f64 {
    let value = text(item, key).map_or(0.0, |value| int(&value));
    if value.is_nan() { 0.0 } else { value }
}

/// A double as a PostgreSQL `integer`. A NaN, a fraction or a value out of
/// range is an error, as it is when postgres.js sends it.
pub fn int4(value: f64) -> Result<i32, String> {
    if value.fract() == 0.0 && value >= f64::from(i32::MIN) && value <= f64::from(i32::MAX) {
        Ok(value as i32)
    } else {
        Err(format!("value \"{value}\" is not a valid integer"))
    }
}

/// A double as a PostgreSQL `bigint`.
pub fn int8(value: f64) -> Result<i64, String> {
    // 2^63 is exactly representable, and it is the first value out of range.
    if value.fract() == 0.0
        && (-9_223_372_036_854_775_808.0..9_223_372_036_854_775_808.0).contains(&value)
    {
        Ok(value as i64)
    } else {
        Err(format!("value \"{value}\" is not a valid bigint"))
    }
}

/// A whole double as JavaScript prints it in a template string.
pub fn integer_text(value: f64) -> String {
    if value.fract() == 0.0 && value.abs() < 1e21 {
        format!("{value:.0}")
    } else {
        value.to_string()
    }
}

/// Moneydance `YYYYMMDD` to `YYYY-MM-DD`. Like `convertDate`, it counts
/// UTF-16 units and lets a NaN component through, because a NaN fails every
/// comparison.
pub fn convert_date(value: Option<&str>) -> Result<String, String> {
    let raw = value.unwrap_or("");
    let units: Vec<u16> = raw.encode_utf16().collect();
    if raw.is_empty() || units.len() != 8 {
        return Err(format!(
            "Invalid date format: {}",
            value.unwrap_or("undefined")
        ));
    }
    let part = |range: std::ops::Range<usize>| String::from_utf16_lossy(&units[range]);
    let (year, month, day) = (part(0..4), part(4..6), part(6..8));
    let (year_number, month_number, day_number) = (int(&year), int(&month), int(&day));
    if year_number < 1900.0 || year_number > 2100.0 {
        return Err(format!("Invalid year: {year}"));
    }
    if month_number < 1.0 || month_number > 12.0 {
        return Err(format!("Invalid month: {month}"));
    }
    if day_number < 1.0 || day_number > 31.0 {
        return Err(format!("Invalid day: {day}"));
    }
    Ok(format!("{year}-{month}-{day}"))
}

/// A Moneydance millisecond timestamp as a local date. An unreadable or
/// missing value gives `today`, as `convertTimestampToDate` does.
pub fn timestamp_date(value: Option<&str>, today: NaiveDate) -> NaiveDate {
    let milliseconds = value.map_or(f64::NAN, int);
    // JavaScript dates end 8.64e15 ms either side of the epoch.
    if milliseconds.is_nan() || milliseconds.abs() > 8.64e15 {
        return today;
    }
    Local
        .timestamp_millis_opt(milliseconds as i64)
        .single()
        .map_or(today, |moment| moment.date_naive())
}

/// `y`, `yes` or `1`, in any case.
pub fn is_true(value: Option<&str>) -> bool {
    value.is_some_and(|value| matches!(value.to_lowercase().as_str(), "y" | "yes" | "1"))
}

fn is_reconciled_status(value: Option<&str>) -> bool {
    value.is_some_and(|value| value.trim_matches(is_js_whitespace).to_uppercase() == "X")
}

/// A digit run, a dot, then `suffix`: the numbered split key `12.stat`.
fn is_split_key(key: &str, suffix: &str) -> bool {
    key.split_once('.').is_some_and(|(index, rest)| {
        !index.is_empty() && index.bytes().all(|byte| byte.is_ascii_digit()) && rest == suffix
    })
}

/// Reconciled when the transaction or any of its splits is marked `X`.
/// Counterpoise has one flag per transaction, and Moneydance marks each side.
pub fn is_transaction_reconciled(item: &Item) -> bool {
    is_reconciled_status(field(item, "stat").as_deref())
        || item
            .keys()
            .filter(|key| is_split_key(key, "stat"))
            .any(|key| is_reconciled_status(field(item, key).as_deref()))
}

/// The payee normalization of `normalizePayeeName()`: trim, collapse
/// whitespace, and straighten quote characters. It does not change case.
pub fn normalize_name(name: &str) -> String {
    let mut normalized = String::with_capacity(name.len());
    let mut space = false;
    for character in name.trim_matches(is_js_whitespace).chars() {
        if is_js_whitespace(character) {
            space = true;
            continue;
        }
        if space {
            normalized.push(' ');
            space = false;
        }
        normalized.push(match character {
            '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}' | '\u{2032}' | '\u{0060}'
            | '\u{00B4}' => '\'',
            other => other,
        });
    }
    normalized
}

/// Trimmed text, or `None` when it is blank or missing.
pub fn normalize_optional_text(value: Option<&str>) -> Option<String> {
    let trimmed = value?.trim_matches(is_js_whitespace);
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

/// Moneydance stores `relrt` as the inverse of the price.
pub fn convert_price_to_micros(value: Option<&str>) -> Result<f64, String> {
    let rate = value.map_or(f64::NAN, float);
    if rate.is_nan() || rate == 0.0 {
        return Err(format!(
            "Invalid price rate: {}",
            value.unwrap_or("undefined")
        ));
    }
    Ok(ledger_core::js::round(1.0 / rate * 1_000_000.0))
}

/// The price in micros of `pamt` cents for `samt` share micros.
pub fn price_from_transaction(pamt: f64, samt: f64) -> f64 {
    ledger_core::js::round(pamt.abs() * 10_000_000_000.0 / samt.abs())
}

fn gcd(left: f64, right: f64) -> f64 {
    if right == 0.0 {
        left
    } else {
        gcd(right, left % right)
    }
}

fn simplify(numerator: f64, denominator: f64) -> (f64, f64) {
    let divisor = gcd(numerator, denominator);
    (numerator / divisor, denominator / divisor)
}

/// A stock split as `(numerator, denominator)` in lowest terms, from
/// `parseStockSplitRatio`. `ratio` decides when the share counts are equal,
/// and it detects the exports that swap the old and new counts.
pub fn parse_stock_split_ratio(
    old_shares: Option<&str>,
    new_shares: Option<&str>,
    ratio: Option<&str>,
) -> Result<(f64, f64), String> {
    let old = old_shares.map_or(f64::NAN, int);
    let new = new_shares.map_or(f64::NAN, int);
    if old.is_nan() || new.is_nan() || old <= 0.0 || new <= 0.0 {
        return Err(format!(
            "Invalid split ratio: {}:{}",
            old_shares.unwrap_or("undefined"),
            new_shares.unwrap_or("undefined")
        ));
    }
    let ratio = ratio.map_or(f64::NAN, float);
    let has_ratio = ratio.is_finite() && ratio > 0.0;
    let is_close = |left: f64, right: f64| (left - right).abs() < 1e-6;
    let round = ledger_core::js::round;

    if old == new && has_ratio && !is_close(ratio, 1.0) {
        return Ok(if ratio >= 1.0 {
            simplify(round(ratio), 1.0)
        } else {
            simplify(1.0, round(1.0 / ratio))
        });
    }
    if has_ratio && old != new {
        let (new_over_old, old_over_new) = (new / old, old / new);
        if (is_close(ratio, new_over_old) || is_close(ratio, old_over_new))
            && (ratio - old_over_new).abs() < (ratio - new_over_old).abs()
        {
            return Ok(simplify(old, new));
        }
    }
    Ok(simplify(new, old))
}

/// The indexes of the numbered split keys (`3.samt`), in the order that
/// `Array.prototype.sort()` gives them: as text, so 10 comes before 2.
pub fn split_indexes(item: &Item) -> Vec<String> {
    let mut indexes: Vec<String> = Vec::new();
    for key in item.keys() {
        let Some((index, _)) = key.split_once('.') else {
            continue;
        };
        if index.is_empty() || !index.bytes().all(|byte| byte.is_ascii_digit()) {
            continue;
        }
        // parseInt drops leading zeros, so "03.samt" names split 3.
        let index = integer_text(int(index));
        if !indexes.contains(&index) {
            indexes.push(index);
        }
    }
    indexes.sort();
    indexes
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn item(value: Value) -> Item {
        value.as_object().unwrap().clone()
    }

    #[test]
    fn field_follows_javascript_truthiness() {
        let row = item(json!({"a": "", "b": "0", "c": 0, "d": 12, "e": null}));
        assert_eq!(field(&row, "a"), None);
        assert_eq!(field(&row, "b").as_deref(), Some("0"));
        assert_eq!(field(&row, "c"), None);
        assert_eq!(field(&row, "d").as_deref(), Some("12"));
        assert_eq!(field(&row, "e"), None);
        assert_eq!(field(&row, "missing"), None);
        assert_eq!(text(&row, "a").as_deref(), Some(""));
    }

    #[test]
    fn convert_date_validates_like_the_typescript() {
        assert_eq!(convert_date(Some("20240115")).unwrap(), "2024-01-15");
        assert!(convert_date(Some("2024011")).is_err());
        assert!(convert_date(None).is_err());
        assert!(convert_date(Some("18991231")).is_err());
        assert!(convert_date(Some("20241301")).is_err());
        assert!(convert_date(Some("20240132")).is_err());
        // A NaN year fails no comparison, so it passes.
        assert_eq!(convert_date(Some("abcd0101")).unwrap(), "abcd-01-01");
    }

    #[test]
    fn int4_and_int8_refuse_what_postgres_refuses() {
        assert_eq!(int4(-5.0), Ok(-5));
        assert!(int4(f64::NAN).is_err());
        assert!(int4(1.5).is_err());
        assert!(int4(3_000_000_000.0).is_err());
        assert_eq!(int8(3_000_000_000.0), Ok(3_000_000_000));
        assert!(int8(f64::INFINITY).is_err());
        assert!(int8(9_223_372_036_854_775_808.0).is_err());
    }

    #[test]
    fn normalize_name_collapses_whitespace_and_straightens_quotes() {
        assert_eq!(normalize_name("  Green \t  Grocer  "), "Green Grocer");
        assert_eq!(
            normalize_name("Joe\u{2019}s `Diner\u{00B4}"),
            "Joe's 'Diner'"
        );
        assert_eq!(normalize_name("IKEA"), "IKEA");
        assert_eq!(normalize_name(" \u{feff} "), "");
    }

    #[test]
    fn reconciliation_reads_the_transaction_and_every_split() {
        assert!(is_transaction_reconciled(&item(json!({"stat": " x "}))));
        assert!(is_transaction_reconciled(&item(
            json!({"stat": "", "2.stat": "X"})
        )));
        assert!(!is_transaction_reconciled(&item(
            json!({"stat": "1", "a.stat": "X"})
        )));
    }

    #[test]
    fn prices_invert_the_rate() {
        assert_eq!(convert_price_to_micros(Some("0.02")), Ok(50_000_000.0));
        assert_eq!(convert_price_to_micros(Some("2e-2")), Ok(50_000_000.0));
        assert!(convert_price_to_micros(Some("0")).is_err());
        assert!(convert_price_to_micros(Some("x")).is_err());
        assert_eq!(
            price_from_transaction(-500_000.0, 100_000_000.0),
            50_000_000.0
        );
    }

    #[test]
    fn stock_split_ratios_match_the_typescript() {
        let ratio = |old, new, ratio| parse_stock_split_ratio(Some(old), Some(new), ratio).unwrap();
        assert_eq!(ratio("1", "2", Some("2.0")), (2.0, 1.0));
        assert_eq!(ratio("2", "1", Some("2.0")), (2.0, 1.0));
        assert_eq!(ratio("2", "1", Some("0.5")), (1.0, 2.0));
        assert_eq!(ratio("1", "1", Some("0.5")), (1.0, 2.0));
        assert_eq!(ratio("1", "1", Some("3")), (3.0, 1.0));
        assert_eq!(ratio("4", "6", None), (3.0, 2.0));
        assert!(parse_stock_split_ratio(Some("0"), Some("1"), None).is_err());
        assert!(parse_stock_split_ratio(None, Some("1"), None).is_err());
    }

    #[test]
    fn split_indexes_sort_as_text() {
        let row = item(
            json!({"10.samt": "1", "2.samt": "1", "02.pamt": "1", "1.acctid": "a", "acctid": "b"}),
        );
        assert_eq!(split_indexes(&row), ["1", "10", "2"]);
    }
}
