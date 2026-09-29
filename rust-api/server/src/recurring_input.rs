//! The request schemas of the recurring routes. They keep the rules and the
//! messages of the zod schemas that the TypeScript routes used. Each
//! validator returns the first zod issue in schema key order.
//!
//! The schema declares some fields with `z.any()` or `z.unknown()`. They keep
//! the JSON value as sent, and the handler converts them as the Node write
//! does.

use crate::{
    error::{ApiError, error},
    transaction_input::{Sign, integer},
    validation::{expected, js_number, valid_iso_date},
};
use axum::http::StatusCode;
use serde_json::{Map, Value};

const REQUIRED: &str = "Name, frequency, startDate, and templateSplits are required";
const FREQUENCY: &str = "Invalid frequency";
const START_DATE: &str = "startDate must be in YYYY-MM-DD format";
const END_DATE: &str = "endDate must be in YYYY-MM-DD format";
const NEXT_DATE: &str = "nextDate must be in YYYY-MM-DD format";
const TEMPLATE_SPLITS: &str = "templateSplits must be an array of at least 2 valid splits";
const AUTO_CREATE_DAYS: &str = "autoCreateDaysBefore must be an integer between 0 and 30";
const BUSINESS_DAYS_ONLY: &str = "businessDaysOnly must be a boolean";
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

fn bad_request(message: &'static str) -> ApiError {
    error(StatusCode::BAD_REQUEST, message)
}

/// A template split. The amount is any finite number: `validateSplits`
/// refuses a fraction later, with its own message.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct TemplateSplit {
    pub(crate) account_id: i64,
    pub(crate) amount: f64,
}

/// `z.object({ accountId: z.number().int(), amount: z.number() })`, with
/// the templateSplits message on every field issue.
fn template_split(value: &Value) -> Result<TemplateSplit, ApiError> {
    let object = value.as_object().ok_or_else(|| expected("object", value))?;
    let number = |key: &str| {
        object
            .get(key)
            .and_then(Value::as_number)
            .map(js_number)
            .filter(|number| number.is_finite())
            .ok_or_else(|| bad_request(TEMPLATE_SPLITS))
    };
    let account_id = number("accountId")?;
    if account_id.fract() != 0.0 || account_id.abs() > MAX_SAFE_INTEGER {
        return Err(bad_request(TEMPLATE_SPLITS));
    }
    Ok(TemplateSplit {
        account_id: account_id as i64,
        amount: number("amount")?,
    })
}

/// `z.array(templateSplitSchema, { error }).min(2, error)`. Zod checks the
/// elements before the length.
fn template_splits(value: Option<&Value>) -> Result<Vec<TemplateSplit>, ApiError> {
    let Some(Value::Array(items)) = value else {
        return Err(bad_request(TEMPLATE_SPLITS));
    };
    let splits = items
        .iter()
        .map(template_split)
        .collect::<Result<Vec<_>, _>>()?;
    if splits.len() < 2 {
        return Err(bad_request(TEMPLATE_SPLITS));
    }
    Ok(splits)
}

fn frequency(value: Option<&Value>) -> Result<String, ApiError> {
    value
        .and_then(Value::as_str)
        .filter(|value| ["daily", "weekly", "monthly", "yearly"].contains(value))
        .map(str::to_owned)
        .ok_or_else(|| bad_request(FREQUENCY))
}

/// `z.iso.date(message)`: every issue, a wrong type included, has the message.
fn iso_date(value: Option<&Value>, message: &'static str) -> Result<String, ApiError> {
    value
        .and_then(Value::as_str)
        .filter(|value| valid_iso_date(value))
        .map(str::to_owned)
        .ok_or_else(|| bad_request(message))
}

/// `z.iso.date(message).nullish()` on a present key: null is `None`.
fn nullish_date(value: &Value, message: &'static str) -> Result<Option<String>, ApiError> {
    if value.is_null() {
        Ok(None)
    } else {
        iso_date(Some(value), message).map(Some)
    }
}

/// `z.number().int().min(0).max(30).optional()` with one message.
fn auto_create_days_before(value: Option<&Value>) -> Result<Option<i64>, ApiError> {
    value
        .map(|value| {
            value
                .as_number()
                .map(js_number)
                .filter(|days| days.fract() == 0.0 && (0.0..=30.0).contains(days))
                .map(|days| days as i64)
                .ok_or_else(|| bad_request(AUTO_CREATE_DAYS))
        })
        .transpose()
}

fn business_days_only(value: Option<&Value>) -> Result<Option<bool>, ApiError> {
    value
        .map(|value| {
            value
                .as_bool()
                .ok_or_else(|| bad_request(BUSINESS_DAYS_ONLY))
        })
        .transpose()
}

