use super::investments::{EFFECTIVE_DATE, MAX_SAFE_INTEGER, positions};
use crate::{
    book_auth::{AccessLevel, authenticate_book},
    error::{ApiError, ApiResult, error, error_owned, internal_error},
    state::AppState,
    validation::{
        expected, first_query_values, is_js_whitespace, local_today, parse_int_prefix,
        parse_js_number, parse_json_body,
    },
};
use axum::{
    Json,
    body::Bytes,
    extract::{Path, RawQuery, State},
    http::{HeaderMap, StatusCode},
};
use chrono::{NaiveDateTime, SecondsFormat, Utc};
use ledger_core::{accounting::round_js, collation::compare_names, investments::fixed_price_row};
use ledger_db::engine::{Db, DbPool};
use ledger_db::sql;
use serde::Serialize;
use serde_json::{Map, Value, json, to_value};
use sqlx::{FromRow, QueryBuilder};
use std::collections::HashMap;

const SECURITY_COLUMNS: &str =
    "id, book_id, name, symbol, security_type, fetch_prices, created_at, fixed_price_micros";
const SECURITY_TYPES: [&str; 3] = ["etf", "mutual_fund", "stock"];
const SECURITY_TYPE_MESSAGE: &str = "securityType must be one of: etf, mutual_fund, stock";
const FIXED_PRICE_MESSAGE: &str = "fixedPriceMicros must be a positive whole number of micros";

#[derive(FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SecurityRecord {
    id: i32,
    book_id: i32,
    name: String,
    symbol: String,
    security_type: String,
    fetch_prices: bool,
    #[serde(serialize_with = "serialize_timestamp")]
    created_at: NaiveDateTime,
    fixed_price_micros: Option<i64>,
}

fn serialize_timestamp<S: serde::Serializer>(
    value: &NaiveDateTime,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(&value.and_utc().to_rfc3339_opts(SecondsFormat::Millis, true))
}

fn bad_request(message: &'static str) -> ApiError {
    error(StatusCode::BAD_REQUEST, message)
}

fn js_trim(value: &str) -> &str {
    value.trim_matches(is_js_whitespace)
}

fn account_label(account_id: Option<i32>, name: Option<String>) -> String {
    match account_id {
        None => "All Accounts".to_owned(),
        Some(id) => name.unwrap_or_else(|| format!("Account {id}")),
    }
}

/// The security routes read the path with `Number.parseInt(id, 10)`. NaN is
/// a 400. A number outside the int4 range reaches the query, which fails,
/// and the route returns its 500 message.
pub(super) fn security_path_id(raw: &str, failure: &'static str) -> Result<i32, ApiError> {
    let id = parse_int_prefix(raw).ok_or_else(|| bad_request("Invalid security id"))?;
    i32::try_from(id).map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, failure))
}

pub(super) async fn find_security(
    pool: &DbPool,
    book_id: i32,
    security_id: i32,
    failure: &'static str,
) -> Result<SecurityRecord, ApiError> {
    let query = format!("SELECT {SECURITY_COLUMNS} FROM securities WHERE id = $1 AND book_id = $2");
    sqlx::query_as(&query)
        .bind(security_id)
        .bind(book_id)
        .fetch_optional(pool)
        .await
        .map_err(|cause| internal_error(cause, failure))?
        .ok_or_else(|| error(StatusCode::NOT_FOUND, "Security not found"))
}

/// `fixedPriceMicrosSchema`: absent is `None`, JSON null is `Some(None)`.
fn fixed_price_micros(value: Option<&Value>) -> Result<Option<Option<i64>>, ApiError> {
    match value {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(value) => value
            .as_f64()
            .filter(|number| number.fract() == 0.0 && *number > 0.0 && *number <= MAX_SAFE_INTEGER)
            .map(|number| Some(Some(number as i64)))
            .ok_or_else(|| bad_request(FIXED_PRICE_MESSAGE)),
    }
}

fn security_type(value: Option<&Value>) -> Result<String, ApiError> {
    value
        .and_then(Value::as_str)
        .filter(|value| SECURITY_TYPES.contains(value))
        .map(str::to_owned)
        .ok_or_else(|| bad_request(SECURITY_TYPE_MESSAGE))
}

