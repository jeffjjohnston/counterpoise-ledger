//! The scheduled jobs. `crate::scheduler` runs them in this process on their
//! schedule. The routes `/api/cron/plaid-sync`, `/api/cron/price-sync` and
//! `/api/cron/recurring` run one now, for a caller with
//! `Bearer $CRON_SECRET`. One run of a job waits for another run of the same
//! job to finish (`JobLocks`).
//!
//! A manual run records its status as a scheduled run does
//! (`scheduler::record_run`).
//!
//! A job reports a failure of one book, token, or symbol in its body and
//! still succeeds, as the Node route did.

use crate::{
    cron_auth::require_cron_secret,
    error::{ApiResult, error},
    routes::{
        plaid_sync::{SyncError, sync_token},
        recurring::process_all,
    },
    state::AppState,
    validation::{js_round, js_to_number},
};
use axum::{
    Json,
    extract::State,
    http::{HeaderMap, StatusCode},
};
use ledger_db::engine::Db;
use serde_json::{Value, json};
use sqlx::QueryBuilder;
use std::collections::HashMap;

const PRICE_SCALE: f64 = 1_000_000.0;

fn cron_secret() -> Option<String> {
    std::env::var("CRON_SECRET").ok()
}

// ---------------------------------------------------------------------------
// GET /api/cron/plaid-sync
// ---------------------------------------------------------------------------

/// Syncs each connection that has a linked asset or liability account.
///
/// A demo connection is not synced. Its account link qualifies like a real
/// one, but Plaid always refuses its synthetic access token. A sync of it
/// would count a failure on every run and write that error to the demo
/// book's Sync page.
pub(crate) async fn plaid_sync(State(state): State<AppState>, headers: HeaderMap) -> ApiResult {
    require_cron_secret(&headers, cron_secret().as_deref())?;
    let _running = state.jobs.plaid_sync.lock().await;
    let result = run_plaid_sync(&state).await;
    // A manual run leaves the same record as a scheduled run.
    crate::scheduler::record_run("plaid-sync", &result).await;
    result
}

/// The Plaid sync job, without the caller check and the job lock.
pub(crate) async fn run_plaid_sync(state: &AppState) -> ApiResult {
    const FAILURE: &str = "Failed to run Plaid sync cron";
    if let Some(setting) = state.plaid.missing_setting() {
        return Ok(Json(json!({
            "success": true, "skipped": true, "reason": "Plaid not configured",
            "missingSetting": setting,
        })));
    }
    let tokens: Vec<(i32, i32)> = sqlx::query_as(
        "SELECT DISTINCT t.id, t.book_id FROM plaid_tokens t
         JOIN plaid_accounts p ON p.token_id = t.id
         JOIN accounts a ON a.id = p.counterpoise_account_id
         WHERE t.is_demo = false
           AND p.counterpoise_account_id IS NOT NULL
           AND a.type IN ('asset', 'liability')
         ORDER BY t.id",
    )
    .fetch_all(&state.pool)
    .await
    .map_err(|cause| {
        tracing::error!(error = %cause, "Plaid sync cron failed");
        error(StatusCode::INTERNAL_SERVER_ERROR, FAILURE)
    })?;

    let (mut synced, mut skipped) = (0, 0);
    let mut errors = Vec::new();
    for &(token_id, book_id) in &tokens {
        match sync_token(state, book_id, token_id).await {
            Ok(_) => synced += 1,
            // A manual sync of this connection is running. It fetches what
            // this sync would fetch, so the overlap is not a failure. A
            // failure count would show an error on the Sync page of a
            // healthy connection.
            Err(SyncError::Refused(StatusCode::CONFLICT, _)) => skipped += 1,
            Err(cause) => {
                let message = cause.message();
                tracing::error!(token_id, book_id, error = %message, "Plaid token sync failed");
                errors.push(json!({ "tokenId": token_id, "bookId": book_id, "error": message }));
            }
        }
    }
    let mut result = json!({
        "success": true,
        "tokensFound": tokens.len(),
        "tokensSynced": synced,
        "tokensSkipped": skipped,
        "tokensFailed": errors.len(),
    });
    if !errors.is_empty() {
        result["errors"] = Value::Array(errors);
    }
    Ok(Json(result))
}

