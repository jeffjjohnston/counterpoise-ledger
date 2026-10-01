//! The MCP server: over Streamable HTTP at `POST /api/mcp`, and over stdio
//! with `counterpoise-rust-api mcp`.
//!
//! The tool names, descriptions, annotations and input schemas come from
//! `mcp-tools.json`. That file is the source: edit it to change what a client
//! sees. `tests/mcp/manifest.test.ts` checks that `tools/list` gives it
//! unchanged, and `tests/mcp/annotations.test.ts` checks its annotations and
//! field descriptions.
//!
//! The HTTP transport is stateless: no session IDs, and a new handler for each
//! request. A caller authenticates with `Authorization: Bearer cpk_...` only.
//! The session cookie is removed before anything reads it, so a browser
//! session cannot drive this endpoint.
//!
//! The stdio transport takes its key from `COUNTERPOISE_API_KEY` and sends it
//! as the bearer header of each tool's requests, as the HTTP transport sends
//! the caller's. Each call checks the key again, so a revoked key stops
//! working without a restart. Only the protocol goes to stdout; logs go to
//! stderr.

mod call;
mod tools;
pub(crate) mod webmcp;

use std::{
    collections::HashMap,
    sync::{Arc, OnceLock},
};

use axum::{
    body::Body,
    extract::State,
    http::{HeaderMap, HeaderValue, Request, StatusCode, header, request::Parts},
    response::{IntoResponse, Response},
};
use rmcp::{
    ErrorData as McpError, RoleServer, ServerHandler,
    model::{
        CallToolRequestParams, CallToolResponse, CallToolResult, Implementation, ListToolsResult,
        PaginatedRequestParams, ServerCapabilities, ServerConfig, Tool,
    },
    service::RequestContext,
    transport::streamable_http_server::{
        StreamableHttpServerConfig, StreamableHttpService, session::never::NeverSessionManager,
    },
};
use serde_json::{Value, json};

use crate::{
    auth::{bearer_token, principal},
    state::AppState,
};

pub(crate) use call::Caller;
pub(crate) use call::in_tool_call;

/// The manifest's tools that have a Rust handler, and a validator for each
/// input schema.
struct Registry {
    tools: Vec<Tool>,
    validators: HashMap<String, jsonschema::Validator>,
    /// The top-level property names of each input schema.
    properties: HashMap<String, Vec<String>>,
}

fn registry() -> &'static Registry {
    static REGISTRY: OnceLock<Registry> = OnceLock::new();
    REGISTRY.get_or_init(|| {
        let manifest: Vec<Value> = serde_json::from_str(include_str!("../../mcp-tools.json"))
            .expect("valid MCP tool manifest");
        let mut tools = Vec::new();
        let mut validators = HashMap::new();
        let mut properties = HashMap::new();
        for entry in manifest {
            let name = entry["name"].as_str().expect("tool name").to_owned();
            if !tools::IMPLEMENTED.contains(&name.as_str()) {
                continue;
            }
            let validator = jsonschema::options()
                .should_validate_formats(true)
                .build(&entry["inputSchema"])
                .unwrap_or_else(|cause| panic!("input schema of {name}: {cause}"));
            let keys = entry["inputSchema"]["properties"]
                .as_object()
                .map(|keys| keys.keys().cloned().collect())
                .unwrap_or_default();
            properties.insert(name.clone(), keys);
            validators.insert(name, validator);
            tools.push(serde_json::from_value(entry).expect("manifest entry is an MCP tool"));
        }
        Registry {
            tools,
            validators,
            properties,
        }
    })
}

