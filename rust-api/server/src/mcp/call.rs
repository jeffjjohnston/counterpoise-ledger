//! What a tool uses to do its work: the caller's identity, the book gate, and
//! requests through the router in the same process.
//!
//! A tool sends its requests through the same routes as HTTP clients, with the
//! caller's bearer header or, for WebMCP, the caller's session cookie. The
//! routes then check the credential, validate the input and enforce the access
//! level, so a tool cannot bypass them.

use std::sync::OnceLock;

use axum::{
    Router,
    body::{Body, to_bytes},
    http::{HeaderMap, HeaderValue, Method, Request, StatusCode, header},
};
use rmcp::model::{CallToolResult, ContentBlock};
use serde_json::{Value, json};
use tower::ServiceExt;

use crate::{auth::principal_with, routes::routes, state::AppState, validation::js_number_string};

tokio::task_local! {
    /// Set while a tool's request runs through the router. Only the
    /// dispatcher sets it, and no header can, so an HTTP client cannot forge
    /// it. The value is true when the tool runs for `/api/mcp`, where an
    /// OAuth access token is good.
    static TOOL_CALL: bool;
}

/// True while a route runs for an MCP tool. A route checks this to record no
/// PostHog event and no TypeSafe decision for a tool: before the tools moved
/// to Rust they called the library, not the route, and the library records
/// neither.
pub(crate) fn in_tool_call() -> bool {
    TOOL_CALL.try_with(|_| ()).is_ok()
}

/// True while a route runs for a tool of `/api/mcp`. `auth::principal`
/// then accepts an OAuth access token. The stdio server and WebMCP do not
/// set it: a token is not for them.
pub(crate) fn in_oauth_tool_call() -> bool {
    TOOL_CALL.try_with(|oauth| *oauth).unwrap_or(false)
}

/// A route response body is at most this large.
const RESPONSE_LIMIT: usize = 64 * 1024 * 1024;

/// The error text for a key that is missing, unknown or revoked.
const AUTH_ERROR: &str = "A valid COUNTERPOISE_API_KEY is required";
/// The error text for a user who is not a member of the book.
const BOOK_ACCESS_ERROR: &str = "You do not have access to this book";

/// A successful result: `data` as pretty JSON, as `ok()` writes it.
pub(crate) fn ok(data: &Value) -> CallToolResult {
    let text = serde_json::to_string_pretty(data).expect("a JSON value serializes");
    CallToolResult::success(vec![ContentBlock::text(text)])
}

/// An expected failure: `{ "error": message }` as pretty JSON, as `fail()` writes it.
pub(crate) fn fail(message: &str) -> CallToolResult {
    let text = serde_json::to_string_pretty(&json!({ "error": message }))
        .expect("a JSON value serializes");
    CallToolResult::error(vec![ContentBlock::text(text)])
}

/// An auth failure, as compact JSON, unlike `fail()`. The not-found branch of
/// `get_account_balance_history` uses it too. Clients see this text, so keep it.
pub(crate) fn compact_error(message: &str) -> CallToolResult {
    CallToolResult::error(vec![ContentBlock::text(
        json!({ "error": message }).to_string(),
    )])
}

/// An unexpected failure: plain text, as the TypeScript SDK reports a throw.
pub(crate) fn thrown(message: &str) -> CallToolResult {
    CallToolResult::error(vec![ContentBlock::text(message)])
}

/// Arguments that the input schema refuses, with the error prefix of the
/// TypeScript SDK. `problems` are `path: message` items.
pub(crate) fn invalid_arguments(tool: &str, problems: &[String]) -> CallToolResult {
    thrown(&format!(
        "MCP error -32602: Input validation error: Invalid arguments for tool {tool}: {}",
        problems.join("; ")
    ))
}

/// A tool's early exit: the result to return in place of the rest of its
/// work. Boxed, because a result is large and most calls succeed.
pub(crate) type ToolResult<T> = Result<T, Box<CallToolResult>>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Level {
    Read,
    Write,
    Owner,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Role {
    Owner,
    Editor,
    Viewer,
}

impl Role {
    fn satisfies(self, level: Level) -> bool {
        match level {
            Level::Read => true,
            Level::Write => self != Self::Viewer,
            Level::Owner => self == Self::Owner,
        }
    }
}

/// The message of `accessDeniedMessage(level)` in `lib/book-roles.ts`.
fn access_denied(level: Level) -> &'static str {
    if level == Level::Owner {
        "Only an owner can do this"
    } else {
        "You have read-only access to this book"
    }
}

pub(crate) struct Caller {
    state: AppState,
    /// Only the headers a route reads for identity: the bearer key, the
    /// session cookie, and the client address that `client_ip::record` wrote,
    /// which keys the failed-key lockout. `/api/mcp` removes the cookie before this copy, so
    /// only WebMCP sends one.
    headers: HeaderMap,
    router: OnceLock<Router>,
    /// True for a caller of `/api/mcp`, whose bearer value may be an OAuth
    /// access token.
    oauth: bool,
}

