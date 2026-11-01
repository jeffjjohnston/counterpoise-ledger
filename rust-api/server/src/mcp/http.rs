//! The Streamable HTTP transport of `POST /api/mcp`, in house.
//!
//! rmcp's transport needs tokio tasks, channels and timers, which the
//! Workers build does not have. The endpoint is stateless and answers in
//! JSON, so a request is one JSON-RPC message in and at most one out: this
//! module parses the message, checks its headers and its `_meta` as rmcp's
//! stateless mode does, and calls the tools directly. stdio keeps rmcp.
//!
//! It answers what rmcp 3.4.1 answered with `legacy_session_mode` off and
//! `json_response` on: the same status codes, error texts and JSON-RPC
//! errors, for each protocol version from 2025-03-26 to 2026-07-28. It does
//! not check the `Host` header: rmcp's host list was off, and the `Origin`
//! check in `mod.rs` guards against DNS rebinding.

use axum::{
    body::Body,
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use futures_util::StreamExt;
use rmcp::model::{
    CallToolResponse, CancelTaskMethod, ClientJsonRpcMessage, ClientRequest, CompleteResult,
    DiscoverResult, ErrorCode, ErrorData, GetPromptRequestMethod, GetTaskMethod, JsonRpcRequest,
    ListPromptsResult, ListResourceTemplatesResult, ListResourcesResult, PingRequestMethod,
    ProtocolVersion, ReadResourceRequestMethod, RequestId, RequestMetaObject, ServerJsonRpcMessage,
    ServerResult, SetLevelRequestMethod, SubscribeRequestMethod, SubscriptionsListenRequestMethod,
    UnsubscribeRequestMethod, UpdateTaskMethod,
};
use serde_json::Value;

use super::Handler;

const PROTOCOL_VERSION_HEADER: &str = "mcp-protocol-version";
const METHOD_HEADER: &str = "mcp-method";
const NAME_HEADER: &str = "mcp-name";
const JSON: &str = "application/json";
const EVENT_STREAM: &str = "text/event-stream";

/// The largest request body: 4 MiB, as in rmcp.
pub(crate) const MAX_BODY_BYTES: usize = 4 * 1024 * 1024;

/// The answer to a method other than POST. With no sessions there is no
/// stream to open (GET) or session to end (DELETE).
pub(super) fn method_not_allowed() -> Response {
    let mut response = text(StatusCode::METHOD_NOT_ALLOWED, "Method Not Allowed");
    response
        .headers_mut()
        .insert(header::ALLOW, HeaderValue::from_static("POST"));
    response
}

/// Answers one POST, from a caller that has already been authenticated.
pub(super) async fn post(handler: &Handler, headers: &HeaderMap, body: Body) -> Response {
    match answer(handler, headers, body).await {
        Ok(response) => response,
        Err(refusal) => *refusal,
    }
}

async fn answer(handler: &Handler, headers: &HeaderMap, body: Body) -> Result<Response, Refusal> {
    let accepts = header_text(headers, header::ACCEPT.as_str())
        .is_some_and(|accept| accept.contains(JSON) && accept.contains(EVENT_STREAM));
    if !accepts {
        return Err(refuse(
            StatusCode::NOT_ACCEPTABLE,
            "Not Acceptable: Client must accept both application/json and text/event-stream",
        ));
    }
    let json_body = header_text(headers, header::CONTENT_TYPE.as_str())
        .is_some_and(|content_type| content_type.starts_with(JSON));
    if !json_body {
        return Err(refuse(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Unsupported Media Type: Content-Type must be application/json",
        ));
    }
    let bytes = read_body(body).await?;
    let message: ClientJsonRpcMessage = serde_json::from_slice(&bytes).map_err(|cause| {
        refuse(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            &format!("fail to deserialize request body {cause}"),
        )
    })?;

    let has_request_version = match &message {
        ClientJsonRpcMessage::Request(request) => {
            meta(&request.request).protocol_version().is_some()
        }
        _ => false,
    };
    match &message {
        ClientJsonRpcMessage::Request(request) => {
            if let ClientRequest::InitializeRequest(initialize) = &request.request {
                check_initialize_header(
                    headers,
                    initialize.params.protocol_version.as_str(),
                    &request.id,
                )?;
            } else {
                check_version_header(headers, has_request_version)?;
            }
        }
        _ => check_version_header(headers, has_request_version)?,
    }
    check_standard_headers(headers, &message)?;
    check_request_meta(headers, &message)?;

    let ClientJsonRpcMessage::Request(request) = message else {
        // A notification, a response or an error: a stateless server has
        // nothing to do with it.
        return Ok(StatusCode::ACCEPTED.into_response());
    };
    let negotiated =
        has_request_version || matches!(&request.request, ClientRequest::DiscoverRequest(_));
    let reply = respond(handler, headers, request).await;
    let status = if negotiated {
        status_of(&reply)
    } else {
        StatusCode::OK
    };
    Ok(json(status, &reply))
}

/// The body, refused past [`MAX_BODY_BYTES`].
async fn read_body(body: Body) -> Result<Vec<u8>, Refusal> {
    let mut collected = Vec::new();
    let mut stream = body.into_data_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|cause| {
            refuse(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("Failed to read request body: {cause}"),
            )
        })?;
        if chunk.len() > MAX_BODY_BYTES.saturating_sub(collected.len()) {
            return Err(refuse(
                StatusCode::PAYLOAD_TOO_LARGE,
                &format!("Payload Too Large: request body exceeds {MAX_BODY_BYTES} bytes"),
            ));
        }
        collected.extend_from_slice(&chunk);
    }
    Ok(collected)
}

