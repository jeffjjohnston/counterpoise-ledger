//! Security price routes: the price history, one price entry, the prices due
//! for the navbar pill, the bulk write, and the Tiingo fetch.

use super::{
    investments::{MAX_SAFE_INTEGER, positions},
    securities::{find_security, page_param, security_path_id},
};
use crate::{
    book_auth::{AccessLevel, authenticate_book},
    error::{ApiError, ApiResult, error, error_owned, internal_error},
    state::AppState,
    validation::{
        first_query_values, js_number, js_string, parse_int_prefix, parse_json_body,
        valid_iso_date, zod_type_name,
    },
};
use axum::{
    Json,
    body::Bytes,
    extract::{Path, RawQuery, State},
    http::{HeaderMap, StatusCode},
};
use chrono::{Datelike, Local, Weekday};
use ledger_core::collation::compare_names;
use serde_json::{Value, json};
use std::collections::HashSet;

const PRICE_DATE_REQUIRED: &str = "priceDate is required";
const INVALID_PRICE_MICROS: &str = "Invalid priceMicros";

fn bad_request(message: &'static str) -> ApiError {
    error(StatusCode::BAD_REQUEST, message)
}

/// zod `number().int().positive()`: a JSON number that is a safe integer
/// above zero.
fn positive_safe_integer(value: &Value) -> Option<i64> {
    value
        .as_f64()
        .filter(|number| number.fract() == 0.0 && *number > 0.0 && *number <= MAX_SAFE_INTEGER)
        .map(|number| number as i64)
}

/// zod `iso.date()`.
fn iso_date(value: &Value) -> Option<&str> {
    value.as_str().filter(|date| valid_iso_date(date))
}

#[derive(Debug, PartialEq)]
struct PriceUpdate {
    price_date: String,
    price_micros: i64,
    source: Option<String>,
}

/// `updateSecurityPriceSchema`. Every failure of the object or of
/// `priceDate` has the one message. `source` is not checked: the handler
/// stores `source ?? null`, and the driver writes any other value as
/// `String(value)`.
fn validate_price_update(body: &Value) -> Result<PriceUpdate, ApiError> {
    let object = body
        .as_object()
        .ok_or_else(|| bad_request(PRICE_DATE_REQUIRED))?;
    let price_date = object
        .get("priceDate")
        .and_then(iso_date)
        .ok_or_else(|| bad_request(PRICE_DATE_REQUIRED))?;
    let price_micros = object
        .get("priceMicros")
        .and_then(positive_safe_integer)
        .ok_or_else(|| bad_request(INVALID_PRICE_MICROS))?;
    Ok(PriceUpdate {
        price_date: price_date.to_owned(),
        price_micros,
        source: object
            .get("source")
            .filter(|source| !source.is_null())
            .map(js_string),
    })
}

#[derive(Debug, PartialEq)]
struct PriceItem {
    security_id: i64,
    price_micros: i64,
    price_date: String,
}

/// `priceUpdateItemSchema`. `bulkPricesSchema` drops an item that fails it
/// and does not report it.
fn price_item(item: &Value) -> Option<PriceItem> {
    let object = item.as_object()?;
    Some(PriceItem {
        security_id: positive_safe_integer(object.get("securityId")?)?,
        price_micros: positive_safe_integer(object.get("priceMicros")?)?,
        price_date: iso_date(object.get("priceDate")?)?.to_owned(),
    })
}

fn is_unique_violation(cause: &sqlx::Error) -> bool {
    cause
        .as_database_error()
        .and_then(|database| database.code())
        .is_some_and(|code| code == "23505")
}