#[derive(Debug, PartialEq)]
struct SecurityCreate {
    name: String,
    symbol: String,
    security_type: String,
    fetch_prices: Option<bool>,
    fixed_price_micros: Option<i64>,
}

/// `createSecuritySchema`, then the trims and checks of `createSecurity()`.
fn validate_create(body: &Value) -> Result<SecurityCreate, ApiError> {
    let object = body
        .as_object()
        .ok_or_else(|| bad_request("Name is required"))?;
    let required = |key: &str, message: &'static str| {
        object
            .get(key)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| bad_request(message))
    };
    let name = required("name", "Name is required")?;
    let symbol = required("symbol", "Symbol is required")?;
    let security_type = security_type(object.get("securityType"))?;
    let fetch_prices = object
        .get("fetchPrices")
        .map(|value| {
            value
                .as_bool()
                .ok_or_else(|| bad_request("fetchPrices must be a boolean"))
        })
        .transpose()?;
    let fixed_price_micros = fixed_price_micros(object.get("fixedPriceMicros"))?.flatten();
    let (name, symbol) = (js_trim(name), js_trim(symbol));
    if name.is_empty() {
        return Err(bad_request("Name is required"));
    }
    if symbol.is_empty() {
        return Err(bad_request("Symbol is required"));
    }
    Ok(SecurityCreate {
        name: name.to_owned(),
        symbol: symbol.to_owned(),
        security_type,
        fetch_prices,
        fixed_price_micros,
    })
}

#[derive(Debug, Default, PartialEq)]
struct SecurityUpdate {
    name: Option<String>,
    symbol: Option<String>,
    security_type: Option<String>,
    fetch_prices: Option<bool>,
    fixed_price_micros: Option<Option<i64>>,
}

/// `updateSecuritySchema`, then the trims and checks of `updateSecurity()`
/// that run before it reads the database.
fn validate_update(body: &Value) -> Result<SecurityUpdate, ApiError> {
    let object = body.as_object().ok_or_else(|| expected("object", body))?;
    let text = |key: &str| {
        object
            .get(key)
            .map(|value| value.as_str().ok_or_else(|| expected("string", value)))
            .transpose()
    };
    let name = text("name")?;
    let symbol = text("symbol")?;
    let security_type = object
        .get("securityType")
        .map(|value| security_type(Some(value)))
        .transpose()?;
    let fetch_prices = object
        .get("fetchPrices")
        .map(|value| {
            value
                .as_bool()
                .ok_or_else(|| bad_request("Fetch prices must be a boolean"))
        })
        .transpose()?;
    let fixed_price_micros = fixed_price_micros(object.get("fixedPriceMicros"))?;
    let name = name.map(js_trim);
    let symbol = symbol.map(js_trim);
    if name == Some("") {
        return Err(bad_request("Name is required"));
    }
    if symbol == Some("") {
        return Err(bad_request("Symbol is required"));
    }
    // Setting a fixed price turns fetching off. Clearing it leaves fetching
    // as it is.
    let fetch_prices = match fixed_price_micros {
        Some(Some(_)) => Some(false),
        _ => fetch_prices,
    };
    let update = SecurityUpdate {
        name: name.map(str::to_owned),
        symbol: symbol.map(str::to_owned),
        security_type,
        fetch_prices,
        fixed_price_micros,
    };
    if update == SecurityUpdate::default() {
        return Err(bad_request("No fields to update"));
    }
    Ok(update)
}

