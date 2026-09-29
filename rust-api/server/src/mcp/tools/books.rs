//! The book tools. Books are not tied to one book
//! gate: each tool checks the key, and the owner-only tools check the role.

use axum::http::Method;
use rmcp::model::CallToolResult;
use serde_json::{Map, Value, json};

use crate::mcp::call::{Caller, ToolResult, fail, integer, ok, thrown, without};

/// The owner check of the book tools: a missing book or a non-member gets
/// "Book {id} not found", and a member below owner gets the owner message.
/// Returns the book's name.
async fn require_owner(caller: &Caller, user_id: i32, book_id: i64) -> ToolResult<String> {
    let row: Option<(String, String)> = match i32::try_from(book_id) {
        Ok(book_id) => sqlx::query_as(
            "SELECT b.name, bm.role FROM books b JOIN book_members bm ON bm.book_id = b.id
             WHERE b.id = $1 AND bm.user_id = $2",
        )
        .bind(book_id)
        .bind(user_id)
        .fetch_optional(&caller.state().pool)
        .await
        .map_err(|cause| thrown(&cause.to_string()))?,
        Err(_) => None,
    };
    match row {
        None => Err(fail(&format!("Book {book_id} not found")).into()),
        Some((_, role)) if role != "owner" => Err(fail("Only an owner can do this").into()),
        Some((name, _)) => Ok(name),
    }
}

pub(super) async fn list_books(caller: &Caller) -> ToolResult<CallToolResult> {
    caller.user().await?;
    let books = caller.request(Method::GET, "/api/books", None).await?;
    let rows: Vec<Value> = books
        .as_array()
        .map(|rows| {
            rows.iter()
                .map(|book| {
                    json!({
                        "id": book["id"],
                        "name": book["name"],
                        "createdAt": book["createdAt"],
                        "role": book["role"],
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(ok(&Value::Array(rows)))
}

pub(super) async fn create_book(
    caller: &Caller,
    arguments: &Map<String, Value>,
) -> ToolResult<CallToolResult> {
    caller.user().await?;
    let book = caller
        .request(
            Method::POST,
            "/api/books",
            Some(&Value::Object(arguments.clone())),
        )
        .await?;
    Ok(ok(&book))
}

pub(super) async fn update_book(
    caller: &Caller,
    arguments: &Map<String, Value>,
) -> ToolResult<CallToolResult> {
    let user_id = caller.user().await?;
    let book_id = integer(arguments, "bookId");
    require_owner(caller, user_id, book_id).await?;
    let book = caller
        .request(
            Method::PUT,
            &format!("/api/books/{book_id}"),
            Some(&without(arguments, &["bookId"])),
        )
        .await?;
    Ok(ok(&book))
}

pub(super) async fn create_demo_book(caller: &Caller) -> ToolResult<CallToolResult> {
    caller.user().await?;
    let book = caller
        .request(Method::POST, "/api/books/demo", None)
        .await?;
    Ok(ok(&book))
}

/// Deleting a book takes the whole ledger with it, so the tool requires the
/// book's exact name. The role is checked first, so a caller who cannot see
/// the book never learns its name.
pub(super) async fn delete_book(
    caller: &Caller,
    arguments: &Map<String, Value>,
) -> ToolResult<CallToolResult> {
    let user_id = caller.user().await?;
    let book_id = integer(arguments, "bookId");
    let name = require_owner(caller, user_id, book_id).await?;
    let confirm = arguments
        .get("confirmBookName")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if confirm != name {
        return Err(fail(&format!(
            "confirmBookName does not match. To delete this book, pass its exact name: \"{name}\""
        ))
        .into());
    }
    caller
        .request(Method::DELETE, &format!("/api/books/{book_id}"), None)
        .await?;
    Ok(ok(&json!({ "success": true, "bookId": book_id })))
}