pub(crate) async fn price_history(
    State(state): State<AppState>,
    Path((raw_book_id, raw_id)): Path<(String, String)>,
    RawQuery(raw_query): RawQuery,
    headers: HeaderMap,
) -> ApiResult {
    const FAILURE: &str = "Failed to fetch security price history";
    let book =
        authenticate_book(&state, &headers, &raw_book_id, AccessLevel::Read, FAILURE).await?;
    let failed = |cause| internal_error(cause, FAILURE);
    let security_id = security_path_id(&raw_id, FAILURE)?;
    find_security(&state.pool, book.book_id, security_id, FAILURE).await?;
    let params = first_query_values(raw_query.as_deref());
    let limit = page_param(params.get("limit"), 1.0).map_or(50, |limit| limit.min(200));
    let offset = page_param(params.get("offset"), 0.0).unwrap_or(0);

    let prices: Vec<(String, i64, Option<String>)> = sqlx::query_as(
        "SELECT price_date, price_micros, source FROM security_prices
         WHERE security_id = $1 AND book_id = $2
         ORDER BY price_date DESC LIMIT $3 OFFSET $4",
    )
    .bind(security_id)
    .bind(book.book_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.pool)
    .await
    .map_err(failed)?;
    let total: i32 = sqlx::query_scalar(
        "SELECT CAST(COUNT(*) AS integer) FROM security_prices
         WHERE security_id = $1 AND book_id = $2",
    )
    .bind(security_id)
    .bind(book.book_id)
    .fetch_one(&state.pool)
    .await
    .map_err(failed)?;
    let has_more = offset + (prices.len() as i64) < i64::from(total);
    let prices: Vec<Value> = prices
        .into_iter()
        .map(|(price_date, price_micros, source)| {
            json!({ "priceDate": price_date, "priceMicros": price_micros, "source": source })
        })
        .collect();
    Ok(Json(json!({
        "prices": prices,
        "totalCount": total,
        "hasMore": has_more,
    })))
}

/// `updateSecurityPrice`. A new `priceDate` moves the entry: the key is
/// (security, date), so a move deletes the old row and inserts a new one.
pub(crate) async fn update_price(
    State(state): State<AppState>,
    Path((raw_book_id, raw_id, current_date)): Path<(String, String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult {
    const FAILURE: &str = "Failed to update security price";
    let book =
        authenticate_book(&state, &headers, &raw_book_id, AccessLevel::Write, FAILURE).await?;
    let failed = |cause| internal_error(cause, FAILURE);
    // Node checks the ID for NaN, then reads and validates the body. An ID
    // outside the int4 range fails later, at the database.
    let security_id =
        parse_int_prefix(&raw_id).ok_or_else(|| bad_request("Invalid security id"))?;
    let input = validate_price_update(&parse_json_body(&body, FAILURE)?)?;
    let security_id = i32::try_from(security_id)
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, FAILURE))?;
    find_security(&state.pool, book.book_id, security_id, FAILURE).await?;

    let entry_exists = |date: String| {
        sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS (SELECT 1 FROM security_prices
               WHERE security_id = $1 AND price_date = $2)",
        )
        .bind(security_id)
        .bind(date)
        .fetch_one(&state.pool)
    };
    if !entry_exists(current_date.clone()).await.map_err(failed)? {
        return Err(error(StatusCode::NOT_FOUND, "Price entry not found"));
    }
    if input.price_date == current_date {
        sqlx::query(
            "UPDATE security_prices SET price_micros = $1, source = $2
             WHERE security_id = $3 AND price_date = $4",
        )
        .bind(input.price_micros)
        .bind(&input.source)
        .bind(security_id)
        .bind(&current_date)
        .execute(&state.pool)
        .await
        .map_err(failed)?;
        return Ok(Json(json!({ "success": true })));
    }

    let conflict = || {
        error_owned(
            StatusCode::CONFLICT,
            format!("A price already exists for {}", input.price_date),
        )
    };
    // Checked before the transaction, so that the delete never runs.
    if entry_exists(input.price_date.clone())
        .await
        .map_err(failed)?
    {
        return Err(conflict());
    }
    let moved: Result<(), sqlx::Error> = async {
        let mut transaction = state.pool.begin().await?;
        sqlx::query("DELETE FROM security_prices WHERE security_id = $1 AND price_date = $2")
            .bind(security_id)
            .bind(&current_date)
            .execute(&mut *transaction)
            .await?;
        sqlx::query(
            "INSERT INTO security_prices (security_id, price_date, price_micros, source, book_id)
             VALUES ($1, $2, $3, $4, $5)",
        )
        .bind(security_id)
        .bind(&input.price_date)
        .bind(input.price_micros)
        .bind(&input.source)
        .bind(book.book_id)
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await
    }
    .await;
    match moved {
        Ok(()) => Ok(Json(json!({ "success": true }))),
        // A concurrent move onto the same date passes the check above and
        // collides here. The rollback restores the deleted row.
        Err(cause) if is_unique_violation(&cause) => Err(conflict()),
        Err(cause) => Err(failed(cause)),
    }
}