fn meta(request: &ClientRequest) -> &RequestMetaObject {
    use rmcp::model::GetMeta;
    request.get_meta()
}

fn header_text<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

/// A request refused before it reaches a tool: the whole answer.
type Refusal = Box<Response>;

fn refuse(status: StatusCode, message: &str) -> Refusal {
    Box::new(text(status, message))
}

/// A plain message, with no `Content-Type`, as rmcp sent it.
fn text(status: StatusCode, message: &str) -> Response {
    (status, Body::from(message.to_owned())).into_response()
}

fn json(status: StatusCode, message: &ServerJsonRpcMessage) -> Response {
    let body = serde_json::to_vec(message).expect("a JSON-RPC message serializes");
    (status, [(header::CONTENT_TYPE, JSON)], body).into_response()
}

/// A JSON-RPC error that also fails the HTTP request with 400.
fn bad_request(id: Option<RequestId>, error: ErrorData) -> Refusal {
    Box::new(json(
        StatusCode::BAD_REQUEST,
        &ServerJsonRpcMessage::error(error, id),
    ))
}

/// The `MCP-Protocol-Version` header, when present, names a version this
/// server knows, unless the request names its own version in `_meta`.
fn check_version_header(headers: &HeaderMap, allow_unknown: bool) -> Result<(), Refusal> {
    let Some(value) = headers.get(PROTOCOL_VERSION_HEADER) else {
        return Ok(());
    };
    let Ok(version) = value.to_str() else {
        return Err(refuse(
            StatusCode::BAD_REQUEST,
            "Bad Request: Invalid MCP-Protocol-Version header encoding",
        ));
    };
    let known = ProtocolVersion::KNOWN_VERSIONS
        .iter()
        .any(|known| known.as_str() == version);
    if !allow_unknown && !known {
        return Err(refuse(
            StatusCode::BAD_REQUEST,
            &format!("Bad Request: Unsupported MCP-Protocol-Version: {version}"),
        ));
    }
    Ok(())
}

/// On `initialize`, the header, when present, names the version of the body.
fn check_initialize_header(
    headers: &HeaderMap,
    body_version: &str,
    id: &RequestId,
) -> Result<(), Refusal> {
    let Some(value) = headers.get(PROTOCOL_VERSION_HEADER) else {
        return Ok(());
    };
    let Ok(header_version) = value.to_str() else {
        return Err(bad_request(
            Some(id.clone()),
            ErrorData::invalid_request(
                "Invalid Request: MCP-Protocol-Version header is not valid UTF-8",
                None,
            ),
        ));
    };
    if header_version != body_version {
        return Err(bad_request(
            Some(id.clone()),
            ErrorData::invalid_request(
                format!(
                    "Invalid Request: MCP-Protocol-Version header ({header_version}) does not match initialize params.protocolVersion ({body_version})"
                ),
                None,
            ),
        ));
    }
    Ok(())
}