pub(crate) async fn list_securities(
    State(state): State<AppState>,
    Path(raw_book_id): Path<String>,
    headers: HeaderMap,
) -> ApiResult {
    const FAILURE: &str = "Failed to fetch securities";
    let book =
        authenticate_book(&state, &headers, &raw_book_id, AccessLevel::Read, FAILURE).await?;
    let failed = |cause| internal_error(cause, FAILURE);
    let securities: Vec<(i32, String, String, String, bool, Option<i64>)> = sqlx::query_as(
        "SELECT id, name, symbol, security_type, fetch_prices, fixed_price_micros
         FROM securities WHERE book_id = $1 ORDER BY name, id",
    )
    .bind(book.book_id)
    .fetch_all(&state.pool)
    .await
    .map_err(failed)?;
    // Book-wide, so a holding in an inactive account counts.
    let positions: HashMap<i64, _> = positions(&state.pool, book.book_id, None)
        .await
        .map_err(failed)?
        .into_iter()
        .map(|position| (position.security_id, position))
        .collect();

    // Income is the positive asset legs of each dividend or capital-gain
    // transaction. A dividend that withholds tax also debits an expense
    // account, which is not cash received.
    let income_splits: Vec<(i32, i32)> = sqlx::query_as(
        "SELECT transaction_id, security_id FROM investment_splits
         WHERE book_id = $1 AND action IN ('dividend', 'capGain')",
    )
    .bind(book.book_id)
    .fetch_all(&state.pool)
    .await
    .map_err(failed)?;
    let transaction_ids: Vec<i32> = income_splits.iter().map(|(id, _)| *id).collect();
    let cash: HashMap<i32, i64> = if transaction_ids.is_empty() {
        HashMap::new()
    } else {
        sqlx::query_as::<_, (i32, i64)>(&format!(
            "SELECT s.transaction_id, CAST(SUM(s.amount) AS bigint)
             FROM transaction_splits s JOIN accounts a ON a.id = s.account_id
             WHERE s.transaction_id {} AND a.type = 'asset' AND s.amount > 0
             GROUP BY s.transaction_id",
            sql::in_integers("$1")
        ))
        .bind(sql::json_array(&transaction_ids))
        .fetch_all(&state.pool)
        .await
        .map_err(failed)?
        .into_iter()
        .collect()
    };
    let mut income: HashMap<i32, i64> = HashMap::new();
    for (transaction_id, security_id) in income_splits {
        *income.entry(security_id).or_default() += cash.get(&transaction_id).copied().unwrap_or(0);
    }

    let rows: Vec<Value> = securities
        .into_iter()
        .map(
            |(id, name, symbol, security_type, fetch_prices, fixed_price_micros)| {
                let position = positions.get(&i64::from(id));
                json!({
                    "id": id,
                    "name": name,
                    "symbol": symbol,
                    "securityType": security_type,
                    "fetchPrices": fetch_prices,
                    "fixedPriceMicros": fixed_price_micros,
                    "sharesMicros": position.map_or(0, |p| p.shares_micros),
                    "costBasisCents": position.map_or(0, |p| p.cost_basis_cents),
                    "priceMicros": position.and_then(|p| p.price_micros),
                    "priceDate": position.and_then(|p| p.price_date.clone()),
                    "marketValueCents": position.and_then(|p| p.market_value_cents),
                    "incomeCents": income.get(&id).copied().unwrap_or(0),
                })
            },
        )
        .collect();
    Ok(Json(Value::Array(rows)))
}

