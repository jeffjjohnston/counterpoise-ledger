use crate::error::{ApiError, error, error_owned};
use axum::{body::Bytes, http::StatusCode};
use chrono::{Local, NaiveDate};
/// Rust's `char::is_whitespace` differs from JavaScript at U+0085 and
/// U+FEFF, so a stored payee name would differ from the one Node stores.
pub(crate) use ledger_core::js::is_js_whitespace;
use ledger_core::js::parse_int;
use serde::de::DeserializeOwned;
use serde_json::{Number, Value};
use sqlx::PgPool;
use std::collections::HashMap;
use unicode_segmentation::UnicodeSegmentation;

fn bad_request(message: &'static str) -> ApiError {
    error(StatusCode::BAD_REQUEST, message)
}

pub(crate) fn valid_iso_date(value: &str) -> bool {
    matches!(value.as_bytes(), [y0, y1, y2, y3, b'-', m0, m1, b'-', d0, d1]
        if [y0, y1, y2, y3, m0, m1, d0, d1].iter().all(|digit| digit.is_ascii_digit()))
        && NaiveDate::parse_from_str(value, "%Y-%m-%d").is_ok()
}

pub(crate) fn query_date_param(
    params: &HashMap<String, String>,
    name: &str,
) -> Result<Option<String>, ApiError> {
    match params.get(name).filter(|value| !value.is_empty()) {
        Some(value) if !valid_iso_date(value) => Err(bad_request("Invalid ISO date")),
        Some(value) => Ok(Some(value.clone())),
        None => Ok(None),
    }
}

/// Bind one local calendar date for floating transactions in a request.
pub(crate) fn local_today() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

/// JavaScript `parseInt(raw, 10)`.
pub(crate) fn parse_int_prefix(raw: &str) -> Option<i64> {
    parse_int(raw, false)
}

/// JavaScript `parseInt(raw, 10)` as a double. `None` is NaN. A digit prefix
/// too long for a double is infinite, and `Number.isFinite` refuses it.
pub(crate) fn parse_int_prefix_number(raw: &str) -> Option<f64> {
    let raw = raw.trim_start_matches(is_js_whitespace);
    let (sign, rest) = match raw.strip_prefix('-') {
        Some(rest) => (-1.0, rest),
        None => (1.0, raw.strip_prefix('+').unwrap_or(raw)),
    };
    let end = rest
        .find(|character: char| !character.is_ascii_digit())
        .unwrap_or(rest.len());
    if end == 0 {
        return None;
    }
    Some(sign * rest[..end].parse::<f64>().expect("ASCII digits"))
}

/// JavaScript `parseInt(raw)` with no radix, which also reads `0x` hex.
pub(crate) fn parse_int_auto_radix(raw: &str) -> Option<i64> {
    parse_int(raw, true)
}

/// JavaScript `Number()` on a string: surrounding JavaScript whitespace is
/// ignored, an empty string is 0, an unsigned `0x`, `0b`, or `0o` prefix
/// selects a radix, and `Infinity` is the only word. `None` is NaN.
///
/// Rust's own `trim` and `f64` parser differ: `trim` removes U+0085 and keeps
/// U+FEFF, and the parser accepts `inf` and `nan` in any case.
pub(crate) fn parse_js_number(raw: &str) -> Option<f64> {
    let value = raw.trim_matches(is_js_whitespace);
    if value.is_empty() {
        return Some(0.0);
    }
    for (prefix, radix) in [("0x", 16), ("0b", 2), ("0o", 8)] {
        if value
            .get(..2)
            .is_some_and(|head| head.eq_ignore_ascii_case(prefix))
        {
            let digits = &value[2..];
            if digits.is_empty() || !digits.chars().all(|digit| digit.is_digit(radix)) {
                return None;
            }
            // Accumulated as a double, so a value beyond u64 is a number,
            // not NaN. Above 2^53 it can differ from JavaScript in the last
            // bit, which no integer check here accepts anyway.
            return Some(digits.chars().fold(0.0, |total, digit| {
                total * f64::from(radix) + f64::from(digit.to_digit(radix).expect("checked digit"))
            }));
        }
    }
    let unsigned = value.strip_prefix(['+', '-']).unwrap_or(value);
    if unsigned.starts_with(|character: char| character.is_ascii_alphabetic()) {
        return (unsigned == "Infinity").then(|| {
            if value.starts_with('-') {
                f64::NEG_INFINITY
            } else {
                f64::INFINITY
            }
        });
    }
    value.parse::<f64>().ok()
}