/// SEP-2243: from protocol 2026-07-28, a request names its method in
/// `Mcp-Method`, and a tool call names its tool in `Mcp-Name`, so that a
/// proxy can route it without reading the body. The two must match the
/// body, and each may come once: a proxy could route by a second copy. The
/// `initialize` handshake may leave them out, since a client sends them
/// once the version is agreed, but one that it sends must match too. No
/// tool here declares an `x-mcp-header` parameter.
fn check_standard_headers(
    headers: &HeaderMap,
    message: &ClientJsonRpcMessage,
) -> Result<(), Refusal> {
    let required = header_text(headers, PROTOCOL_VERSION_HEADER)
        .is_some_and(|version| version >= ProtocolVersion::STANDARD_HEADERS.as_str());
    if !required {
        return Ok(());
    }
    let (id, handshake) = match message {
        ClientJsonRpcMessage::Request(request) => (
            Some(request.id.clone()),
            matches!(&request.request, ClientRequest::InitializeRequest(_)),
        ),
        ClientJsonRpcMessage::Notification(_) => (None, false),
        _ => return Ok(()),
    };
    let Ok(body) = serde_json::to_value(message) else {
        return Ok(());
    };
    match standard_header_problem(headers, &body, handshake) {
        Some(reason) => Err(bad_request(id, ErrorData::header_mismatch(reason, None))),
        None => Ok(()),
    }
}

fn standard_header_problem(headers: &HeaderMap, body: &Value, handshake: bool) -> Option<String> {
    for (name, shown) in [(METHOD_HEADER, "Mcp-Method"), (NAME_HEADER, "Mcp-Name")] {
        if headers.get_all(name).iter().nth(1).is_some() {
            return Some(format!("more than one {shown} header"));
        }
        // A value that is not text is malformed, not missing.
        if headers.get(name).is_some() && header_text(headers, name).is_none() {
            return Some(format!("{shown} header is not valid text"));
        }
    }
    let method = body.get("method").and_then(Value::as_str)?;
    match header_text(headers, METHOD_HEADER) {
        None if handshake => return None,
        None => return Some("missing required Mcp-Method header".to_owned()),
        Some(value) if value != method => {
            return Some(format!(
                "Mcp-Method header `{value}` does not match body method `{method}`"
            ));
        }
        Some(_) => {}
    }
    let key = match method {
        "tools/call" | "prompts/get" => "name",
        "resources/read" | "resources/subscribe" | "resources/unsubscribe" => "uri",
        "tasks/get" | "tasks/update" | "tasks/cancel" => "taskId",
        _ => return None,
    };
    let expected = body.get("params")?.get(key)?.as_str()?;
    let Some(raw) = header_text(headers, NAME_HEADER) else {
        return Some(format!("missing required Mcp-Name header for `{method}`"));
    };
    match decode_header_value(raw) {
        None => Some("Mcp-Name header is not valid Base64".to_owned()),
        Some(decoded) if decoded != expected => Some(format!(
            "Mcp-Name header `{decoded}` does not match body value `{expected}`"
        )),
        Some(_) => None,
    }
}

/// A header value as SEP-2243 writes it: as is, or `=?base64?...?=`.
fn decode_header_value(value: &str) -> Option<String> {
    use base64::{Engine, prelude::BASE64_STANDARD};
    match value
        .strip_prefix("=?base64?")
        .and_then(|inner| inner.strip_suffix("?="))
    {
        Some(inner) => String::from_utf8(BASE64_STANDARD.decode(inner).ok()?).ok(),
        None => Some(value.to_owned()),
    }
}

