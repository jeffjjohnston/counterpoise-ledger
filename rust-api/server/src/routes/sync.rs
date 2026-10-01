//! Plaid connections, account mappings, and the sync read routes.

use crate::{
    book_auth::{AccessLevel, authenticate_book},
    error::{ApiError, ApiResult, error, error_owned, internal_error},
    plaid::is_configuration_error,
    routes::transactions::{AccountRow, now_millis, serialize_timestamp},
    state::AppState,
    typesafe::record_unlink,
    validation::{
        first_query_values, is_js_whitespace, js_number, js_string, parse_int_prefix_number,
        parse_js_number, parse_json_body,
    },
};
use axum::{
    Json,
    body::Bytes,
    extract::{Path, RawQuery, State},
    http::{HeaderMap, StatusCode},
};
use chrono::{Days, Local, NaiveDateTime, SecondsFormat};
use ledger_db::engine::Db;
use ledger_db::sql;
use serde::Serialize;
use serde_json::{Map, Value, json, to_value};
use sqlx::FromRow;
use sqlx::QueryBuilder;
use std::collections::{HashMap, HashSet};

pub(crate) fn bad_request(message: &'static str) -> ApiError {
    error(StatusCode::BAD_REQUEST, message)
}

pub(crate) fn iso_timestamp(value: NaiveDateTime) -> String {
    value.and_utc().to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// `parseInt(raw, 10)` with the `Number.isFinite` check of `parseTokenId`.
/// The number is not yet converted: a value outside the int4 range passes
/// here, and PostgreSQL refuses it only when a query binds it.
pub(crate) fn finite_path_id(raw: &str, invalid_message: &'static str) -> Result<f64, ApiError> {
    parse_int_prefix_number(raw)
        .filter(|value| value.is_finite())
        .ok_or_else(|| bad_request(invalid_message))
}

/// Node binds the parsed number to an `integer` column. PostgreSQL rejects a
/// value outside the int4 range, and the route returns its 500 message.
pub(crate) fn database_id(value: f64, failure_message: &'static str) -> Result<i32, ApiError> {
    if (f64::from(i32::MIN)..=f64::from(i32::MAX)).contains(&value) {
        // The value is a whole number, so this conversion is exact.
        Ok(value as i32)
    } else {
        Err(error(StatusCode::INTERNAL_SERVER_ERROR, failure_message))
    }
}

// ---------------------------------------------------------------------------
// Pending count
// ---------------------------------------------------------------------------

pub(crate) async fn pending_count(
    State(state): State<AppState>,
    Path(raw_book_id): Path<String>,
    headers: HeaderMap,
) -> ApiResult {
    let book = authenticate_book(
        &state,
        &headers,
        &raw_book_id,
        AccessLevel::Read,
        "Failed to fetch pending count",
    )
    .await?;
    let count: i32 = sqlx::query_scalar(
        "SELECT CAST(COUNT(*) AS integer)
         FROM plaid_transaction_reconciliation r
         JOIN plaid_accounts a ON a.id = r.plaid_account_link_id
         WHERE r.book_id = $1
           AND a.counterpoise_account_id IS NOT NULL
           AND ((r.resolution_status = 'pending' AND r.review_reason IS NULL)
                OR r.review_reason IS NOT NULL)",
    )
    .bind(book.book_id)
    .fetch_one(&state.pool)
    .await
    .map_err(|cause| internal_error(cause, "Failed to fetch pending count"))?;
    Ok(Json(json!({ "count": count })))
}

// ---------------------------------------------------------------------------
// Connections (Plaid tokens)
// ---------------------------------------------------------------------------

const INVALID_TOKEN_ID: &str = "Invalid token id";
const TOKEN_NOT_FOUND: &str = "Token not found";
const DUPLICATE_ITEM: &str = "A token with this itemId already exists";
const CREATE_TOKEN_REQUIRED: &str = "financialInstitution, itemId, and accessToken are required";
const UPDATE_TOKEN_REQUIRED: &str = "financialInstitution and itemId are required";

const TOKEN_COLUMNS: &str =
    "id, financial_institution, item_id, access_token, created_at, updated_at";

#[derive(FromRow)]
struct TokenRow {
    id: i32,
    financial_institution: String,
    item_id: String,
    access_token: String,
    created_at: NaiveDateTime,
    updated_at: NaiveDateTime,
}

/// `maskAccessToken`: the first and last four characters, with at least
/// eight asterisks between them. JavaScript counts UTF-16 code units.
fn mask_access_token(token: &str) -> String {
    let units: Vec<u16> = token.encode_utf16().collect();
    if units.len() <= 8 {
        return "*".repeat(units.len());
    }
    let prefix = String::from_utf16_lossy(&units[..4]);
    let suffix = String::from_utf16_lossy(&units[units.len() - 4..]);
    let middle = "*".repeat((units.len() - 8).max(8));
    format!("{prefix}{middle}{suffix}")
}

/// `toTokenListItem`: never the access token itself.
fn token_item(row: &TokenRow) -> Map<String, Value> {
    let mut item = Map::new();
    item.insert("id".into(), json!(row.id));
    item.insert(
        "financialInstitution".into(),
        json!(row.financial_institution),
    );
    item.insert("itemId".into(), json!(row.item_id));
    item.insert(
        "accessTokenMasked".into(),
        json!(mask_access_token(&row.access_token)),
    );
    item.insert("createdAt".into(), json!(iso_timestamp(row.created_at)));
    item.insert("updatedAt".into(), json!(iso_timestamp(row.updated_at)));
    item
}

/// `z.string().trim().min(1)` with one message for every failure. The body
/// is a JSON object, or every field fails with the same message.
fn required_text(body: &Value, key: &str, message: &'static str) -> Result<String, ApiError> {
    body.as_object()
        .and_then(|object| object.get(key))
        .and_then(Value::as_str)
        .map(|value| value.trim_matches(is_js_whitespace))
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| bad_request(message))
}