/// JSON as `request.json()` and `response.json()` read it. The body is first
/// decoded as UTF-8 text, and each invalid sequence becomes U+FFFD.
/// `from_utf8_lossy` replaces the same maximal subparts as the WHATWG
/// decoder. `serde_json::from_slice` refuses a BOM and invalid UTF-8.
///
/// Node removes up to two leading byte order marks: undici removes one from
/// the bytes, and then its `TextDecoder` removes one from the text. A third
/// one stays, and `JSON.parse` refuses it.
pub(crate) fn from_json_bytes<T: DeserializeOwned>(bytes: &[u8]) -> serde_json::Result<T> {
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    let text = String::from_utf8_lossy(bytes);
    serde_json::from_str(text.strip_prefix('\u{FEFF}').unwrap_or(&text))
}

/// Node catches malformed JSON at the route boundary and returns that
/// route's 500 message before running its zod schema.
pub(crate) fn parse_json_body(
    body: &Bytes,
    failure_message: &'static str,
) -> Result<Value, ApiError> {
    from_json_bytes(body).map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, failure_message))
}

/// URLSearchParams.get takes the first occurrence; route schemas ignore keys
/// they did not declare.
pub(crate) fn first_query_values(raw: Option<&str>) -> HashMap<String, String> {
    let mut first = HashMap::new();
    if let Some(raw) = raw {
        for (key, value) in url::form_urlencoded::parse(raw.as_bytes()) {
            first
                .entry(key.into_owned())
                .or_insert_with(|| value.into_owned());
        }
    }
    first
}

/// The double that `JSON.parse` reads for a JSON number. serde_json keeps
/// the number as written (`arbitrary_precision`), so a number beyond the
/// double range is an infinity here, as in JavaScript, and a number below it
/// is 0. `Number::as_f64` gives `None` for an infinity.
pub(crate) fn js_number(number: &Number) -> f64 {
    number
        .to_string()
        .parse()
        .expect("a JSON number is a valid float")
}

/// The type name zod v4 reports in an "expected X, received Y" issue. Zod
/// names an infinity by its value. It refuses an infinity wherever it expects
/// a number.
pub(crate) fn zod_type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(number) => match js_number(number) {
            f64::INFINITY => "Infinity",
            f64::NEG_INFINITY => "-Infinity",
            _ => "number",
        },
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

pub(crate) fn expected(kind: &str, value: &Value) -> ApiError {
    error_owned(
        StatusCode::BAD_REQUEST,
        format!(
            "Invalid input: expected {kind}, received {}",
            zod_type_name(value)
        ),
    )
}

/// JavaScript `Number.prototype.toString()`: the shortest digits that
/// round-trip, written with an exponent below 1e-6 and from 1e21.
pub(crate) fn js_number_string(value: f64) -> String {
    if value.is_infinite() {
        return if value > 0.0 { "Infinity" } else { "-Infinity" }.to_owned();
    }
    if value == 0.0 {
        return "0".to_owned();
    }
    if value < 0.0 {
        return format!("-{}", js_number_string(-value));
    }
    // `{:e}` gives the same shortest digits, as `d.ddde<exponent>`.
    let scientific = format!("{value:e}");
    let (mantissa, exponent) = scientific.split_once('e').expect("exponent");
    let digits = mantissa.replace('.', "");
    let k = digits.len() as i32;
    let n = exponent.parse::<i32>().expect("exponent digits") + 1;
    if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat(-n as usize))
    } else {
        let sign = if n > 0 { '+' } else { '-' };
        let (head, tail) = digits.split_at(1);
        let point = if tail.is_empty() { "" } else { "." };
        format!("{head}{point}{tail}e{sign}{}", (n - 1).abs())
    }
}

/// JavaScript `Math.round`: a half rounds toward positive infinity.
pub(crate) fn js_round(value: f64) -> f64 {
    let floor = value.floor();
    if value - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    }
}

