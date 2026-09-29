//! The issue-report and system-status tools.
//! They are not tied to one book: each tool checks the key only.

use axum::http::Method;
use rmcp::model::CallToolResult;
use serde_json::{Map, Value, json};

use crate::{
    mcp::call::{Caller, ToolResult, fail, integer, invalid_arguments, ok, without},
    validation::is_js_whitespace,
};

const REPORTS_PATH: &str = "/api/issue-reports";

/// The zod schemas trim the description before `min(1)`. The JSON Schema
/// has no trim, so a description of only whitespace passes it. An input error
/// comes before an auth error, so this check runs before the key check.
fn check_description(tool: &str, arguments: &Map<String, Value>, message: &str) -> ToolResult<()> {
    match arguments.get("description").and_then(Value::as_str) {
        Some(text) if text.trim_matches(is_js_whitespace).is_empty() => {
            Err(invalid_arguments(tool, &[format!("description: {message}")]).into())
        }
        _ => Ok(()),
    }
}

pub(super) async fn create(
    caller: &Caller,
    arguments: &Map<String, Value>,
) -> ToolResult<CallToolResult> {
    check_description("create_issue_report", arguments, "Description is required")?;
    caller.user().await?;
    let report = caller
        .request(
            Method::POST,
            REPORTS_PATH,
            Some(&Value::Object(arguments.clone())),
        )
        .await?;
    Ok(ok(&report))
}

pub(super) async fn list(caller: &Caller) -> ToolResult<CallToolResult> {
    caller.user().await?;
    Ok(ok(&caller.request(Method::GET, REPORTS_PATH, None).await?))
}

/// The route says "Issue report not found". The tool names the ID.
pub(super) async fn update(
    caller: &Caller,
    arguments: &Map<String, Value>,
) -> ToolResult<CallToolResult> {
    check_description(
        "update_issue_report",
        arguments,
        "Description cannot be empty",
    )?;
    caller.user().await?;
    let id = integer(arguments, "id");
    match caller
        .request_found(
            Method::PUT,
            &format!("{REPORTS_PATH}/{id}"),
            Some(&without(arguments, &["id"])),
        )
        .await?
    {
        Some(report) => Ok(ok(&report)),
        None => Err(fail(&format!("Issue report {id} not found")).into()),
    }
}

pub(super) async fn delete(
    caller: &Caller,
    arguments: &Map<String, Value>,
) -> ToolResult<CallToolResult> {
    caller.user().await?;
    let id = integer(arguments, "id");
    match caller
        .request_found(Method::DELETE, &format!("{REPORTS_PATH}/{id}"), None)
        .await?
    {
        Some(_) => Ok(ok(&json!({ "success": true, "id": id }))),
        None => Err(fail(&format!("Issue report {id} not found")).into()),
    }
}

pub(super) async fn system_status(caller: &Caller) -> ToolResult<CallToolResult> {
    caller.user().await?;
    Ok(ok(&caller
        .request(Method::GET, "/api/system/status", None)
        .await?))
}
