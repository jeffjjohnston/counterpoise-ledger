//! The scheduled jobs. `crate::scheduler` runs them in this process on their
//! schedule. The routes `/api/cron/plaid-sync`, `/api/cron/price-sync` and
//! `/api/cron/recurring` run one now, for a caller with
//! `Bearer $CRON_SECRET`. One run of a job waits for another run of the same
//! job to finish: each run holds the job's lease (`crate::leases`).
//!
//! A manual run records its status as a scheduled run does
//! (`scheduler::record_run`).
//!
//! A job reports a failure of one book, token, or symbol in its body and
//! still succeeds, as the Node route did.

use crate::{
    book_scope::BookAccess,
    cron_auth::require_cron_secret,
    error::{ApiResult, error},
    routes::{
        investments::positions,
        plaid_sync::{SyncError, sync_token},
        recurring::process_all,
    },
    state::AppState,
    tiingo::FailureKind,
    validation::{js_round, js_to_number},
};
use axum::{
    Json,
    extract::State,
    http::{HeaderMap, StatusCode},
};
use ledger_db::sql;
use ledger_db::store::{Sql, params};
use serde_json::{Value, json};
use std::collections::{BTreeSet, HashMap, HashSet};

const PRICE_SCALE: f64 = 1_000_000.0;

fn cron_secret() -> Option<String> {
    ledger_db::env::var("CRON_SECRET").ok()
}

// ---------------------------------------------------------------------------
// GET /api/cron/plaid-sync
// ---------------------------------------------------------------------------

/// The answer of a manual run that stopped because its lease lapsed.
pub(crate) const LEASE_LOST: &str = "The job stopped before it finished";

/// Syncs each connection that has a linked asset or liability account.
///
/// A demo connection is not synced. Its account link qualifies like a real
/// one, but Plaid always refuses its synthetic access token. A sync of it
/// would count a failure on every run and write that error to the demo
/// book's Sync page.
pub(crate) async fn plaid_sync(State(state): State<AppState>, headers: HeaderMap) -> ApiResult {
    require_cron_secret(&headers, cron_secret().as_deref())?;
    let running = crate::leases::wait(&state.database, crate::leases::Job::PlaidSync.lease_name())
        .await
        .map_err(|cause| crate::error::internal_error(cause, "Failed to start the job"))?;
    let result = running
        .guard(run_plaid_sync(&state))
        .await
        .unwrap_or_else(|lost| Err(crate::error::internal_error(lost, LEASE_LOST)));
    // A manual run leaves the same record as a scheduled run.
    crate::scheduler::record_run(&state, "plaid-sync", &result);
    result
}

/// The Plaid sync job, without the caller check and the job lock.
pub(crate) async fn run_plaid_sync(state: &AppState) -> ApiResult {
    Ok(sync_connections(state, None, usize::MAX).await?.0)
}