// ---------------------------------------------------------------------------
// GET /api/cron/price-sync
// ---------------------------------------------------------------------------

/// `Math.round(price * PRICE_SCALE)` as the database driver binds it to a
/// bigint column. `None` is a value that the PostgreSQL release refused, and
/// that this route still refuses: NaN, an infinity, or a value out of the
/// bigint range.
fn price_micros(price: Option<&Value>) -> Option<i64> {
    let micros = js_round(js_to_number(price) * PRICE_SCALE);
    // -2^63 and 2^63 are exact doubles, so the bounds do not round.
    (-9_223_372_036_854_775_808.0..9_223_372_036_854_775_808.0)
        .contains(&micros)
        .then_some(micros as i64)
}

/// Adds the newest Tiingo close of each security that fetches prices. A
/// price already stored for that security and date stays, so a manual entry
/// is never replaced. After a holiday Tiingo sends the close of the market
/// day before, which is already stored, so the job can run again safely.
pub(crate) async fn price_sync(State(state): State<AppState>, headers: HeaderMap) -> ApiResult {
    require_cron_secret(&headers, cron_secret().as_deref())?;
    let _running = state.jobs.price_sync.lock().await;
    let result = run_price_sync(&state).await;
    // A manual run leaves the same record as a scheduled run.
    crate::scheduler::record_run("price-sync", &result).await;
    result
}

