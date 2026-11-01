//! The weekly review tool: a read of the newest review. It cannot start a
//! review: that is a paid AI call, which the user starts in the app.

use axum::http::Method;
use rmcp::model::CallToolResult;
use serde_json::{Map, Value};

use crate::mcp::call::{Caller, Level, ToolResult, integer, ok};

pub(super) async fn get(
    caller: &Caller,
    arguments: &Map<String, Value>,
) -> ToolResult<CallToolResult> {
    let book_id = integer(arguments, "bookId");
    caller.book(book_id, Level::Read).await?;
    let review = caller
        .request(
            Method::GET,
            &format!("/api/b/{book_id}/weekly-review"),
            None,
        )
        .await?;
    Ok(ok(&review))
}