pub(crate) async fn list_tokens(
    State(state): State<AppState>,
    Path(raw_book_id): Path<String>,
    headers: HeaderMap,
) -> ApiResult {
    const FAILURE: &str = "Failed to fetch sync tokens";
    let book =
        authenticate_book(&state, &headers, &raw_book_id, AccessLevel::Read, FAILURE).await?;
    let tokens: Vec<TokenRow> = sqlx::query_as(&format!(
        "SELECT {TOKEN_COLUMNS} FROM plaid_tokens WHERE book_id = $1
         ORDER BY financial_institution, item_id"
    ))
    .bind(book.book_id)
    .fetch_all(&state.pool)
    .await
    .map_err(|cause| internal_error(cause, FAILURE))?;
    // COUNT(column) counts the values that are not null, which is the
    // number of accounts that are mapped.
    let counts: Vec<(i32, i32, i32)> = sqlx::query_as(
        "SELECT token_id, CAST(COUNT(*) AS integer), CAST(COUNT(counterpoise_account_id) AS integer)
         FROM plaid_accounts WHERE book_id = $1 GROUP BY token_id",
    )
    .bind(book.book_id)
    .fetch_all(&state.pool)
    .await
    .map_err(|cause| internal_error(cause, FAILURE))?;
    let counts: HashMap<i32, (i32, i32)> = counts
        .into_iter()
        .map(|(token_id, total, mapped)| (token_id, (total, mapped)))
        .collect();
    let items: Vec<Value> = tokens
        .iter()
        .map(|token| {
            let (total, mapped) = counts.get(&token.id).copied().unwrap_or_default();
            let mut item = token_item(token);
            item.insert("totalAccountCount".into(), json!(total));
            item.insert("mappedAccountCount".into(), json!(mapped));
            Value::Object(item)
        })
        .collect();
    Ok(Json(Value::Array(items)))
}

pub(crate) async fn create_token(
    State(state): State<AppState>,
    Path(raw_book_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult {
    const FAILURE: &str = "Failed to create sync token";
    let book =
        authenticate_book(&state, &headers, &raw_book_id, AccessLevel::Owner, FAILURE).await?;
    let body = parse_json_body(&body, FAILURE)?;
    let institution = required_text(&body, "financialInstitution", CREATE_TOKEN_REQUIRED)?;
    let item_id = required_text(&body, "itemId", CREATE_TOKEN_REQUIRED)?;
    let access_token = required_text(&body, "accessToken", CREATE_TOKEN_REQUIRED)?;

    // Item IDs are unique across the installation. This check covers the
    // book; a duplicate in another book fails the insert with the 500.
    let duplicate: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM plaid_tokens WHERE book_id = $1 AND item_id = $2)",
    )
    .bind(book.book_id)
    .bind(&item_id)
    .fetch_one(&state.pool)
    .await
    .map_err(|cause| internal_error(cause, FAILURE))?;
    if duplicate {
        return Err(error(StatusCode::CONFLICT, DUPLICATE_ITEM));
    }
    let now = now_millis();
    let token: TokenRow = sqlx::query_as(&format!(
        "INSERT INTO plaid_tokens (financial_institution, item_id, access_token, book_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $5) RETURNING {TOKEN_COLUMNS}"
    ))
    .bind(&institution)
    .bind(&item_id)
    .bind(&access_token)
    .bind(book.book_id)
    .bind(now)
    .fetch_one(&state.pool)
    .await
    .map_err(|cause| internal_error(cause, FAILURE))?;
    Ok(Json(Value::Object(token_item(&token))))
}

/// The connection with this ID in this book, if there is one.
async fn token_in_book(
    state: &AppState,
    book_id: i32,
    token_id: i32,
    failure_message: &'static str,
) -> Result<Option<TokenRow>, ApiError> {
    sqlx::query_as(&format!(
        "SELECT {TOKEN_COLUMNS} FROM plaid_tokens WHERE id = $1 AND book_id = $2"
    ))
    .bind(token_id)
    .bind(book_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|cause| internal_error(cause, failure_message))
}

