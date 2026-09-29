//! The recurring-rule tools. Each tool sends its request through the route,
//! and gives the route's messages.

use axum::http::Method;
use rmcp::model::CallToolResult;
use serde_json::{Map, Value, json};

use crate::mcp::call::{Caller, Level, ToolResult, integer, ok, with_query, without};

fn recurring_path(book_id: i64) -> String {
    format!("/api/b/{book_id}/recurring")
}

/// `createRuleSchema` preprocesses an `endDate` of `""` to null before the
/// date check, because the create form sends `""` for an empty field. The
/// JSON Schema cannot hold a preprocess and refuses `""`, so the argument
/// changes here, before the schema check, as zod changes it.
pub(super) fn prepare_create(arguments: &mut Map<String, Value>) {
    if arguments.get("endDate") == Some(&json!("")) {
        arguments.insert("endDate".to_owned(), Value::Null);
    }
}

pub(super) async fn list(
    caller: &Caller,
    arguments: &Map<String, Value>,
) -> ToolResult<CallToolResult> {
    let book_id = integer(arguments, "bookId");
    caller.book(book_id, Level::Read).await?;
    Ok(ok(&caller
        .request(Method::GET, &recurring_path(book_id), None)
        .await?))
}

pub(super) async fn create(
    caller: &Caller,
    arguments: &Map<String, Value>,
) -> ToolResult<CallToolResult> {
    let book_id = integer(arguments, "bookId");
    caller.book(book_id, Level::Write).await?;
    Ok(ok(&caller
        .request(
            Method::POST,
            &recurring_path(book_id),
            Some(&without(arguments, &["bookId"])),
        )
        .await?))
}

pub(super) async fn update(
    caller: &Caller,
    arguments: &Map<String, Value>,
) -> ToolResult<CallToolResult> {
    let book_id = integer(arguments, "bookId");
    let rule_id = integer(arguments, "ruleId");
    caller.book(book_id, Level::Write).await?;
    Ok(ok(&caller
        .request(
            Method::PUT,
            &format!("{}/{rule_id}", recurring_path(book_id)),
            Some(&without(arguments, &["bookId", "ruleId"])),
        )
        .await?))
}

pub(super) async fn delete(
    caller: &Caller,
    arguments: &Map<String, Value>,
) -> ToolResult<CallToolResult> {
    let book_id = integer(arguments, "bookId");
    let rule_id = integer(arguments, "ruleId");
    caller.book(book_id, Level::Write).await?;
    caller
        .request(
            Method::DELETE,
            &format!("{}/{rule_id}", recurring_path(book_id)),
            None,
        )
        .await?;
    Ok(ok(&json!({ "success": true, "ruleId": rule_id })))
}

pub(super) async fn projected(
    caller: &Caller,
    arguments: &Map<String, Value>,
) -> ToolResult<CallToolResult> {
    let book_id = integer(arguments, "bookId");
    caller.book(book_id, Level::Read).await?;
    let path = with_query(
        format!("{}/projected", recurring_path(book_id)),
        arguments,
        &["startDate", "endDate", "accountId"],
    );
    Ok(ok(&caller.request(Method::GET, &path, None).await?))
}

pub(super) async fn transactions(
    caller: &Caller,
    arguments: &Map<String, Value>,
) -> ToolResult<CallToolResult> {
    let book_id = integer(arguments, "bookId");
    caller.book(book_id, Level::Read).await?;
    let path = with_query(
        format!("{}/transactions", recurring_path(book_id)),
        arguments,
        &["startDate", "endDate"],
    );
    Ok(ok(&caller.request(Method::GET, &path, None).await?))
}

/// With `ruleId`, that rule is forced; with `processAll`, every due rule
/// runs; with neither, nothing is created. The route has the same branches.
pub(super) async fn process(
    caller: &Caller,
    arguments: &Map<String, Value>,
) -> ToolResult<CallToolResult> {
    let book_id = integer(arguments, "bookId");
    caller.book(book_id, Level::Write).await?;
    Ok(ok(&caller
        .request(
            Method::POST,
            &format!("{}/process", recurring_path(book_id)),
            Some(&without(arguments, &["bookId"])),
        )
        .await?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_end_date_becomes_null_before_the_schema_check() {
        let mut arguments = json!({"endDate": ""}).as_object().unwrap().clone();
        prepare_create(&mut arguments);
        assert_eq!(arguments["endDate"], Value::Null);
        let mut arguments = json!({"endDate": "2030-01-01"})
            .as_object()
            .unwrap()
            .clone();
        prepare_create(&mut arguments);
        assert_eq!(arguments["endDate"], json!("2030-01-01"));
    }
}
