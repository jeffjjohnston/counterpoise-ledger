//! The security-price tools.

use axum::http::{Method, StatusCode};
use rmcp::model::CallToolResult;
use serde_json::{Map, Value, json};

use crate::{
    mcp::call::{Caller, Level, ToolResult, fail, integer, ok, outcome, thrown, without},
    routes::security_prices::{SetPricesError, set_prices},
};

fn price_path(book_id: i64, security_id: i64, date: &str) -> String {
    format!("/api/b/{book_id}/securities/{security_id}/prices/{date}")
}

/// The routes say "Security not found" and "Price entry not found". The tool
/// names the security or the date.
fn library_message(body: &Value, security_id: i64, date: &str) -> Option<String> {
    match body.get("error").and_then(Value::as_str) {
        Some("Security not found") => Some(format!("Security {security_id} not found")),
        Some("Price entry not found") => Some(format!("Price entry for {date} not found")),
        _ => None,
    }
}

async fn change_price(
    caller: &Caller,
    method: Method,
    arguments: &Map<String, Value>,
    date_key: &str,
    body: Option<&Value>,
) -> ToolResult<CallToolResult> {
    let book_id = integer(arguments, "bookId");
    let security_id = integer(arguments, "securityId");
    let date = arguments
        .get(date_key)
        .and_then(Value::as_str)
        .unwrap_or_default();
    let (status, response) = caller
        .send(method, &price_path(book_id, security_id, date), body)
        .await?;
    if status == StatusCode::NOT_FOUND
        && let Some(message) = library_message(&response, security_id, date)
    {
        return Err(fail(&message).into());
    }
    outcome(status, response)?;
    Ok(ok(&json!({ "success": true })))
}

/// The bulk route drops a malformed item without a word and reports only a
/// count. The tool reports each item it skipped, so it calls the shared
/// write directly.
pub(super) async fn set(
    caller: &Caller,
    arguments: &Map<String, Value>,
) -> ToolResult<CallToolResult> {
    let book_id = integer(arguments, "bookId");
    caller.book(book_id, Level::Write).await?;
    let book = i32::try_from(book_id).map_err(|cause| thrown(&cause.to_string()))?;
    let items = arguments
        .get("priceUpdates")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice);
    match set_prices(&caller.state().pool, book, items).await {
        Ok(result) => Ok(ok(&json!({
            "count": result.written.len(),
            "written": result.written,
            "discarded": result.discarded,
        }))),
        Err(SetPricesError::Invalid(message)) => Err(fail(message).into()),
        Err(SetPricesError::OutOfRange) => {
            Err(thrown("value out of range for type integer").into())
        }
        Err(SetPricesError::Database(cause)) => Err(thrown(&cause.to_string()).into()),
    }
}

pub(super) async fn update(
    caller: &Caller,
    arguments: &Map<String, Value>,
) -> ToolResult<CallToolResult> {
    let book_id = integer(arguments, "bookId");
    caller.book(book_id, Level::Write).await?;
    let body = without(arguments, &["bookId", "securityId", "currentDate"]);
    change_price(caller, Method::PUT, arguments, "currentDate", Some(&body)).await
}

pub(super) async fn delete(
    caller: &Caller,
    arguments: &Map<String, Value>,
) -> ToolResult<CallToolResult> {
    let book_id = integer(arguments, "bookId");
    caller.book(book_id, Level::Write).await?;
    change_price(caller, Method::DELETE, arguments, "priceDate", None).await
}

pub(super) async fn due(
    caller: &Caller,
    arguments: &Map<String, Value>,
) -> ToolResult<CallToolResult> {
    let book_id = integer(arguments, "bookId");
    caller.book(book_id, Level::Read).await?;
    Ok(ok(&caller
        .request(
            Method::GET,
            &format!("/api/b/{book_id}/securities/prices-due"),
            None,
        )
        .await?))
}

/// The Tiingo route needs write access, because it serves the price editor.
/// The tool only reads, so it needs read access and calls Tiingo directly.
pub(super) async fn tiingo(
    caller: &Caller,
    arguments: &Map<String, Value>,
) -> ToolResult<CallToolResult> {
    let book_id = integer(arguments, "bookId");
    caller.book(book_id, Level::Read).await?;
    let tiingo = &caller.state().tiingo;
    if !tiingo.is_configured() {
        return Err(fail("TIINGO_API_KEY environment variable not configured").into());
    }
    let symbols = arguments
        .get("symbols")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice);
    let (prices, errors) = tiingo
        .fetch_latest_prices(symbols)
        .await
        .map_err(|cause| thrown(&cause.to_string()))?;
    Ok(ok(&json!({ "prices": prices, "errors": errors })))
}