/// A request that names its version in `_meta` sends the same version in
/// the header. From 2026-07-28, and on `server/discover`, a request must
/// carry its `_meta`.
fn check_request_meta(headers: &HeaderMap, message: &ClientJsonRpcMessage) -> Result<(), Refusal> {
    let ClientJsonRpcMessage::Request(request) = message else {
        return Ok(());
    };
    if matches!(&request.request, ClientRequest::InitializeRequest(_)) {
        return Ok(());
    }
    let discover = matches!(&request.request, ClientRequest::DiscoverRequest(_));
    let meta = meta(&request.request);
    let header_version = header_text(headers, PROTOCOL_VERSION_HEADER);
    let Some(meta_version) = meta.protocol_version() else {
        let required = discover
            || header_version
                .is_some_and(|version| version >= ProtocolVersion::V_2026_07_28.as_str());
        if required {
            let missing = meta.missing_required_keys(&ProtocolVersion::V_2026_07_28);
            return Err(bad_request(
                Some(request.id.clone()),
                ErrorData::invalid_params(
                    format!(
                        "Invalid params: request _meta is missing or has malformed required fields: {}",
                        missing.join(", ")
                    ),
                    None,
                ),
            ));
        }
        return Ok(());
    };
    let Some(header_version) = header_version else {
        return Err(bad_request(
            Some(request.id.clone()),
            ErrorData::header_mismatch(
                "request _meta protocolVersion requires MCP-Protocol-Version header",
                None,
            ),
        ));
    };
    if header_version != meta_version.as_str() {
        return Err(bad_request(
            Some(request.id.clone()),
            ErrorData::header_mismatch(
                format!(
                    "MCP-Protocol-Version header ({header_version}) does not match request _meta protocolVersion ({meta_version})"
                ),
                None,
            ),
        ));
    }
    Ok(())
}

/// On a request that negotiates its version itself, a JSON-RPC error that
/// means a malformed request also fails the HTTP request.
fn status_of(reply: &ServerJsonRpcMessage) -> StatusCode {
    let ServerJsonRpcMessage::Error(error) = reply else {
        return StatusCode::OK;
    };
    match error.error.code {
        ErrorCode::UNSUPPORTED_PROTOCOL_VERSION
        | ErrorCode::MISSING_REQUIRED_CLIENT_CAPABILITY
        | ErrorCode::INVALID_PARAMS
        | ErrorCode::HEADER_MISMATCH => StatusCode::BAD_REQUEST,
        ErrorCode::METHOD_NOT_FOUND => StatusCode::NOT_FOUND,
        _ => StatusCode::OK,
    }
}

fn is_legacy(version: &ProtocolVersion) -> bool {
    version.as_str() < ProtocolVersion::V_2026_07_28.as_str()
}

async fn respond(
    handler: &Handler,
    headers: &HeaderMap,
    request: JsonRpcRequest<ClientRequest>,
) -> ServerJsonRpcMessage {
    let JsonRpcRequest { id, request, .. } = request;
    match dispatch(handler, headers, request).await {
        Ok(result) => ServerJsonRpcMessage::response(result, id),
        Err(error) => ServerJsonRpcMessage::error(error, Some(id)),
    }
}