/// Fields whose zod schema gives one custom message for any failure, as
/// `(tool, path, message)`. The JSON Schema cannot hold that message, so a
/// failure at one of these paths carries it in place of the JSON Schema
/// text. In a path, `*` stands for any array index. A missing required
/// property counts as a failure of that property, as zod reports it. Add a
/// path here when a test or a client relies on its message.
const ZOD_MESSAGES: &[(&str, &str, &str)] = &[
    (
        "create_security",
        "/fixedPriceMicros",
        "fixedPriceMicros must be a positive whole number of micros",
    ),
    (
        "update_security",
        "/fixedPriceMicros",
        "fixedPriceMicros must be a positive whole number of micros",
    ),
    (
        "update_plaid_token",
        "/financialInstitution",
        tools::UPDATE_TOKEN_REQUIRED,
    ),
    (
        "update_plaid_token",
        "/itemId",
        tools::UPDATE_TOKEN_REQUIRED,
    ),
    (
        "set_plaid_token_accounts",
        "/assignments",
        "assignments must be an array",
    ),
    (
        "set_plaid_token_accounts",
        "/assignments/*",
        tools::PLAID_ACCOUNT_ID_REQUIRED,
    ),
    (
        "set_plaid_token_accounts",
        "/assignments/*/plaidAccountId",
        tools::PLAID_ACCOUNT_ID_REQUIRED,
    ),
    (
        "set_plaid_token_accounts",
        "/assignments/*/counterpoiseAccountId",
        tools::COUNTERPOISE_ACCOUNT_ID_INVALID,
    ),
    (
        "reconcile_plaid_transaction",
        "/reconciliationId",
        "reconciliationId is required",
    ),
    ("reconcile_plaid_transaction", "/action", "Invalid action"),
    (
        "list_pending_plaid_transactions",
        "/accountId",
        "Invalid accountId",
    ),
];

/// The zod message for a failure at `path`, with each array index read as
/// `*`.
fn zod_message(tool: &str, path: &str) -> Option<&'static str> {
    let pattern: Vec<&str> = path
        .split('/')
        .map(|segment| {
            if !segment.is_empty() && segment.parse::<usize>().is_ok() {
                "*"
            } else {
                segment
            }
        })
        .collect();
    let pattern = pattern.join("/");
    ZOD_MESSAGES
        .iter()
        .find(|(name, key, _)| *name == tool && *key == pattern)
        .map(|(_, _, message)| *message)
}

/// Validates a tool's arguments as the TypeScript SDK and zod do, then runs
/// the tool as `caller`. The HTTP transport and WebMCP both call this.
pub(crate) async fn call_tool(
    caller: &Caller,
    name: &str,
    mut arguments: serde_json::Map<String, Value>,
) -> CallToolResult {
    let registry = registry();
    let Some(validator) = registry.validators.get(name) else {
        return call::thrown(&format!("MCP error -32602: Tool {name} not found"));
    };
    tools::prepare(name, &mut arguments);
    if let Some(refused) = tools::precheck(name, &arguments) {
        return refused;
    }
    let value = Value::Object(arguments.clone());
    let problems: Vec<String> = validator
        .iter_errors(&value)
        .map(|problem| {
            let mut path = problem.instance_path().to_string();
            // A missing property is a failure of that property, as zod
            // reports it.
            if let jsonschema::error::ValidationErrorKind::Required { property } = problem.kind()
                && let Some(property) = property.as_str()
            {
                path = format!("{path}/{property}");
            }
            if path.is_empty() {
                problem.to_string()
            } else if let Some(message) = zod_message(name, &path) {
                format!("{path}: {message}")
            } else {
                format!("{path}: {problem}")
            }
        })
        .collect();
    if !problems.is_empty() {
        return call::invalid_arguments(name, &problems);
    }
    // Drop the keys that the schema does not list, as zod does. A tool
    // that forwards its arguments to a route must not pass them on: the
    // route may act on a key the tool omits on purpose, such as
    // `accessToken` or `typesafe`.
    if let Some(keys) = registry.properties.get(name) {
        arguments.retain(|key, _| keys.contains(key));
    }
    match tools::call(caller, name, &arguments).await {
        Some(result) => result,
        None => call::thrown(&format!("MCP error -32602: Tool {name} not found")),
    }
}

#[derive(Clone)]
struct Handler {
    state: AppState,
    /// The stdio server's credential: the key as a bearer header. None over
    /// HTTP, where each request carries its own.
    credential: Option<HeaderMap>,
}

