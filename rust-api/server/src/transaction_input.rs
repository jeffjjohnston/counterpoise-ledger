//! The request schemas of the transaction routes. They keep the rules and the
//! messages of the zod schemas that the TypeScript routes used, which
//! answered with the message of the first zod issue. Zod reports issues in schema key order, not in body
//! order, so each function checks the keys in the order of the schema.

use crate::{
    error::{ApiError, error, error_owned},
    validation::{
        is_js_whitespace, js_number, parse_int_prefix_number, parse_js_number, valid_iso_date,
        zod_type_name,
    },
};
use axum::http::StatusCode;
use chrono::{NaiveDate, NaiveTime};
use ledger_core::accounting::InvestmentAction;
use serde_json::{Map, Value};
use std::collections::HashMap;

const INVALID_DATE: &str = "Date must be in YYYY-MM-DD format";
const CREATE_SPLITS: &str = "Date and at least 2 splits are required, even for stock splits";
pub(crate) const UPDATE_SPLITS: &str = "At least 2 splits are required, even for stock splits";
const CHECK_NUMBER: &str = "checkNumber must be a string when provided";
const INVESTMENT_SPLITS_ARRAY: &str = "investmentSplits must be an array when provided";
const EXPECTED_UPDATED_AT: &str = "expectedUpdatedAt must be an ISO timestamp";
const ACTIONS: &str =
    "Invalid option: expected one of \"buy\"|\"sell\"|\"dividend\"|\"capGain\"|\"fee\"|\"split\"";
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

fn bad_request(message: &'static str) -> ApiError {
    error(StatusCode::BAD_REQUEST, message)
}

/// Zod's "expected X, received Y" issue. An absent key is `undefined`.
fn expected(kind: &str, value: Option<&Value>) -> ApiError {
    let received = value.map_or("undefined", zod_type_name);
    error_owned(
        StatusCode::BAD_REQUEST,
        format!("Invalid input: expected {kind}, received {received}"),
    )
}

#[derive(Clone, Copy)]
pub(crate) enum Sign {
    Any,
    Positive,
    NonNegative,
}

/// `z.number().int()`, then `.positive()` or `.nonnegative()`. The `int`
/// check accepts safe integers only, and it runs before the sign check.
pub(crate) fn integer(value: Option<&Value>, sign: Sign) -> Result<i64, ApiError> {
    let Some(Value::Number(number)) = value else {
        return Err(expected("number", value));
    };
    // JSON 1.0 is an integer to zod, even when serde_json keeps it as an f64.
    let number = js_number(number);
    if number.is_infinite() {
        return Err(expected("number", value));
    }
    if number.fract() != 0.0 {
        return Err(bad_request("Invalid input: expected int, received number"));
    }
    if number > MAX_SAFE_INTEGER {
        return Err(bad_request(
            "Too big: expected int to be <=9007199254740991",
        ));
    }
    if number < -MAX_SAFE_INTEGER {
        return Err(bad_request(
            "Too small: expected int to be >=-9007199254740991",
        ));
    }
    match sign {
        Sign::Positive if number <= 0.0 => Err(bad_request("Too small: expected number to be >0")),
        Sign::NonNegative if number < 0.0 => {
            Err(bad_request("Too small: expected number to be >=0"))
        }
        _ => Ok(number as i64),
    }
}

fn optional_integer(value: Option<&Value>, sign: Sign) -> Result<Option<i64>, ApiError> {
    value.map(|value| integer(Some(value), sign)).transpose()
}

fn optional_string(object: &Map<String, Value>, key: &str) -> Result<Option<String>, ApiError> {
    match object.get(key) {
        None => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        Some(other) => Err(expected("string", Some(other))),
    }
}

/// `z.string().nullish()`: absent is `None`, JSON null is `Some(None)`.
fn nullish_string(
    object: &Map<String, Value>,
    key: &str,
) -> Result<Option<Option<String>>, ApiError> {
    match object.get(key) {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(Value::String(value)) => Ok(Some(Some(value.clone()))),
        Some(other) => Err(expected("string", Some(other))),
    }
}

fn optional_bool(object: &Map<String, Value>, key: &str) -> Result<Option<bool>, ApiError> {
    match object.get(key) {
        None => Ok(None),
        Some(Value::Bool(value)) => Ok(Some(*value)),
        Some(other) => Err(expected("boolean", Some(other))),
    }
}