pub(crate) async fn create_security(
    State(state): State<AppState>,
    Path(raw_book_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult {
    const FAILURE: &str = "Failed to create security";
    let book =
        authenticate_book(&state, &headers, &raw_book_id, AccessLevel::Write, FAILURE).await?;
    let input = validate_create(&parse_json_body(&body, FAILURE)?)?;
    let existing: Option<i32> = sqlx::query_scalar(
        "SELECT id FROM securities WHERE book_id = $1 AND lower(symbol) = lower($2) LIMIT 1",
    )
    .bind(book.book_id)
    .bind(&input.symbol)
    .fetch_optional(&state.pool)
    .await
    .map_err(|cause| internal_error(cause, FAILURE))?;
    if let Some(existing) = existing {
        return Err(error_owned(
            StatusCode::CONFLICT,
            format!(
                "A security with symbol \"{}\" already exists (id {existing})",
                input.symbol
            ),
        ));
    }
    // A fixed price has no feed, so it turns fetching off.
    let fetch_prices = if input.fixed_price_micros.is_some() {
        false
    } else {
        input.fetch_prices.unwrap_or(true)
    };
    let query = format!(
        "INSERT INTO securities
           (book_id, name, symbol, security_type, fixed_price_micros, fetch_prices, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING {SECURITY_COLUMNS}"
    );
    let created: SecurityRecord = sqlx::query_as(&query)
        .bind(book.book_id)
        .bind(&input.name)
        .bind(&input.symbol)
        .bind(&input.security_type)
        .bind(input.fixed_price_micros)
        .bind(fetch_prices)
        .bind(Utc::now().naive_utc())
        .fetch_one(&state.pool)
        .await
        .map_err(|cause| internal_error(cause, FAILURE))?;
    Ok(Json(to_value(created).expect("security serializes")))
}

pub(crate) async fn get_security(
    State(state): State<AppState>,
    Path((raw_book_id, raw_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> ApiResult {
    const FAILURE: &str = "Failed to fetch security";
    let book =
        authenticate_book(&state, &headers, &raw_book_id, AccessLevel::Read, FAILURE).await?;
    let security_id = security_path_id(&raw_id, FAILURE)?;
    let security = find_security(&state.pool, book.book_id, security_id, FAILURE).await?;
    Ok(Json(to_value(security).expect("security serializes")))
}

/// The ID of another security in the book that has this symbol, compared
/// without case. `updateSecurity()` refuses such a symbol with a
/// `SecurityDuplicateError` that names this ID. The route answers with its
/// 500 message; the MCP tool writes the library's message.
pub(crate) async fn clashing_symbol(
    pool: &DbPool,
    book_id: i32,
    security_id: i32,
    symbol: &str,
) -> Result<Option<i32>, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT id FROM securities
         WHERE book_id = $1 AND id <> $2 AND lower(symbol) = lower($3) LIMIT 1",
    )
    .bind(book_id)
    .bind(security_id)
    .bind(symbol)
    .fetch_optional(pool)
    .await
}

pub(crate) async fn update_security(
    State(state): State<AppState>,
    Path((raw_book_id, raw_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult {
    const FAILURE: &str = "Failed to update security";
    let book =
        authenticate_book(&state, &headers, &raw_book_id, AccessLevel::Write, FAILURE).await?;
    // Node reads the body before it checks the ID, and validates the body
    // before an out-of-range ID fails at the database.
    let body = parse_json_body(&body, FAILURE)?;
    let security_id =
        parse_int_prefix(&raw_id).ok_or_else(|| bad_request("Invalid security id"))?;
    let input = validate_update(&body)?;
    let security_id = i32::try_from(security_id)
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, FAILURE))?;
    find_security(&state.pool, book.book_id, security_id, FAILURE).await?;
    if let Some(symbol) = &input.symbol {
        // The route does not map the duplicate error of updateSecurity(), so
        // a clash is its 500 message.
        let clash = clashing_symbol(&state.pool, book.book_id, security_id, symbol)
            .await
            .map_err(|cause| internal_error(cause, FAILURE))?;
        if clash.is_some() {
            return Err(error(StatusCode::INTERNAL_SERVER_ERROR, FAILURE));
        }
    }
    let mut update = QueryBuilder::<Db>::new("UPDATE securities SET ");
    let mut fields = update.separated(", ");
    if let Some(name) = &input.name {
        fields.push("name = ").push_bind_unseparated(name);
    }
    if let Some(symbol) = &input.symbol {
        fields.push("symbol = ").push_bind_unseparated(symbol);
    }
    if let Some(security_type) = &input.security_type {
        fields
            .push("security_type = ")
            .push_bind_unseparated(security_type);
    }
    if let Some(fetch_prices) = input.fetch_prices {
        fields
            .push("fetch_prices = ")
            .push_bind_unseparated(fetch_prices);
    }
    if let Some(fixed_price_micros) = input.fixed_price_micros {
        fields
            .push("fixed_price_micros = ")
            .push_bind_unseparated(fixed_price_micros);
    }
    update
        .push(" WHERE id = ")
        .push_bind(security_id)
        .push(" AND book_id = ")
        .push_bind(book.book_id)
        .push(format!(" RETURNING {SECURITY_COLUMNS}"));
    let updated: SecurityRecord = update
        .build_query_as()
        .fetch_optional(&state.pool)
        .await
        .map_err(|cause| internal_error(cause, FAILURE))?
        .ok_or_else(|| error(StatusCode::NOT_FOUND, "Security not found"))?;
    Ok(Json(to_value(updated).expect("security serializes")))
}

pub(crate) async fn delete_security(
    State(state): State<AppState>,
    Path((raw_book_id, raw_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> ApiResult {
    const FAILURE: &str = "Failed to delete security";
    let book =
        authenticate_book(&state, &headers, &raw_book_id, AccessLevel::Write, FAILURE).await?;
    let security_id = security_path_id(&raw_id, FAILURE)?;
    // Splits, lots, and prices cascade from a security, so a delete would
    // erase its investment history and leave the transactions in place.
    let splits: i32 = sqlx::query_scalar(
        "SELECT CAST(COUNT(*) AS integer) FROM investment_splits
         WHERE security_id = $1 AND book_id = $2",
    )
    .bind(security_id)
    .bind(book.book_id)
    .fetch_one(&state.pool)
    .await
    .map_err(|cause| internal_error(cause, FAILURE))?;
    if splits > 0 {
        return Err(bad_request(
            "Cannot delete security with investment transactions",
        ));
    }
    let deleted = sqlx::query("DELETE FROM securities WHERE id = $1 AND book_id = $2")
        .bind(security_id)
        .bind(book.book_id)
        .execute(&state.pool)
        .await
        .map_err(|cause| internal_error(cause, FAILURE))?;
    if deleted.rows_affected() == 0 {
        return Err(error(StatusCode::NOT_FOUND, "Security not found"));
    }
    Ok(Json(json!({ "success": true })))
}

#[derive(FromRow)]
struct SecuritySplitRecord {
    id: i32,
    transaction_id: i32,
    transaction_date: String,
    transaction_description: Option<String>,
    account_id: Option<i32>,
    account_name: Option<String>,
    account_is_active: Option<bool>,
    action: String,
    shares_micros: i64,
    price_micros: i64,
    fees_cents: i32,
    split_numerator: Option<i32>,
    split_denominator: Option<i32>,
}

impl SecuritySplitRecord {
    fn json(&self) -> Map<String, Value> {
        let value = json!({
            "id": self.id,
            "transactionId": self.transaction_id,
            "transactionDate": self.transaction_date,
            "transactionDescription": self.transaction_description,
            "accountId": self.account_id,
            "accountName": account_label(self.account_id, self.account_name.clone()),
            "action": self.action,
            "sharesMicros": self.shares_micros,
            "priceMicros": self.price_micros,
            "feesCents": self.fees_cents,
            "splitNumerator": self.split_numerator,
            "splitDenominator": self.split_denominator,
        });
        let Value::Object(map) = value else {
            unreachable!("json! object")
        };
        map
    }

    fn ratio(&self) -> Option<f64> {
        match (self.split_numerator, self.split_denominator) {
            (Some(numerator), Some(denominator)) if numerator != 0 && denominator != 0 => {
                Some(f64::from(numerator) / f64::from(denominator))
            }
            _ => None,
        }
    }
}

fn security_split_query() -> String {
    format!(
        "SELECT s.id, s.transaction_id, {EFFECTIVE_DATE} AS transaction_date,
                t.description AS transaction_description, s.account_id,
                a.name AS account_name, a.is_active AS account_is_active, s.action,
                s.shares_micros, s.price_micros, s.fees_cents, s.split_numerator,
                s.split_denominator
         FROM investment_splits s
         JOIN transactions t ON t.id = s.transaction_id
         LEFT JOIN accounts a ON a.id = s.account_id
         WHERE s.security_id = $1 AND s.book_id = $2"
    )
}

/// The detail route's own market value: a floating-point product rounded
/// once, not the exact micros product the rest of the app uses.
fn float_value_cents(shares_micros: i64, price_micros: i64) -> i64 {
    round_js((shares_micros as f64 / 1_000_000.0) * (price_micros as f64 / 1_000_000.0) * 100.0)
}

struct AccountPosition {
    account_id: i32,
    account_name: String,
    is_active: bool,
    shares_micros: i64,
}

pub(crate) async fn security_detail(
    State(state): State<AppState>,
    Path((raw_book_id, raw_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> ApiResult {
    const FAILURE: &str = "Failed to fetch security detail";
    let book =
        authenticate_book(&state, &headers, &raw_book_id, AccessLevel::Read, FAILURE).await?;
    let failed = |cause| internal_error(cause, FAILURE);
    let security_id = security_path_id(&raw_id, FAILURE)?;
    let security = find_security(&state.pool, book.book_id, security_id, FAILURE).await?;
    let latest: Option<(i64, String)> = sqlx::query_as(
        "SELECT price_micros, price_date FROM security_prices
         WHERE security_id = $1 AND book_id = $2 ORDER BY price_date DESC LIMIT 1",
    )
    .bind(security_id)
    .bind(book.book_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(failed)?;
    let query = format!(
        "{} ORDER BY {EFFECTIVE_DATE} ASC, s.id ASC",
        security_split_query()
    );
    let splits: Vec<SecuritySplitRecord> = sqlx::query_as(&query)
        .bind(security_id)
        .bind(book.book_id)
        .fetch_all(&state.pool)
        .await
        .map_err(failed)?;
    let basis: HashMap<i32, i32> = sqlx::query_as(
        "SELECT account_id, CAST(COALESCE(SUM(remaining_basis_cents), 0) AS integer)
         FROM investment_lots
         WHERE book_id = $1 AND security_id = $2 AND remaining_shares_micros > 0
         GROUP BY account_id",
    )
    .bind(book.book_id)
    .bind(security_id)
    .fetch_all(&state.pool)
    .await
    .map_err(failed)?
    .into_iter()
    .collect();

    // A fixed price replaces every recorded price.
    let latest = match security.fixed_price_micros {
        Some(price) => {
            let row = fixed_price_row(i64::from(security.id), price, &local_today());
            Some((row.price_micros, row.price_date))
        }
        None => latest,
    };

    // Accounts in first-seen order, which is the order of a JavaScript Map.
    let mut held: Vec<AccountPosition> = Vec::new();
    fn position<'a>(
        held: &'a mut Vec<AccountPosition>,
        split: &SecuritySplitRecord,
        account_id: i32,
    ) -> &'a mut AccountPosition {
        let index = match held.iter().position(|row| row.account_id == account_id) {
            Some(index) => index,
            None => {
                held.push(AccountPosition {
                    account_id,
                    account_name: split
                        .account_name
                        .clone()
                        .unwrap_or_else(|| format!("Account {account_id}")),
                    is_active: split.account_is_active.unwrap_or(true),
                    shares_micros: 0,
                });
                held.len() - 1
            }
        };
        &mut held[index]
    }
    for split in &splits {
        if split.action == "split" {
            let Some(ratio) = split.ratio() else { continue };
            match split.account_id {
                None => {
                    for row in &mut held {
                        row.shares_micros = round_js(row.shares_micros as f64 * ratio);
                    }
                }
                Some(account_id) => {
                    let row = position(&mut held, split, account_id);
                    row.shares_micros = round_js(row.shares_micros as f64 * ratio);
                }
            }
            continue;
        }
        let Some(account_id) = split.account_id else {
            continue;
        };
        let delta = match split.action.as_str() {
            "buy" => split.shares_micros,
            "sell" => -split.shares_micros,
            _ => continue,
        };
        position(&mut held, split, account_id).shares_micros += delta;
    }
    let mut held: Vec<AccountPosition> = held
        .into_iter()
        .filter(|row| row.shares_micros > 0)
        .collect();
    held.sort_by(|a, b| compare_names(&a.account_name, &b.account_name));
    let positions: Vec<Value> = held
        .iter()
        .map(|row| {
            json!({
                "accountId": row.account_id,
                "accountName": row.account_name,
                "isActive": row.is_active,
                "sharesMicros": row.shares_micros,
                "costBasisCents": basis.get(&row.account_id).copied().unwrap_or(0),
                "marketValueCents": latest
                    .as_ref()
                    .map(|(price, _)| float_value_cents(row.shares_micros, *price)),
            })
        })
        .collect();

    let mut newest_first: Vec<&SecuritySplitRecord> = splits.iter().collect();
    newest_first.sort_by(|a, b| {
        b.transaction_date
            .cmp(&a.transaction_date)
            .then(b.id.cmp(&a.id))
    });
    let mut security_json = to_value(&security).expect("security serializes");
    security_json["latestPriceMicros"] = json!(latest.as_ref().map(|(price, _)| *price));
    security_json["latestPriceDate"] = json!(latest.as_ref().map(|(_, date)| date));
    Ok(Json(json!({
        "security": security_json,
        "positionsByAccount": positions,
        "splits": newest_first.iter().map(|split| Value::Object(split.json())).collect::<Vec<_>>(),
    })))
}

#[derive(FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
struct LotRow {
    lot_id: i32,
    account_id: i32,
    account_name: String,
    acquired_date: String,
    shares_micros: i64,
    basis_cents: i32,
}

pub(crate) async fn security_lots(
    State(state): State<AppState>,
    Path((raw_book_id, raw_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> ApiResult {
    const FAILURE: &str = "Failed to fetch lots";
    let book =
        authenticate_book(&state, &headers, &raw_book_id, AccessLevel::Read, FAILURE).await?;
    let security_id = security_path_id(&raw_id, FAILURE)?;
    find_security(&state.pool, book.book_id, security_id, FAILURE).await?;
    let rows: Vec<LotRow> = sqlx::query_as(
        "SELECT l.id AS lot_id, l.account_id, a.name AS account_name, l.acquired_date,
                l.remaining_shares_micros AS shares_micros, l.remaining_basis_cents AS basis_cents
         FROM investment_lots l JOIN accounts a ON a.id = l.account_id
         WHERE l.book_id = $1 AND l.security_id = $2 AND l.remaining_shares_micros > 0
         ORDER BY l.acquired_date ASC, l.id ASC",
    )
    .bind(book.book_id)
    .bind(security_id)
    .fetch_all(&state.pool)
    .await
    .map_err(|cause| internal_error(cause, FAILURE))?;
    Ok(Json(to_value(rows).expect("lots serialize")))
}

/// `securitySplitListQuery`: a malformed value falls back to the default and
/// never fails. `Number()` reads the value; zod's `int()` rejects a value
/// beyond the safe-integer range.
pub(super) fn page_param(raw: Option<&String>, minimum: f64) -> Option<i64> {
    let value = parse_js_number(raw.filter(|raw| !raw.is_empty())?)?;
    (value.is_finite()
        && value.fract() == 0.0
        && value.abs() <= MAX_SAFE_INTEGER
        && value >= minimum)
        .then_some(value as i64)
}

pub(crate) async fn security_splits(
    State(state): State<AppState>,
    Path((raw_book_id, raw_id)): Path<(String, String)>,
    RawQuery(raw_query): RawQuery,
    headers: HeaderMap,
) -> ApiResult {
    const FAILURE: &str = "Failed to fetch security splits";
    let book =
        authenticate_book(&state, &headers, &raw_book_id, AccessLevel::Read, FAILURE).await?;
    let failed = |cause| internal_error(cause, FAILURE);
    let security_id = security_path_id(&raw_id, FAILURE)?;
    find_security(&state.pool, book.book_id, security_id, FAILURE).await?;
    let params = first_query_values(raw_query.as_deref());
    let limit = page_param(params.get("limit"), 1.0).map_or(50, |limit| limit.min(200));
    let offset = page_param(params.get("offset"), 0.0).unwrap_or(0);

    let query = format!(
        "{} ORDER BY {EFFECTIVE_DATE} DESC, s.id DESC LIMIT COALESCE($3, -1) OFFSET COALESCE($4, 0)",
        security_split_query()
    );
    let splits: Vec<SecuritySplitRecord> = sqlx::query_as(&query)
        .bind(security_id)
        .bind(book.book_id)
        .bind(limit)
        .bind(offset)
        .fetch_all(&state.pool)
        .await
        .map_err(failed)?;
    let total: i32 = sqlx::query_scalar(
        "SELECT CAST(COUNT(*) AS integer) FROM investment_splits
         WHERE security_id = $1 AND book_id = $2",
    )
    .bind(security_id)
    .bind(book.book_id)
    .fetch_one(&state.pool)
    .await
    .map_err(failed)?;

    let is_income =
        |split: &SecuritySplitRecord| matches!(split.action.as_str(), "dividend" | "capGain");
    let income_ids: Vec<i32> = splits
        .iter()
        .filter(|split| is_income(split))
        .map(|split| split.transaction_id)
        .collect();
    // The cash amount is the positive asset legs. A dividend that withholds
    // tax also debits an expense account, which is not cash.
    let cash: HashMap<i32, i64> = if income_ids.is_empty() {
        HashMap::new()
    } else {
        sqlx::query_as::<_, (i32, i64)>(&format!(
            "SELECT s.transaction_id, CAST(SUM(s.amount) AS bigint)
             FROM transaction_splits s JOIN accounts a ON a.id = s.account_id
             WHERE s.transaction_id {} AND a.type = 'asset' AND s.amount > 0
             GROUP BY s.transaction_id",
            sql::in_integers("$1")
        ))
        .bind(sql::json_array(&income_ids))
        .fetch_all(&state.pool)
        .await
        .map_err(failed)?
        .into_iter()
        .collect()
    };
    let has_more = offset + (splits.len() as i64) < i64::from(total);
    let rows: Vec<Value> = splits
        .iter()
        .map(|split| {
            let mut row = split.json();
            if is_income(split) {
                row.insert(
                    "cashAmountCents".to_owned(),
                    json!(cash.get(&split.transaction_id).copied().unwrap_or(0)),
                );
            }
            Value::Object(row)
        })
        .collect();
    Ok(Json(json!({
        "splits": rows,
        "totalCount": total,
        "hasMore": has_more,
    })))
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
    async fn create_and_update_inputs_match_node() {
        for (body, expected) in [
            (json!([]), "Name is required"),
            (
                json!({"name": 5, "symbol": 5, "securityType": "x"}),
                "Name is required",
            ),
            (json!({"name": " "}), "Symbol is required"),
            (json!({"name": "A", "symbol": "B"}), SECURITY_TYPE_MESSAGE),
            (
                json!({"name": "A", "symbol": "B", "securityType": "etf", "fetchPrices": null}),
                "fetchPrices must be a boolean",
            ),
            (
                json!({"name": "A", "symbol": "B", "securityType": "etf", "fixedPriceMicros": 9007199254740992_i64}),
                FIXED_PRICE_MESSAGE,
            ),
            (
                json!({"name": " ", "symbol": "B", "securityType": "etf"}),
                "Name is required",
            ),
        ] {
            assert_eq!(message(validate_create(&body)).await, expected, "{body}");
        }
        assert_eq!(
            validate_create(&json!({
                "name": "\u{feff} Fund ", "symbol": " VTI", "securityType": "etf",
                "fixedPriceMicros": 1_000_000, "bookId": 9
            }))
            .unwrap(),
            SecurityCreate {
                name: "Fund".into(),
                symbol: "VTI".into(),
                security_type: "etf".into(),
                fetch_prices: None,
                fixed_price_micros: Some(1_000_000),
            }
        );
        for (body, expected) in [
            (json!(null), "Invalid input: expected object, received null"),
            (
                json!({"name": 5, "fetchPrices": "x"}),
                "Invalid input: expected string, received number",
            ),
            (json!({"securityType": null}), SECURITY_TYPE_MESSAGE),
            (
                json!({"fetchPrices": "x"}),
                "Fetch prices must be a boolean",
            ),
            (json!({"fixedPriceMicros": 0}), FIXED_PRICE_MESSAGE),
            (json!({}), "No fields to update"),
            (json!({"symbol": " "}), "Symbol is required"),
        ] {
            assert_eq!(message(validate_update(&body)).await, expected, "{body}");
        }
        let update = validate_update(&json!({"fixedPriceMicros": 5, "fetchPrices": true})).unwrap();
        assert_eq!(update.fetch_prices, Some(false));
        let cleared = validate_update(&json!({"fixedPriceMicros": null})).unwrap();
        assert_eq!(cleared.fixed_price_micros, Some(None));
        assert_eq!(cleared.fetch_prices, None);
    }

    #[test]
    fn page_params_fall_back_like_zod_catch() {
        let param = |raw: &str, minimum| page_param(Some(&raw.to_owned()), minimum);
        assert_eq!(param("1e2", 1.0), Some(100));
        assert_eq!(param(" 7 ", 1.0), Some(7));
        assert_eq!(param("0x10", 0.0), Some(16));
        assert_eq!(param("-0", 0.0), Some(0));
        for raw in ["-1", "1e300", "9007199254740993", "Infinity", "abc"] {
            assert_eq!(param(raw, 0.0), None, "{raw}");
        }
        assert_eq!(param("0", 1.0), None);
    }

    #[test]
    fn detail_value_uses_the_floating_point_product() {
        assert_eq!(float_value_cents(1_000_000, 10_005_000), 1001);
        assert_eq!(float_value_cents(3_000_000, 333_333), 100);
    }
}