/// JavaScript `Number(value)` for a parsed JSON value. `None` is undefined,
/// which is NaN. An array or an object converts through its string, as
/// JavaScript does.
pub(crate) fn js_to_number(value: Option<&Value>) -> f64 {
    match value {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(value)) => f64::from(u8::from(*value)),
        Some(Value::Number(number)) => js_number(number),
        Some(Value::String(text)) => parse_js_number(text).unwrap_or(f64::NAN),
        Some(value) => parse_js_number(&js_string(value)).unwrap_or(f64::NAN),
    }
}

/// JavaScript `String(value)` for a parsed JSON value: an array joins its
/// elements with commas and writes null as nothing, and an object is
/// `[object Object]`. A template literal and the database driver both
/// convert a value this way.
pub(crate) fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(value) => value.to_string(),
        Value::Number(number) => js_number_string(js_number(number)),
        Value::String(value) => value.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                item => js_string(item),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

/// A parsed value as `JSON.stringify` writes it again: an infinity becomes
/// null. Use it before a response repeats a value from a request or from an
/// upstream body.
pub(crate) fn js_json(value: &Value) -> Value {
    match value {
        Value::Number(number) if js_number(number).is_infinite() => Value::Null,
        Value::Array(items) => items.iter().map(js_json).collect(),
        Value::Object(object) => Value::Object(
            object
                .iter()
                .map(|(key, value)| (key.clone(), js_json(value)))
                .collect(),
        ),
        value => value.clone(),
    }
}

/// JavaScript truthiness for a parsed JSON value. `JSON.parse` cannot give
/// NaN, so a number is false only when it is zero.
pub(crate) fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(number) => js_number(number) != 0.0,
        Value::String(value) => !value.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// A JavaScript array-index key: the canonical text of an integer below
/// 2^32 - 1. An object lists these keys first, in ascending order.
fn array_index(key: &str) -> Option<u32> {
    key.parse::<u32>()
        .ok()
        .filter(|index| *index != u32::MAX && index.to_string() == key)
}

/// The entries of an object in JavaScript property order.
fn js_key_order(object: &serde_json::Map<String, Value>) -> Vec<(&String, &Value)> {
    let mut indexed: Vec<(u32, (&String, &Value))> = Vec::new();
    let mut named = Vec::new();
    for entry in object {
        match array_index(entry.0) {
            Some(index) => indexed.push((index, entry)),
            None => named.push(entry),
        }
    }
    indexed.sort_by_key(|(index, _)| *index);
    indexed
        .into_iter()
        .map(|(_, entry)| entry)
        .chain(named)
        .collect()
}

/// `JSON.stringify` for a parsed JSON value. A number is written as
/// JavaScript writes it, so `1.0` is `1` and an infinity is `null`. An object
/// lists its keys as a JavaScript object does: array-index keys first in
/// ascending order, then the other keys in the order they were read.
pub(crate) fn js_stringify(value: &Value) -> String {
    match value {
        Value::Number(number) => match js_number(number) {
            number if number.is_infinite() => "null".to_owned(),
            number => js_number_string(number),
        },
        Value::Array(items) => format!(
            "[{}]",
            items.iter().map(js_stringify).collect::<Vec<_>>().join(",")
        ),
        Value::Object(object) => format!(
            "{{{}}}",
            js_key_order(object)
                .into_iter()
                .map(|(key, value)| format!(
                    "{}:{}",
                    serde_json::to_string(key).expect("a string serializes"),
                    js_stringify(value)
                ))
                .collect::<Vec<_>>()
                .join(",")
        ),
        value => serde_json::to_string(value).expect("a JSON value serializes"),
    }
}

const ACCOUNT_SUBTYPES: [&str; 6] = ["bank", "credit_card", "loan", "investment", "cash", "other"];

/// `accountSubtypeSchema.nullish()`: a JSON null is `None`.
fn account_subtype(value: &Value) -> Result<Option<String>, ApiError> {
    if value.is_null() {
        return Ok(None);
    }
    value
        .as_str()
        .filter(|value| ACCOUNT_SUBTYPES.contains(value))
        .map(|value| Some(value.to_owned()))
        .ok_or_else(|| bad_request("Invalid account subtype"))
}