impl Handler {
    async fn call(&self, request: CallToolRequestParams, headers: &HeaderMap) -> CallToolResult {
        let caller = Caller::new(self.state.clone(), headers);
        call_tool(
            &caller,
            request.name.as_ref(),
            request.arguments.unwrap_or_default(),
        )
        .await
    }
}

impl ServerHandler for Handler {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build()).with_server_info(
            Implementation::new("counterpoise", env!("CARGO_PKG_VERSION")),
        )
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, McpError> {
        Ok(ListToolsResult {
            tools: registry().tools.clone(),
            ..Default::default()
        })
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, McpError> {
        if let Some(headers) = &self.credential {
            return Ok(self.call(request, headers).await.into());
        }
        let Some(parts) = context.extensions.get::<Parts>() else {
            return Ok(call::thrown("The request has no HTTP headers").into());
        };
        Ok(self.call(request, &parts.headers).await.into())
    }
}

fn unauthorized() -> Response {
    let mut response = (
        StatusCode::UNAUTHORIZED,
        axum::Json(json!({ "error": "A valid COUNTERPOISE_API_KEY is required" })),
    )
        .into_response();
    response
        .headers_mut()
        .insert(header::WWW_AUTHENTICATE, HeaderValue::from_static("Bearer"));
    response
}

/// An `Origin` that names another host. Browsers send `Origin`, so this stops
/// a page on another site from calling the endpoint. A request without
/// `Origin` passes, as in the cross-origin check of `security.rs`.
///
/// The public host is `X-Forwarded-Host` when it is present, as in
/// `security.rs`: a reverse proxy that replaces `Host` can put the browser's
/// host there. When the server does not trust a proxy, `client_ip::record`
/// removes the header before it gets here. The key
/// is a bearer header, never a cookie, so a page cannot borrow a user's
/// credentials here in any case: this check is a second line.
fn is_cross_origin(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(header::ORIGIN) else {
        return false;
    };
    let host = headers
        .get("x-forwarded-host")
        .or_else(|| headers.get(header::HOST))
        .and_then(|host| host.to_str().ok())
        .and_then(|host| host.split(',').next())
        .map(str::trim);
    let Some(host) = host else {
        return true;
    };
    match origin
        .to_str()
        .ok()
        .and_then(|origin| url::Url::parse(origin).ok())
    {
        Some(origin) => {
            let authority = match (origin.host_str(), origin.port()) {
                (Some(name), Some(port)) => format!("{name}:{port}"),
                (Some(name), None) => name.to_owned(),
                (None, _) => return true,
            };
            !authority.eq_ignore_ascii_case(host)
        }
        None => true,
    }
}

/// `POST /api/mcp` and the other methods of the Streamable HTTP transport.
pub(crate) async fn http(State(state): State<AppState>, mut request: Request<Body>) -> Response {
    if is_cross_origin(request.headers()) {
        return (
            StatusCode::FORBIDDEN,
            axum::Json(json!({ "error": "Cross-origin request rejected" })),
        )
            .into_response();
    }
    request.headers_mut().remove(header::COOKIE);
    if bearer_token(request.headers()).is_none() {
        return unauthorized();
    }
    match principal(&state, request.headers()).await {
        Ok(Some(_)) => {}
        Ok(None) => return unauthorized(),
        Err(cause) => {
            tracing::error!(error = %cause, "MCP key check failed");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                axum::Json(json!({ "error": "Internal error" })),
            )
                .into_response();
        }
    }
    // The Origin check above guards against DNS rebinding. The Host header is
    // whatever name the reverse proxy serves, so no host list applies.
    let config = StreamableHttpServerConfig::default()
        .with_legacy_session_mode(false)
        .with_json_response(true)
        .disable_allowed_hosts();
    let service = StreamableHttpService::new(
        move || {
            Ok(Handler {
                state: state.clone(),
                credential: None,
            })
        },
        Arc::new(NeverSessionManager::default()),
        config,
    );
    service.handle(request).await.map(Body::new)
}

