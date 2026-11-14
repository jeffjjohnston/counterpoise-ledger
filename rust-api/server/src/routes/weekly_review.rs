//! The weekly review routes (guides/weekly-review.md): the book setting, the
//! latest review, a manual run, dismiss and restore, and the cron job.

use crate::{
    book_auth::{AccessLevel, AuthenticatedBook, authenticate_book},
    book_scope::{BookAccess, Write},
    cron_auth::require_cron_secret,
    db_scope::{read_transaction, write_transaction},
    error::{ApiError, ApiResult, error},
    platform,
    routes::{sync::iso_timestamp, transactions::now_millis},
    state::AppState,
    weekly_review::{self, Start, anthropic::is_configured},
};
use axum::{
    Json,
    body::Bytes,
    extract::{Path, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use chrono::NaiveDateTime;
use ledger_db::locks::FOR_UPDATE;
use ledger_db::{
    Sql,
    store::{Builder, params},
};
use serde_json::{Value, json};
use std::collections::HashMap;

const FAILURE: &str = "The weekly review is temporarily unavailable";
const UNAVAILABLE: &str = "The weekly review is unavailable on this installation";
const ITEM_NOT_FOUND: &str = "Review item not found";

fn failed(cause: impl std::fmt::Display) -> ApiError {
    tracing::error!(error = %cause, "Weekly review request failed");
    error(StatusCode::INTERNAL_SERVER_ERROR, FAILURE)
}

async fn authenticate(
    state: &AppState,
    headers: &HeaderMap,
    raw_book_id: &str,
    level: AccessLevel,
) -> Result<AuthenticatedBook, ApiError> {
    authenticate_book(state, headers, raw_book_id, level, FAILURE).await
}

fn no_store(value: Value) -> Response {
    let mut response = Json(value).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

fn settings(sql: &impl Sql, book_id: i32) -> Result<Value, ApiError> {
    let book: Option<(bool, i64)> = sql
        .query_optional(
            "SELECT weekly_review_enabled, weekly_review_revision FROM books WHERE id = ?1",
            &params![book_id],
        )
        .map_err(failed)?;
    let (enabled, revision) = book.ok_or_else(|| error(StatusCode::NOT_FOUND, "Book not found"))?;
    Ok(json!({ "enabled": enabled, "revision": revision, "configured": is_configured() }))
}

pub(crate) async fn get_weekly_review_settings(
    State(state): State<AppState>,
    Path(raw_book_id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let book = authenticate(&state, &headers, &raw_book_id, AccessLevel::Read).await?;
    Ok(no_store(settings(&*state.database, book.book_id())?))
}

pub(crate) async fn update_weekly_review_settings(
    State(state): State<AppState>,
    Path(raw_book_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult {
    let book = authenticate(&state, &headers, &raw_book_id, AccessLevel::Write).await?;
    let access = book.write()?;
    let body: Value = crate::validation::from_json_bytes(&body)
        .map_err(|_| error(StatusCode::BAD_REQUEST, "Invalid JSON"))?;
    let enabled = match body.as_object() {
        Some(object) if object.len() == 1 => object.get("enabled").and_then(Value::as_bool),
        _ => None,
    }
    .ok_or_else(|| error(StatusCode::BAD_REQUEST, "Expected enabled: true or false"))?;
    set_settings(&state, &access, enabled, false).map(Json)
}

/// Turns the feature off and deletes the reviews of the book.
pub(crate) async fn clear_weekly_review_settings(
    State(state): State<AppState>,
    Path(raw_book_id): Path<String>,
    headers: HeaderMap,
) -> ApiResult {
    let book = authenticate(&state, &headers, &raw_book_id, AccessLevel::Write).await?;
    let access = book.write()?;
    set_settings(&state, &access, false, true).map(Json)
}

/// A change of state, or a clear, moves the revision on, so that a result
/// already in flight is discarded.
fn set_settings(
    state: &AppState,
    access: &BookAccess<'_, Write>,
    enabled: bool,
    clear: bool,
) -> Result<Value, ApiError> {
    let book_id = access.book_id();
    write_transaction(&state.database, FAILURE, |tx| {
        let current: Option<bool> = tx
            .query_optional(
                &format!("SELECT weekly_review_enabled FROM books WHERE id = ?1{FOR_UPDATE}"),
                &params![book_id],
            )
            .map_err(failed)?;
        let current = current.ok_or_else(|| error(StatusCode::NOT_FOUND, "Book not found"))?;
        if enabled && !is_configured() {
            return Err(error(StatusCode::CONFLICT, UNAVAILABLE));
        }
        if clear || current != enabled {
            tx.execute(
                "UPDATE books SET weekly_review_enabled = ?2,
                                  weekly_review_revision = weekly_review_revision + 1
                 WHERE id = ?1",
                &params![book_id, enabled],
            )
            .map_err(failed)?;
        }
        if clear {
            tx.execute(
                "DELETE FROM weekly_reviews WHERE book_id = ?1",
                &params![book_id],
            )
            .map_err(failed)?;
        }
        settings(tx, book_id)
    })
}

// ---------------------------------------------------------------------------
// The review
// ---------------------------------------------------------------------------

#[derive(ledger_db::store::FromRow)]
struct ReviewRow {
    id: i64,
    source: String,
    period_start: String,
    period_end: String,
    status: String,
    summary: Option<String>,
    error: Option<String>,
    model: Option<String>,
    started_at: NaiveDateTime,
    completed_at: Option<NaiveDateTime>,
}

const REVIEW_COLUMNS: &str = "id, source, period_start, period_end, status, summary, error, model, \
                              started_at, completed_at";

#[derive(ledger_db::store::FromRow)]
struct ItemRow {
    id: i64,
    kind: String,
    category: String,
    title: String,
    detail: String,
    transaction_ids: String,
    recurring_rule_id: Option<i64>,
    dismissed_at: Option<NaiveDateTime>,
}

const ITEM_COLUMNS: &str =
    "id, kind, category, title, detail, transaction_ids, recurring_rule_id, dismissed_at";

fn transaction_ids(row: &ItemRow) -> Vec<i64> {
    serde_json::from_str(&row.transaction_ids).unwrap_or_default()
}

/// The register account of each transaction: its first asset or liability
/// account, else its first account. The card links to the register of that
/// account, because the register without `accountId` opens the favorite
/// account and loses `highlight`. A deleted transaction has no entry.
fn register_accounts(
    sql: &impl Sql,
    book_id: i32,
    items: &[ItemRow],
) -> Result<HashMap<i64, i64>, ApiError> {
    let ids: Vec<i64> = items.iter().flat_map(transaction_ids).collect();
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let mut query = Builder::new(
        "SELECT s.transaction_id,
                COALESCE(MIN(CASE WHEN a.type IN ('asset', 'liability') THEN s.account_id END),
                         MIN(s.account_id))
         FROM transaction_splits s
         JOIN accounts a ON a.id = s.account_id AND a.book_id = s.book_id
         WHERE s.book_id = ",
    );
    query
        .push_bind(book_id)
        .push(" AND s.transaction_id ")
        .push_in_integers(&ids)
        .push(" GROUP BY s.transaction_id");
    let rows: Vec<(i64, i64)> = query.query(sql).map_err(failed)?;
    Ok(rows.into_iter().collect())
}

fn item_json(row: &ItemRow, accounts: &HashMap<i64, i64>) -> Value {
    let ids = transaction_ids(row);
    let transactions: Vec<Value> = ids
        .iter()
        .map(|id| json!({ "id": id, "accountId": accounts.get(id) }))
        .collect();
    json!({
        "id": row.id,
        "kind": row.kind,
        "category": row.category,
        "title": row.title,
        "detail": row.detail,
        "transactionIds": ids,
        "transactions": transactions,
        "recurringRuleId": row.recurring_rule_id,
        "dismissedAt": row.dismissed_at.map(iso_timestamp),
    })
}

fn review_json(row: &ReviewRow, items: Vec<Value>) -> Value {
    json!({
        "id": row.id,
        "source": row.source,
        "periodStart": row.period_start,
        "periodEnd": row.period_end,
        "status": row.status,
        "summary": row.summary,
        "error": row.error,
        "model": row.model,
        "startedAt": iso_timestamp(row.started_at),
        "completedAt": row.completed_at.map(iso_timestamp),
        "items": items,
    })
}

fn newest(sql: &impl Sql, book_id: i32, status: &str) -> Result<Option<ReviewRow>, ApiError> {
    sql.query_optional(
        &format!(
            "SELECT {REVIEW_COLUMNS} FROM weekly_reviews WHERE book_id = ?1 AND status = ?2
             ORDER BY started_at DESC, id DESC LIMIT 1"
        ),
        &params![book_id, status],
    )
    .map_err(failed)
}

/// `GET /api/b/{bookId}/weekly-review`: the newest complete review with its
/// items that are not dismissed, the running review, and a failure newer
/// than the newest complete review.
pub(crate) async fn get_weekly_review(
    State(state): State<AppState>,
    Path(raw_book_id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let book = authenticate(&state, &headers, &raw_book_id, AccessLevel::Read).await?;
    let book_id = book.book_id();
    // One snapshot for every read. A save that commits between two reads
    // could otherwise remove the review from `running` before `latest` or
    // `lastFailure` shows it, and the card would show no review.
    read_transaction(&state.database, FAILURE, |snapshot| {
        let enabled = settings(snapshot, book_id)?["enabled"] == true;
        let complete = newest(snapshot, book_id, "complete")?;
        let latest = match &complete {
            None => Value::Null,
            Some(row) => {
                let items: Vec<ItemRow> = snapshot
                    .query(
                        &format!(
                            "SELECT {ITEM_COLUMNS} FROM weekly_review_items
                             WHERE book_id = ?1 AND review_id = ?2 AND dismissed_at IS NULL
                             ORDER BY position"
                        ),
                        &params![book_id, row.id],
                    )
                    .map_err(failed)?;
                let accounts = register_accounts(snapshot, book_id, &items)?;
                review_json(
                    row,
                    items
                        .iter()
                        .map(|item| item_json(item, &accounts))
                        .collect(),
                )
            }
        };
        // A run older than STALE_RUN lost its save. It is not reported as
        // running, so the card offers "Review now", whose start marks it
        // interrupted.
        let fresh_since = now_millis() - crate::weekly_review::STALE_RUN;
        let running = newest(snapshot, book_id, "running")?
            .filter(|row| row.started_at > fresh_since)
            .map(|row| {
                json!({
                    "id": row.id,
                    "periodStart": row.period_start,
                    "periodEnd": row.period_end,
                    "startedAt": iso_timestamp(row.started_at),
                })
            });
        let last_failure = newest(snapshot, book_id, "failed")?
            .filter(|failure| {
                complete
                    .as_ref()
                    .is_none_or(|row| (failure.started_at, failure.id) > (row.started_at, row.id))
            })
            .map(|row| {
                json!({
                    "id": row.id,
                    "error": row.error,
                    "completedAt": row.completed_at.map(iso_timestamp),
                })
            });
        Ok(no_store(json!({
            "configured": is_configured(),
            "enabled": enabled,
            "latest": latest,
            "running": running,
            "lastFailure": last_failure,
        })))
    })
}

/// `POST /api/b/{bookId}/weekly-review/run`: starts a review and answers at
/// once. The call to Claude runs in a background task, which keeps a
/// Durable Object up until it ends.
pub(crate) async fn run_weekly_review_now(
    State(state): State<AppState>,
    Path(raw_book_id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let book = authenticate(&state, &headers, &raw_book_id, AccessLevel::Write).await?;
    let access = book.write()?;
    if !is_configured() {
        return Err(error(StatusCode::CONFLICT, UNAVAILABLE));
    }
    match weekly_review::start(&state.database, &access, "manual").map_err(failed)? {
        Start::NotEnabled => Err(error(
            StatusCode::CONFLICT,
            "The weekly review is off for this book",
        )),
        Start::Running => Err(error(
            StatusCode::CONFLICT,
            "A review of this book is running",
        )),
        // Only a scheduled start has a limit.
        Start::AttemptsUsed => Err(failed("a manual review met the scheduled limit")),
        Start::Started(id) => {
            let (database, access) = (state.database.clone(), access.detach());
            platform::spawn_to_finish(async move {
                weekly_review::run(&database, access, id).await;
            });
            Ok((StatusCode::ACCEPTED, Json(json!({ "id": id }))).into_response())
        }
    }
}

pub(crate) async fn dismiss_weekly_review_item(
    State(state): State<AppState>,
    Path((raw_book_id, raw_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> ApiResult {
    let book = authenticate(&state, &headers, &raw_book_id, AccessLevel::Write).await?;
    set_dismissed(&state, &book, &raw_id, true).await
}

pub(crate) async fn restore_weekly_review_item(
    State(state): State<AppState>,
    Path((raw_book_id, raw_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> ApiResult {
    let book = authenticate(&state, &headers, &raw_book_id, AccessLevel::Write).await?;
    set_dismissed(&state, &book, &raw_id, false).await
}

async fn set_dismissed(
    state: &AppState,
    book: &AuthenticatedBook,
    raw_id: &str,
    dismissed: bool,
) -> ApiResult {
    let access = book.write()?;
    let id: i64 = raw_id
        .parse()
        .ok()
        .filter(|id| *id > 0)
        .ok_or_else(|| error(StatusCode::BAD_REQUEST, "Invalid item ID"))?;
    let row: Option<ItemRow> = state
        .database
        .query_optional(
            &format!(
                "UPDATE weekly_review_items SET dismissed_at = ?3, dismissed_by = ?4
         WHERE id = ?2 AND book_id = ?1 RETURNING {ITEM_COLUMNS}"
            ),
            &params![
                access.book_id(),
                id,
                dismissed.then(now_millis),
                if dismissed { access.user_id() } else { None }
            ],
        )
        .map_err(failed)?;
    let row = row.ok_or_else(|| error(StatusCode::NOT_FOUND, ITEM_NOT_FOUND))?;
    let accounts = register_accounts(
        &*state.database,
        access.book_id(),
        std::slice::from_ref(&row),
    )?;
    Ok(Json(item_json(&row, &accounts)))
}

// ---------------------------------------------------------------------------
// GET /api/cron/weekly-review
// ---------------------------------------------------------------------------

pub(crate) async fn weekly_review_cron(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> ApiResult {
    let secret = ledger_db::env::var("CRON_SECRET").ok();
    require_cron_secret(&headers, secret.as_deref())?;
    let running = crate::leases::wait(
        &state.database,
        crate::leases::Job::WeeklyReview.lease_name(),
    )
    .await
    .map_err(|cause| crate::error::internal_error(cause, "Failed to start the job"))?;
    let result = running
        .guard(run_weekly_review(&state))
        .await
        .unwrap_or_else(|lost| {
            Err(crate::error::internal_error(
                lost,
                crate::routes::cron::LEASE_LOST,
            ))
        });
    crate::scheduler::record_run(&state, "weekly-review", &result);
    result
}

/// The weekly job, without the caller check and the job lock. It reviews
/// each book that opted in, one after the other. The failure of one book is
/// logged and does not stop the others.
pub(crate) async fn run_weekly_review(state: &AppState) -> ApiResult {
    Ok(review_books(state, None, usize::MAX).await?.0)
}

/// Reviews at most `limit` of the books that opted in, in ID order, from
/// the first after `after`. The second value is the ID of the last book
/// reviewed when more remain: where the next step starts. A scheduled run
/// reviews one book per step, so one step fits in the time that a Workers
/// alarm has.
///
/// A book that already has a complete scheduled review of this week is left
/// out, so a second run of the job (a retried alarm, a run that stopped and
/// starts again, or the later runs of the Monday) does not ask Claude again.
/// A failed scheduled review does not count as the review of the week: a
/// later run tries the book again, until the book has
/// `SCHEDULED_ATTEMPTS` failed scheduled reviews of the week. The selection
/// leaves such a book out, and `weekly_review::start` applies the limit
/// again in its transaction, after a stale `running` review became failed.
///
/// The last step of a run counts the books that opted in and have no
/// complete scheduled review of the week (`booksWithoutReview`): a review
/// failed, or a manual review of the book was running. The scheduler records
/// a run with such a book as failed, so the status page shows it.
pub(crate) async fn review_books(
    state: &AppState,
    after: Option<i32>,
    limit: usize,
) -> Result<(Json<Value>, Option<i32>), ApiError> {
    if !is_configured() {
        return Ok((
            Json(json!({
                "success": true,
                "skipped": true,
                "missingSetting": "ANTHROPIC_API_KEY",
            })),
            None,
        ));
    }
    // The period that `weekly_review::start` gives a review that starts
    // today.
    let period_start = platform::today() - chrono::Days::new(7);
    let mut books: Vec<i32> = state
        .database
        .query(
            &format!(
                "SELECT b.id FROM books b
                 WHERE b.weekly_review_enabled = 1 AND b.id > ?1 AND {no_review}
                   AND (SELECT COUNT(*) FROM weekly_reviews r
                     WHERE r.book_id = b.id AND r.source = 'schedule' AND r.period_start = ?2
                       AND r.status = 'failed') < ?3
                 ORDER BY b.id",
                no_review = no_review_of_the_week("?2")
            ),
            &params![
                after.unwrap_or(i32::MIN),
                period_start,
                weekly_review::SCHEDULED_ATTEMPTS
            ],
        )
        .map_err(failed)?;
    let more = books.len() > limit;
    books.truncate(limit);
    let next = if more { books.last().copied() } else { None };
    let (mut reviewed, mut failures) = (0, 0);
    for book_id in books {
        let access = BookAccess::for_system_job(book_id);
        match weekly_review::start(&state.database, &access, "schedule") {
            Ok(Start::Started(id)) => {
                if weekly_review::run(&state.database, access, id).await {
                    reviewed += 1;
                } else {
                    failures += 1;
                }
            }
            // A manual review of the book is running. The book keeps no
            // scheduled review of the week, so a later run tries it again.
            Ok(Start::Running) => {
                tracing::warn!(
                    book_id,
                    "A review of the book is running: a later run tries again"
                );
            }
            // `AttemptsUsed`: a stale review became the last failure that
            // the week allows, after the selection counted the failures.
            // The count below reports the book.
            Ok(Start::NotEnabled | Start::AttemptsUsed) => {}
            Err(cause) => {
                tracing::error!(book_id, error = %cause, "Could not start a weekly review");
                failures += 1;
            }
        }
    }
    let mut body = json!({ "success": true, "booksReviewed": reviewed, "booksFailed": failures });
    if next.is_none() {
        let without: i64 = state
            .database
            .query_row(
                &format!(
                    "SELECT COUNT(*) FROM books b
                     WHERE b.weekly_review_enabled = 1 AND {no_review}",
                    no_review = no_review_of_the_week("?1")
                ),
                &params![period_start],
            )
            .map_err(failed)?;
        body["booksWithoutReview"] = json!(without);
    }
    Ok((Json(body), next))
}

/// The SQL condition that the book `b` has no complete scheduled review of
/// the week. `period_start` is the parameter that holds the first day of the
/// week.
fn no_review_of_the_week(period_start: &str) -> String {
    format!(
        "NOT EXISTS (SELECT 1 FROM weekly_reviews r
           WHERE r.book_id = b.id AND r.source = 'schedule' AND r.status = 'complete'
             AND r.period_start = {period_start})"
    )
}