/// `z.string({ error: CHECK_NUMBER_MESSAGE })`: every failure, JSON null
/// included, has the one message.
fn check_number(object: &Map<String, Value>) -> Result<Option<String>, ApiError> {
    match object.get("checkNumber") {
        None => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        Some(_) => Err(bad_request(CHECK_NUMBER)),
    }
}

fn as_object(value: &Value) -> Result<&Map<String, Value>, ApiError> {
    value
        .as_object()
        .ok_or_else(|| expected("object", Some(value)))
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct SplitInput {
    pub(crate) account_id: i64,
    pub(crate) amount: i64,
}

fn split(value: &Value) -> Result<SplitInput, ApiError> {
    let object = as_object(value)?;
    Ok(SplitInput {
        account_id: integer(object.get("accountId"), Sign::Positive)?,
        amount: integer(object.get("amount"), Sign::Any)?,
    })
}

/// `z.array(splitSchema, { error }).min(2, error)`. Zod checks the elements
/// before the length, so an element issue comes first.
fn splits(value: Option<&Value>, message: &'static str) -> Result<Vec<SplitInput>, ApiError> {
    let Some(Value::Array(items)) = value else {
        return Err(bad_request(message));
    };
    let splits = items.iter().map(split).collect::<Result<Vec<_>, _>>()?;
    if splits.len() < 2 {
        return Err(bad_request(message));
    }
    Ok(splits)
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct InvestmentSplitInput {
    /// The element as sent. `validateInvestmentSplitPayload` reads it.
    pub(crate) raw: Value,
    pub(crate) security_id: i64,
    pub(crate) action: InvestmentAction,
    pub(crate) shares_micros: i64,
    pub(crate) price_micros: i64,
    pub(crate) fees_cents: Option<i64>,
    pub(crate) split_numerator: Option<i64>,
    pub(crate) split_denominator: Option<i64>,
}

fn investment_action(value: Option<&Value>) -> Result<InvestmentAction, ApiError> {
    value
        .and_then(Value::as_str)
        .and_then(|action| {
            serde_json::from_value::<InvestmentAction>(Value::String(action.to_owned())).ok()
        })
        .ok_or_else(|| bad_request(ACTIONS))
}

fn investment_split(value: &Value) -> Result<InvestmentSplitInput, ApiError> {
    let object = as_object(value)?;
    Ok(InvestmentSplitInput {
        raw: value.clone(),
        security_id: integer(object.get("securityId"), Sign::Positive)?,
        action: investment_action(object.get("action"))?,
        shares_micros: integer(object.get("sharesMicros"), Sign::NonNegative)?,
        price_micros: integer(object.get("priceMicros"), Sign::NonNegative)?,
        fees_cents: optional_integer(object.get("feesCents"), Sign::NonNegative)?,
        split_numerator: optional_integer(object.get("splitNumerator"), Sign::Positive)?,
        split_denominator: optional_integer(object.get("splitDenominator"), Sign::Positive)?,
    })
}

fn investment_splits(
    object: &Map<String, Value>,
) -> Result<Option<Vec<InvestmentSplitInput>>, ApiError> {
    match object.get("investmentSplits") {
        None => Ok(None),
        Some(Value::Array(items)) => items
            .iter()
            .map(investment_split)
            .collect::<Result<Vec<_>, _>>()
            .map(Some),
        Some(_) => Err(bad_request(INVESTMENT_SPLITS_ARRAY)),
    }
}

/// `createTransactionBodySchema`.
#[derive(Debug, PartialEq)]
pub(crate) struct CreateTransaction {
    pub(crate) date: String,
    pub(crate) description: Option<String>,
    pub(crate) notes: Option<String>,
    pub(crate) payee_name: Option<String>,
    pub(crate) check_number: Option<String>,
    pub(crate) is_floating: Option<bool>,
    pub(crate) is_reconciled: Option<bool>,
    pub(crate) splits: Vec<SplitInput>,
    pub(crate) investment_splits: Option<Vec<InvestmentSplitInput>>,
}

pub(crate) fn validate_create(body: &Value) -> Result<CreateTransaction, ApiError> {
    // The object schema carries the splits message, so a body that is not an
    // object gets it, as the original route's first guard did.
    let object = body.as_object().ok_or_else(|| bad_request(CREATE_SPLITS))?;
    let date = object
        .get("date")
        .and_then(Value::as_str)
        .filter(|date| valid_iso_date(date))
        .ok_or_else(|| bad_request(INVALID_DATE))?
        .to_owned();
    Ok(CreateTransaction {
        date,
        description: optional_string(object, "description")?,
        notes: optional_string(object, "notes")?,
        payee_name: optional_string(object, "payeeName")?,
        check_number: check_number(object)?,
        is_floating: optional_bool(object, "isFloating")?,
        is_reconciled: optional_bool(object, "isReconciled")?,
        splits: splits(object.get("splits"), CREATE_SPLITS)?,
        investment_splits: investment_splits(object)?,
    })
}

/// `updateTransactionBodySchema`. Every field is optional. For `notes` and
/// `payeeName`, `Some(None)` is JSON null, which clears the field.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct UpdateTransaction {
    pub(crate) date: Option<String>,
    pub(crate) description: Option<String>,
    pub(crate) notes: Option<Option<String>>,
    pub(crate) payee_name: Option<Option<String>>,
    pub(crate) check_number: Option<String>,
    pub(crate) is_floating: Option<bool>,
    pub(crate) is_reconciled: Option<bool>,
    pub(crate) splits: Option<Vec<SplitInput>>,
    pub(crate) investment_splits: Option<Vec<InvestmentSplitInput>>,
    /// Epoch milliseconds, as JavaScript `new Date(value).getTime()`.
    pub(crate) expected_updated_at: Option<i64>,
}

pub(crate) fn validate_update(body: &Value) -> Result<UpdateTransaction, ApiError> {
    let object = as_object(body)?;
    let date = match object.get("date") {
        None => None,
        Some(value) => Some(
            value
                .as_str()
                .filter(|date| valid_iso_date(date))
                .ok_or_else(|| bad_request(INVALID_DATE))?
                .to_owned(),
        ),
    };
    Ok(UpdateTransaction {
        date,
        description: optional_string(object, "description")?,
        notes: nullish_string(object, "notes")?,
        payee_name: nullish_string(object, "payeeName")?,
        check_number: check_number(object)?,
        is_floating: optional_bool(object, "isFloating")?,
        is_reconciled: optional_bool(object, "isReconciled")?,
        splits: object
            .contains_key("splits")
            .then(|| splits(object.get("splits"), UPDATE_SPLITS))
            .transpose()?,
        investment_splits: investment_splits(object)?,
        expected_updated_at: object
            .get("expectedUpdatedAt")
            .map(|value| expected_updated_at(value.as_str()))
            .transpose()?,
    })
}

/// `z.iso.datetime()` with its defaults: a calendar date, `T`, hours,
/// minutes, and seconds, an optional fraction of any length, and `Z`. No
/// offset and no lowercase letters. Returns epoch milliseconds, with the
/// fraction truncated as JavaScript `Date` parsing does.
pub(crate) fn iso_datetime_millis(value: &str) -> Option<i64> {
    let date = value.get(..10).filter(|date| valid_iso_date(date))?;
    let rest = &value.as_bytes()[10..];
    let [b'T', h0, h1, b':', m0, m1, b':', s0, s1, tail @ ..] = rest else {
        return None;
    };
    let digits = [h0, h1, m0, m1, s0, s1];
    if !digits.iter().all(|digit| digit.is_ascii_digit()) {
        return None;
    }
    let pair = |high: &u8, low: &u8| u32::from(high - b'0') * 10 + u32::from(low - b'0');
    let (hour, minute, second) = (pair(h0, h1), pair(m0, m1), pair(s0, s1));
    if hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    let millis = match tail {
        [b'Z'] => 0,
        [b'.', fraction @ .., b'Z']
            if !fraction.is_empty() && fraction.iter().all(u8::is_ascii_digit) =>
        {
            fraction
                .iter()
                .chain(std::iter::repeat(&b'0'))
                .take(3)
                .fold(0, |total, digit| total * 10 + u32::from(digit - b'0'))
        }
        _ => return None,
    };
    let date = NaiveDate::parse_from_str(date, "%Y-%m-%d").ok()?;
    let time = NaiveTime::from_hms_milli_opt(hour, minute, second, millis)?;
    Some(date.and_time(time).and_utc().timestamp_millis())
}

/// `expectedUpdatedAtQuerySchema`, shared by the update body and the delete
/// query string.
pub(crate) fn expected_updated_at(value: Option<&str>) -> Result<i64, ApiError> {
    value
        .and_then(iso_datetime_millis)
        .ok_or_else(|| bad_request(EXPECTED_UPDATED_AT))
}

/// `listTransactionsQuery`, after the route maps each search parameter. The
/// IDs are JavaScript numbers. The handler converts them for an integer
/// column where Node would send them to PostgreSQL.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct ListQuery {
    pub(crate) account_id: Option<i64>,
    pub(crate) account_ids: Option<Vec<i64>>,
    pub(crate) balance_account_id: Option<i64>,
    pub(crate) payee_id: Option<i64>,
    pub(crate) recurring_rule_id: Option<i64>,
    pub(crate) start_date: Option<String>,
    pub(crate) end_date: Option<String>,
    pub(crate) include_meta: bool,
    pub(crate) limit: Option<i64>,
    pub(crate) offset: Option<i64>,
    pub(crate) ensure_id: Option<i64>,
    /// The raw `limit`. `"0"`, and only that spelling, means every row.
    pub(crate) limit_param: Option<String>,
}

