use reqwest::Client;
use serde_json::{Value, json};
use std::time::Duration;

#[derive(Clone)]
pub(crate) struct PostHogCapture {
    client: Client,
    key: Option<String>,
    endpoint: String,
}

impl PostHogCapture {
    pub(crate) fn from_env() -> Self {
        Self::new(
            std::env::var("NEXT_PUBLIC_POSTHOG_KEY").ok(),
            std::env::var("NEXT_PUBLIC_POSTHOG_HOST").ok(),
        )
    }

    pub(crate) fn new(key: Option<String>, host: Option<String>) -> Self {
        let host = host
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "https://us.i.posthog.com".to_owned());
        Self {
            client: Client::builder()
                .timeout(Duration::from_secs(10))
                .build()
                .expect("HTTP client"),
            key: key.filter(|value| !value.is_empty()),
            endpoint: format!("{}/batch/", host.trim_end_matches('/')),
        }
    }

    async fn send_event(
        &self,
        user_id: i32,
        event: &str,
        properties: Option<Value>,
    ) -> Result<(), reqwest::Error> {
        let Some(key) = &self.key else { return Ok(()) };
        let response = self
            .client
            .post(&self.endpoint)
            .json(&json!({
                "api_key": key,
                "batch": [{
                    "distinct_id": user_id.to_string(),
                    "event": event,
                    "properties": properties.unwrap_or_else(|| json!({})),
                }],
            }))
            .send()
            .await?;
        response.error_for_status()?;
        Ok(())
    }

    /// Fire and forget. An analytics outage never changes an accounting
    /// route's response. A route that runs for an MCP tool records nothing
    /// (see `mcp::in_tool_call()`).
    pub(crate) fn capture_event(
        &self,
        user_id: i32,
        event: &'static str,
        properties: Option<Value>,
    ) {
        if self.key.is_none() || crate::mcp::in_tool_call() {
            return;
        }
        let capture = self.clone();
        tokio::spawn(async move {
            if let Err(cause) = capture.send_event(user_id, event, properties).await {
                tracing::warn!(error = %cause, "PostHog capture failed");
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Json, Router, routing::post};
    use tokio::sync::oneshot;

    #[tokio::test]
    async fn capture_uses_node_event_identity_and_properties() {
        let (tx, rx) = oneshot::channel();
        let sender = std::sync::Arc::new(std::sync::Mutex::new(Some(tx)));
        let app = Router::new().route(
            "/batch/",
            post({
                let sender = sender.clone();
                move |Json(body): Json<Value>| {
                    let sender = sender.clone();
                    async move {
                        sender.lock().unwrap().take().unwrap().send(body).unwrap();
                        axum::http::StatusCode::OK
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let host = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(axum::serve(listener, app).into_future());
        let capture = PostHogCapture::new(Some("project-key".into()), Some(host));
        capture
            .send_event(
                42,
                "account_created",
                Some(json!({"bookId": 7, "type": "asset"})),
            )
            .await
            .unwrap();
        assert_eq!(
            rx.await.unwrap(),
            json!({
                "api_key": "project-key",
                "batch": [{"distinct_id": "42", "event": "account_created", "properties": {"bookId": 7, "type": "asset"}}],
            })
        );
        server.abort();
    }

    #[tokio::test]
    async fn absent_key_is_a_no_op() {
        let capture = PostHogCapture::new(None, None);
        capture
            .send_event(42, "account_created", None)
            .await
            .unwrap();
    }
}