pub(crate) async fn delete_price(
    State(state): State<AppState>,
    Path((raw_book_id, raw_id, price_date)): Path<(String, String, String)>,
    headers: HeaderMap,
) -> ApiResult {
    const FAILURE: &str = "Failed to delete security price";
    let book =
        authenticate_book(&state, &headers, &raw_book_id, AccessLevel::Write, FAILURE).await?;
    let security_id = security_path_id(&raw_id, FAILURE)?;
    find_security(&state.pool, book.book_id, security_id, FAILURE).await?;
    let deleted =
        sqlx::query("DELETE FROM security_prices WHERE security_id = $1 AND price_date = $2")
            .bind(security_id)
            .bind(&price_date)
            .execute(&state.pool)
            .await
            .map_err(|cause| internal_error(cause, FAILURE))?;
    if deleted.rows_affected() == 0 {
        return Err(error(StatusCode::NOT_FOUND, "Price entry not found"));
    }
    Ok(Json(json!({ "success": true })))
}

/// `lastWeekdayOnOrBefore(new Date())` in the server time zone.
fn last_weekday() -> String {
    let mut date = Local::now().date_naive();
    while matches!(date.weekday(), Weekday::Sat | Weekday::Sun) {
        date = date.pred_opt().expect("a date before today");
    }
    date.format("%Y-%m-%d").to_string()
}

/// `listPricesDue`: manually priced securities with an open position and no
/// price for the last market day.
pub(crate) async fn prices_due(
    State(state): State<AppState>,
    Path(raw_book_id): Path<String>,
    headers: HeaderMap,
) -> ApiResult {
    const FAILURE: &str = "Failed to fetch securities needing prices";
    let book =
        authenticate_book(&state, &headers, &raw_book_id, AccessLevel::Read, FAILURE).await?;
    let failed = |cause| internal_error(cause, FAILURE);
    // A fixed-price security is never prompted for, so it is not in this
    // population at all.
    let manual: HashSet<i64> = sqlx::query_scalar::<_, i32>(
        "SELECT id FROM securities
         WHERE book_id = $1 AND fetch_prices = false AND fixed_price_micros IS NULL",
    )
    .bind(book.book_id)
    .fetch_all(&state.pool)
    .await
    .map_err(failed)?
    .into_iter()
    .map(i64::from)
    .collect();
    if manual.is_empty() {
        return Ok(Json(json!({ "dueDate": null, "securities": [] })));
    }

    // The newest price of a fetched security is the last market day. A book
    // with no fetched prices uses the last calendar weekday.
    let newest: Option<String> = sqlx::query_scalar(
        "SELECT max(p.price_date) FROM security_prices p
         JOIN securities s ON p.security_id = s.id
         WHERE s.book_id = $1 AND s.fetch_prices = true",
    )
    .bind(book.book_id)
    .fetch_one(&state.pool)
    .await
    .map_err(failed)?;
    let due_date = newest.unwrap_or_else(last_weekday);

    let mut due: Vec<_> = positions(&state.pool, book.book_id, None)
        .await
        .map_err(failed)?
        .into_iter()
        .filter(|position| {
            manual.contains(&position.security_id)
                && position.shares_micros > 0
                && position
                    .price_date
                    .as_deref()
                    .is_none_or(|date| date < due_date.as_str())
        })
        .collect();
    due.sort_by(|left, right| compare_names(&left.security_name, &right.security_name));
    let securities: Vec<Value> = due
        .into_iter()
        .map(|position| {
            json!({
                "securityId": position.security_id,
                "name": position.security_name,
                "symbol": position.security_symbol,
                "lastPriceMicros": position.price_micros,
                "lastPriceDate": position.price_date,
            })
        })
        .collect();
    Ok(Json(
        json!({ "dueDate": due_date, "securities": securities }),
    ))
}

/// `setSecurityPrices` through the bulk route: one transaction for the
/// batch. An update changes the price and keeps the source. An insert has the
/// source `manual`.
/// The first issue of `priceUpdateItemSchema` for one item, with the zod
/// message. `None` means that the item is valid.
fn price_item_issue(item: &Value) -> Option<String> {
    let Some(object) = item.as_object() else {
        return Some(format!(
            "Invalid input: expected object, received {}",
            zod_type_name(item)
        ));
    };
    for key in ["securityId", "priceMicros"] {
        let issue = match object.get(key) {
            None => Some("Invalid input: expected number, received undefined".to_owned()),
            Some(value @ Value::Number(number)) => {
                let number = js_number(number);
                if !number.is_finite() {
                    Some(format!(
                        "Invalid input: expected number, received {}",
                        zod_type_name(value)
                    ))
                } else if number.fract() != 0.0 {
                    Some("Invalid input: expected int, received number".to_owned())
                } else if number > MAX_SAFE_INTEGER {
                    Some("Too big: expected int to be <=9007199254740991".to_owned())
                } else if number < -MAX_SAFE_INTEGER {
                    Some("Too small: expected int to be >=-9007199254740991".to_owned())
                } else if number <= 0.0 {
                    Some("Too small: expected number to be >0".to_owned())
                } else {
                    None
                }
            }
            Some(value) => Some(format!(
                "Invalid input: expected number, received {}",
                zod_type_name(value)
            )),
        };
        if issue.is_some() {
            return issue;
        }
    }
    match object.get("priceDate") {
        None => Some("Invalid input: expected string, received undefined".to_owned()),
        Some(Value::String(date)) if valid_iso_date(date) => None,
        Some(Value::String(_)) => Some("Invalid ISO date".to_owned()),
        Some(value) => Some(format!(
            "Invalid input: expected string, received {}",
            zod_type_name(value)
        )),
    }
}

