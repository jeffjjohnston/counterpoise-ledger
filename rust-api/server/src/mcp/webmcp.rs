//! WebMCP: the MCP tools for an agent in the browser, at
//! `/api/b/{bookId}/webmcp`.
//!
//! `components/WebMcpTools.tsx` reads the tool list with `GET` and calls one
//! tool with `POST { name, arguments }`. The caller authenticates as for any
//! other book route, usually with the session cookie. The transport checks
//! `read` access to the book. Each tool then sends its requests through the
//! routes with the caller's credential, so each route checks its own level.
//!
//! The page is pinned to one book, so the route supplies `bookId` and the
//! browser never sees it.

use axum::{
    Json,
    body::Bytes,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use rmcp::model::CallToolResult;
use serde_json::{Map, Value, json};

use super::{Caller, call_tool, registry};
use crate::{
    book_auth::{AccessLevel, authenticate_book},
    error::{ApiError, ApiResult, error, error_owned},
    state::AppState,
    validation::from_json_bytes,
};

/// The 500 message when the book check itself fails.
const FAILURE: &str = "Tool execution failed";

/// Tools the browser registry does not carry, for two reasons that happen to
/// agree.
///
/// Scope: the page is already pinned to one book. Book management, the
/// Counterpoise issue tracker, PostHog analytics, background-job health, and
/// Plaid connection administration are not work an agent on a ledger page
/// should do. Granting or changing another user's access to a book is the
/// same kind of operation. The member tools are withheld for that reason,
/// not for the byte budget.
///
/// Budget: the registry is measured as a whole. A browser build sums every
/// descriptor's name, title, description, input schema, and annotations. It
/// rejects the whole registry past 65,536 bytes and disables WebMCP for the
/// page, with an error that names no limit. All 63 tools together exceed
/// that limit. Excluding the tools below keeps every remaining tool at full
/// fidelity. This is a better trade than stripping parameter documentation
/// from all 63 tools. `tests/http/webmcp.test.ts` holds the line.
const WEB_EXCLUDED_TOOLS: &[&str] = &[
    "list_books",
    "create_book",
    "update_book",
    "create_demo_book",
    "delete_book",
    "list_book_members",
    "add_book_member",
    "update_book_member",
    "remove_book_member",
    "analyze_usage",
    "get_system_status",
    "create_issue_report",
    "list_issue_reports",
    "update_issue_report",
    "delete_issue_report",
    "list_plaid_token_accounts",
    "update_plaid_token",
    "delete_plaid_token",
    "set_plaid_token_accounts",
    "sync_plaid_token",
    "clear_plaid_sync_data",
];

fn is_served(name: &str) -> bool {
    !WEB_EXCLUDED_TOOLS.contains(&name) && registry().validators.contains_key(name)
}

/// The input schema without `bookId`, which the route supplies, and without
/// `$schema`, which is the same 52 bytes on every tool and tells the browser
/// nothing it acts on. The other keys keep their order.
fn for_browser(schema: &Map<String, Value>) -> Map<String, Value> {
    let mut shaped = schema.clone();
    shaped.remove("$schema");
    let mut properties = schema
        .get("properties")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    properties.remove("bookId");
    shaped.insert("properties".to_owned(), Value::Object(properties));
    if let Some(required) = schema.get("required").and_then(Value::as_array) {
        let required: Vec<Value> = required
            .iter()
            .filter(|name| name.as_str() != Some("bookId"))
            .cloned()
            .collect();
        if required.is_empty() {
            shaped.remove("required");
        } else {
            shaped.insert("required".to_owned(), Value::Array(required));
        }
    }
    shaped
}

/// Each served tool as the browser registry takes it.
fn browser_tools() -> Vec<Value> {
    registry()
        .tools
        .iter()
        .filter(|tool| !WEB_EXCLUDED_TOOLS.contains(&tool.name.as_ref()))
        .map(|tool| {
            let mut descriptor = Map::new();
            descriptor.insert("name".to_owned(), json!(tool.name));
            if let Some(title) = &tool.title {
                descriptor.insert("title".to_owned(), json!(title));
            }
            let description = tool
                .description
                .as_deref()
                .or(tool.title.as_deref())
                .unwrap_or(&tool.name);
            descriptor.insert("description".to_owned(), json!(description));
            descriptor.insert(
                "inputSchema".to_owned(),
                Value::Object(for_browser(&tool.input_schema)),
            );
            if let Some(annotations) = &tool.annotations {
                descriptor.insert(
                    "annotations".to_owned(),
                    serde_json::to_value(annotations).expect("annotations serialize"),
                );
            }
            Value::Object(descriptor)
        })
        .collect()
}

/// `GET /api/b/{bookId}/webmcp`: the tool list.
pub(crate) async fn list(
    State(state): State<AppState>,
    Path(raw_book_id): Path<String>,
    headers: HeaderMap,
) -> ApiResult {
    authenticate_book(&state, &headers, &raw_book_id, AccessLevel::Read, FAILURE).await?;
    Ok(Json(Value::Array(browser_tools())))
}

fn bad_request(message: &'static str) -> Response {
    error(StatusCode::BAD_REQUEST, message).into_response()
}

/// The tool's JSON text, or its error message.
fn payload(name: &str, result: &CallToolResult) -> Result<Value, ApiError> {
    let text = result
        .content
        .iter()
        .find_map(|content| content.as_text().map(|text| text.text.as_str()));
    let parsed = match text {
        Some(text) => from_json_bytes::<Value>(text.as_bytes()).map_err(|_| text.to_owned()),
        None => Ok(result.structured_content.clone().unwrap_or(Value::Null)),
    };
    if result.is_error != Some(true) {
        return parsed.map_err(|text| error_owned(StatusCode::BAD_REQUEST, text));
    }
    // A thrown error, such as an argument that fails the input schema, is
    // plain text, not JSON. Its text is the message.
    let message = match parsed {
        Ok(Value::Object(object)) if object.contains_key("error") => {
            crate::validation::js_string(&object["error"])
        }
        Ok(_) => format!("MCP tool {name} failed"),
        Err(text) => text,
    };
    Err(error_owned(StatusCode::BAD_REQUEST, message))
}

/// `POST /api/b/{bookId}/webmcp` with `{ name, arguments }`: calls one tool.
/// The answer is the tool's JSON, or `{ error }` with status 400 when the
/// tool fails.
pub(crate) async fn call(
    State(state): State<AppState>,
    Path(raw_book_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let book =
        match authenticate_book(&state, &headers, &raw_book_id, AccessLevel::Read, FAILURE).await {
            Ok(book) => book,
            Err(denied) => return denied.into_response(),
        };
    let body: Value = match from_json_bytes(&body) {
        Ok(body @ (Value::Object(_) | Value::Array(_))) => body,
        _ => return bad_request("A JSON request body is required"),
    };
    let (Some(Value::String(name)), Some(Value::Object(arguments))) =
        (body.get("name"), body.get("arguments"))
    else {
        return bad_request("name and arguments are required");
    };
    // Withheld tools must be uncallable, not merely unlisted: anything that
    // holds the session cookie can reach this endpoint, whether or not it read
    // the list. The answer calls the tool unknown, so it does not confirm that
    // a withheld tool exists.
    if !is_served(name) {
        return error_owned(StatusCode::BAD_REQUEST, format!("Unknown MCP tool: {name}"))
            .into_response();
    }
    let mut arguments = arguments.clone();
    if registry()
        .properties
        .get(name.as_str())
        .is_some_and(|keys| keys.iter().any(|key| key == "bookId"))
    {
        arguments.insert("bookId".to_owned(), json!(book.book_id));
    }
    let caller = Caller::new(state, &headers);
    let result = call_tool(&caller, name, arguments).await;
    match payload(name, &result) {
        Ok(value) => Json(value).into_response(),
        Err(failure) => failure.into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rmcp::model::ContentBlock;

    #[test]
    fn schemas_drop_book_id_and_the_schema_key() {
        let schema = json!({
            "$schema": "http://json-schema.org/draft-07/schema#",
            "type": "object",
            "properties": {"bookId": {"type": "integer"}, "name": {"type": "string"}},
            "required": ["bookId", "name"],
            "additionalProperties": false
        });
        let shaped = for_browser(schema.as_object().unwrap());
        assert_eq!(
            Value::Object(shaped),
            json!({
                "type": "object",
                "properties": {"name": {"type": "string"}},
                "required": ["name"],
                "additionalProperties": false
            })
        );
        let only_book =
            json!({"type": "object", "properties": {"bookId": {}}, "required": ["bookId"]});
        let shaped = for_browser(only_book.as_object().unwrap());
        assert_eq!(
            Value::Object(shaped),
            json!({"type": "object", "properties": {}})
        );
    }

    #[test]
    fn the_list_withholds_the_excluded_tools_and_every_book_id() {
        let tools = browser_tools();
        let names: Vec<&str> = tools
            .iter()
            .map(|tool| tool["name"].as_str().unwrap())
            .collect();
        for name in WEB_EXCLUDED_TOOLS {
            assert!(!names.contains(name), "{name} is listed");
            assert!(!is_served(name), "{name} is callable");
        }
        assert!(names.contains(&"create_transaction"));
        assert!(is_served("create_transaction"));
        assert!(!is_served("no_such_tool"));
        assert_eq!(
            names.len(),
            registry().tools.len() - WEB_EXCLUDED_TOOLS.len()
        );
        for tool in &tools {
            assert!(tool["inputSchema"]["properties"].get("bookId").is_none());
            assert!(tool["inputSchema"].get("$schema").is_none());
            assert!(tool["description"].is_string());
        }
    }

    #[test]
    fn every_excluded_tool_is_a_real_tool() {
        for name in WEB_EXCLUDED_TOOLS {
            assert!(registry().validators.contains_key(*name), "{name}");
        }
    }

    fn message(result: Result<Value, ApiError>) -> String {
        result.expect_err("a failure").message().to_owned()
    }

    #[test]
    fn payloads_read_the_tool_text() {
        let ok = CallToolResult::success(vec![ContentBlock::text("{\n  \"id\": 3\n}")]);
        assert_eq!(payload("t", &ok).unwrap(), json!({"id": 3}));
        let failed = CallToolResult::error(vec![ContentBlock::text("{\"error\":\"Nope\"}")]);
        assert_eq!(message(payload("t", &failed)), "Nope");
        let no_message = CallToolResult::error(vec![ContentBlock::text("[1]")]);
        assert_eq!(message(payload("t", &no_message)), "MCP tool t failed");
        let thrown = CallToolResult::error(vec![ContentBlock::text("MCP error -32602: bad")]);
        assert_eq!(message(payload("t", &thrown)), "MCP error -32602: bad");
    }
}