/// `z.number().int().positive().nullish()`: a JSON null is `None`.
fn account_parent_id(value: &Value) -> Result<Option<i64>, ApiError> {
    if value.is_null() {
        return Ok(None);
    }
    let Some(number) = value.as_number() else {
        return Err(expected("number", value));
    };
    // JSON 1.0 is a number that zod accepts as an integer, even when
    // serde_json preserved its decimal spelling.
    let number = js_number(number);
    if number.is_infinite() {
        return Err(expected("number", value));
    }
    if number.fract() != 0.0 {
        return Err(bad_request("Invalid input: expected int, received number"));
    }
    if number <= 0.0 {
        return Err(bad_request("Too small: expected number to be >0"));
    }
    if number > 9_007_199_254_740_991.0 {
        return Err(bad_request(
            "Too big: expected int to be <=9007199254740991",
        ));
    }
    Ok(Some(number as i64))
}

/// `accountIconSchema`: null and blank strings mean "inherit", so both are
/// `None`. One grapheme cluster is one character.
pub(crate) fn account_icon(value: &Value) -> Result<Option<String>, ApiError> {
    match value {
        Value::Null => Ok(None),
        Value::String(value) => {
            let value = value.trim_matches(is_js_whitespace);
            if value.is_empty() {
                Ok(None)
            } else if value.graphemes(true).count() == 1 {
                Ok(Some(value.to_owned()))
            } else {
                Err(bad_request("Icon must be a single character"))
            }
        }
        _ => Err(bad_request("Invalid input")),
    }
}

/// A typed result whose fields are the only values a write handler may insert.
/// This matches the first issue of the Node account-create zod schema.
#[derive(Debug, PartialEq)]
pub(crate) struct AccountCreate {
    pub(crate) name: String,
    pub(crate) account_type: String,
    pub(crate) subtype: Option<String>,
    pub(crate) parent_id: Option<i64>,
    pub(crate) icon: Option<String>,
}

pub(crate) fn validate_account_create(body: &Value) -> Result<AccountCreate, ApiError> {
    let object = body
        .as_object()
        .ok_or_else(|| bad_request("Name and type are required"))?;
    let name = object
        .get("name")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| bad_request("Name and type are required"))?;
    let account_type = object
        .get("type")
        .and_then(Value::as_str)
        .filter(|value| ["asset", "liability", "equity", "income", "expense"].contains(value))
        .ok_or_else(|| bad_request("Invalid account type"))?;
    let subtype = object.get("subtype").map_or(Ok(None), account_subtype)?;
    let parent_id = object.get("parentId").map_or(Ok(None), account_parent_id)?;
    let icon = object.get("icon").map_or(Ok(None), account_icon)?;
    Ok(AccountCreate {
        name: name.to_owned(),
        account_type: account_type.to_owned(),
        subtype,
        parent_id,
        icon,
    })
}

/// The fields of the Node account-update zod schema. The outer `Option` is
/// `None` when the key is absent, which leaves the column unchanged. For the
/// nullable fields, `Some(None)` writes NULL.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct AccountUpdate {
    pub(crate) name: Option<String>,
    pub(crate) subtype: Option<Option<String>>,
    pub(crate) parent_id: Option<Option<i64>>,
    pub(crate) is_active: Option<bool>,
    pub(crate) is_favorite: Option<bool>,
    pub(crate) icon: Option<Option<String>>,
}

pub(crate) fn validate_account_update(body: &Value) -> Result<AccountUpdate, ApiError> {
    let object = body.as_object().ok_or_else(|| expected("object", body))?;
    let boolean = |key: &str| -> Result<Option<bool>, ApiError> {
        object
            .get(key)
            .map(|value| value.as_bool().ok_or_else(|| expected("boolean", value)))
            .transpose()
    };
    // Zod reports the first failing key in schema order, not body order.
    Ok(AccountUpdate {
        name: object
            .get("name")
            .map(|value| {
                value
                    .as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| expected("string", value))
            })
            .transpose()?,
        subtype: object.get("subtype").map(account_subtype).transpose()?,
        parent_id: object.get("parentId").map(account_parent_id).transpose()?,
        is_active: boolean("isActive")?,
        is_favorite: boolean("isFavorite")?,
        icon: object.get("icon").map(account_icon).transpose()?,
    })
}

/// The Node payee-create schema checks that `name` is a string that is not
/// empty after `trim()`, and reports every failure with one message.
pub(crate) fn validate_payee_create(body: &Value) -> Result<&str, ApiError> {
    body.get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.trim_matches(is_js_whitespace).is_empty())
        .ok_or_else(|| bad_request("Name is required"))
}