/// What rmcp's `ServerHandler` dispatch gives for this server: tools only,
/// no prompts, resources, subscriptions, logging or tasks.
async fn dispatch(
    handler: &Handler,
    headers: &HeaderMap,
    request: ClientRequest,
) -> Result<ServerResult, ErrorData> {
    let meta = meta(&request).clone();
    let requested = meta.protocol_version();
    // The version of this request: its `_meta`, else the version that
    // `initialize` names, else the header, else 2025-03-26.
    let version = requested.clone().unwrap_or_else(|| match &request {
        ClientRequest::InitializeRequest(initialize) => initialize.params.protocol_version.clone(),
        _ => header_text(headers, PROTOCOL_VERSION_HEADER)
            .and_then(|version| serde_json::from_value(Value::String(version.to_owned())).ok())
            .unwrap_or(ProtocolVersion::V_2025_03_26),
    });
    let initialize = matches!(&request, ClientRequest::InitializeRequest(_));
    if !initialize
        && let Some(requested) = &requested
        && !ProtocolVersion::KNOWN_VERSIONS.contains(requested)
    {
        return Err(ErrorData::unsupported_protocol_version(
            requested.clone(),
            ProtocolVersion::KNOWN_VERSIONS,
        ));
    }
    let needs_meta = !initialize
        && (matches!(&request, ClientRequest::DiscoverRequest(_))
            || requested
                .as_ref()
                .is_some_and(|version| !is_legacy(version)));
    if needs_meta {
        let missing = meta.missing_required_keys(&ProtocolVersion::V_2026_07_28);
        if !missing.is_empty() {
            return Err(ErrorData::invalid_params(
                format!(
                    "request _meta is missing or has malformed required fields: {}",
                    missing.join(", ")
                ),
                None,
            ));
        }
    }
    let legacy = !needs_meta && is_legacy(&version);
    let method = request.method().to_owned();
    let mut result = match request {
        ClientRequest::InitializeRequest(initialize) => {
            let mut info = Handler::info();
            info.protocol_version = negotiate(&initialize.params.protocol_version);
            ServerResult::InitializeResult(info)
        }
        ClientRequest::DiscoverRequest(_) => {
            ServerResult::DiscoverResult(DiscoverResult::from_server_info(
                ProtocolVersion::KNOWN_VERSIONS.to_vec(),
                Handler::info(),
            ))
        }
        ClientRequest::PingRequest(_) if legacy => ServerResult::empty(()),
        ClientRequest::PingRequest(_) => {
            return Err(ErrorData::method_not_found::<PingRequestMethod>());
        }
        ClientRequest::CompleteRequest(_) => {
            ServerResult::CompleteResult(CompleteResult::default())
        }
        ClientRequest::ListPromptsRequest(_) => {
            ServerResult::ListPromptsResult(ListPromptsResult::default())
        }
        ClientRequest::ListResourcesRequest(_) => {
            ServerResult::ListResourcesResult(ListResourcesResult::default())
        }
        ClientRequest::ListResourceTemplatesRequest(_) => {
            ServerResult::ListResourceTemplatesResult(ListResourceTemplatesResult::default())
        }
        ClientRequest::ListToolsRequest(_) => ServerResult::ListToolsResult(Handler::tools()),
        ClientRequest::CallToolRequest(call) => {
            let result = handler.call(call.params, headers).await;
            ServerResult::from(CallToolResponse::from(result))
        }
        ClientRequest::SetLevelRequest(_) => {
            return Err(ErrorData::method_not_found::<SetLevelRequestMethod>());
        }
        ClientRequest::GetPromptRequest(_) => {
            return Err(ErrorData::method_not_found::<GetPromptRequestMethod>());
        }
        ClientRequest::ReadResourceRequest(_) => {
            return Err(ErrorData::method_not_found::<ReadResourceRequestMethod>());
        }
        ClientRequest::SubscriptionsListenRequest(_) => {
            return Err(ErrorData::method_not_found::<
                SubscriptionsListenRequestMethod,
            >());
        }
        ClientRequest::SubscribeRequest(_) => {
            return Err(ErrorData::method_not_found::<SubscribeRequestMethod>());
        }
        ClientRequest::UnsubscribeRequest(_) => {
            return Err(ErrorData::method_not_found::<UnsubscribeRequestMethod>());
        }
        ClientRequest::GetTaskRequest(_) => {
            return Err(ErrorData::method_not_found::<GetTaskMethod>());
        }
        ClientRequest::UpdateTaskRequest(_) => {
            return Err(ErrorData::method_not_found::<UpdateTaskMethod>());
        }
        ClientRequest::CancelTaskRequest(_) => {
            return Err(ErrorData::method_not_found::<CancelTaskMethod>());
        }
        // A custom method, or a kind of request newer than this code.
        _ => return Err(ErrorData::new(ErrorCode::METHOD_NOT_FOUND, method, None)),
    };
    // SEP-2322: a result carries `resultType` from 2026-07-28 only.
    if is_legacy(&version) {
        result.strip_result_type_for_legacy_peer();
    }
    Ok(result)
}

