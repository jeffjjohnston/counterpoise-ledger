use crate::{
    book_auth::{AccessLevel, authenticate_book},
    book_scope::{BookAccess, Write},
    error::{ApiError, ApiResult, error, internal_error},
    platform,
    state::AppState,
    validation::{
        first_query_values, local_today, parse_int_prefix_number, parse_js_number, parse_json_body,
        validate_payee_create,
    },
};
use axum::{
    Json,
    body::Bytes,
    extract::{Path, RawQuery, State},
    http::{HeaderMap, StatusCode},
};
use chrono::{NaiveDateTime, SecondsFormat};
use ledger_db::{Sql, store::params};
use serde::Serialize;
use serde_json::{Value, json, to_value};

#[derive(ledger_db::store::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
struct PayeeListRow {
    id: i32,
    name: String,
    last_transaction_date: Option<String>,
    transaction_count: i32,
}

#[derive(ledger_db::store::FromRow)]
struct PayeeSummaryRow {
    id: i32,
    name: String,
    created_at: NaiveDateTime,
    transaction_count: i32,
}

/// `normalizePayeeName()`. It does not change case: "IKEA" and "Ikea" are
/// two payees.
pub(crate) use ledger_core::names::normalize_payee_name as normalize_name;

fn parse_limit(input: Option<&str>) -> Option<i64> {
    let value = parse_js_number(input?)?;
    (value.is_finite() && value > 0.0 && value.fract() == 0.0 && value <= 9_007_199_254_740_991.0)
        .then_some(value as i64)
}

pub(crate) async fn list_payees(
    State(state): State<AppState>,
    Path(raw_book_id): Path<String>,
    RawQuery(raw_query): RawQuery,
    headers: HeaderMap,
) -> ApiResult {
    let book = authenticate_book(
        &state,
        &headers,
        &raw_book_id,
        AccessLevel::Read,
        "Failed to fetch payees",
    )
    .await?;
    let params = first_query_values(raw_query.as_deref());
    let search = normalize_name(params.get("search").map_or("", String::as_str));
    let pattern = ledger_db::folds::fold(&search);
    let limit = parse_limit(params.get("limit").map(String::as_str));
    // Bind the same local calendar date used by the Node date helpers.
    let today = local_today();
    let rows: Vec<PayeeListRow> = state
        .database
        .query(
            "SELECT p.id, p.name,
                MAX(CASE WHEN t.is_floating THEN ?3 ELSE t.date END) AS last_transaction_date,
                CAST(COUNT(t.id) AS integer) AS transaction_count
         FROM payees p
         LEFT JOIN transactions t ON t.payee_id = p.id
         WHERE p.book_id = ?1 AND (?2 = '' OR instr(p.name_fold, ?2) > 0)
         GROUP BY p.id
         ORDER BY CASE WHEN ?2 = '' THEN 0
                       WHEN instr(p.name_fold, ?2) = 1 THEN 0
                       WHEN instr(p.name_fold, ' ' || ?2) > 0 THEN 1
                       ELSE 2 END,
                  p.name
         LIMIT COALESCE(?4, -1)",
            &params![book.book_id(), pattern, today, limit],
        )
        .map_err(|cause| internal_error(cause, "Failed to fetch payees"))?;
    Ok(Json(to_value(rows).expect("payee rows serialize")))
}