/// The price sync job, without the caller check and the job lock.
pub(crate) async fn run_price_sync(state: &AppState) -> ApiResult {
    const FAILURE: &str = "Failed to run price sync cron";
    if !state.tiingo.is_configured() {
        return Ok(Json(json!({
            "success": true, "skipped": true, "reason": "Tiingo not configured",
            "missingSetting": "TIINGO_API_KEY",
        })));
    }
    let failed = |cause: String| {
        tracing::error!(error = %cause, "Price sync cron failed");
        error(StatusCode::INTERNAL_SERVER_ERROR, FAILURE)
    };
    // Tiingo has no feed for a fixed-price security, such as the fixed NAV of
    // a money market fund. A fixed price also sets fetch_prices off, so this
    // filter only applies if the two disagree.
    let fetchable: Vec<(i32, i32, String)> = sqlx::query_as(
        "SELECT id, book_id, symbol FROM securities
         WHERE fetch_prices = true AND fixed_price_micros IS NULL
         ORDER BY id",
    )
    .fetch_all(&state.pool)
    .await
    .map_err(|cause| failed(cause.to_string()))?;
    if fetchable.is_empty() {
        return Ok(Json(json!({
            "success": true,
            "securitiesFound": 0,
            "pricesInserted": 0,
            "pricesSkipped": 0,
        })));
    }

    // Two books can hold the same symbol. Each symbol is fetched once.
    let mut symbols: Vec<Value> = Vec::new();
    for (_, _, symbol) in &fetchable {
        let symbol = Value::String(symbol.to_uppercase());
        if !symbols.contains(&symbol) {
            symbols.push(symbol);
        }
    }
    let (prices, errors) = state
        .tiingo
        .fetch_latest_prices(&symbols)
        .await
        .map_err(|cause| failed(cause.to_string()))?;
    let by_symbol: HashMap<String, _> = prices
        .iter()
        .map(|price| (price.symbol.to_uppercase(), price))
        .collect();

    let (mut security_ids, mut book_ids, mut dates, mut micros) =
        (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    for (id, book_id, symbol) in &fetchable {
        let Some(latest) = by_symbol.get(&symbol.to_uppercase()) else {
            continue;
        };
        // Node sends the value to the one INSERT, and PostgreSQL refuses the
        // whole statement.
        let value = price_micros(latest.price.as_ref())
            .ok_or_else(|| failed(format!("price of {symbol} is not a bigint")))?;
        security_ids.push(*id);
        book_ids.push(*book_id);
        dates.push(latest.date.clone());
        micros.push(value);
    }

    let mut inserted = 0;
    if !security_ids.is_empty() {
        let mut insert = QueryBuilder::<Db>::new(
            "INSERT INTO security_prices (security_id, book_id, price_date, price_micros, source) ",
        );
        insert.push_values(0..security_ids.len(), |mut row, index| {
            row.push_bind(security_ids[index])
                .push_bind(book_ids[index])
                .push_bind(dates[index].clone())
                .push_bind(micros[index])
                .push_bind("tiingo");
        });
        insert.push(" ON CONFLICT (security_id, price_date) DO NOTHING");
        inserted = insert
            .build()
            .execute(&state.pool)
            .await
            .map_err(|cause| failed(cause.to_string()))?
            .rows_affected();
    }
    let mut result = json!({
        "success": true,
        "securitiesFound": fetchable.len(),
        "pricesInserted": inserted,
        "pricesSkipped": security_ids.len() as u64 - inserted,
    });
    if !errors.is_empty() {
        result["errors"] = json!(errors);
    }
    Ok(Json(result))
}

// ---------------------------------------------------------------------------
// GET /api/cron/recurring
// ---------------------------------------------------------------------------

/// Processes the due recurring rules of each book. A failure in one book is
/// logged and the job continues with the next book.
pub(crate) async fn recurring(State(state): State<AppState>, headers: HeaderMap) -> ApiResult {
    require_cron_secret(&headers, cron_secret().as_deref())?;
    let _running = state.jobs.recurring.lock().await;
    let result = run_recurring(&state).await;
    // A manual run leaves the same record as a scheduled run.
    crate::scheduler::record_run("recurring", &result).await;
    result
}

/// The recurring job, without the caller check and the job lock.
pub(crate) async fn run_recurring(state: &AppState) -> ApiResult {
    const FAILURE: &str = "Failed to process recurring rules";
    let books: Vec<i32> = sqlx::query_scalar("SELECT id FROM books ORDER BY id")
        .fetch_all(&state.pool)
        .await
        .map_err(|cause| {
            tracing::error!(error = %cause, "Recurring cron failed");
            error(StatusCode::INTERNAL_SERVER_ERROR, FAILURE)
        })?;
    let mut transaction_ids = Vec::new();
    for &book_id in &books {
        match process_all(&state.pool, book_id, FAILURE).await {
            Ok(processed) => transaction_ids.extend(processed.transaction_ids),
            // process_all logs the cause.
            Err(_) => tracing::error!(book_id, "Recurring rules of a book failed"),
        }
    }
    Ok(Json(json!({
        "success": true,
        "booksProcessed": books.len(),
        "transactionsCreated": transaction_ids.len(),
        "transactionIds": transaction_ids,
    })))
}

#[cfg(test)]
mod tests {
    use super::price_micros;
    use serde_json::json;

    #[test]
    fn price_micros_follows_math_round_and_the_bigint_range() {
        assert_eq!(price_micros(Some(&json!(299.123456))), Some(299_123_456));
        assert_eq!(price_micros(Some(&json!(0.0000005))), Some(1));
        assert_eq!(price_micros(Some(&json!(-0.0000005))), Some(0));
        assert_eq!(price_micros(Some(&json!("12.5"))), Some(12_500_000));
        assert_eq!(price_micros(Some(&json!(null))), Some(0));
        assert_eq!(price_micros(Some(&json!([7]))), Some(7_000_000));
        assert_eq!(price_micros(None), None);
        assert_eq!(price_micros(Some(&json!("abc"))), None);
        assert_eq!(price_micros(Some(&json!({}))), None);
        assert_eq!(price_micros(Some(&json!(1e300))), None);
    }
}
