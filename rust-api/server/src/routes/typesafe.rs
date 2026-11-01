//! `settings/typesafe` and the TypeSafe retention cleanup, as the Node routes
//! and `lib/typesafe/settings.ts` do them.

use crate::{
    book_auth::{AccessLevel, AuthenticatedBook, authenticate_book},
    book_scope::{BookAccess, Write},
    cron_auth::require_cron_secret,
    db_scope::write_transaction_or,
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
use ledger_db::locks::FOR_UPDATE;
use ledger_db::store::{self, Sql, params};
use serde_json::{Value, json};

/// `typeSafeHttpError` for an error that is not a TypeSafe or reconcile
/// error: the database or anything else that throws.
const UNAVAILABLE: &str = "TypeSafe is temporarily unavailable";

/// Node logs no cause here, so that no request data can reach the log.
fn unavailable(_cause: store::Error) -> ApiError {
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

/// `getTypeSafeSettings`, on the database or inside a transaction.
fn settings(sql: &impl Sql, book_id: i32) -> Result<Value, ApiError> {
    let book: Option<(bool, bool, i32)> = sql
        .query_optional(
            "SELECT typesafe_reconciliation_enabled, typesafe_entry_enabled, typesafe_revision
             FROM books WHERE id = ?1",
            &params![book_id],
        )
        .map_err(unavailable)?;
    let (enabled, entry, revision) =
        book.ok_or_else(|| error(StatusCode::NOT_FOUND, "Book not found"))?;
    Ok(json!({
        "enabled": enabled,
        "entrySuggestionsEnabled": entry,
        "revision": revision,
        "configured": is_configured(),
    }))
}

/// The settings that a PATCH or a clear sets. `None` keeps the value.
struct Change {
    reconciliation: Option<bool>,
    entry: Option<bool>,
}

/// typesafeSettingsSchema: one or both of `enabled` and
/// `entrySuggestionsEnabled`, booleans, and no other key.
fn change(body: &Value) -> Option<Change> {
    let object = body.as_object()?;
    if object.is_empty()
        || object
            .keys()
            .any(|key| key != "enabled" && key != "entrySuggestionsEnabled")
    {
        return None;
    }
    let flag = |key: &str| match object.get(key) {
        None => Some(None),
        Some(value) => value.as_bool().map(Some),
    };
    Some(Change {
        reconciliation: flag("enabled")?,
        entry: flag("entrySuggestionsEnabled")?,
    })
}

pub(crate) async fn get_settings(
    State(state): State<AppState>,
    Path(raw_book_id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let book = authenticate(&state, &headers, &raw_book_id, AccessLevel::Read).await?;
    let mut response = Json(settings(&*state.database, book.book_id())?).into_response();
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
    let access = book.write()?;
    let body: Value = crate::validation::from_json_bytes(&body)
        .map_err(|_| error(StatusCode::BAD_REQUEST, "Invalid JSON"))?;
    let change = change(&body).ok_or_else(|| {
        error(
            StatusCode::BAD_REQUEST,
            "Expected enabled or entrySuggestionsEnabled: true or false",
        )
    })?;
    set_settings(&state, &access, change, false).map(Json)
}

/// Clear experiment data: turns both features off and deletes the book's
/// evaluations, decisions, entry records and archived counts. Quotas stay.
pub(crate) async fn clear_settings(
    State(state): State<AppState>,
    Path(raw_book_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let book = authenticate(&state, &headers, &raw_book_id, AccessLevel::Write).await?;
    let access = book.write()?;
    let off = Change {
        reconciliation: Some(false),
        entry: Some(false),
    };
    set_settings(&state, &access, off, true).map(Json)
}

/// `setTypeSafeSettings`. A change of state, or a clear, moves the revision
/// on, so a result already in flight cannot publish, and marks pending
/// evaluations of both features stale, so their lease cannot block a new
/// request. Both features share the revision.
fn set_settings(
    state: &AppState,
    access: &BookAccess<'_, Write>,
    change: Change,
    clear: bool,
) -> Result<Value, ApiError> {
    let book_id = access.book_id();
    write_transaction_or(&state.database, unavailable, |tx| {
        let current: Option<(bool, bool)> = tx
            .query_optional(
                &format!(
                    "SELECT typesafe_reconciliation_enabled, typesafe_entry_enabled
                     FROM books WHERE id = ?1{FOR_UPDATE}"
                ),
                &params![book_id],
            )
            .map_err(unavailable)?;
        let current = current.ok_or_else(|| error(StatusCode::NOT_FOUND, "Book not found"))?;
        // A request to turn a feature on fails without a key, also when it
        // is already on (the earlier rule).
        if (change.reconciliation == Some(true) || change.entry == Some(true)) && !is_configured() {
            return Err(error(
                StatusCode::CONFLICT,
                "TypeSafe is unavailable on this installation",
            ));
        }
        let next = (
            change.reconciliation.unwrap_or(current.0),
            change.entry.unwrap_or(current.1),
        );
        let mut statements = Vec::new();
        if clear || next != current {
            tx.execute(
                "UPDATE books SET typesafe_reconciliation_enabled = ?2, typesafe_entry_enabled = ?3,
                                  typesafe_revision = typesafe_revision + 1
                 WHERE id = ?1",
                &params![book_id, next.0, next.1],
            )
            .map_err(unavailable)?;
            statements.extend([
                "UPDATE typesafe_evaluations SET status = 'stale'
                 WHERE book_id = ?1 AND status = 'pending'",
                "UPDATE typesafe_entry_evaluations SET status = 'stale'
                 WHERE book_id = ?1 AND status = 'pending'",
            ]);
        }
        if clear {
            statements.extend([
                "DELETE FROM typesafe_decisions WHERE book_id = ?1",
                "DELETE FROM typesafe_evaluations WHERE book_id = ?1",
                "DELETE FROM typesafe_entry_outcomes WHERE book_id = ?1",
                "DELETE FROM typesafe_entry_evaluations WHERE book_id = ?1",
                "DELETE FROM typesafe_aggregates WHERE book_id = ?1",
            ]);
        }
        for statement in statements {
            tx.execute(statement, &params![book_id])
                .map_err(unavailable)?;
        }
        settings(tx, book_id)
    })
}

/// `GET /api/cron/typesafe-cleanup`: one bounded batch, hourly, also when
/// TypeSafe is disabled. The error body never names the cause.
pub(crate) async fn cleanup_route(headers: HeaderMap, State(state): State<AppState>) -> Response {
    let secret = ledger_db::env::var("CRON_SECRET").ok();
    if let Err(denied) = require_cron_secret(&headers, secret.as_deref()) {
        return denied.into_response();
    }
    let lease = crate::leases::wait(
        &state.database,
        crate::leases::Job::TypesafeCleanup.lease_name(),
    )
    .await;
    let Ok(running) = lease else {
        tracing::error!("TypeSafe retention cleanup failed");
        return error(StatusCode::INTERNAL_SERVER_ERROR, "Cleanup failed").into_response();
    };
    match running.guard(run_cleanup(&state)).await {
        Ok(Ok(body)) => body.into_response(),
        Ok(Err(failure)) => failure.into_response(),
        Err(_) => {
            tracing::error!("TypeSafe retention cleanup failed");
            error(StatusCode::INTERNAL_SERVER_ERROR, "Cleanup failed").into_response()
        }
    }
}

/// The TypeSafe cleanup job, without the caller check and the job lock.
pub(crate) async fn run_cleanup(state: &AppState) -> crate::error::ApiResult {
    match cleanup(&state.database, now_millis()) {
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
