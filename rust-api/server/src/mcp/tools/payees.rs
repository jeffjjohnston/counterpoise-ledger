//! The payee tools.

use axum::http::Method;
use rmcp::model::CallToolResult;
use serde_json::{Map, Value, json};

use crate::{
    mcp::call::{
        Caller, Level, ToolResult, fail, integer, invalid_arguments, ok, thrown, with_query,
    },
    routes::payees::{create_exact, normalize_name},
};

fn payees_path(book_id: i64) -> String {
    format!("/api/b/{book_id}/payees")
}

pub(super) async fn list(
    caller: &Caller,
    arguments: &Map<String, Value>,
) -> ToolResult<CallToolResult> {
    let book_id = integer(arguments, "bookId");
    caller.book(book_id, Level::Read).await?;
    let path = with_query(payees_path(book_id), arguments, &["search", "limit"]);
    Ok(ok(&caller.request(Method::GET, &path, None).await?))
}

/// The payee and its `lastAccountId`. The web UI reads these with two
/// requests; the tool gives them as one object.
pub(super) async fn get(
    caller: &Caller,
    arguments: &Map<String, Value>,
) -> ToolResult<CallToolResult> {
    let book_id = integer(arguments, "bookId");
    let payee_id = integer(arguments, "payeeId");
    caller.book(book_id, Level::Read).await?;
    let path = format!("{}/{payee_id}", payees_path(book_id));
    let Some(mut payee) = caller.find(&path).await? else {
        return Err(fail(&format!("Payee with id {payee_id} not found")).into());
    };
    let last = caller
        .request(Method::GET, &format!("{path}/last-account"), None)
        .await?;
    if let Some(payee) = payee.as_object_mut() {
        payee.insert("lastAccountId".to_owned(), last["accountId"].clone());
    }
    Ok(ok(&payee))
}

/// Unlike `POST /payees`, the tool does not return a case variant that
/// already exists: "Ikea" after "IKEA" creates a second payee. An exact
/// repeat fails, because the book allows one payee for each exact name.
pub(super) async fn create(
    caller: &Caller,
    arguments: &Map<String, Value>,
) -> ToolResult<CallToolResult> {
    let book_id = integer(arguments, "bookId");
    let raw = arguments
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let name = normalize_name(raw);
    // The zod schema trims the name before `min(1)`, so a name of only
    // whitespace is an input error. The JSON Schema has no trim, so the check
    // is here, before the book gate: an input error comes before an access
    // error.
    if name.is_empty() {
        return Err(
            invalid_arguments("create_payee", &["name: Name is required".to_owned()]).into(),
        );
    }
    caller.book(book_id, Level::Write).await?;
    let book_id = i32::try_from(book_id).map_err(|cause| thrown(&cause.to_string()))?;
    match create_exact(&caller.state().pool, book_id, &name).await {
        Ok(Some(payee)) => Ok(ok(&payee)),
        Ok(None) => Err(fail(&format!(
            "A payee named \"{name}\" already exists in this book"
        ))
        .into()),
        Err(cause) => Err(thrown(&cause.to_string()).into()),
    }
}

pub(super) async fn delete(
    caller: &Caller,
    arguments: &Map<String, Value>,
) -> ToolResult<CallToolResult> {
    let book_id = integer(arguments, "bookId");
    let payee_id = integer(arguments, "payeeId");
    caller.book(book_id, Level::Write).await?;
    caller
        .request(
            Method::DELETE,
            &format!("{}/{payee_id}", payees_path(book_id)),
            None,
        )
        .await?;
    Ok(ok(&json!({ "success": true, "payeeId": payee_id })))
}