/// The version `initialize` answers with: the client's when it has the
/// handshake and is known, else the newest version that has it. From
/// 2026-07-28 a client negotiates in each request's `_meta` instead.
fn negotiate(requested: &ProtocolVersion) -> ProtocolVersion {
    if is_legacy(requested) && ProtocolVersion::KNOWN_VERSIONS.contains(requested) {
        return requested.clone();
    }
    let ours = Handler::info().protocol_version;
    if is_legacy(&ours) {
        return ours;
    }
    ProtocolVersion::KNOWN_VERSIONS
        .iter()
        .filter(|version| is_legacy(version))
        .max_by(|left, right| left.as_str().cmp(right.as_str()))
        .cloned()
        .expect("a known version has the initialize handshake")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AppState;
    use axum::body::to_bytes;
    use serde_json::json;

    const META: &str = r#"{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{},"io.modelcontextprotocol/clientInfo":{"name":"t","version":"1"}}"#;

    fn handler() -> Handler {
        Handler {
            state: AppState::in_memory(),
            credential: None,
        }
    }

    /// POSTs `body` with the usual headers and `extra`, and gives the status
    /// and the body, parsed when it is JSON.
    async fn send(extra: &[(&str, &str)], body: &str) -> (StatusCode, Value) {
        send_with(extra, &[], body).await
    }

    /// `send`, with the headers of `repeated` added after the others, so
    /// that a name can come twice.
    async fn send_with(
        extra: &[(&str, &str)],
        repeated: &[(&str, &str)],
        body: &str,
    ) -> (StatusCode, Value) {
        let mut headers = HeaderMap::new();
        headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(JSON));
        headers.insert(
            header::ACCEPT,
            HeaderValue::from_static("application/json, text/event-stream"),
        );
        for (name, value) in extra {
            headers.insert(
                header::HeaderName::from_bytes(name.as_bytes()).unwrap(),
                HeaderValue::from_str(value).unwrap(),
            );
        }
        for (name, value) in repeated {
            headers.append(
                header::HeaderName::from_bytes(name.as_bytes()).unwrap(),
                HeaderValue::from_str(value).unwrap(),
            );
        }
        let response = post(&handler(), &headers, Body::from(body.to_owned())).await;
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let value = serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into_owned()));
        (status, value)
    }

    fn initialize(version: &str) -> String {
        json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": version, "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}
        }})
        .to_string()
    }

    fn request(method: &str, meta: bool) -> String {
        let params = if meta {
            format!(r#"{{"_meta":{META}}}"#)
        } else {
            "{}".to_owned()
        };
        format!(r#"{{"jsonrpc":"2.0","id":1,"method":"{method}","params":{params}}}"#)
    }

    #[tokio::test]
    async fn initialize_answers_with_a_version_that_has_the_handshake() {
        for (asked, answered) in [
            ("2025-06-18", "2025-06-18"),
            ("2024-11-05", "2024-11-05"),
            ("2026-07-28", "2025-11-25"),
            ("2099-01-01", "2025-11-25"),
        ] {
            let (status, body) = send(&[], &initialize(asked)).await;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(body["result"]["protocolVersion"], answered, "{asked}");
            assert_eq!(body["result"]["capabilities"], json!({"tools": {}}));
        }
        let (status, body) = send(
            &[("mcp-protocol-version", "2025-03-26")],
            &initialize("2025-06-18"),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"]["code"], -32600);
    }

    #[tokio::test]
    async fn refuses_what_is_not_one_json_rpc_message() {
        let (status, _) = send(&[("accept", "application/json")], &initialize("2025-06-18")).await;
        assert_eq!(status, StatusCode::NOT_ACCEPTABLE);
        let (status, _) = send(&[("content-type", "text/plain")], &initialize("2025-06-18")).await;
        assert_eq!(status, StatusCode::UNSUPPORTED_MEDIA_TYPE);
        let (status, _) = send(&[], &format!("[{}]", initialize("2025-06-18"))).await;
        assert_eq!(status, StatusCode::UNSUPPORTED_MEDIA_TYPE);
        let big = format!(r#"{{"x":"{}"}}"#, "a".repeat(MAX_BODY_BYTES));
        let (status, _) = send(&[], &big).await;
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
        let (status, _) = send(
            &[("mcp-protocol-version", "bogus")],
            &request("tools/list", false),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(
            method_not_allowed().status(),
            StatusCode::METHOD_NOT_ALLOWED
        );
    }

    #[tokio::test]
    async fn a_notification_or_a_response_is_accepted() {
        let notification = r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#;
        assert_eq!(send(&[], notification).await.0, StatusCode::ACCEPTED);
        let response = r#"{"jsonrpc":"2.0","id":5,"result":{}}"#;
        assert_eq!(send(&[], response).await.0, StatusCode::ACCEPTED);
    }

    #[tokio::test]
    async fn a_legacy_request_lists_the_tools_without_a_result_type() {
        let (status, body) = send(&[], &request("tools/list", false)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["result"]["ttlMs"], 300_000);
        assert_eq!(body["result"]["cacheScope"], "private");
        assert!(body["result"].get("resultType").is_none());
        assert!(!body["result"]["tools"].as_array().unwrap().is_empty());
        let (_, body) = send(&[], &request("ping", false)).await;
        assert_eq!(body["result"], json!({}));
        let (status, body) = send(&[], &request("prompts/get", false)).await;
        assert_eq!(status, StatusCode::OK, "a legacy error keeps HTTP 200");
        assert_eq!(body["error"]["code"], -32601);
    }

    #[tokio::test]
    async fn a_2026_request_carries_its_version_in_meta_and_headers() {
        let headers = [
            ("mcp-protocol-version", "2026-07-28"),
            ("mcp-method", "tools/list"),
        ];
        let (status, body) = send(&headers, &request("tools/list", true)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["result"]["resultType"], "complete");

        let (status, body) = send(&headers[..1], &request("tools/list", true)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"]["code"], -32020, "Mcp-Method is required");

        let (status, body) = send(&headers, &request("tools/list", false)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"]["code"], -32602, "_meta is required");

        let (status, body) = send(&[], &request("tools/list", true)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(
            body["error"]["code"], -32020,
            "the header must name the version"
        );

        let ping = [
            ("mcp-protocol-version", "2026-07-28"),
            ("mcp-method", "ping"),
        ];
        let (status, body) = send(&ping, &request("ping", true)).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "2026-07-28 has no ping");
        assert_eq!(body["error"]["code"], -32601);

        let discover = [
            ("mcp-protocol-version", "2026-07-28"),
            ("mcp-method", "server/discover"),
        ];
        let (status, body) = send(&discover, &request("server/discover", true)).await;
        assert_eq!(status, StatusCode::OK);
        assert!(
            body["result"]["supportedVersions"]
                .as_array()
                .unwrap()
                .contains(&json!("2026-07-28"))
        );
    }

    #[tokio::test]
    async fn a_2026_tool_call_names_its_tool_in_a_header() {
        let call = format!(
            r#"{{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{{"name":"list_books","arguments":{{}},"_meta":{META}}}}}"#
        );
        let headers = |name| {
            [
                ("mcp-protocol-version", "2026-07-28"),
                ("mcp-method", "tools/call"),
                ("mcp-name", name),
            ]
        };
        // The handler has no key, so the tool itself refuses.
        let (status, body) = send(&headers("list_books"), &call).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["result"]["isError"], true);
        let (status, _) = send(&headers("=?base64?bGlzdF9ib29rcw==?="), &call).await;
        assert_eq!(status, StatusCode::OK);
        let (status, body) = send(&headers("other"), &call).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"]["code"], -32020);
        // A second copy of a routing header is refused, even when the
        // first matches: a proxy could route by the second.
        for repeated in [("mcp-name", "other"), ("mcp-method", "tools/list")] {
            let (status, body) = send_with(&headers("list_books"), &[repeated], &call).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{repeated:?}");
            assert_eq!(body["error"]["code"], -32020);
        }
    }

    #[tokio::test]
    async fn a_2026_handshake_may_leave_out_its_method_header_but_not_send_another() {
        let version = ("mcp-protocol-version", "2026-07-28");
        let (status, _) = send(&[version], &initialize("2026-07-28")).await;
        assert_eq!(status, StatusCode::OK);
        let (status, _) = send(
            &[version, ("mcp-method", "initialize")],
            &initialize("2026-07-28"),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let (status, body) = send(
            &[version, ("mcp-method", "tools/list")],
            &initialize("2026-07-28"),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"]["code"], -32020);
        // A value that is not text is malformed, not left out.
        let mut headers = HeaderMap::new();
        headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(JSON));
        headers.insert(
            header::ACCEPT,
            HeaderValue::from_static("application/json, text/event-stream"),
        );
        headers.insert(
            "mcp-protocol-version",
            HeaderValue::from_static("2026-07-28"),
        );
        headers.insert(
            "mcp-method",
            HeaderValue::from_bytes(b"init\xffialize").unwrap(),
        );
        let response = post(&handler(), &headers, Body::from(initialize("2026-07-28"))).await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["error"]["code"], -32020);
    }
}