pub(crate) async fn get_payee(
    State(state): State<AppState>,
    Path((raw_book_id, raw_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> ApiResult {
    let book = authenticate_book(
        &state,
        &headers,
        &raw_book_id,
        AccessLevel::Read,
        "Failed to fetch payee",
    )
    .await?;
    let id = payee_path_id(&raw_id, "Failed to fetch payee")?;
    let row: Option<PayeeSummaryRow> = state
        .database
        .query_optional(
            "SELECT p.id, p.name, p.created_at, CAST(COUNT(t.id) AS integer) AS transaction_count
         FROM payees p LEFT JOIN transactions t ON t.payee_id = p.id
         WHERE p.book_id = ?1 AND p.id = ?2
         GROUP BY p.id",
            &params![book.book_id(), id],
        )
        .map_err(|cause| internal_error(cause, "Failed to fetch payee"))?;
    let row = row.ok_or_else(|| error(StatusCode::NOT_FOUND, "Payee not found"))?;
    Ok(Json(json!({
        "id": row.id,
        "name": row.name,
        "createdAt": row.created_at.and_utc().to_rfc3339_opts(SecondsFormat::Millis, true),
        "transactionCount": row.transaction_count,
    })))
}

#[derive(ledger_db::store::FromRow)]
struct PayeeRow {
    id: i32,
    book_id: i32,
    name: String,
    created_at: NaiveDateTime,
}

fn payee_json(row: PayeeRow) -> Value {
    json!({
        "id": row.id,
        "bookId": row.book_id,
        "name": row.name,
        "createdAt": row.created_at.and_utc().to_rfc3339_opts(SecondsFormat::Millis, true),
    })
}

/// Node validates `^\d+$`, then sends `parseInt(id, 10)` to an integer
/// column. A value outside the int4 range makes that query fail.
fn payee_path_id(raw: &str, failure_message: &'static str) -> Result<i32, ApiError> {
    if raw.is_empty() || !raw.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(error(StatusCode::BAD_REQUEST, "Invalid payee id"));
    }
    raw.parse::<i32>()
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, failure_message))
}