/// The bearer header for a key, or no header when the key is missing or
/// cannot be a header value.
fn key_headers(key: Option<&str>) -> HeaderMap {
    let mut headers = HeaderMap::new();
    if let Some(value) = key
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .and_then(|key| HeaderValue::from_str(&format!("Bearer {key}")).ok())
    {
        headers.insert(header::AUTHORIZATION, value);
    }
    headers
}

/// `counterpoise-rust-api mcp`: serves the tools over stdio until the client
/// closes stdin. A missing or unknown key does not stop the server: each tool
/// then answers with the auth error, as the TypeScript server did.
pub(crate) async fn stdio(
    state: AppState,
    key: Option<&str>,
) -> Result<(), Box<dyn std::error::Error>> {
    use rmcp::ServiceExt;

    let headers = key_headers(key);
    match principal(&state, &headers).await {
        Ok(Some(user_id)) => tracing::info!(user_id, "MCP authenticated"),
        Ok(None) => {
            tracing::warn!("No valid API key: every tool requires a valid COUNTERPOISE_API_KEY")
        }
        Err(cause) => tracing::error!(error = %cause, "MCP key check failed"),
    }
    let handler = Handler {
        state,
        credential: Some(headers),
    };
    handler
        .serve(rmcp::transport::stdio())
        .await?
        .waiting()
        .await?;
    Ok(())
}