impl Caller {
    pub(crate) fn new(state: AppState, request_headers: &HeaderMap) -> Self {
        let mut headers = HeaderMap::new();
        for name in [
            header::AUTHORIZATION.as_str(),
            header::COOKIE.as_str(),
            crate::client_ip::CLIENT_IP_HEADER,
        ] {
            if let Some(value) = request_headers.get(name) {
                headers.insert(
                    name.parse::<header::HeaderName>().expect("static name"),
                    value.clone(),
                );
            }
        }
        Self {
            state,
            headers,
            router: OnceLock::new(),
            oauth: false,
        }
    }

    /// A caller of `/api/mcp`: as [`Caller::new`], and an OAuth access token
    /// is good for its tools.
    pub(crate) fn for_mcp_endpoint(state: AppState, request_headers: &HeaderMap) -> Self {
        Self {
            oauth: true,
            ..Self::new(state, request_headers)
        }
    }

    pub(crate) fn state(&self) -> &AppState {
        &self.state
    }

    /// The user of the key, as `requireAuth()` resolves it. The check runs on
    /// every call, so a revoked key stops working at once.
    pub(crate) async fn user(&self) -> ToolResult<i32> {
        match principal_with(&self.state, &self.headers, self.oauth).await {
            Ok(Some(user_id)) => Ok(user_id),
            Ok(None) => Err(compact_error(AUTH_ERROR).into()),
            Err(cause) => Err(thrown(&cause.to_string()).into()),
        }
    }

    /// `requireBookAuth(bookId, level)`: the user, and their role in the book.
    pub(crate) async fn book(&self, book_id: i64, level: Level) -> ToolResult<(i32, Role)> {
        let user_id = self.user().await?;
        let role: Option<String> = match i32::try_from(book_id) {
            Ok(book_id) => sqlx::query_scalar(
                "SELECT role FROM book_members WHERE book_id = $1 AND user_id = $2",
            )
            .bind(book_id)
            .bind(user_id)
            .fetch_optional(&self.state.pool)
            .await
            .map_err(|cause| thrown(&cause.to_string()))?,
            Err(_) => None,
        };
        let role = match role.as_deref() {
            None => return Err(compact_error(BOOK_ACCESS_ERROR).into()),
            Some("owner") => Role::Owner,
            Some("editor") => Role::Editor,
            Some("viewer") => Role::Viewer,
            Some(other) => return Err(thrown(&format!("Unknown book role: {other}")).into()),
        };
        if !role.satisfies(level) {
            return Err(compact_error(access_denied(level)).into());
        }
        Ok((user_id, role))
    }

    /// Sends one request through the router. A 2xx response gives its JSON
    /// body. A 401 gives the MCP auth error. Any other status gives the
    /// route's `error` message as a tool failure, or as a thrown error when the
    /// status is 5xx.
    pub(crate) async fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
    ) -> ToolResult<Value> {
        let (status, value) = self.send(method, path, body).await?;
        outcome(status, value)
    }

    /// A GET as `request` sends it, except that a 404 gives `None`. A tool
    /// uses this when its not-found message differs from the route's.
    pub(crate) async fn find(&self, path: &str) -> ToolResult<Option<Value>> {
        self.request_found(Method::GET, path, None).await
    }

    /// A request as `request` sends it, except that a 404 gives `None`.
    pub(crate) async fn request_found(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
    ) -> ToolResult<Option<Value>> {
        let (status, value) = self.send(method, path, body).await?;
        if status == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        outcome(status, value).map(Some)
    }

    /// Sends one request and gives its status and JSON body as they are.
    /// A tool uses this when it maps a route's error to its own message; it
    /// passes any other response to `outcome`.
    pub(crate) async fn send(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
    ) -> ToolResult<(StatusCode, Value)> {
        let router = self
            .router
            .get_or_init(|| routes().with_state(self.state.clone()))
            .clone();
        let mut request = Request::builder().method(method).uri(path);
        for (name, value) in &self.headers {
            request = request.header(name, value);
        }
        let request = match body {
            Some(body) => request
                .header(
                    header::CONTENT_TYPE,
                    HeaderValue::from_static("application/json"),
                )
                .body(Body::from(body.to_string())),
            None => request.body(Body::empty()),
        }
        .map_err(|cause| thrown(&cause.to_string()))?;
        let response = TOOL_CALL
            .scope(self.oauth, router.oneshot(request))
            .await
            .map_err(|cause| thrown(&cause.to_string()))?;
        let status = response.status();
        let bytes = to_bytes(response.into_body(), RESPONSE_LIMIT)
            .await
            .map_err(|cause| thrown(&cause.to_string()))?;
        let value: Value = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).map_err(|cause| thrown(&cause.to_string()))?
        };
        Ok((status, value))
    }
}

/// The result of a route response, as `Caller::request` describes it.
pub(crate) fn outcome(status: StatusCode, value: Value) -> ToolResult<Value> {
    if status.is_success() {
        return Ok(value);
    }
    if status == StatusCode::UNAUTHORIZED {
        return Err(compact_error(AUTH_ERROR).into());
    }
    let message = value.get("error").and_then(Value::as_str).map_or_else(
        || format!("Request failed with status {status}"),
        str::to_owned,
    );
    Err(Box::new(if status.is_server_error() {
        thrown(&message)
    } else {
        fail(&message)
    }))
}

