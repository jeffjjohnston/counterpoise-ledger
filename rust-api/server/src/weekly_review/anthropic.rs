//! The Claude Messages API, for the weekly review. Anthropic has no Rust
//! SDK, so this module sends raw HTTP. A request body and a response body
//! never enter a log: a failure is one of the static error codes.

use crate::platform;
use serde_json::{Value, json};
use std::time::Duration;

pub(crate) const MODEL: &str = "claude-opus-5-5";
const API_VERSION: &str = "2023-06-01";
/// The header of `fallbacks: "default"`: when the model declines, the API
/// runs the same request on a fallback model in the same call.
const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";
const MAX_TOKENS: u32 = 16_000;
const TIMEOUT: Duration = Duration::from_secs(300);

fn api_key() -> Option<String> {
    ledger_db::env::var("ANTHROPIC_API_KEY")
        .ok()
        .map(|key| key.trim().to_owned())
        .filter(|key| !key.is_empty())
}

/// Whether the server has an API key. It reads the environment on each
/// call, as `typesafe::is_configured` does.
pub(crate) fn is_configured() -> bool {
    api_key().is_some()
}

/// The text of the answer, the model that wrote it (a fallback can change
/// it), and the token counts.
#[derive(Debug, PartialEq)]
pub(crate) struct Reply {
    pub(crate) text: String,
    pub(crate) model: String,
    pub(crate) input_tokens: i64,
    pub(crate) output_tokens: i64,
}

pub(crate) fn request_body(system: &str, document: &Value, schema: &Value) -> Value {
    json!({
        "model": MODEL,
        "max_tokens": MAX_TOKENS,
        "system": system,
        "messages": [{ "role": "user", "content": document.to_string() }],
        "output_config": {
            "effort": "medium",
            "format": { "type": "json_schema", "schema": schema },
        },
        "fallbacks": "default",
    })
}

/// Reads a Messages API response. Only `end_turn` is an answer.
pub(crate) fn read_reply(body: &Value) -> Result<Reply, &'static str> {
    match body.get("stop_reason").and_then(Value::as_str) {
        Some("end_turn") => {}
        Some("refusal") => return Err("refusal"),
        _ => return Err("invalid_response"),
    }
    let text = body
        .get("content")
        .and_then(Value::as_array)
        .and_then(|blocks| {
            blocks
                .iter()
                .rev()
                .find(|block| block.get("type").and_then(Value::as_str) == Some("text"))
        })
        .and_then(|block| block.get("text"))
        .and_then(Value::as_str)
        .ok_or("invalid_response")?;
    let usage = |key: &str| {
        body.get("usage")
            .and_then(|usage| usage.get(key))
            .and_then(Value::as_i64)
            .unwrap_or(0)
    };
    Ok(Reply {
        text: text.to_owned(),
        model: body
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or(MODEL)
            .to_owned(),
        input_tokens: usage("input_tokens"),
        output_tokens: usage("output_tokens"),
    })
}

/// The error code of a status that is not a success. A rejected key gets its
/// own code, so that the operator does not wait for an outage to end.
pub(crate) fn status_error(status: u16) -> &'static str {
    match status {
        300..=399 => "network_error",
        401 | 403 => "invalid_api_key",
        429 => "rate_limited",
        500..=599 => "provider_unavailable",
        _ => "provider_error",
    }
}

/// One request, one try. `ANTHROPIC_API_URL` replaces the origin: the HTTP
/// tests point it at a local mock, so no test calls Anthropic.
pub(crate) async fn ask(
    system: &str,
    document: &Value,
    schema: &Value,
) -> Result<Reply, &'static str> {
    let key = api_key().ok_or("not_configured")?;
    let origin = ledger_db::env::var("ANTHROPIC_API_URL")
        .ok()
        .filter(|origin| !origin.is_empty())
        .unwrap_or_else(|| "https://api.anthropic.com".to_owned());
    let body = request_body(system, document, schema).to_string();
    // A redirect is not followed, so the key never leaves for another host.
    let exchange = platform::outbound(async {
        let answer = platform::post_without_redirects(
            &format!("{origin}/v1/messages"),
            &[
                ("x-api-key", &key),
                ("anthropic-version", API_VERSION),
                ("anthropic-beta", FALLBACK_BETA),
                ("content-type", "application/json"),
            ],
            body,
        )
        .await
        .map_err(|_| "network_error")?;
        if !(200..300).contains(&answer.status) {
            // The status only: the body can repeat a part of the request.
            tracing::warn!(
                status = answer.status,
                "Anthropic answered with an error status"
            );
            return Err(status_error(answer.status));
        }
        Ok(answer.body)
    });
    let bytes = platform::timeout(TIMEOUT, exchange)
        .await
        .ok_or("timeout")??;
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| "invalid_response")?;
    read_reply(&value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn reply(stop_reason: &str, content: Value) -> Value {
        json!({
            "id": "msg_1", "type": "message", "role": "assistant", "model": "claude-opus-5-5",
            "content": content, "stop_reason": stop_reason,
            "usage": { "input_tokens": 1200, "output_tokens": 300 }
        })
    }

    #[test]
    fn each_error_status_has_its_code() {
        for (status, code) in [
            (301, "network_error"),
            (400, "provider_error"),
            (401, "invalid_api_key"),
            (403, "invalid_api_key"),
            (404, "provider_error"),
            (429, "rate_limited"),
            (500, "provider_unavailable"),
            (529, "provider_unavailable"),
        ] {
            assert_eq!(status_error(status), code, "status {status}");
        }
    }

    #[test]
    fn the_request_has_the_model_the_schema_and_the_fallbacks() {
        let body = request_body("system", &json!({ "a": 1 }), &json!({ "type": "object" }));
        assert_eq!(body["model"], json!(MODEL));
        assert_eq!(body["max_tokens"], json!(16000));
        assert_eq!(body["system"], json!("system"));
        assert_eq!(
            body["output_config"],
            json!({
                "effort": "medium",
                "format": { "type": "json_schema", "schema": { "type": "object" } }
            })
        );
        assert_eq!(body["fallbacks"], json!("default"));
        assert_eq!(
            body["messages"],
            json!([{ "role": "user", "content": "{\"a\":1}" }])
        );
        assert!(body.get("thinking").is_none());
    }

    #[test]
    fn reads_the_last_text_block_and_the_usage() {
        let body = reply(
            "end_turn",
            json!([
                { "type": "thinking", "thinking": "", "signature": "x" },
                { "type": "text", "text": "{\"summary\":\"s\",\"items\":[]}" }
            ]),
        );
        assert_eq!(
            read_reply(&body),
            Ok(Reply {
                text: "{\"summary\":\"s\",\"items\":[]}".into(),
                model: "claude-opus-5-5".into(),
                input_tokens: 1200,
                output_tokens: 300,
            })
        );
    }

    #[test]
    fn a_refusal_and_a_cut_answer_are_failures() {
        assert_eq!(read_reply(&reply("refusal", json!([]))), Err("refusal"));
        assert_eq!(
            read_reply(&reply(
                "max_tokens",
                json!([{ "type": "text", "text": "{" }])
            )),
            Err("invalid_response")
        );
        assert_eq!(
            read_reply(&reply("end_turn", json!([]))),
            Err("invalid_response")
        );
        assert_eq!(
            read_reply(&json!({ "error": "x" })),
            Err("invalid_response")
        );
    }
}