pub(crate) async fn update_token(
    State(state): State<AppState>,
    Path((raw_book_id, raw_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult {
    const FAILURE: &str = "Failed to update sync token";
    let book =
        authenticate_book(&state, &headers, &raw_book_id, AccessLevel::Owner, FAILURE).await?;
    let token_id = finite_path_id(&raw_id, INVALID_TOKEN_ID)?;
    let body = parse_json_body(&body, FAILURE)?;
    let institution = required_text(&body, "financialInstitution", UPDATE_TOKEN_REQUIRED)?;
    let item_id = required_text(&body, "itemId", UPDATE_TOKEN_REQUIRED)?;
    // A value that is not a string, or is blank after trimming, keeps the
    // access token on file.
    let access_token = body
        .get("accessToken")
        .and_then(Value::as_str)
        .map(|value| value.trim_matches(is_js_whitespace))
        .filter(|value| !value.is_empty());

    let token_id = database_id(token_id, FAILURE)?;
    if token_in_book(&state, book.book_id, token_id, FAILURE)
        .await?
        .is_none()
    {
        return Err(error(StatusCode::NOT_FOUND, TOKEN_NOT_FOUND));
    }
    let duplicate: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM plaid_tokens WHERE book_id = $1 AND item_id = $2 AND id <> $3)",
    )
    .bind(book.book_id)
    .bind(&item_id)
    .bind(token_id)
    .fetch_one(&state.pool)
    .await
    .map_err(|cause| internal_error(cause, FAILURE))?;
    if duplicate {
        return Err(error(StatusCode::CONFLICT, DUPLICATE_ITEM));
    }
    let token: TokenRow = sqlx::query_as(&format!(
        "UPDATE plaid_tokens SET financial_institution = $1, item_id = $2,
                access_token = COALESCE($3, access_token), updated_at = $4
         WHERE id = $5 AND book_id = $6 RETURNING {TOKEN_COLUMNS}"
    ))
    .bind(&institution)
    .bind(&item_id)
    .bind(access_token)
    .bind(now_millis())
    .bind(token_id)
    .bind(book.book_id)
    .fetch_one(&state.pool)
    .await
    .map_err(|cause| internal_error(cause, FAILURE))?;
    Ok(Json(Value::Object(token_item(&token))))
}

/// Deletes a connection. The foreign keys cascade to its account mappings
/// and its staged bank transactions.
pub(crate) async fn delete_token(
    State(state): State<AppState>,
    Path((raw_book_id, raw_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> ApiResult {
    const FAILURE: &str = "Failed to delete sync token";
    let book =
        authenticate_book(&state, &headers, &raw_book_id, AccessLevel::Owner, FAILURE).await?;
    let token_id = database_id(finite_path_id(&raw_id, INVALID_TOKEN_ID)?, FAILURE)?;
    let deleted: Option<i32> =
        sqlx::query_scalar("DELETE FROM plaid_tokens WHERE id = $1 AND book_id = $2 RETURNING id")
            .bind(token_id)
            .bind(book.book_id)
            .fetch_optional(&state.pool)
            .await
            .map_err(|cause| internal_error(cause, FAILURE))?;
    if deleted.is_none() {
        return Err(error(StatusCode::NOT_FOUND, TOKEN_NOT_FOUND));
    }
    Ok(Json(json!({ "success": true })))
}

/// `clearSyncData`: discards the staged rows that are still pending and
/// resets the cursor, so the next sync fetches from the start. Both writes
/// are in one transaction: staged rows left on a cursor that has moved past
/// them could not come back.
pub(crate) async fn clear_sync_data(
    State(state): State<AppState>,
    Path((raw_book_id, raw_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> ApiResult {
    const FAILURE: &str = "Failed to reset sync";
    let book =
        authenticate_book(&state, &headers, &raw_book_id, AccessLevel::Write, FAILURE).await?;
    let token_id = database_id(finite_path_id(&raw_id, INVALID_TOKEN_ID)?, FAILURE)?;
    if token_in_book(&state, book.book_id, token_id, FAILURE)
        .await?
        .is_none()
    {
        return Err(error(StatusCode::NOT_FOUND, TOKEN_NOT_FOUND));
    }
    let database = |cause| internal_error(cause, FAILURE);
    let mut transaction = ledger_db::locks::begin_pool(&state.pool)
        .await
        .map_err(database)?;
    sqlx::query(
        "DELETE FROM plaid_transaction_reconciliation
         WHERE resolution_status = 'pending'
           AND plaid_account_link_id IN (SELECT id FROM plaid_accounts WHERE token_id = $1)",
    )
    .bind(token_id)
    .execute(transaction.as_mut())
    .await
    .map_err(database)?;
    sqlx::query(
        "UPDATE plaid_tokens SET sync_cursor = NULL, last_synced_at = NULL, last_error = NULL,
                updated_at = $2
         WHERE id = $1",
    )
    .bind(token_id)
    .bind(now_millis())
    .execute(transaction.as_mut())
    .await
    .map_err(database)?;
    transaction.commit().await.map_err(database)?;
    Ok(Json(json!({ "success": true })))
}

// ---------------------------------------------------------------------------
// Account mappings of one connection
// ---------------------------------------------------------------------------

const ASSIGNMENTS_ARRAY: &str = "assignments must be an array";
const PLAID_ACCOUNT_ID_REQUIRED: &str = "Each assignment must include plaidAccountId";
const COUNTERPOISE_ACCOUNT_ID_INVALID: &str =
    "counterpoiseAccountId must be a positive integer or null";
const DUPLICATE_PLAID_ACCOUNT_ID: &str = "Duplicate plaidAccountId in assignments";
const DUPLICATE_COUNTERPOISE_ACCOUNT_ID: &str =
    "A Counterpoise account cannot be assigned to more than one Plaid account";
const ONLY_ASSET_OR_LIABILITY: &str =
    "Only asset or liability Counterpoise accounts can be synchronized with Plaid";

#[derive(FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
struct PlaidAccountRow {
    plaid_account_id: String,
    name: String,
    official_name: Option<String>,
    mask: Option<String>,
    #[serde(rename = "type")]
    account_type: String,
    subtype: Option<String>,
    counterpoise_account_id: Option<i32>,
}

async fn token_accounts(
    state: &AppState,
    token_id: i32,
    failure_message: &'static str,
) -> Result<Vec<PlaidAccountRow>, ApiError> {
    sqlx::query_as(
        "SELECT plaid_account_id, name, official_name, mask, type AS account_type, subtype,
                counterpoise_account_id
         FROM plaid_accounts WHERE token_id = $1 ORDER BY name, plaid_account_id",
    )
    .bind(token_id)
    .fetch_all(&state.pool)
    .await
    .map_err(|cause| internal_error(cause, failure_message))
}

/// A field of a Plaid account as Node binds it to a text column: a string
/// as sent, another value as `String(value)`, and null or a missing field as
/// NULL.
fn plaid_text(account: &Value, key: &str) -> Option<String> {
    match account.as_object().and_then(|object| object.get(key)) {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) => Some(text.clone()),
        Some(other) => Some(js_string(other)),
    }
}

/// `refreshPlaidAccounts`: upserts every account that Plaid reports for the
/// Item and deletes the mappings of accounts that it no longer reports.
async fn refresh_accounts(
    state: &AppState,
    book_id: i32,
    token_id: i32,
    access_token: &str,
) -> Result<(), String> {
    let accounts = state.plaid.fetch_accounts(access_token).await?;
    if accounts.iter().any(Value::is_null) {
        return Err("Cannot read properties of null (reading 'account_id')".to_owned());
    }
    let column = |key: &str| -> Vec<Option<String>> {
        accounts
            .iter()
            .map(|account| plaid_text(account, key))
            .collect()
    };
    let incoming_ids = column("account_id");
    let now = now_millis();
    let mut transaction = ledger_db::locks::begin_pool(&state.pool)
        .await
        .map_err(|cause| cause.to_string())?;
    if !accounts.is_empty() {
        let columns = [
            column("name"),
            column("official_name"),
            column("mask"),
            column("type"),
            column("subtype"),
        ];
        let mut insert = QueryBuilder::<Db>::new(
            "INSERT INTO plaid_accounts (book_id, token_id, plaid_account_id, name, official_name,
                                         mask, type, subtype, created_at, updated_at) ",
        );
        insert.push_values(incoming_ids.iter().enumerate(), |mut row, (index, id)| {
            row.push_bind(book_id)
                .push_bind(token_id)
                .push_bind(id.clone());
            for values in &columns {
                row.push_bind(values[index].clone());
            }
            row.push_bind(now).push_bind(now);
        });
        insert.push(
            " ON CONFLICT (plaid_account_id) DO UPDATE SET
               token_id = excluded.token_id, name = excluded.name,
               official_name = excluded.official_name, mask = excluded.mask,
               type = excluded.type, subtype = excluded.subtype,
               updated_at = excluded.updated_at",
        );
        insert
            .build()
            .execute(transaction.as_mut())
            .await
            .map_err(|cause| cause.to_string())?;
    }
    // `NOT IN` a list that holds a null matches no row, as `<> ALL` does.
    sqlx::query(&format!(
        "DELETE FROM plaid_accounts WHERE token_id = $1 AND plaid_account_id NOT {}",
        sql::in_texts("$2")
    ))
    .bind(token_id)
    .bind(sql::json_array(&incoming_ids))
    .execute(transaction.as_mut())
    .await
    .map_err(|cause| cause.to_string())?;
    transaction
        .commit()
        .await
        .map_err(|cause| cause.to_string())
}

pub(crate) async fn list_token_accounts(
    State(state): State<AppState>,
    Path((raw_book_id, raw_id)): Path<(String, String)>,
    RawQuery(raw_query): RawQuery,
    headers: HeaderMap,
) -> ApiResult {
    const FAILURE: &str = "Failed to fetch token Plaid accounts";
    let book =
        authenticate_book(&state, &headers, &raw_book_id, AccessLevel::Read, FAILURE).await?;
    let token_id = database_id(finite_path_id(&raw_id, INVALID_TOKEN_ID)?, FAILURE)?;
    let refresh = first_query_values(raw_query.as_deref())
        .get("refresh")
        .is_some_and(|value| value == "true");
    let token = token_in_book(&state, book.book_id, token_id, FAILURE)
        .await?
        .ok_or_else(|| error(StatusCode::NOT_FOUND, TOKEN_NOT_FOUND))?;
    if refresh
        && let Err(message) =
            refresh_accounts(&state, book.book_id, token_id, &token.access_token).await
    {
        // A refresh failure repeats its message. A configuration fault is
        // the installation's, and anything else is reported as Plaid's.
        let status = if is_configuration_error(&message) {
            StatusCode::INTERNAL_SERVER_ERROR
        } else {
            StatusCode::BAD_GATEWAY
        };
        tracing::error!(error = %message, "Plaid account refresh failed");
        return Err(error_owned(status, message));
    }
    let accounts = token_accounts(&state, token_id, FAILURE).await?;
    Ok(Json(to_value(accounts).expect("Plaid accounts serialize")))
}

struct Assignment {
    plaid_account_id: String,
    counterpoise_account_id: Option<f64>,
}

/// `assignAccountsSchema`: the first issue in element and key order, then the
/// two duplicate checks.
fn validate_assignments(body: &Value) -> Result<Vec<Assignment>, ApiError> {
    let elements = body
        .as_object()
        .and_then(|object| object.get("assignments"))
        .and_then(Value::as_array)
        .ok_or_else(|| bad_request(ASSIGNMENTS_ARRAY))?;
    let mut assignments = Vec::with_capacity(elements.len());
    for element in elements {
        let object = element
            .as_object()
            .ok_or_else(|| bad_request(PLAID_ACCOUNT_ID_REQUIRED))?;
        let plaid_account_id = object
            .get("plaidAccountId")
            .and_then(Value::as_str)
            .map(|value| value.trim_matches(is_js_whitespace))
            .filter(|value| !value.is_empty())
            .ok_or_else(|| bad_request(PLAID_ACCOUNT_ID_REQUIRED))?
            .to_owned();
        // A positive safe integer, or null. The key is required.
        let counterpoise_account_id = match object.get("counterpoiseAccountId") {
            Some(Value::Null) => None,
            Some(Value::Number(number)) => {
                let value = js_number(number);
                if value.fract() != 0.0 || value <= 0.0 || value > 9_007_199_254_740_991.0 {
                    return Err(bad_request(COUNTERPOISE_ACCOUNT_ID_INVALID));
                }
                Some(value)
            }
            _ => return Err(bad_request(COUNTERPOISE_ACCOUNT_ID_INVALID)),
        };
        assignments.push(Assignment {
            plaid_account_id,
            counterpoise_account_id,
        });
    }
    let plaid_ids: HashSet<&str> = assignments
        .iter()
        .map(|assignment| assignment.plaid_account_id.as_str())
        .collect();
    if plaid_ids.len() != assignments.len() {
        return Err(bad_request(DUPLICATE_PLAID_ACCOUNT_ID));
    }
    let requested: Vec<u64> = assignments
        .iter()
        .filter_map(|assignment| assignment.counterpoise_account_id)
        .map(|id| id as u64)
        .collect();
    if requested.iter().collect::<HashSet<_>>().len() != requested.len() {
        return Err(bad_request(DUPLICATE_COUNTERPOISE_ACCOUNT_ID));
    }
    Ok(assignments)
}

pub(crate) async fn set_token_accounts(
    State(state): State<AppState>,
    Path((raw_book_id, raw_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult {
    const FAILURE: &str = "Failed to save Plaid account assignments";
    let book =
        authenticate_book(&state, &headers, &raw_book_id, AccessLevel::Owner, FAILURE).await?;
    let token_id = finite_path_id(&raw_id, INVALID_TOKEN_ID)?;
    let body = parse_json_body(&body, FAILURE)?;
    let assignments = validate_assignments(&body)?;
    let token_id = database_id(token_id, FAILURE)?;
    if token_in_book(&state, book.book_id, token_id, FAILURE)
        .await?
        .is_none()
    {
        return Err(error(StatusCode::NOT_FOUND, TOKEN_NOT_FOUND));
    }

    let known: HashSet<String> = token_accounts(&state, token_id, FAILURE)
        .await?
        .into_iter()
        .map(|account| account.plaid_account_id)
        .collect();
    if let Some(unknown) = assignments
        .iter()
        .find(|assignment| !known.contains(&assignment.plaid_account_id))
    {
        return Err(error_owned(
            StatusCode::BAD_REQUEST,
            format!(
                "Unknown plaidAccountId for token: {}",
                unknown.plaid_account_id
            ),
        ));
    }

    let plaid_ids: Vec<&str> = assignments
        .iter()
        .map(|assignment| assignment.plaid_account_id.as_str())
        .collect();
    let requested = assignments
        .iter()
        .filter_map(|assignment| assignment.counterpoise_account_id)
        .map(|id| database_id(id, FAILURE))
        .collect::<Result<Vec<i32>, _>>()?;
    if !requested.is_empty() {
        let types: Vec<String> = sqlx::query_scalar(&format!(
            "SELECT type FROM accounts WHERE book_id = $1 AND id {in2}",
            in2 = sql::in_integers("$2")
        ))
        .bind(book.book_id)
        .bind(sql::json_array(&requested))
        .fetch_all(&state.pool)
        .await
        .map_err(|cause| internal_error(cause, FAILURE))?;
        if types.len() != requested.len() {
            return Err(bad_request(
                "One or more counterpoiseAccountId values are invalid",
            ));
        }
        // A mapping to an income or expense account would save here and
        // then fail every sync, so it is refused with the sync's own message.
        if types
            .iter()
            .any(|kind| kind != "asset" && kind != "liability")
        {
            return Err(bad_request(ONLY_ASSET_OR_LIABILITY));
        }
        let conflict: bool = sqlx::query_scalar(&format!(
            "SELECT EXISTS (SELECT 1 FROM plaid_accounts
                            WHERE counterpoise_account_id {in1} AND plaid_account_id NOT {in2})",
            in1 = sql::in_integers("$1"),
            in2 = sql::in_texts("$2")
        ))
        .bind(sql::json_array(&requested))
        .bind(sql::json_array(&plaid_ids))
        .fetch_one(&state.pool)
        .await
        .map_err(|cause| internal_error(cause, FAILURE))?;
        if conflict {
            return Err(bad_request(
                "One or more Counterpoise accounts are already mapped to another Plaid account",
            ));
        }
    }

    // Clear every mapping that the request touches before it sets any.
    // counterpoise_account_id has a unique index, so a swap of two accounts
    // would otherwise collide with the mapping that it is about to move.
    let database = |cause| internal_error(cause, FAILURE);
    let now = now_millis();
    let mut transaction = ledger_db::locks::begin_pool(&state.pool)
        .await
        .map_err(database)?;
    if !plaid_ids.is_empty() {
        sqlx::query(&format!(
            "UPDATE plaid_accounts SET counterpoise_account_id = NULL, updated_at = $3
             WHERE token_id = $1 AND plaid_account_id {in2}",
            in2 = sql::in_texts("$2")
        ))
        .bind(token_id)
        .bind(sql::json_array(&plaid_ids))
        .bind(now)
        .execute(transaction.as_mut())
        .await
        .map_err(database)?;
    }
    for assignment in &assignments {
        // Each ID passed `database_id` above.
        let account_id = assignment.counterpoise_account_id.map(|id| id as i32);
        sqlx::query(
            "UPDATE plaid_accounts SET counterpoise_account_id = $3, updated_at = $4
             WHERE token_id = $1 AND plaid_account_id = $2",
        )
        .bind(token_id)
        .bind(&assignment.plaid_account_id)
        .bind(account_id)
        .bind(now)
        .execute(transaction.as_mut())
        .await
        .map_err(database)?;
    }
    transaction.commit().await.map_err(database)?;
    let accounts = token_accounts(&state, token_id, FAILURE).await?;
    Ok(Json(to_value(accounts).expect("Plaid accounts serialize")))
}

// ---------------------------------------------------------------------------
// Book-wide reads
// ---------------------------------------------------------------------------

#[derive(FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
struct AssignedAccountRow {
    plaid_link_id: i32,
    financial_institution: String,
    token_id: i32,
    item_id: String,
    plaid_account_id: String,
    plaid_account_name: String,
    plaid_account_mask: Option<String>,
    counterpoise_account_id: Option<i32>,
    counterpoise_account_name: String,
    #[serde(serialize_with = "serialize_optional_timestamp")]
    last_synced_at: Option<NaiveDateTime>,
    last_error: Option<String>,
    pending_count: i32,
    review_count: i32,
}

fn serialize_optional_timestamp<S: serde::Serializer>(
    value: &Option<NaiveDateTime>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    match value {
        Some(value) => serialize_timestamp(value, serializer),
        None => serializer.serialize_none(),
    }
}

/// `getAssignedAccounts`: each mapped Plaid account with its queue counts.
pub(crate) async fn assigned_accounts(
    State(state): State<AppState>,
    Path(raw_book_id): Path<String>,
    headers: HeaderMap,
) -> ApiResult {
    const FAILURE: &str = "Failed to fetch assigned sync accounts";
    let book =
        authenticate_book(&state, &headers, &raw_book_id, AccessLevel::Read, FAILURE).await?;
    let rows: Vec<AssignedAccountRow> = sqlx::query_as(
        "SELECT pa.id AS plaid_link_id, t.financial_institution, t.id AS token_id, t.item_id,
                pa.plaid_account_id, pa.name AS plaid_account_name, pa.mask AS plaid_account_mask,
                pa.counterpoise_account_id, a.name AS counterpoise_account_name,
                t.last_synced_at, t.last_error,
                CAST(COALESCE(SUM(CASE WHEN r.resolution_status = 'pending' AND r.review_reason IS NULL
                                       THEN 1 ELSE 0 END), 0) AS integer) AS pending_count,
                CAST(COALESCE(SUM(CASE WHEN r.review_reason IS NOT NULL THEN 1 ELSE 0 END), 0)
                     AS integer) AS review_count
         FROM plaid_accounts pa
         JOIN plaid_tokens t ON pa.token_id = t.id
         JOIN accounts a ON pa.counterpoise_account_id = a.id
         LEFT JOIN plaid_transaction_reconciliation r ON r.plaid_account_link_id = pa.id
         WHERE t.book_id = $1 AND pa.counterpoise_account_id IS NOT NULL
         GROUP BY pa.id, t.financial_institution, t.item_id, pa.plaid_account_id, pa.name, pa.mask,
                  pa.counterpoise_account_id, a.name, t.id, t.last_synced_at, t.last_error
         ORDER BY t.financial_institution, t.item_id, pa.name",
    )
    .bind(book.book_id)
    .fetch_all(&state.pool)
    .await
    .map_err(|cause| internal_error(cause, FAILURE))?;
    Ok(Json(to_value(rows).expect("assigned accounts serialize")))
}

/// Unmatched local transactions older than this many days are flagged.
const STALE_AGE_DAYS: u64 = 9;
/// Transactions older than this many days are ignored.
const LOOKBACK_DAYS: u64 = 60;

fn local_days_ago(days: u64) -> String {
    (Local::now().date_naive() - Days::new(days))
        .format("%Y-%m-%d")
        .to_string()
}

#[derive(FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
struct StaleAccountRow {
    account_id: i32,
    account_name: String,
    count: i32,
    oldest_date: Option<String>,
}

/// `getStaleUnmatched`: local transactions on synced accounts that no bank
/// transaction has matched. The stored date is used, not the effective
/// date: a floating transaction's effective date is always today, which
/// would exempt the entries that never posted.
pub(crate) async fn stale_unmatched(
    State(state): State<AppState>,
    Path(raw_book_id): Path<String>,
    headers: HeaderMap,
) -> ApiResult {
    const FAILURE: &str = "Failed to fetch stale unmatched transactions";
    let book =
        authenticate_book(&state, &headers, &raw_book_id, AccessLevel::Read, FAILURE).await?;
    let rows: Vec<StaleAccountRow> = sqlx::query_as(
        "SELECT a.id AS account_id, a.name AS account_name,
                CAST(COUNT(DISTINCT t.id) AS integer) AS count, MIN(t.date) AS oldest_date
         FROM transactions t
         JOIN transaction_splits s ON s.transaction_id = t.id AND s.book_id = $1
         JOIN accounts a ON s.account_id = a.id AND a.book_id = $1
         JOIN plaid_accounts pa ON pa.counterpoise_account_id = a.id AND pa.book_id = $1
         WHERE t.book_id = $1 AND t.is_reconciled = false AND t.date < $2 AND t.date >= $3
           AND NOT EXISTS (
             SELECT 1 FROM plaid_transaction_reconciliation r
             WHERE r.book_id = $1 AND r.plaid_account_link_id = pa.id
               AND r.matched_transaction_id = t.id)
         GROUP BY a.id, a.name
         ORDER BY a.name, a.id",
    )
    .bind(book.book_id)
    .bind(local_days_ago(STALE_AGE_DAYS))
    .bind(local_days_ago(LOOKBACK_DAYS))
    .fetch_all(&state.pool)
    .await
    .map_err(|cause| internal_error(cause, FAILURE))?;
    let total: i64 = rows.iter().map(|row| i64::from(row.count)).sum();
    Ok(Json(json!({ "totalCount": total, "accounts": rows })))
}

// ---------------------------------------------------------------------------
// Pending bank transactions shown in the register
// ---------------------------------------------------------------------------

/// Keeps the IDs of the pending rows clear of the negative IDs of the
/// projected recurring transactions.
const PLAID_PENDING_ID_OFFSET: i64 = 1_000_000_000_000;
const EPOCH: &str = "1970-01-01T00:00:00.000Z";

/// `formatCategory`: "FOOD_AND_DRINK" is "Food And Drink". JavaScript
/// changes the case of the first UTF-16 code unit, which cannot change a
/// character outside the Basic Multilingual Plane.
fn format_category(category: Option<&str>) -> Option<String> {
    let category = category.filter(|category| !category.is_empty())?;
    let words: Vec<String> = category
        .to_lowercase()
        .split('_')
        .map(|word| {
            let mut characters = word.chars();
            match characters.next() {
                Some(first) if u32::from(first) <= 0xFFFF => {
                    first.to_uppercase().chain(characters).collect()
                }
                _ => word.to_owned(),
            }
        })
        .collect();
    Some(words.join(" "))
}

#[derive(FromRow)]
struct PendingRow {
    id: i32,
    date: String,
    authorized_date: Option<String>,
    amount_cents: i32,
    name: String,
    merchant_name: Option<String>,
    category_primary: Option<String>,
    account_id: i32,
}

/// `listPendingPlaidTransactions`: the unmatched bank transactions as
/// display transactions, at their authorized date, newest first.
pub(crate) async fn pending_transactions(
    State(state): State<AppState>,
    Path(raw_book_id): Path<String>,
    RawQuery(raw_query): RawQuery,
    headers: HeaderMap,
) -> ApiResult {
    const FAILURE: &str = "Failed to fetch pending Plaid transactions";
    let book =
        authenticate_book(&state, &headers, &raw_book_id, AccessLevel::Read, FAILURE).await?;
    // `z.coerce.number().int()`: `Number(value)`, which must be a safe
    // integer. An empty value is no filter.
    let account_id = match first_query_values(raw_query.as_deref()).get("accountId") {
        None => None,
        Some(value) if value.is_empty() => None,
        Some(value) => {
            let number = parse_js_number(value)
                .filter(|number| {
                    number.is_finite()
                        && number.fract() == 0.0
                        && number.abs() <= 9_007_199_254_740_991.0
                })
                .ok_or_else(|| bad_request("Invalid accountId"))?;
            Some(database_id(number, FAILURE)?)
        }
    };
    let mut rows: Vec<PendingRow> = sqlx::query_as(
        "SELECT r.id, r.date, r.authorized_date, r.amount_cents, r.name, r.merchant_name,
                r.category_primary, a.id AS account_id
         FROM plaid_transaction_reconciliation r
         JOIN plaid_accounts pa ON r.plaid_account_link_id = pa.id AND pa.book_id = $1
         JOIN accounts a ON pa.counterpoise_account_id = a.id AND a.book_id = $1
         WHERE r.book_id = $1 AND r.resolution_status = 'pending' AND r.review_reason IS NULL
           AND ($2 IS NULL OR a.id = $2)
         ORDER BY r.id",
    )
    .bind(book.book_id)
    .bind(account_id)
    .fetch_all(&state.pool)
    .await
    .map_err(|cause| internal_error(cause, FAILURE))?;
    let account_ids: Vec<i32> = rows.iter().map(|row| row.account_id).collect();
    let accounts: Vec<AccountRow> = sqlx::query_as(&format!(
        "SELECT id, book_id, name, type AS account_type, subtype, parent_id, is_active,
                is_favorite, is_investment_cash, icon, created_at, updated_at
         FROM accounts WHERE id {in1}",
        in1 = sql::in_integers("$1")
    ))
    .bind(sql::json_array(&account_ids))
    .fetch_all(&state.pool)
    .await
    .map_err(|cause| internal_error(cause, FAILURE))?;
    let accounts: HashMap<i32, AccountRow> = accounts
        .into_iter()
        .map(|account| (account.id, account))
        .collect();

    // A stable sort, as `Array.prototype.sort` is.
    rows.sort_by(|a, b| {
        let date = |row: &PendingRow| row.authorized_date.clone().unwrap_or(row.date.clone());
        date(b).cmp(&date(a))
    });
    let pending: Vec<Value> = rows
        .iter()
        .map(|row| {
            let id = -(PLAID_PENDING_ID_OFFSET + i64::from(row.id));
            let payee_name = row.merchant_name.as_deref().unwrap_or(&row.name);
            json!({
                "id": id,
                "bookId": book.book_id,
                "date": row.authorized_date.as_deref().unwrap_or(&row.date),
                "description": row.name,
                "checkNumber": null,
                "notes": null,
                "payeeId": null,
                "isReconciled": false,
                "isFloating": false,
                "recurringRuleId": null,
                "createdBy": null,
                "updatedBy": null,
                "createdAt": EPOCH,
                "updatedAt": EPOCH,
                "payee": { "id": id, "bookId": book.book_id, "name": payee_name, "createdAt": EPOCH },
                "splits": [{
                    "id": id,
                    "bookId": book.book_id,
                    "transactionId": id,
                    "accountId": row.account_id,
                    // Plaid amounts are positive for money out; the split on
                    // the asset account is the negation.
                    "amount": -i64::from(row.amount_cents),
                    "account": accounts.get(&row.account_id),
                }],
                "investmentSplits": [],
                "isPlaidPending": true,
                "plaidCategory": format_category(row.category_primary.as_deref()),
            })
        })
        .collect();
    Ok(Json(Value::Array(pending)))
}

// ---------------------------------------------------------------------------
// The bank transaction linked to one transaction
// ---------------------------------------------------------------------------

#[derive(FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
struct PlaidLinkRow {
    id: i32,
    plaid_transaction_id: String,
    date: String,
    authorized_date: Option<String>,
    amount_cents: i32,
    name: String,
    merchant_name: Option<String>,
    original_description: Option<String>,
    pending: bool,
    iso_currency_code: Option<String>,
    category_primary: Option<String>,
    category_detailed: Option<String>,
    raw_json: String,
}

/// `getTransactionPlaidLink`: the staged bank transaction matched to this
/// transaction, or null. An ID that is not a number is also null.
pub(crate) async fn transaction_plaid_link(
    State(state): State<AppState>,
    Path((raw_book_id, raw_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> ApiResult {
    const FAILURE: &str = "Failed to fetch Plaid link";
    let book =
        authenticate_book(&state, &headers, &raw_book_id, AccessLevel::Read, FAILURE).await?;
    let Some(transaction_id) = parse_int_prefix_number(&raw_id) else {
        return Ok(Json(Value::Null));
    };
    let transaction_id = database_id(transaction_id, FAILURE)?;
    let row: Option<PlaidLinkRow> = sqlx::query_as(
        "SELECT id, plaid_transaction_id, date, authorized_date, amount_cents, name, merchant_name,
                original_description, pending, iso_currency_code, category_primary,
                category_detailed, raw_json
         FROM plaid_transaction_reconciliation
         WHERE matched_transaction_id = $1 AND book_id = $2
         LIMIT 1",
    )
    .bind(transaction_id)
    .bind(book.book_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|cause| internal_error(cause, FAILURE))?;
    Ok(Json(to_value(row).expect("Plaid link serializes")))
}

/// `unlinkPlaidTransaction`: every staged row matched to this transaction
/// goes back to pending, and the transaction is no longer reconciled.
pub(crate) async fn unlink_transaction(
    State(state): State<AppState>,
    Path((raw_book_id, raw_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> ApiResult {
    const FAILURE: &str = "Failed to unlink from Plaid";
    let book =
        authenticate_book(&state, &headers, &raw_book_id, AccessLevel::Write, FAILURE).await?;
    let transaction_id =
        parse_int_prefix_number(&raw_id).ok_or_else(|| bad_request("Invalid transaction ID"))?;
    let transaction_id = database_id(transaction_id, FAILURE)?;
    let database = |cause| internal_error(cause, FAILURE);
    let linked: Vec<i32> = sqlx::query_scalar(
        "SELECT id FROM plaid_transaction_reconciliation
         WHERE matched_transaction_id = $1 AND book_id = $2",
    )
    .bind(transaction_id)
    .bind(book.book_id)
    .fetch_all(&state.pool)
    .await
    .map_err(database)?;
    if linked.is_empty() {
        return Err(error(StatusCode::NOT_FOUND, "No Plaid link found"));
    }
    let now = now_millis();
    let mut transaction = ledger_db::locks::begin_pool(&state.pool)
        .await
        .map_err(database)?;
    sqlx::query(&format!(
        "UPDATE plaid_transaction_reconciliation
         SET resolution_status = 'pending', matched_transaction_id = NULL, review_reason = NULL,
             review_metadata_json = NULL, resolved_at = NULL, updated_at = $3
         WHERE id {in1} AND book_id = $2",
        in1 = sql::in_integers("$1")
    ))
    .bind(sql::json_array(&linked))
    .bind(book.book_id)
    .bind(now)
    .execute(transaction.as_mut())
    .await
    .map_err(database)?;
    sqlx::query(
        "UPDATE transactions SET is_reconciled = false, updated_at = $3, updated_by = $4
         WHERE id = $1 AND book_id = $2",
    )
    .bind(transaction_id)
    .bind(book.book_id)
    .bind(now)
    .bind(book.user_id)
    .execute(transaction.as_mut())
    .await
    .map_err(database)?;
    transaction.commit().await.map_err(database)?;

    record_unlink(&state.pool, book.book_id, transaction_id).await;
    state.analytics.capture_event(
        book.user_id,
        "sync_transaction_unlinked",
        Some(json!({ "bookId": book.book_id })),
    );
    Ok(Json(json!({ "success": true })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn access_tokens_are_masked_as_javascript_counts_them() {
        assert_eq!(mask_access_token(""), "");
        assert_eq!(mask_access_token("12345678"), "********");
        assert_eq!(mask_access_token("123456789"), "1234********6789");
        assert_eq!(
            mask_access_token("access-sandbox-123456789"),
            "acce****************6789"
        );
        // Two UTF-16 code units each.
        assert_eq!(mask_access_token("😀😀😀😀😀"), "😀😀********😀😀");
    }

    #[test]
    fn categories_read_as_node_formats_them() {
        assert_eq!(
            format_category(Some("FOOD_AND_DRINK")).as_deref(),
            Some("Food And Drink")
        );
        assert_eq!(format_category(Some("")), None);
        assert_eq!(format_category(None), None);
        assert_eq!(format_category(Some("A__B")).as_deref(), Some("A  B"));
        assert_eq!(format_category(Some("ßIG")).as_deref(), Some("SSig"));
        assert_eq!(format_category(Some("𐐀X")).as_deref(), Some("𐐨x"));
    }

    #[test]
    fn assignments_report_the_first_zod_issue() {
        let message = |body: Value| match validate_assignments(&body) {
            Ok(_) => "ok".to_owned(),
            Err(error) => format!("{error:?}"),
        };
        for (body, expected) in [
            (json!([]), ASSIGNMENTS_ARRAY),
            (json!({ "assignments": "x" }), ASSIGNMENTS_ARRAY),
            (json!({ "assignments": [null] }), PLAID_ACCOUNT_ID_REQUIRED),
            (
                json!({ "assignments": [{ "plaidAccountId": " " }] }),
                PLAID_ACCOUNT_ID_REQUIRED,
            ),
            (
                json!({ "assignments": [{ "plaidAccountId": "a" }] }),
                COUNTERPOISE_ACCOUNT_ID_INVALID,
            ),
            (
                json!({ "assignments": [{ "plaidAccountId": "a", "counterpoiseAccountId": 1.5 }] }),
                COUNTERPOISE_ACCOUNT_ID_INVALID,
            ),
            (
                json!({ "assignments": [{ "plaidAccountId": "a", "counterpoiseAccountId": 0 }] }),
                COUNTERPOISE_ACCOUNT_ID_INVALID,
            ),
            (
                json!({ "assignments": [
                    { "plaidAccountId": "a", "counterpoiseAccountId": 1 },
                    { "plaidAccountId": " a ", "counterpoiseAccountId": 1 },
                ] }),
                DUPLICATE_PLAID_ACCOUNT_ID,
            ),
            (
                json!({ "assignments": [
                    { "plaidAccountId": "a", "counterpoiseAccountId": 1 },
                    { "plaidAccountId": "b", "counterpoiseAccountId": 1.0 },
                ] }),
                DUPLICATE_COUNTERPOISE_ACCOUNT_ID,
            ),
        ] {
            assert!(message(body.clone()).contains(expected), "{body}");
        }
        assert_eq!(
            message(json!({ "assignments": [
                { "plaidAccountId": "a", "counterpoiseAccountId": null },
                { "plaidAccountId": "b", "counterpoiseAccountId": null },
            ] })),
            "ok"
        );
    }
}