/// An integer argument that the input schema has already checked.
pub(crate) fn integer(arguments: &serde_json::Map<String, Value>, name: &str) -> i64 {
    arguments
        .get(name)
        .and_then(Value::as_i64)
        .unwrap_or_default()
}

/// The arguments without the named keys: the body of a route request.
pub(crate) fn without(arguments: &serde_json::Map<String, Value>, names: &[&str]) -> Value {
    Value::Object(
        arguments
            .iter()
            .filter(|(key, _)| !names.contains(&key.as_str()))
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect(),
    )
}

/// A double as `JSON.stringify` writes it: the text of
/// `Number.prototype.toString()`, so 150 stays `150` and not `150.0`, and
/// null for NaN or an infinity.
pub(crate) fn js_double(value: f64) -> Value {
    if !value.is_finite() {
        return Value::Null;
    }
    Value::Number(
        js_number_string(value)
            .parse()
            .expect("JavaScript number text is JSON"),
    )
}

/// `path` with the named arguments as its query string, in the order of
/// `names`. An argument that is missing or null is left out. A string goes as
/// it is, and a number or a boolean as its JSON text.
pub(crate) fn with_query(
    path: String,
    arguments: &serde_json::Map<String, Value>,
    names: &[&str],
) -> String {
    let mut query = url::form_urlencoded::Serializer::new(String::new());
    for name in names {
        match arguments.get(*name) {
            Some(Value::String(text)) => {
                query.append_pair(name, text);
            }
            Some(value @ (Value::Number(_) | Value::Bool(_))) => {
                query.append_pair(name, &value.to_string());
            }
            _ => {}
        }
    }
    let query = query.finish();
    if query.is_empty() {
        path
    } else {
        format!("{path}?{query}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(result: &CallToolResult) -> &str {
        result.content[0]
            .as_text()
            .expect("text content")
            .text
            .as_str()
    }

    #[test]
    fn envelopes_match_the_typescript_helpers() {
        assert_eq!(
            text(&ok(&json!({"a": [1], "b": {}}))),
            "{\n  \"a\": [\n    1\n  ],\n  \"b\": {}\n}"
        );
        assert_eq!(ok(&json!(1)).is_error, Some(false));
        let failure = fail("Nope");
        assert_eq!(text(&failure), "{\n  \"error\": \"Nope\"\n}");
        assert_eq!(failure.is_error, Some(true));
        assert_eq!(
            text(&compact_error(AUTH_ERROR)),
            r#"{"error":"A valid COUNTERPOISE_API_KEY is required"}"#
        );
    }

    #[test]
    fn roles_satisfy_the_access_levels() {
        assert!(Role::Viewer.satisfies(Level::Read));
        assert!(!Role::Viewer.satisfies(Level::Write));
        assert!(Role::Editor.satisfies(Level::Write));
        assert!(!Role::Editor.satisfies(Level::Owner));
        assert!(Role::Owner.satisfies(Level::Owner));
    }

    #[test]
    fn without_drops_the_path_arguments() {
        let arguments = json!({"bookId": 1, "name": "x"})
            .as_object()
            .unwrap()
            .clone();
        assert_eq!(without(&arguments, &["bookId"]), json!({"name": "x"}));
        assert_eq!(integer(&arguments, "bookId"), 1);
    }

    #[tokio::test]
    async fn only_a_tool_request_is_a_tool_call() {
        assert!(!in_tool_call());
        assert!(!in_oauth_tool_call());
        assert!(TOOL_CALL.scope(false, async { in_tool_call() }).await);
        assert!(!TOOL_CALL.scope(false, async { in_oauth_tool_call() }).await);
        assert!(TOOL_CALL.scope(true, async { in_oauth_tool_call() }).await);
    }

    #[test]
    fn doubles_are_written_as_javascript_writes_them() {
        assert_eq!(js_double(150.0).to_string(), "150");
        assert_eq!(js_double(1.5).to_string(), "1.5");
        assert_eq!(js_double(0.1 + 0.2).to_string(), "0.30000000000000004");
        assert_eq!(js_double(1e-7).to_string(), "1e-7");
        assert_eq!(js_double(-0.0).to_string(), "0");
        assert_eq!(js_double(f64::NAN), Value::Null);
    }

    #[test]
    fn with_query_encodes_the_named_arguments() {
        let arguments = json!({"bookId": 1, "search": "a&b c", "limit": 5, "skip": null})
            .as_object()
            .unwrap()
            .clone();
        assert_eq!(
            with_query(
                "/p".to_owned(),
                &arguments,
                &["search", "limit", "skip", "none"]
            ),
            "/p?search=a%26b+c&limit=5"
        );
        assert_eq!(with_query("/p".to_owned(), &arguments, &["none"]), "/p");
    }
}
