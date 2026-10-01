//! `settings/typesafe` and the TypeSafe retention cleanup, as the Node routes
//! and `lib/typesafe/settings.ts` do them.

use crate::{
    book_auth::{AccessLevel, AuthenticatedBook, authenticate_book},
    cron_auth::require_cron_secret,
    error::{ApiError, error},
    routes::transactions::now_millis,
    state::AppState,
    typesafe::{CLEANUP_BATCH, cleanup, is_configured},
};
use axum::{
    Json,
    body::Bytes,
    extract::{Path, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use ledger_db::engine::DbExecutor;
use ledger_db::locks::FOR_UPDATE;
use serde_json::{Value, json};

/// `typeSafeHttpError` for an error that is not a TypeSafe or reconcile
/// error: the database or anything else that throws.
const UNAVAILABLE: &str = "TypeSafe is temporarily unavailable";

/// Node logs no cause here, so that no request data can reach the log.
fn unavailable(_cause: sqlx::Error) -> ApiError {
    tracing::error!("TypeSafe request failed");
    error(StatusCode::SERVICE_UNAVAILABLE, UNAVAILABLE)
}

/// The route checks the ID shape before it authenticates, so a malformed ID
/// answers 400 even without a session.
async fn authenticate(
    state: &AppState,
    headers: &HeaderMap,
    raw_book_id: &str,
    level: AccessLevel,
) -> Result<AuthenticatedBook, ApiError> {
    let mut chars = raw_book_id.chars();
    let well_formed = chars
        .next()
        .is_some_and(|first| ('1'..='9').contains(&first))
        && chars.all(|c| c.is_ascii_digit());
    if !well_formed {
        return Err(error(StatusCode::BAD_REQUEST, "Invalid book ID"));
    }
    authenticate_book(state, headers, raw_book_id, level, UNAVAILABLE)
        .await
        .map_err(|denied| {
            if denied.status() == StatusCode::INTERNAL_SERVER_ERROR {
                error(StatusCode::SERVICE_UNAVAILABLE, UNAVAILABLE)
            } else {
                denied
            }
        })
}

/// `getTypeSafeSettings`, on the pool or inside a transaction.
async fn settings<'e, E>(executor: E, book_id: i32) -> Result<Value, ApiError>
where
    E: DbExecutor<'e>,
{
    let book: Option<(bool, i32)> = sqlx::query_as(
        "SELECT typesafe_reconciliation_enabled, typesafe_revision FROM books WHERE id = $1",
    )
    .bind(book_id)
    .fetch_optional(executor)
    .await
    .map_err(unavailable)?;
    let (enabled, revision) = book.ok_or_else(|| error(StatusCode::NOT_FOUND, "Book not found"))?;
    Ok(json!({ "enabled": enabled, "revision": revision, "configured": is_configured() }))
}

pub(crate) async fn get_settings(
    State(state): State<AppState>,
    Path(raw_book_id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let book = authenticate(&state, &headers, &raw_book_id, AccessLevel::Read).await?;
    let mut response = Json(settings(&state.pool, book.book_id).await?).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(response)
}

pub(crate) async fn update_settings(
    State(state): State<AppState>,
    Path(raw_book_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<Value>, ApiError> {
    let book = authenticate(&state, &headers, &raw_book_id, AccessLevel::Write).await?;
    let body: Value = crate::validation::from_json_bytes(&body)
        .map_err(|_| error(StatusCode::BAD_REQUEST, "Invalid JSON"))?;
    // typesafeSettingsSchema: exactly `{ enabled: boolean }`.
    let enabled = match body.as_object() {
        Some(object) if object.len() == 1 => object.get("enabled").and_then(Value::as_bool),
        _ => None,
    }
    .ok_or_else(|| error(StatusCode::BAD_REQUEST, "Expected enabled: true or false"))?;
    set_settings(&state, book.book_id, enabled, false)
        .await
        .map(Json)
}

/// Clear experiment data: turns the feature off and deletes the book's
/// evaluations, decisions and archived counts. Quotas stay.
pub(crate) async fn clear_settings(
    State(state): State<AppState>,
    Path(raw_book_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let book = authenticate(&state, &headers, &raw_book_id, AccessLevel::Write).await?;
    set_settings(&state, book.book_id, false, true)
        .await
        .map(Json)
}

/// `setTypeSafeSettings`. A change of state, or a clear, moves the revision
/// on, so a result already in flight cannot publish, and marks pending
/// evaluations stale, so their lease cannot block a new request.
async fn set_settings(
    state: &AppState,
    book_id: i32,
    enabled: bool,
    clear: bool,
) -> Result<Value, ApiError> {
    let mut transaction = ledger_db::locks::begin_pool(&state.pool)
        .await
        .map_err(unavailable)?;
    let current: Option<bool> = sqlx::query_scalar(&format!(
        "SELECT typesafe_reconciliation_enabled FROM books WHERE id = $1{FOR_UPDATE}"
    ))
    .bind(book_id)
    .fetch_optional(transaction.as_mut())
    .await
    .map_err(unavailable)?;
    let current = current.ok_or_else(|| error(StatusCode::NOT_FOUND, "Book not found"))?;
    if enabled && !is_configured() {
        return Err(error(
            StatusCode::CONFLICT,
            "TypeSafe is unavailable on this installation",
        ));
    }
    if clear || current != enabled {
        sqlx::query(
            "UPDATE books SET typesafe_reconciliation_enabled = $2,
                              typesafe_revision = typesafe_revision + 1
             WHERE id = $1",
        )
        .bind(book_id)
        .bind(enabled)
        .execute(transaction.as_mut())
        .await
        .map_err(unavailable)?;
        sqlx::query(
            "UPDATE typesafe_evaluations SET status = 'stale'
             WHERE book_id = $1 AND status = 'pending'",
        )
        .bind(book_id)
        .execute(transaction.as_mut())
        .await
        .map_err(unavailable)?;
    }
    if clear {
        for statement in [
            "DELETE FROM typesafe_decisions WHERE book_id = $1",
            "DELETE FROM typesafe_evaluations WHERE book_id = $1",
            "DELETE FROM typesafe_aggregates WHERE book_id = $1",
        ] {
            sqlx::query(statement)
                .bind(book_id)
                .execute(transaction.as_mut())
                .await
                .map_err(unavailable)?;
        }
    }
    let result = settings(transaction.as_mut(), book_id).await?;
    transaction.commit().await.map_err(unavailable)?;
    Ok(result)
}

/// `GET /api/cron/typesafe-cleanup`: one bounded batch, hourly, also when
/// TypeSafe is disabled. The error body never names the cause.
pub(crate) async fn cleanup_route(headers: HeaderMap, State(state): State<AppState>) -> Response {
    let secret = std::env::var("CRON_SECRET").ok();
    if let Err(denied) = require_cron_secret(&headers, secret.as_deref()) {
        return denied.into_response();
    }
    let _running = state.jobs.typesafe_cleanup.lock().await;
    match run_cleanup(&state).await {
        Ok(body) => body.into_response(),
        Err(failure) => failure.into_response(),
    }
}

/// The TypeSafe cleanup job, without the caller check and the job lock.
pub(crate) async fn run_cleanup(state: &AppState) -> crate::error::ApiResult {
    match cleanup(&state.pool, now_millis()).await {
        Ok(deleted) => Ok(Json(
            json!({ "deleted": deleted, "batchLimit": CLEANUP_BATCH }),
        )),
        Err(_) => {
            // As in Node, the log names no cause.
            tracing::error!("TypeSafe retention cleanup failed");
            Err(error(StatusCode::INTERNAL_SERVER_ERROR, "Cleanup failed"))
        }
    }
}