pub(crate) async fn create_payee(
    State(state): State<AppState>,
    Path(raw_book_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult {
    const FAILURE: &str = "Failed to create payee";
    let book =
        authenticate_book(&state, &headers, &raw_book_id, AccessLevel::Write, FAILURE).await?;
    let access = book.write()?;
    let body = parse_json_body(&body, FAILURE)?;
    let name = normalize_name(validate_payee_create(&body)?);

    // The form's "new payee" field treats a case variant as the same payee
    // and returns the stored row: the folded name matches `name_fold`.
    // The exact spelling first, then the oldest: see `find_payee_by_name`.
    let existing: Option<PayeeRow> = state
        .database
        .query_optional(
            "SELECT id, book_id, name, created_at FROM payees
         WHERE book_id = ?1 AND name_fold = ?2
         ORDER BY name = ?3 DESC, id LIMIT 1",
            &params![book.book_id(), ledger_db::folds::fold(&name), &name],
        )
        .map_err(|cause| internal_error(cause, FAILURE))?;
    if let Some(row) = existing {
        return Ok(Json(payee_json(row)));
    }

    // A concurrent request can create the payee after the lookup above; the
    // create then returns it, as the lookup would have.
    match create_exact(&state.database, &access, &name)
        .map_err(|cause| internal_error(cause, FAILURE))?
    {
        Ok(payee) | Err(payee) => Ok(Json(payee)),
    }
}

/// `createPayee()` of `lib/payees.ts`, for a name that `normalize_name` has
/// already normalized. Inserts the payee and returns it, or returns
/// `Err(existing payee)` when the book already has the payee: a name matches
/// without letter case, so "Ikea" after "IKEA" is the existing payee. One
/// write transaction holds the check and the insert, so two concurrent calls
/// with case variants make one payee.
///
/// `POST /payees` returns the existing payee; the MCP tool `create_payee`
/// reports it as an error.
pub(crate) fn create_exact(
    database: &ledger_db::Database,
    access: &BookAccess<'_, Write>,
    name: &str,
) -> Result<Result<Value, Value>, ledger_db::store::Error> {
    let book_id = access.book_id();
    database.transaction(|tx| {
        let existing: Option<PayeeRow> = tx.query_optional(
            "SELECT id, book_id, name, created_at FROM payees
             WHERE book_id = ?1 AND name_fold = ?2
             ORDER BY name = ?3 DESC, id LIMIT 1",
            &params![book_id, ledger_db::folds::fold(name), name],
        )?;
        if let Some(existing) = existing {
            return Ok(Err(payee_json(existing)));
        }
        let row: PayeeRow = tx.query_row(
            "INSERT INTO payees (name, book_id, created_at, name_fold) VALUES (?1, ?2, ?3, ?4)
             RETURNING id, book_id, name, created_at",
            &params![
                name,
                book_id,
                platform::timestamp(),
                ledger_db::folds::fold(name)
            ],
        )?;
        Ok(Ok(payee_json(row)))
    })
}

pub(crate) async fn delete_payee(
    State(state): State<AppState>,
    Path((raw_book_id, raw_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> ApiResult {
    const FAILURE: &str = "Failed to delete payee";
    let book =
        authenticate_book(&state, &headers, &raw_book_id, AccessLevel::Write, FAILURE).await?;
    let payee_id = payee_path_id(&raw_id, FAILURE)?;
    let exists: bool = state
        .database
        .query_row(
            "SELECT EXISTS (SELECT 1 FROM payees WHERE id = ?1 AND book_id = ?2)",
            &params![payee_id, book.book_id()],
        )
        .map_err(|cause| internal_error(cause, FAILURE))?;
    if !exists {
        return Err(error(StatusCode::NOT_FOUND, "Payee not found"));
    }
    let used: bool = state
        .database
        .query_row(
            "SELECT EXISTS (SELECT 1 FROM transactions WHERE payee_id = ?1)",
            &params![payee_id],
        )
        .map_err(|cause| internal_error(cause, FAILURE))?;
    if used {
        return Err(error(
            StatusCode::CONFLICT,
            "Cannot delete a payee that has associated transactions",
        ));
    }
    state
        .database
        .execute(
            "DELETE FROM payees WHERE id = ?1 AND book_id = ?2",
            &params![payee_id, book.book_id()],
        )
        .map_err(|cause| internal_error(cause, FAILURE))?;
    Ok(Json(json!({ "success": true })))
}

pub(crate) async fn last_account(
    State(state): State<AppState>,
    Path((raw_book_id, raw_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> ApiResult {
    let book = authenticate_book(
        &state,
        &headers,
        &raw_book_id,
        AccessLevel::Read,
        "Failed to fetch last account",
    )
    .await?;
    // Node refuses only a value that is not finite. A finite value outside
    // the int4 range fails in PostgreSQL, and the route returns its 500.
    let id = parse_int_prefix_number(&raw_id)
        .filter(|id| id.is_finite())
        .ok_or_else(|| error(StatusCode::BAD_REQUEST, "Invalid payee id"))?;
    let id = i32::try_from(id as i64).map_err(|_| {
        error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to fetch last account",
        )
    })?;
    let today = local_today();
    let account_id: Option<i32> = state.database.query_optional("WITH latest AS (
           SELECT id FROM transactions
           WHERE book_id = ?1 AND payee_id = ?2
           ORDER BY CASE WHEN is_floating THEN ?3 ELSE date END DESC, id DESC
           LIMIT 1
         ), largest AS (
           SELECT MAX(s.amount) AS amount FROM transaction_splits s JOIN latest t ON t.id = s.transaction_id
           WHERE s.amount > 0
         ), candidates AS (
           SELECT DISTINCT s.account_id FROM transaction_splits s JOIN latest t ON t.id = s.transaction_id
           WHERE s.amount = (SELECT amount FROM largest)
         ), usage AS (
           SELECT s.account_id, COUNT(*) AS frequency
           FROM transaction_splits s JOIN transactions t ON t.id = s.transaction_id
           JOIN candidates c ON c.account_id = s.account_id
           WHERE (SELECT COUNT(*) FROM candidates) > 1
             AND t.book_id = ?1 AND t.payee_id = ?2 AND s.amount > 0
           GROUP BY s.account_id
         )
         SELECT c.account_id FROM candidates c LEFT JOIN usage u ON u.account_id = c.account_id
         ORDER BY COALESCE(u.frequency, 0) DESC, c.account_id ASC LIMIT 1",&params![book.book_id(), id, today])
    .map_err(|cause| internal_error(cause, "Failed to fetch last account"))?;
    Ok(Json(json!({ "accountId": account_id })))
}

#[cfg(test)]
mod tests {
    use super::{normalize_name, parse_limit};

    #[test]
    fn payee_search_normalizes_names_and_limits() {
        assert_eq!(normalize_name("  Bob’s   Shop "), "Bob's Shop");
        assert_eq!(
            normalize_name("\u{feff}IKEA\u{a0}\u{a0}Store"),
            "IKEA Store"
        );
        assert_eq!(normalize_name("\u{85}IKEA"), "\u{85}IKEA");
        assert_eq!(parse_limit(Some("2")), Some(2));
        assert_eq!(parse_limit(Some("1e2")), Some(100));
        assert_eq!(parse_limit(Some("bad")), None);
    }
}