/// The tool text of a result, for tests.
#[cfg(test)]
fn text(result: &CallToolResult) -> String {
    result
        .content
        .iter()
        .filter_map(|content: &rmcp::model::ContentBlock| {
            content.as_text().map(|text| text.text.clone())
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&'static str, &'static str)]) -> HeaderMap {
        let mut headers = HeaderMap::new();
        for (name, value) in pairs {
            headers.insert(*name, HeaderValue::from_static(value));
        }
        headers
    }

    #[test]
    fn create_demo_book_lists_every_dataset() {
        let manifest: Vec<Value> =
            serde_json::from_str(include_str!("../../mcp-tools.json")).expect("manifest");
        let tool = manifest
            .iter()
            .find(|entry| entry["name"] == "create_demo_book")
            .expect("create_demo_book");
        let listed: Vec<&str> = tool["inputSchema"]["properties"]["dataset"]["enum"]
            .as_array()
            .expect("a dataset enum")
            .iter()
            .map(|id| id.as_str().expect("a string ID"))
            .collect();
        let ids: Vec<&str> = ledger_db::seed::DemoDataset::ALL
            .iter()
            .map(|dataset| dataset.id())
            .collect();
        assert_eq!(listed, ids);
        let validator = &registry().validators["create_demo_book"];
        assert!(validator.is_valid(&json!({})));
        assert!(validator.is_valid(&json!({"dataset": "single"})));
        assert!(!validator.is_valid(&json!({"dataset": "nope"})));
    }

    #[test]
    fn registry_holds_every_implemented_tool() {
        let names: Vec<&str> = registry()
            .tools
            .iter()
            .map(|tool| tool.name.as_ref())
            .collect();
        let mut expected = tools::IMPLEMENTED.to_vec();
        expected.sort_unstable();
        let mut listed = names.clone();
        listed.sort_unstable();
        assert_eq!(listed, expected);
    }

    #[test]
    fn schemas_refuse_what_zod_refuses() {
        let validator = &registry().validators["update_book"];
        assert!(validator.is_valid(&json!({"bookId": 1, "name": "Ledger"})));
        assert!(!validator.is_valid(&json!({"bookId": 0, "name": "Ledger"})));
        assert!(!validator.is_valid(&json!({"bookId": 1.5, "name": "Ledger"})));
        assert!(!validator.is_valid(&json!({"name": "Ledger"})));
    }

    #[test]
    fn every_manifest_tool_has_a_rust_handler() {
        let manifest: Vec<Value> =
            serde_json::from_str(include_str!("../../mcp-tools.json")).expect("manifest");
        let mut names: Vec<&str> = manifest
            .iter()
            .map(|entry| entry["name"].as_str().expect("tool name"))
            .collect();
        names.sort_unstable();
        let mut implemented = tools::IMPLEMENTED.to_vec();
        implemented.sort_unstable();
        assert_eq!(names, implemented);
    }

    #[test]
    fn registry_knows_the_fields_of_each_schema() {
        let keys = &registry().properties["update_book"];
        assert!(keys.contains(&"bookId".to_owned()));
        assert!(keys.contains(&"name".to_owned()));
        assert!(!keys.contains(&"userId".to_owned()));
    }

    #[test]
    fn zod_messages_apply_to_their_field_only() {
        assert_eq!(
            zod_message("create_security", "/fixedPriceMicros"),
            Some("fixedPriceMicros must be a positive whole number of micros")
        );
        assert_eq!(zod_message("create_security", "/name"), None);
        assert_eq!(
            zod_message(
                "set_plaid_token_accounts",
                "/assignments/0/counterpoiseAccountId"
            ),
            Some("counterpoiseAccountId must be a positive integer or null")
        );
        assert_eq!(zod_message("create_account", "/fixedPriceMicros"), None);
        for (tool, path, _) in ZOD_MESSAGES {
            let field = path
                .rsplit('/')
                .find(|segment| *segment != "*")
                .unwrap_or_default();
            let schema = &registry()
                .tools
                .iter()
                .find(|entry| entry.name == *tool)
                .unwrap_or_else(|| panic!("{tool} is not served"))
                .input_schema;
            assert!(
                serde_json::to_string(&**schema)
                    .expect("a schema serializes")
                    .contains(&format!("\"{field}\"")),
                "{tool} has no field {field}"
            );
        }
    }

    #[test]
    fn origin_must_match_the_host() {
        assert!(!is_cross_origin(&headers(&[("host", "books.example")])));
        assert!(!is_cross_origin(&headers(&[
            ("host", "books.example"),
            ("origin", "https://books.example")
        ])));
        assert!(!is_cross_origin(&headers(&[
            ("host", "localhost:3000"),
            ("origin", "http://localhost:3000")
        ])));
        assert!(is_cross_origin(&headers(&[
            ("host", "books.example"),
            ("origin", "https://evil.example")
        ])));
        assert!(is_cross_origin(&headers(&[
            ("host", "localhost:3000"),
            ("origin", "http://localhost:4000")
        ])));
        assert!(is_cross_origin(&headers(&[
            ("host", "books.example"),
            ("origin", "null")
        ])));
        assert!(is_cross_origin(&headers(&[(
            "origin",
            "https://books.example"
        )])));
    }

    #[test]
    fn origin_is_compared_with_the_forwarded_host_behind_the_next_proxy() {
        let proxied = |origin: &'static str| {
            headers(&[
                ("host", "rust-api:4000"),
                ("x-forwarded-host", "books.example"),
                ("origin", origin),
            ])
        };
        assert!(!is_cross_origin(&proxied("https://books.example")));
        assert!(is_cross_origin(&proxied("https://evil.example")));
        assert!(!is_cross_origin(&headers(&[
            ("host", "rust-api:4000"),
            ("x-forwarded-host", "books.example, inner.proxy"),
            ("origin", "https://books.example"),
        ])));
    }

    #[test]
    fn a_key_becomes_a_bearer_header() {
        let headers = key_headers(Some(" cpk_abc "));
        assert_eq!(bearer_token(&headers), Some("cpk_abc"));
        assert!(key_headers(None).is_empty());
        assert!(key_headers(Some("")).is_empty());
        assert!(key_headers(Some("cpk\nx")).is_empty());
    }

    #[test]
    fn unknown_tools_and_bad_arguments_fail_as_the_sdk_does() {
        let result = call::thrown("MCP error -32602: Tool nope not found");
        assert_eq!(text(&result), "MCP error -32602: Tool nope not found");
        assert_eq!(result.is_error, Some(true));
    }
}