/// The `z.any()` and `z.unknown()` fields, as sent. An absent key is `None`.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct LooseFields {
    pub(crate) interval: Option<Value>,
    pub(crate) days_of_week: Option<Value>,
    pub(crate) week_of_month: Option<Value>,
    pub(crate) days_of_month: Option<Value>,
    pub(crate) template_description: Option<Value>,
    pub(crate) payee_id: Option<Value>,
    pub(crate) payee_name: Option<Value>,
}

impl LooseFields {
    fn from_object(object: &Map<String, Value>) -> Self {
        let field = |key: &str| object.get(key).cloned();
        Self {
            interval: field("interval"),
            days_of_week: field("daysOfWeek"),
            week_of_month: field("weekOfMonth"),
            days_of_month: field("daysOfMonth"),
            template_description: field("templateDescription"),
            payee_id: field("payeeId"),
            payee_name: field("payeeName"),
        }
    }
}

#[derive(Debug, PartialEq)]
pub(crate) struct CreateRule {
    pub(crate) name: String,
    pub(crate) frequency: String,
    pub(crate) start_date: String,
    pub(crate) end_date: Option<String>,
    pub(crate) template_splits: Vec<TemplateSplit>,
    pub(crate) auto_create_days_before: Option<i64>,
    pub(crate) business_days_only: Option<bool>,
    pub(crate) loose: LooseFields,
}

/// `createRuleSchema`. A body that is not an object gets the combined
/// "required" message, and so does a missing or empty name.
pub(crate) fn validate_create(body: &Value) -> Result<CreateRule, ApiError> {
    let object = body.as_object().ok_or_else(|| bad_request(REQUIRED))?;
    let name = object
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
        .ok_or_else(|| bad_request(REQUIRED))?;
    let frequency = frequency(object.get("frequency"))?;
    let start_date = iso_date(object.get("startDate"), START_DATE)?;
    // An empty string is null here, and so is an absent key.
    let end_date = match object.get("endDate") {
        None | Some(Value::Null) => None,
        Some(Value::String(value)) if value.is_empty() => None,
        value => Some(iso_date(value, END_DATE)?),
    };
    Ok(CreateRule {
        name: name.to_owned(),
        frequency,
        start_date,
        end_date,
        template_splits: template_splits(object.get("templateSplits"))?,
        auto_create_days_before: auto_create_days_before(object.get("autoCreateDaysBefore"))?,
        business_days_only: business_days_only(object.get("businessDaysOnly"))?,
        loose: LooseFields::from_object(object),
    })
}

/// `updateRuleSchema`. The outer `Option` is `None` for an absent key. For
/// `endDate` and `nextDate`, `Some(None)` is an explicit null.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct UpdateRule {
    pub(crate) start_date: Option<String>,
    pub(crate) end_date: Option<Option<String>>,
    pub(crate) next_date: Option<Option<String>>,
    pub(crate) template_splits: Option<Vec<TemplateSplit>>,
    pub(crate) auto_create_days_before: Option<i64>,
    pub(crate) business_days_only: Option<bool>,
    pub(crate) name: Option<String>,
    pub(crate) frequency: Option<String>,
    pub(crate) is_active: Option<bool>,
    pub(crate) loose: LooseFields,
}

pub(crate) fn validate_update(body: &Value) -> Result<UpdateRule, ApiError> {
    let object = body.as_object().ok_or_else(|| expected("object", body))?;
    Ok(UpdateRule {
        start_date: object
            .get("startDate")
            .map(|value| iso_date(Some(value), START_DATE))
            .transpose()?,
        end_date: object
            .get("endDate")
            .map(|value| nullish_date(value, END_DATE))
            .transpose()?,
        next_date: object
            .get("nextDate")
            .map(|value| nullish_date(value, NEXT_DATE))
            .transpose()?,
        template_splits: object
            .get("templateSplits")
            .map(|value| template_splits(Some(value)))
            .transpose()?,
        auto_create_days_before: auto_create_days_before(object.get("autoCreateDaysBefore"))?,
        business_days_only: business_days_only(object.get("businessDaysOnly"))?,
        name: object
            .get("name")
            .map(|value| {
                value
                    .as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| expected("string", value))
            })
            .transpose()?,
        frequency: object
            .get("frequency")
            .map(|value| frequency(Some(value)))
            .transpose()?,
        is_active: object
            .get("isActive")
            .map(|value| value.as_bool().ok_or_else(|| expected("boolean", value)))
            .transpose()?,
        loose: LooseFields::from_object(object),
    })
}

#[derive(Debug, PartialEq)]
pub(crate) struct ProcessRules {
    pub(crate) rule_id: Option<i64>,
    pub(crate) process_all: Option<bool>,
}