/// Syncs at most `limit` of the linked connections, in ID order, from the
/// first after `after`. The second value is the ID of the last connection
/// synced when more remain: where the next step starts. A scheduled run
/// syncs a few connections per step, so one step fits in the time that a
/// Workers alarm has.
pub(crate) async fn sync_connections(
    state: &AppState,
    after: Option<i32>,
    limit: usize,
) -> Result<(Json<Value>, Option<i32>), crate::error::ApiError> {
    const FAILURE: &str = "Failed to run Plaid sync cron";
    if let Some(setting) = state.plaid.missing_setting() {
        return Ok((
            Json(json!({
                "success": true, "skipped": true, "reason": "Plaid not configured",
                "missingSetting": setting,
            })),
            None,
        ));
    }
    let mut tokens: Vec<(i32, i32)> = state
        .database
        .query(
            "SELECT DISTINCT t.id, t.book_id FROM plaid_tokens t
         JOIN plaid_accounts p ON p.token_id = t.id
         JOIN accounts a ON a.id = p.counterpoise_account_id
         WHERE t.is_demo = false
           AND p.counterpoise_account_id IS NOT NULL
           AND a.type IN ('asset', 'liability')
           AND t.id > ?1
         ORDER BY t.id",
            &params![after.unwrap_or(i32::MIN)],
        )
        .map_err(|cause| {
            tracing::error!(error = %cause, "Plaid sync cron failed");
            error(StatusCode::INTERNAL_SERVER_ERROR, FAILURE)
        })?;
    let more = tokens.len() > limit;
    tokens.truncate(limit);

    let (mut synced, mut skipped) = (0, 0);
    let mut errors = Vec::new();
    for &(token_id, book_id) in &tokens {
        // A scheduled job has no user. The query above chose the token and its
        // book.
        let access = BookAccess::for_system_job(book_id);
        match sync_token(state, &access, token_id).await {
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
    let next = if more {
        tokens.last().map(|&(token_id, _)| token_id)
    } else {
        None
    };
    Ok((Json(result), next))
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

/// Adds the newest Tiingo close of each security that fetches prices and has
/// an open position in its book. A price already stored for that security and date stays, so a manual entry
/// is never replaced. After a holiday Tiingo sends the close of the market
/// day before, which is already stored, so the job can run again safely.
pub(crate) async fn price_sync(State(state): State<AppState>, headers: HeaderMap) -> ApiResult {
    require_cron_secret(&headers, cron_secret().as_deref())?;
    let running = crate::leases::wait(&state.database, crate::leases::Job::PriceSync.lease_name())
        .await
        .map_err(|cause| crate::error::internal_error(cause, "Failed to start the job"))?;
    let result = running
        .guard(run_price_sync(&state))
        .await
        .unwrap_or_else(|lost| Err(crate::error::internal_error(lost, LEASE_LOST)));
    // A manual run leaves the same record as a scheduled run.
    crate::scheduler::record_run(&state, "price-sync", &result);
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
    let mut fetchable: Vec<(i32, i32, String)> = state
        .database
        .query(
            "SELECT id, book_id, symbol FROM securities
         WHERE fetch_prices = true AND fixed_price_micros IS NULL
         ORDER BY id",
            &[],
        )
        .map_err(|cause| failed(cause.to_string()))?;
    // A security that no book holds needs no price. Each request counts
    // against the hourly Tiingo limit, and an old security, such as an
    // expired option, can use all of it. A position is open when
    // `positions()` gives it, as for the prices-due pill.
    let books: BTreeSet<i32> = fetchable.iter().map(|(_, book_id, _)| *book_id).collect();
    let mut held = HashSet::new();
    for book_id in books {
        let open =
            positions(&state.database, book_id, None).map_err(|cause| failed(cause.to_string()))?;
        held.extend(open.into_iter().map(|position| position.security_id));
    }
    fetchable.retain(|(id, _, _)| held.contains(&i64::from(*id)));
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
        // One request at a time, so that no request goes out after a 429.
        .fetch_latest_prices(&symbols, 1)
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

    // Tiingo answers 404 when it has no ticker of that name, such as an
    // expired option. Such a security never gets a price from Tiingo, and
    // each request for it uses one of the hourly requests, so fetching stops.
    // The prices-due pill then asks for its price if a book holds it.
    let not_found: Vec<&str> = errors
        .iter()
        .filter(|error| error.kind == FailureKind::NotFound)
        .filter_map(|error| error.symbol.as_str())
        .collect();
    let disabled: Vec<i32> = fetchable
        .iter()
        .filter(|(_, _, symbol)| not_found.contains(&symbol.to_uppercase().as_str()))
        .map(|(id, _, _)| *id)
        .collect();

    let written = state.database.transaction(|tx| {
        let mut inserted = 0;
        if !security_ids.is_empty() {
            let rows: Vec<_> = (0..security_ids.len())
                .map(|index| {
                    (
                        security_ids[index],
                        book_ids[index],
                        &dates[index],
                        micros[index],
                    )
                })
                .collect();
            inserted = tx.execute(
                &format!(
                    "INSERT INTO security_prices
                       (security_id, book_id, price_date, price_micros, source)
                     {} ON CONFLICT (security_id, price_date) DO NOTHING",
                    sql::json_rows(&["#0", "#1", "#2", "#3", "'tiingo'"], "?1")
                ),
                &params![sql::json_array(&rows)],
            )?;
        }
        if !disabled.is_empty() {
            tx.execute(
                &format!(
                    "UPDATE securities SET fetch_prices = false WHERE id {}",
                    sql::in_integers("?1")
                ),
                &params![sql::json_array(&disabled)],
            )?;
        }
        Ok::<_, ledger_db::store::Error>(inserted)
    });
    let inserted = written.map_err(|cause| failed(cause.to_string()))?;
    for failure in &errors {
        tracing::warn!(symbol = %failure.symbol, error = %failure.error, "Tiingo price fetch failed");
    }
    for symbol in &not_found {
        tracing::warn!(
            symbol,
            "Tiingo has no such ticker; price fetching turned off"
        );
    }
    let rate_limited = errors
        .iter()
        .any(|error| error.kind == FailureKind::RateLimited);
    tracing::info!(
        securities = fetchable.len(),
        inserted,
        skipped = security_ids.len() as u64 - inserted,
        errors = errors.len(),
        rate_limited,
        "Price sync results"
    );

    let mut result = json!({
        "success": true,
        "securitiesFound": fetchable.len(),
        "pricesInserted": inserted,
        "pricesSkipped": security_ids.len() as u64 - inserted,
    });
    if !errors.is_empty() {
        result["errors"] = json!(errors);
    }
    if !not_found.is_empty() {
        result["fetchDisabled"] = json!(not_found);
    }
    if rate_limited {
        result["rateLimited"] = json!(true);
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
    let running = crate::leases::wait(&state.database, crate::leases::Job::Recurring.lease_name())
        .await
        .map_err(|cause| crate::error::internal_error(cause, "Failed to start the job"))?;
    let result = running
        .guard(run_recurring(&state))
        .await
        .unwrap_or_else(|lost| Err(crate::error::internal_error(lost, LEASE_LOST)));
    // A manual run leaves the same record as a scheduled run.
    crate::scheduler::record_run(&state, "recurring", &result);
    result
}

/// The recurring job, without the caller check and the job lock.
pub(crate) async fn run_recurring(state: &AppState) -> ApiResult {
    const FAILURE: &str = "Failed to process recurring rules";
    let books: Vec<i32> = state
        .database
        .query("SELECT id FROM books ORDER BY id", &[])
        .map_err(|cause| {
            tracing::error!(error = %cause, "Recurring cron failed");
            error(StatusCode::INTERNAL_SERVER_ERROR, FAILURE)
        })?;
    let mut transaction_ids = Vec::new();
    for &book_id in &books {
        let access = BookAccess::for_system_job(book_id);
        match process_all(&state.database, &access, FAILURE) {
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