/// `z.string().min(1).pipe(z.coerce.number().int())` with a sign check, and
/// one message for every failure.
fn number_param(
    value: Option<&String>,
    sign: Sign,
    message: &'static str,
) -> Result<Option<i64>, ApiError> {
    let Some(value) = value else { return Ok(None) };
    let number = (!value.is_empty())
        .then(|| parse_js_number(value))
        .flatten()
        .filter(|number| {
            number.is_finite()
                && number.fract() == 0.0
                && number.abs() <= MAX_SAFE_INTEGER
                && match sign {
                    Sign::Positive => *number > 0.0,
                    Sign::NonNegative => *number >= 0.0,
                    Sign::Any => true,
                }
        })
        .ok_or_else(|| bad_request(message))?;
    Ok(Some(number as i64))
}

pub(crate) fn validate_list_query(params: &HashMap<String, String>) -> Result<ListQuery, ApiError> {
    // `?? undefined` keeps an empty value, which then fails. `|| undefined`
    // drops it, as if the parameter were absent.
    let kept = |key: &str| params.get(key);
    let dropped = |key: &str| params.get(key).filter(|value| !value.is_empty());
    let date = |key: &str| match dropped(key) {
        Some(value) if !valid_iso_date(value) => Err(bad_request("Invalid ISO date")),
        value => Ok(value.cloned()),
    };
    Ok(ListQuery {
        account_id: number_param(kept("accountId"), Sign::Positive, "Invalid accountId")?,
        account_ids: kept("accountIds")
            .map(|value| {
                // `parseInt(id.trim(), 10)`, keeping the finite results.
                let ids: Vec<i64> = value
                    .split(',')
                    .filter_map(|id| parse_int_prefix_number(id.trim_matches(is_js_whitespace)))
                    .filter(|id| id.is_finite())
                    .map(|id| id as i64)
                    .collect();
                if ids.is_empty() {
                    Err(bad_request("Invalid accountIds"))
                } else {
                    Ok(ids)
                }
            })
            .transpose()?,
        balance_account_id: number_param(
            kept("balanceAccountId"),
            Sign::Positive,
            "Invalid balanceAccountId",
        )?,
        payee_id: number_param(kept("payeeId"), Sign::Positive, "Invalid payeeId")?,
        recurring_rule_id: number_param(
            kept("recurringRuleId"),
            Sign::Positive,
            "Invalid recurringRuleId",
        )?,
        start_date: date("startDate")?,
        end_date: date("endDate")?,
        include_meta: kept("includeMeta").is_some_and(|value| value == "true"),
        limit: number_param(dropped("limit"), Sign::NonNegative, "Invalid limit")?,
        offset: number_param(dropped("offset"), Sign::NonNegative, "Invalid offset")?,
        ensure_id: number_param(dropped("ensureId"), Sign::Positive, "Invalid ensureId")?,
        limit_param: dropped("limit").cloned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::to_bytes, response::IntoResponse};
    use serde_json::json;

    async fn message(result: Result<impl std::fmt::Debug, ApiError>) -> String {
        let response = result.unwrap_err().into_response();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 1024).await.unwrap()).unwrap();
        body["error"].as_str().unwrap().to_owned()
    }

    fn two_splits() -> Value {
        json!([{"accountId": 1, "amount": -5}, {"accountId": 2, "amount": 5}])
    }

    #[tokio::test]
    async fn create_reports_the_first_zod_issue_in_schema_order() {
        for (body, expected) in [
            (json!(null), CREATE_SPLITS),
            (json!([]), CREATE_SPLITS),
            (json!({}), INVALID_DATE),
            (json!({"date": "2025-01-01"}), CREATE_SPLITS),
            (
                json!({"date": "2023-02-29", "splits": two_splits()}),
                INVALID_DATE,
            ),
            (json!({"date": 5, "splits": two_splits()}), INVALID_DATE),
            (
                json!({"date": "2025-01-01", "splits": [{"accountId": "x", "amount": 1}]}),
                "Invalid input: expected number, received string",
            ),
            (
                json!({"date": "2025-01-01", "splits": [{"accountId": 0, "amount": 1}]}),
                "Too small: expected number to be >0",
            ),
            (
                json!({"date": "2025-01-01", "splits": [{"accountId": 1.5, "amount": 1}, {}]}),
                "Invalid input: expected int, received number",
            ),
            (
                json!({"date": "2025-01-01", "splits": [{"accountId": 1e17, "amount": 1}, {"accountId": 1, "amount": 1}]}),
                "Too big: expected int to be <=9007199254740991",
            ),
            (
                json!({"date": "2025-01-01", "splits": [{"accountId": 1, "amount": -1e17}, {"accountId": 1, "amount": 1}]}),
                "Too small: expected int to be >=-9007199254740991",
            ),
            (
                json!({"date": "2025-01-01", "splits": [{"accountId": 1}]}),
                "Invalid input: expected number, received undefined",
            ),
            (
                json!({"date": "2025-01-01", "splits": [null, null]}),
                "Invalid input: expected object, received null",
            ),
            (json!({"date": "2025-01-01", "splits": "x"}), CREATE_SPLITS),
            (
                json!({"date": "2025-01-01", "splits": two_splits(), "checkNumber": null}),
                CHECK_NUMBER,
            ),
            (
                json!({"date": "2025-01-01", "splits": two_splits(), "notes": null}),
                "Invalid input: expected string, received null",
            ),
            (
                json!({"date": "2025-01-01", "splits": two_splits(), "isFloating": "true"}),
                "Invalid input: expected boolean, received string",
            ),
            (
                json!({"date": "2025-01-01", "splits": two_splits(), "investmentSplits": {}}),
                INVESTMENT_SPLITS_ARRAY,
            ),
            (
                json!({"date": "2025-01-01", "splits": two_splits(), "investmentSplits": [{}]}),
                "Invalid input: expected number, received undefined",
            ),
            (
                json!({"date": "2025-01-01", "splits": two_splits(), "investmentSplits": [{"securityId": 1, "action": 5, "sharesMicros": 0, "priceMicros": 0}]}),
                ACTIONS,
            ),
            (
                json!({"date": "2025-01-01", "splits": two_splits(), "investmentSplits": [{"securityId": 1, "action": "buy", "sharesMicros": -1, "priceMicros": 0}]}),
                "Too small: expected number to be >=0",
            ),
            (
                json!({"date": "2025-01-01", "splits": two_splits(), "investmentSplits": [{"securityId": 1, "action": "buy", "sharesMicros": 1, "priceMicros": 0, "feesCents": null}]}),
                "Invalid input: expected number, received null",
            ),
            (
                json!({"date": "2025-01-01", "splits": [{"accountId": -1, "amount": 1}], "description": 5}),
                "Invalid input: expected string, received number",
            ),
        ] {
            assert_eq!(message(validate_create(&body)).await, expected, "{body}");
        }
        let valid = validate_create(&json!({
            "date": "0000-01-01", "splits": two_splits(), "bookId": 9,
            "investmentSplits": [{"securityId": 1, "action": "split", "sharesMicros": 0, "priceMicros": 0, "splitNumerator": 2.0, "splitDenominator": 1}],
        }))
        .unwrap();
        assert_eq!(valid.date, "0000-01-01");
        assert_eq!(valid.investment_splits.unwrap()[0].split_numerator, Some(2));
    }

    #[tokio::test]
    async fn update_accepts_partial_bodies_and_nullable_fields() {
        assert_eq!(
            validate_update(&json!({})).unwrap(),
            UpdateTransaction::default()
        );
        let cleared = validate_update(&json!({"notes": null, "payeeName": null})).unwrap();
        assert_eq!(cleared.notes, Some(None));
        assert_eq!(cleared.payee_name, Some(None));
        for (body, expected) in [
            (json!(null), "Invalid input: expected object, received null"),
            (json!([]), "Invalid input: expected object, received array"),
            (json!({"splits": []}), UPDATE_SPLITS),
            (json!({"splits": null}), UPDATE_SPLITS),
            (json!({"date": null}), INVALID_DATE),
            (
                json!({"description": null}),
                "Invalid input: expected string, received null",
            ),
            (json!({"checkNumber": null}), CHECK_NUMBER),
            (json!({"investmentSplits": null}), INVESTMENT_SPLITS_ARRAY),
            (json!({"expectedUpdatedAt": 5}), EXPECTED_UPDATED_AT),
        ] {
            assert_eq!(message(validate_update(&body)).await, expected, "{body}");
        }
    }

    #[test]
    fn iso_datetime_matches_zod_and_javascript_date() {
        for (value, millis) in [
            ("2025-01-01T00:00:00Z", Some(1_735_689_600_000)),
            ("2025-01-01T00:00:00.1239Z", Some(1_735_689_600_123)),
            ("2025-01-01T00:00:00.9999999Z", Some(1_735_689_600_999)),
            ("2025-01-01T00:00:00.12Z", Some(1_735_689_600_120)),
            ("0000-01-01T00:00:00Z", Some(-62_167_219_200_000)),
            ("2025-01-01", None),
            ("2025-01-01T00:00:00+01:00", None),
            ("2025-01-01T00:00Z", None),
            ("2025-01-01T00:00:00", None),
            ("2025-01-01T00:00:00.Z", None),
            ("2025-01-01T00:00:60Z", None),
            ("2025-01-01T24:00:00Z", None),
            ("2025-02-30T00:00:00Z", None),
            ("2025-01-01t00:00:00z", None),
            ("2025-01-01 00:00:00Z", None),
            ("2025-01-01T00:00:00,1Z", None),
            ("", None),
            ("2025-01-0é", None),
        ] {
            assert_eq!(iso_datetime_millis(value), millis, "{value}");
        }
    }

    #[tokio::test]
    async fn list_query_matches_the_route_mapping() {
        let params = |pairs: &[(&str, &str)]| {
            pairs
                .iter()
                .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
                .collect::<HashMap<_, _>>()
        };
        for (pairs, expected) in [
            (vec![("accountId", "")], "Invalid accountId"),
            (vec![("accountId", "1.5")], "Invalid accountId"),
            (vec![("accountId", "0")], "Invalid accountId"),
            (vec![("accountId", "1e400")], "Invalid accountId"),
            (vec![("accountId", "Infinity")], "Invalid accountId"),
            (vec![("accountIds", "")], "Invalid accountIds"),
            (vec![("accountIds", ",")], "Invalid accountIds"),
            (vec![("limit", "-1")], "Invalid limit"),
            (vec![("offset", "1.5")], "Invalid offset"),
            (vec![("startDate", "2025-13-01")], "Invalid ISO date"),
            (
                vec![("endDate", "x"), ("accountId", "x")],
                "Invalid accountId",
            ),
            (vec![("ensureId", "-2")], "Invalid ensureId"),
            (
                vec![("includeMeta", "true"), ("payeeId", "")],
                "Invalid payeeId",
            ),
        ] {
            assert_eq!(
                message(validate_list_query(&params(&pairs))).await,
                expected,
                "{pairs:?}"
            );
        }
        let query = validate_list_query(&params(&[
            ("accountId", " 5 "),
            ("accountIds", "a,,3x, 4"),
            ("balanceAccountId", "0x10"),
            ("payeeId", "1e3"),
            ("recurringRuleId", "99999999999"),
            ("startDate", ""),
            ("limit", ""),
            ("offset", "0"),
            ("includeMeta", "TRUE"),
        ]))
        .unwrap();
        assert_eq!(
            query,
            ListQuery {
                account_id: Some(5),
                account_ids: Some(vec![3, 4]),
                balance_account_id: Some(16),
                payee_id: Some(1000),
                recurring_rule_id: Some(99_999_999_999),
                offset: Some(0),
                ..ListQuery::default()
            }
        );
        let everything = validate_list_query(&params(&[("limit", "0")])).unwrap();
        assert_eq!(
            (everything.limit, everything.limit_param.as_deref()),
            (Some(0), Some("0"))
        );
    }
}
