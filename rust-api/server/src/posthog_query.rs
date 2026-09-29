//! The PostHog Query API client (HogQL) of `lib/posthog-query.ts`.
//!
//! The legacy `/api/event/` endpoint is deprecated and returns only the most
//! recent events, whatever window a caller asks for. All historical analysis
//! goes through `POST /api/projects/@current/query/` with a HogQL query. The
//! `@current` alias is necessary, because a project-scoped personal API key
//! cannot list projects.

use std::{sync::OnceLock, time::Duration};

use reqwest::Client;
use serde_json::{Value, json};

/// The `results` rows of a HogQL query. Each row is one array of columns.
pub(crate) type Rows = Vec<Value>;

fn client() -> &'static Client {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        Client::builder()
            .timeout(Duration::from_secs(60))
            .build()
            .expect("HTTP client")
    })
}

/// `getPostHogQueryConfig()`: the host and the personal API key. An empty
/// variable counts as missing.
fn config() -> Option<(String, String)> {
    let key = std::env::var("POSTHOG_PERSONAL_API_KEY")
        .ok()
        .filter(|value| !value.is_empty())?;
    let host = std::env::var("NEXT_PUBLIC_POSTHOG_HOST")
        .ok()
        .filter(|value| !value.is_empty())?;
    Some((host, key))
}

/// `escapeHogQLString()`: a backslash and a single quote get a backslash.
pub(crate) fn escape_string(value: &str) -> String {
    value.replace('\\', "\\\\").replace('\'', "\\'")
}

/// `parsePropertiesColumn()`: HogQL gives `events.properties` as a JSON
/// string. A string that is not JSON stays a string.
pub(crate) fn parse_properties(value: &Value) -> Value {
    match value {
        Value::String(text) => serde_json::from_str(text).unwrap_or_else(|_| value.clone()),
        other => other.clone(),
    }
}

/// `runHogQLQuery()`. The error is the message of the TypeScript error.
pub(crate) async fn run(query: &str) -> Result<Rows, String> {
    let (host, key) = config().ok_or_else(|| {
        "PostHog not configured (POSTHOG_PERSONAL_API_KEY, NEXT_PUBLIC_POSTHOG_HOST)".to_owned()
    })?;
    let response = client()
        .post(format!("{host}/api/projects/@current/query/"))
        .bearer_auth(key)
        .json(&json!({ "query": { "kind": "HogQLQuery", "query": query } }))
        .send()
        .await
        .map_err(|cause| cause.to_string())?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        let snippet: String = body.chars().take(500).collect();
        let snippet = if snippet.is_empty() {
            String::new()
        } else {
            format!(" {snippet}")
        };
        return Err(format!(
            "PostHog API error: {} {}{snippet}",
            status.as_u16(),
            status.canonical_reason().unwrap_or_default()
        ));
    }
    let data: Value = response.json().await.map_err(|cause| cause.to_string())?;
    Ok(match data.get("results") {
        Some(Value::Array(rows)) => rows.clone(),
        _ => Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escape_and_properties_match_the_typescript_helpers() {
        assert_eq!(escape_string(r"a\b'c"), r"a\\b\'c");
        assert_eq!(
            parse_properties(&json!(r#"{"path":"/b/1"}"#)),
            json!({"path": "/b/1"})
        );
        assert_eq!(parse_properties(&json!("not json")), json!("not json"));
        assert_eq!(parse_properties(&json!({"a": 1})), json!({"a": 1}));
    }
}