/// `processRulesSchema`: `ruleId` is `z.number().int()`, and `processAll` is
/// `z.boolean()`. Both are optional.
pub(crate) fn validate_process(body: &Value) -> Result<ProcessRules, ApiError> {
    let object = body.as_object().ok_or_else(|| expected("object", body))?;
    Ok(ProcessRules {
        rule_id: object
            .get("ruleId")
            .map(|value| integer(Some(value), Sign::Any))
            .transpose()?,
        process_all: object
            .get("processAll")
            .map(|value| value.as_bool().ok_or_else(|| expected("boolean", value)))
            .transpose()?,
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

    fn valid() -> Value {
        json!({
            "name": "Rent", "frequency": "monthly", "startDate": "2030-01-01",
            "templateSplits": [{"accountId": 1, "amount": 5}, {"accountId": 2, "amount": -5}],
        })
    }

    #[tokio::test]
    async fn create_reports_the_first_issue_in_schema_order() {
        for (patch, expected) in [
            (json!({"name": null, "frequency": "hourly"}), REQUIRED),
            (json!({"frequency": "hourly", "startDate": "x"}), FREQUENCY),
            (
                json!({"startDate": "2030-02-30", "endDate": "x"}),
                START_DATE,
            ),
            (json!({"endDate": 5, "templateSplits": []}), END_DATE),
            (
                json!({"templateSplits": [5], "autoCreateDaysBefore": 99}),
                "Invalid input: expected object, received number",
            ),
            (
                json!({"templateSplits": [{"accountId": 1, "amount": 1}]}),
                TEMPLATE_SPLITS,
            ),
            (
                json!({"templateSplits": [{"accountId": 9_007_199_254_740_992_u64, "amount": 1}, {"accountId": 1, "amount": 1}]}),
                TEMPLATE_SPLITS,
            ),
            (
                json!({"autoCreateDaysBefore": 30.5, "businessDaysOnly": 1}),
                AUTO_CREATE_DAYS,
            ),
            (json!({"businessDaysOnly": 1}), BUSINESS_DAYS_ONLY),
        ] {
            let mut body = valid();
            for (key, value) in patch.as_object().unwrap() {
                body[key] = value.clone();
            }
            assert_eq!(message(validate_create(&body)).await, expected, "{patch}");
        }
        assert_eq!(message(validate_create(&json!([]))).await, REQUIRED);
        let parsed = validate_create(&json!({
            "name": "Rent", "frequency": "weekly", "startDate": "2030-01-01", "endDate": "",
            "templateSplits": [{"accountId": 1.0, "amount": 1.5}, {"accountId": 2, "amount": -1.5}],
            "interval": "2", "payeeId": null, "bookId": 9,
        }))
        .unwrap();
        assert_eq!(parsed.end_date, None);
        assert_eq!(
            parsed.template_splits[0],
            TemplateSplit {
                account_id: 1,
                amount: 1.5
            }
        );
        assert_eq!(parsed.loose.interval, Some(json!("2")));
        assert_eq!(parsed.loose.payee_id, Some(Value::Null));
        assert_eq!(parsed.loose.payee_name, None);
    }

    #[tokio::test]
    async fn update_keeps_absent_and_null_apart() {
        assert_eq!(
            message(validate_update(&json!(null))).await,
            "Invalid input: expected object, received null"
        );
        assert_eq!(
            message(validate_update(&json!({"startDate": null}))).await,
            START_DATE
        );
        assert_eq!(
            message(validate_update(&json!({"nextDate": ""}))).await,
            NEXT_DATE
        );
        assert_eq!(
            message(validate_update(&json!({"isActive": 1, "name": 2}))).await,
            "Invalid input: expected string, received number"
        );
        let parsed = validate_update(&json!({"endDate": null, "nextDate": "2030-01-01"})).unwrap();
        assert_eq!(parsed.end_date, Some(None));
        assert_eq!(parsed.next_date, Some(Some("2030-01-01".into())));
        assert_eq!(validate_update(&json!({})).unwrap(), UpdateRule::default());
    }

    #[tokio::test]
    async fn process_uses_the_default_zod_messages() {
        assert_eq!(
            message(validate_process(&json!({"ruleId": 1.5}))).await,
            "Invalid input: expected int, received number"
        );
        assert_eq!(
            message(validate_process(&json!({"processAll": "yes"}))).await,
            "Invalid input: expected boolean, received string"
        );
        assert_eq!(
            validate_process(&json!({"ruleId": 0})).unwrap(),
            ProcessRules {
                rule_id: Some(0),
                process_all: None
            }
        );
    }
}