/// Node binds a JavaScript number to an `integer` column. PostgreSQL rejects
/// a value outside the int4 range, and the route returns its 500 message.
pub(crate) fn database_integer(value: i64, failure_message: &'static str) -> Result<i32, ApiError> {
    i32::try_from(value).map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, failure_message))
}

/// Reference checks always include book_id. Schema validation alone cannot
/// distinguish a parent's ID in another book from a permitted parent.
pub(crate) async fn require_account_parent(
    pool: &PgPool,
    book_id: i32,
    parent_id: Option<i64>,
    failure_message: &'static str,
) -> Result<(), ApiError> {
    let Some(parent_id) = parent_id else {
        return Ok(());
    };
    let parent_id = database_integer(parent_id, failure_message)?;
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM accounts WHERE id = $1 AND book_id = $2)")
            .bind(parent_id)
            .bind(book_id)
            .fetch_one(pool)
            .await
            .map_err(|cause| crate::error::internal_error(cause, failure_message))?;
    if exists {
        Ok(())
    } else {
        Err(bad_request("Invalid parentId"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::to_bytes, response::IntoResponse};
    use serde_json::json;

    #[test]
    fn json_bytes_are_decoded_as_utf8_text_first() {
        let read = |bytes: &[u8]| from_json_bytes::<Value>(bytes).ok();
        assert_eq!(
            read(b"\xEF\xBB\xBF{\"a\":1}"),
            Some(serde_json::json!({ "a": 1 }))
        );
        // Node removes two BOMs, not three. JSON.parse refuses U+FEFF as
        // whitespace.
        assert_eq!(
            read(b"\xEF\xBB\xBF\xEF\xBB\xBF{}"),
            Some(serde_json::json!({}))
        );
        assert_eq!(read(b"\xEF\xBB\xBF\xEF\xBB\xBF\xEF\xBB\xBF{}"), None);
        assert_eq!(read(b" \xEF\xBB\xBF{}"), None);
        // Each maximal invalid subpart becomes one U+FFFD.
        assert_eq!(
            read(b"\"a\xFFb\xE2\x82c\xF0\x9F\x98\""),
            Some(Value::String("a\u{FFFD}b\u{FFFD}c\u{FFFD}".into()))
        );
        assert_eq!(read(b"\xFF"), None);
    }

    #[test]
    fn numbers_beyond_the_double_range_read_as_javascript_does() {
        let body: Value = serde_json::from_str(&format!(
            r#"[1e400, -1e400, 1e-400, {}, 1.5]"#,
            "9".repeat(400)
        ))
        .expect("serde_json keeps an overflowing number");
        let Value::Array(items) = &body else {
            unreachable!()
        };
        let read: Vec<f64> = items
            .iter()
            .map(|item| js_number(item.as_number().unwrap()))
            .collect();
        assert_eq!(
            read,
            [f64::INFINITY, f64::NEG_INFINITY, 0.0, f64::INFINITY, 1.5]
        );
        assert_eq!(
            items.iter().map(zod_type_name).collect::<Vec<_>>(),
            ["Infinity", "-Infinity", "number", "Infinity", "number"]
        );
        assert_eq!(js_string(&body), "Infinity,-Infinity,0,Infinity,1.5");
        assert_eq!(
            js_json(&json!({ "a": items[0], "b": [items[1], 2] })),
            json!({ "a": null, "b": [null, 2] })
        );
    }

    #[test]
    fn js_string_matches_javascript_string() {
        for (value, expected) in [
            (json!(null), "null"),
            (json!(true), "true"),
            (json!("VTI"), "VTI"),
            (json!(5), "5"),
            (json!(-0.0), "0"),
            (json!(1.5), "1.5"),
            (json!(-2.25), "-2.25"),
            (json!(123_456.0), "123456"),
            (json!(0.000_001), "0.000001"),
            (json!(1e-7), "1e-7"),
            (json!(1.5e-7), "1.5e-7"),
            (json!(1e20), "100000000000000000000"),
            (json!(1e21), "1e+21"),
            (json!(1.25e22), "1.25e+22"),
            (
                json!(12_345_678_901_234_567_890_u64),
                "12345678901234567000",
            ),
            (json!(0.1), "0.1"),
            (json!(["A", ["B", null], 1]), "A,B,,1"),
            (json!([]), ""),
            (json!({ "a": 1 }), "[object Object]"),
        ] {
            assert_eq!(js_string(&value), expected, "{value}");
        }
    }

    #[test]
    fn js_truthy_and_stringify_match_javascript() {
        let body: Value =
            serde_json::from_str(r#"[null, false, 0, -0.0, "", 1.0, "0", [], {}, 1e400]"#).unwrap();
        let Value::Array(items) = &body else {
            unreachable!()
        };
        assert_eq!(
            items.iter().map(js_truthy).collect::<Vec<_>>(),
            [
                false, false, false, false, false, true, true, true, true, true
            ]
        );
        assert_eq!(
            js_stringify(&body),
            r#"[null,false,0,0,"",1,"0",[],{},null]"#
        );
        assert_eq!(
            js_stringify(&json!({"b": [1.5, "a\"\n"], "a": true})),
            r#"{"b":[1.5,"a\"\n"],"a":true}"#
        );
        // Array-index keys come first in ascending order. A repeated key keeps
        // its first position and its last value.
        let object: Value = serde_json::from_str(
            r#"{"b":1,"10":2,"2":3,"a":4,"4294967295":5,"01":6,"4294967294":7,"b":8}"#,
        )
        .unwrap();
        assert_eq!(
            js_stringify(&object),
            r#"{"2":3,"10":2,"4294967294":7,"b":8,"a":4,"4294967295":5,"01":6}"#
        );
    }

    #[test]
    fn javascript_parse_int_forms() {
        for (raw, decimal, auto) in [
            ("12abc", Some(12), Some(12)),
            ("  +7", Some(7), Some(7)),
            ("-0x1F", Some(0), Some(-31)),
            ("0X1f", Some(0), Some(31)),
            ("0x", Some(0), None),
            ("0xg", Some(0), None),
            ("\u{feff}\u{a0}5", Some(5), Some(5)),
            ("\u{85}5", None, None),
            ("abc", None, None),
            ("", None, None),
            ("99999999999999999999999", Some(i64::MAX), Some(i64::MAX)),
        ] {
            assert_eq!(parse_int_prefix(raw), decimal, "parseInt({raw:?}, 10)");
            assert_eq!(parse_int_auto_radix(raw), auto, "parseInt({raw:?})");
        }
    }

    #[test]
    fn javascript_parse_int_as_a_double() {
        assert_eq!(parse_int_prefix_number(" -12abc"), Some(-12.0));
        assert_eq!(
            parse_int_prefix_number("99999999999"),
            Some(99_999_999_999.0)
        );
        assert_eq!(parse_int_prefix_number("x1"), None);
        assert_eq!(
            parse_int_prefix_number(&"9".repeat(400)),
            Some(f64::INFINITY)
        );
    }

    #[test]
    fn node_number_path_conversion() {
        for (raw, expected) in [
            (" 5", 5.0),
            ("0x10", 16.0),
            ("0b101", 5.0),
            ("0o10", 8.0),
            ("", 0.0),
            ("1e2", 100.0),
        ] {
            assert_eq!(parse_js_number(raw), Some(expected));
        }
        for raw in [
            "0x", "+0x10", "five", "1_0", "0x+5", "inf", "nan", "infinity", "\u{85}5",
        ] {
            assert_eq!(parse_js_number(raw), None, "{raw:?}");
        }
        assert_eq!(parse_js_number("\u{feff}5\u{a0}"), Some(5.0));
        assert_eq!(parse_js_number("-Infinity"), Some(f64::NEG_INFINITY));
        assert_eq!(
            parse_js_number("0x1FFFFFFFFFFFFFFFF"),
            Some(36_893_488_147_419_103_232.0)
        );
    }

    async fn error_message(body: Value) -> Value {
        let response = validate_account_create(&body).unwrap_err().into_response();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        serde_json::from_slice(&to_bytes(response.into_body(), 1024).await.unwrap()).unwrap()
    }

    #[tokio::test]
    async fn account_schema_errors_and_unknown_field_stripping() {
        assert_eq!(
            error_message(json!({"type":"asset"})).await,
            json!({"error":"Name and type are required"})
        );
        assert_eq!(
            error_message(json!({"name":"A","type":"banana"})).await,
            json!({"error":"Invalid account type"})
        );
        assert_eq!(
            error_message(json!({"name":"A","type":"asset","subtype":"bad"})).await,
            json!({"error":"Invalid account subtype"})
        );
        assert_eq!(
            error_message(json!({"name":"A","type":"asset","parentId":0})).await,
            json!({"error":"Too small: expected number to be >0"})
        );
        assert_eq!(
            error_message(json!({"name":"A","type":"asset","icon":"🚗🚙"})).await,
            json!({"error":"Icon must be a single character"})
        );
        let parsed = validate_account_create(
            &json!({"name":"A","type":"asset","icon":"👨‍👩‍👧‍👦","bookId":999,"id":888}),
        )
        .unwrap();
        assert_eq!(parsed.icon.as_deref(), Some("👨‍👩‍👧‍👦"));
        assert_eq!(parsed.parent_id, None);
        assert_eq!(parsed.name, "A");
        let decimal_integer =
            validate_account_create(&json!({"name":"A","type":"asset","parentId":1.0})).unwrap();
        assert_eq!(decimal_integer.parent_id, Some(1));
    }

    async fn update_error(body: Value) -> Value {
        let response = validate_account_update(&body).unwrap_err().into_response();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        serde_json::from_slice(&to_bytes(response.into_body(), 1024).await.unwrap()).unwrap()
    }

    #[tokio::test]
    async fn account_update_keeps_absent_null_and_schema_order_apart() {
        for (body, message) in [
            (json!(null), "Invalid input: expected object, received null"),
            (json!([]), "Invalid input: expected object, received array"),
            (
                json!({"isActive": null, "name": 5}),
                "Invalid input: expected string, received number",
            ),
            (json!({"subtype": 5}), "Invalid account subtype"),
            (
                json!({"parentId": {}}),
                "Invalid input: expected number, received object",
            ),
            (
                json!({"isFavorite": 1}),
                "Invalid input: expected boolean, received number",
            ),
            (json!({"icon": []}), "Invalid input"),
        ] {
            assert_eq!(update_error(body).await, json!({ "error": message }));
        }
        assert_eq!(
            validate_account_update(&json!({"type": "expense", "bookId": 2})).unwrap(),
            AccountUpdate::default()
        );
        assert_eq!(
            validate_account_update(&json!({
                "name": "", "subtype": null, "parentId": null, "icon": " ", "isActive": false
            }))
            .unwrap(),
            AccountUpdate {
                name: Some(String::new()),
                subtype: Some(None),
                parent_id: Some(None),
                is_active: Some(false),
                is_favorite: None,
                icon: Some(None),
            }
        );
    }

    #[test]
    fn payee_name_uses_javascript_trim() {
        assert_eq!(
            validate_payee_create(&json!({"name": " A "})).unwrap(),
            " A "
        );
        assert_eq!(
            validate_payee_create(&json!({"name": "\u{85}"})).unwrap(),
            "\u{85}"
        );
        for body in [
            json!(null),
            json!([]),
            json!({"name": 5}),
            json!({"name": "\u{feff} "}),
        ] {
            assert!(validate_payee_create(&body).is_err());
        }
        assert!(database_integer(i64::from(i32::MAX), "failed").is_ok());
        assert!(database_integer(i64::from(i32::MAX) + 1, "failed").is_err());
    }

    #[tokio::test]
    async fn account_parent_reference_is_scoped_to_the_book() {
        let Some(url) = crate::state::test_database_url() else {
            return;
        };
        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .unwrap();
        sqlx::query("CREATE TEMP TABLE accounts (id integer, book_id integer)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO accounts VALUES (123, 8)")
            .execute(&pool)
            .await
            .unwrap();
        assert!(
            require_account_parent(&pool, 8, Some(123), "failed")
                .await
                .is_ok()
        );
        let denied = require_account_parent(&pool, 7, Some(123), "failed")
            .await
            .unwrap_err()
            .into_response();
        assert_eq!(denied.status(), StatusCode::BAD_REQUEST);
        let body: Value =
            serde_json::from_slice(&to_bytes(denied.into_body(), 1024).await.unwrap()).unwrap();
        assert_eq!(body, json!({"error":"Invalid parentId"}));
    }
}
