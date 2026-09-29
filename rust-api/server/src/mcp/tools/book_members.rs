//! The book member tools.

use axum::http::Method;
use rmcp::model::CallToolResult;
use serde_json::{Map, Value, json};

use crate::mcp::call::{Caller, Level, Role, ToolResult, fail, integer, ok, without};

fn members_path(book_id: i64) -> String {
    format!("/api/books/{book_id}/members")
}

pub(super) async fn list(
    caller: &Caller,
    arguments: &Map<String, Value>,
) -> ToolResult<CallToolResult> {
    let book_id = integer(arguments, "bookId");
    caller.book(book_id, Level::Read).await?;
    Ok(ok(&caller
        .request(Method::GET, &members_path(book_id), None)
        .await?))
}

pub(super) async fn add(
    caller: &Caller,
    arguments: &Map<String, Value>,
) -> ToolResult<CallToolResult> {
    let book_id = integer(arguments, "bookId");
    caller.book(book_id, Level::Owner).await?;
    let member = caller
        .request(
            Method::POST,
            &members_path(book_id),
            Some(&without(arguments, &["bookId"])),
        )
        .await?;
    Ok(ok(&member))
}

pub(super) async fn update(
    caller: &Caller,
    arguments: &Map<String, Value>,
) -> ToolResult<CallToolResult> {
    let book_id = integer(arguments, "bookId");
    let user_id = integer(arguments, "userId");
    caller.book(book_id, Level::Owner).await?;
    let member = caller
        .request(
            Method::PUT,
            &format!("{}/{user_id}", members_path(book_id)),
            Some(&without(arguments, &["bookId", "userId"])),
        )
        .await?;
    Ok(ok(&member))
}

/// Any member may remove themselves. Only an owner may remove someone else.
pub(super) async fn remove(
    caller: &Caller,
    arguments: &Map<String, Value>,
) -> ToolResult<CallToolResult> {
    let book_id = integer(arguments, "bookId");
    let user_id = integer(arguments, "userId");
    let (caller_id, role) = caller.book(book_id, Level::Read).await?;
    if user_id != i64::from(caller_id) && role != Role::Owner {
        return Err(fail("Only an owner can do this").into());
    }
    caller
        .request(
            Method::DELETE,
            &format!("{}/{user_id}", members_path(book_id)),
            None,
        )
        .await?;
    Ok(ok(
        &json!({ "success": true, "bookId": book_id, "userId": user_id }),
    ))
}