/// Why `set_prices` wrote nothing.
pub(crate) enum SetPricesError {
    /// The message of a `SecurityValidationError`.
    Invalid(&'static str),
    /// A security ID outside the int4 range. Node sends it to an integer
    /// column, and PostgreSQL refuses it.
    OutOfRange,
    Database(sqlx::Error),
}

/// The items that `set_prices` wrote, and the ones it skipped.
pub(crate) struct SetPrices {
    /// `{ securityId, priceMicros, priceDate }`, as zod gives a valid item.
    pub(crate) written: Vec<Value>,
    /// `{ index, reason }`: the item's position and its first zod issue.
    pub(crate) discarded: Vec<Value>,
}

/// Upserts the valid items as manual prices in one transaction. It refuses the batch when no
/// item is valid, or when a security is not in this book. The bulk route
/// reports only the count; the MCP tool also reports what it skipped.
pub(crate) async fn set_prices(
    pool: &sqlx::PgPool,
    book_id: i32,
    items: &[Value],
) -> Result<SetPrices, SetPricesError> {
    let mut updates = Vec::new();
    let mut written = Vec::new();
    let mut discarded = Vec::new();
    for (index, item) in items.iter().enumerate() {
        match (price_item_issue(item), price_item(item)) {
            (None, Some(update)) => {
                written.push(json!({
                    "securityId": update.security_id,
                    "priceMicros": update.price_micros,
                    "priceDate": update.price_date,
                }));
                updates.push(update);
            }
            (Some(reason), _) => discarded.push(json!({ "index": index, "reason": reason })),
            (None, None) => discarded.push(json!({ "index": index, "reason": "Invalid input" })),
        }
    }
    if updates.is_empty() {
        return Err(SetPricesError::Invalid("No valid price updates provided"));
    }

    let mut security_ids = updates
        .iter()
        .map(|update| i32::try_from(update.security_id))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| SetPricesError::OutOfRange)?;
    security_ids.sort_unstable();
    security_ids.dedup();
    let owned: i32 = sqlx::query_scalar(
        "SELECT CAST(COUNT(*) AS integer) FROM securities WHERE book_id = $1 AND id = ANY($2)",
    )
    .bind(book_id)
    .bind(&security_ids)
    .fetch_one(pool)
    .await
    .map_err(SetPricesError::Database)?;
    if owned as usize != security_ids.len() {
        return Err(SetPricesError::Invalid(
            "One or more securities do not belong to this book",
        ));
    }

    let mut transaction = pool.begin().await.map_err(SetPricesError::Database)?;
    for update in &updates {
        // The key is (security, date). The security belongs to this book,
        // so a conflicting row does too.
        sqlx::query(
            "INSERT INTO security_prices (security_id, price_date, price_micros, source, book_id)
             VALUES ($1, $2, $3, 'manual', $4)
             ON CONFLICT (security_id, price_date)
             DO UPDATE SET price_micros = EXCLUDED.price_micros",
        )
        .bind(update.security_id as i32)
        .bind(&update.price_date)
        .bind(update.price_micros)
        .bind(book_id)
        .execute(&mut *transaction)
        .await
        .map_err(SetPricesError::Database)?;
    }
    transaction
        .commit()
        .await
        .map_err(SetPricesError::Database)?;
    Ok(SetPrices { written, discarded })
}

pub(crate) async fn bulk_prices(
    State(state): State<AppState>,
    Path(raw_book_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult {
    const FAILURE: &str = "Failed to update security prices";
    let book =
        authenticate_book(&state, &headers, &raw_book_id, AccessLevel::Write, FAILURE).await?;
    let failed = |cause| internal_error(cause, FAILURE);
    let body = parse_json_body(&body, FAILURE)?;
    let items = body
        .as_object()
        .and_then(|object| object.get("priceUpdates"))
        .and_then(Value::as_array)
        .ok_or_else(|| bad_request("priceUpdates must be an array"))?;
    let written = set_prices(&state.pool, book.book_id, items)
        .await
        .map_err(|cause| match cause {
            SetPricesError::Invalid(message) => bad_request(message),
            SetPricesError::OutOfRange => error(StatusCode::INTERNAL_SERVER_ERROR, FAILURE),
            SetPricesError::Database(cause) => failed(cause),
        })?
        .written;
    let count = written.len();
    Ok(Json(json!({
        "message": format!("Successfully updated {count} price(s)"),
        "count": count,
    })))
}

/// The Update Prices modal fetches here, then saves the reviewed values
/// through the bulk route. Nothing is written.
pub(crate) async fn tiingo_prices(
    State(state): State<AppState>,
    Path(raw_book_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult {
    const FAILURE: &str = "Failed to fetch prices from Tiingo";
    authenticate_book(&state, &headers, &raw_book_id, AccessLevel::Write, FAILURE).await?;
    let not_configured = |cause: crate::tiingo::NotConfigured| {
        error_owned(StatusCode::INTERNAL_SERVER_ERROR, cause.to_string())
    };
    // Node checks the key before it reads the body.
    if !state.tiingo.is_configured() {
        return Err(not_configured(crate::tiingo::NotConfigured));
    }
    let body = parse_json_body(&body, FAILURE)?;
    let symbols = body
        .as_object()
        .and_then(|object| object.get("symbols"))
        .and_then(Value::as_array)
        .filter(|symbols| !symbols.is_empty())
        .ok_or_else(|| bad_request("symbols must be a non-empty array"))?;
    let (prices, errors) = state
        .tiingo
        .fetch_latest_prices(symbols)
        .await
        .map_err(not_configured)?;
    Ok(Json(json!({ "prices": prices, "errors": errors })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::to_bytes, response::IntoResponse};

    async fn message(result: Result<impl std::fmt::Debug, ApiError>) -> String {
        let response = result.unwrap_err().into_response();
        let body: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 1024).await.unwrap()).unwrap();
        body["error"].as_str().unwrap().to_owned()
    }

    #[tokio::test]
    async fn price_update_matches_the_zod_schema() {
        for (body, expected) in [
            (json!(null), PRICE_DATE_REQUIRED),
            (json!([]), PRICE_DATE_REQUIRED),
            (
                json!({ "priceDate": "2024-02-30", "priceMicros": 1 }),
                PRICE_DATE_REQUIRED,
            ),
            (json!({ "priceDate": "2024-02-29" }), INVALID_PRICE_MICROS),
            (
                json!({ "priceDate": "2024-02-29", "priceMicros": 1.5 }),
                INVALID_PRICE_MICROS,
            ),
            (
                json!({ "priceDate": "2024-02-29", "priceMicros": 9_007_199_254_740_992_u64 }),
                INVALID_PRICE_MICROS,
            ),
        ] {
            assert_eq!(
                message(validate_price_update(&body)).await,
                expected,
                "{body}"
            );
        }
        assert_eq!(
            validate_price_update(
                &json!({ "priceDate": "2024-02-29", "priceMicros": 2.0, "source": [1, "b"] })
            )
            .unwrap(),
            PriceUpdate {
                price_date: "2024-02-29".into(),
                price_micros: 2,
                source: Some("1,b".into()),
            }
        );
        assert_eq!(
            validate_price_update(
                &json!({ "priceDate": "2024-02-29", "priceMicros": 2, "source": null })
            )
            .unwrap()
            .source,
            None
        );
    }

    #[test]
    fn bulk_items_that_fail_the_schema_are_dropped() {
        let valid =
            json!({ "securityId": 3, "priceMicros": 1e3, "priceDate": "2025-01-02", "x": 1 });
        assert_eq!(
            price_item(&valid),
            Some(PriceItem {
                security_id: 3,
                price_micros: 1000,
                price_date: "2025-01-02".into(),
            })
        );
        for item in [
            json!(null),
            json!([3, 1, "2025-01-02"]),
            json!({ "securityId": "3", "priceMicros": 1, "priceDate": "2025-01-02" }),
            json!({ "securityId": 3, "priceMicros": -1, "priceDate": "2025-01-02" }),
            json!({ "securityId": 3, "priceMicros": 1, "priceDate": "2025-1-02" }),
        ] {
            assert_eq!(price_item(&item), None, "{item}");
        }
    }
}
