//! Tiingo end-of-day prices. The manual
//! Update Prices route and the price-sync cron use this module.
//!
//! Each failure message is the one the Node function reports. A TypeError in
//! Node names a variable, which the Next build minifies. This module uses the
//! names in the TypeScript source. A body that is not JSON gets a different
//! message from the Node SyntaxError.

use crate::validation::{from_json_bytes, js_json, js_string};
use reqwest::Client;
use serde::Serialize;
use serde_json::Value;
use std::{
    fmt,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::sync::Semaphore;

const DEFAULT_BASE_URL: &str = "https://api.tiingo.com";

/// The key is not set, so no request can go to Tiingo.
#[derive(Debug)]
pub(crate) struct NotConfigured;

impl fmt::Display for NotConfigured {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("TIINGO_API_KEY environment variable not configured")
    }
}

#[derive(Clone)]
pub(crate) struct Tiingo {
    client: Client,
    key: Option<String>,
    base_url: String,
}

#[derive(Debug, PartialEq, Serialize)]
pub(crate) struct LatestPrice {
    pub(crate) symbol: String,
    /// The `adjClose` value as Tiingo sent it. An infinity stays an
    /// infinity here, because the price-sync cron calculates with it. It is
    /// written as `JSON.stringify` writes it: an infinity is null, and an
    /// undefined property is not written.
    #[serde(
        skip_serializing_if = "Option::is_none",
        serialize_with = "serialize_js_json"
    )]
    pub(crate) price: Option<Value>,
    pub(crate) date: String,
}

fn serialize_js_json<S: serde::Serializer>(
    value: &Option<Value>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    value.as_ref().map(js_json).serialize(serializer)
}

#[derive(Debug, PartialEq, Serialize)]
pub(crate) struct SymbolError {
    /// The symbol as the caller sent it, which need not be a string. An
    /// infinity is null, as `JSON.stringify` writes it.
    pub(crate) symbol: Value,
    pub(crate) error: String,
    /// The response does not include it.
    #[serde(skip)]
    pub(crate) kind: FailureKind,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum FailureKind {
    /// Tiingo answered 404: it has no ticker of this name.
    NotFound,
    /// Tiingo answered 429: the hourly or daily request limit is used up.
    RateLimited,
    /// No request was sent, because Tiingo answered 429 before.
    NotSent,
    Other,
}

/// The failure of one symbol, before the symbol is attached.
struct Failure {
    error: String,
    kind: FailureKind,
}

impl From<String> for Failure {
    fn from(error: String) -> Self {
        Self {
            error,
            kind: FailureKind::Other,
        }
    }
}

impl Tiingo {
    pub(crate) fn from_env() -> Self {
        Self::new(
            std::env::var("TIINGO_API_KEY").ok(),
            std::env::var("TIINGO_API_URL").ok(),
        )
    }

    /// `TIINGO_API_URL` replaces the Tiingo origin. The HTTP parity tests
    /// point it at a local mock.
    pub(crate) fn new(key: Option<String>, base_url: Option<String>) -> Self {
        Self {
            // Node's fetch has no deadline of its own. This one stops a
            // stalled request from holding the route open.
            client: Client::builder()
                .timeout(Duration::from_secs(60))
                .build()
                .expect("HTTP client"),
            key: key.filter(|key| !key.is_empty()),
            base_url: base_url
                .filter(|url| !url.is_empty())
                .unwrap_or_else(|| DEFAULT_BASE_URL.to_owned()),
        }
    }

    pub(crate) fn is_configured(&self) -> bool {
        self.key.is_some()
    }

    /// `fetchLatestTiingoPrices`: the newest adjusted close of each symbol.
    /// At most `concurrency` requests run at the same time, in the input
    /// order. A failure goes into the errors for its symbol and does not stop
    /// the batch, except a 429: each request counts against the Tiingo limit,
    /// so no request starts after one. The symbols not sent get a `NotSent`
    /// error. Both lists keep the input order.
    pub(crate) async fn fetch_latest_prices(
        &self,
        symbols: &[Value],
        concurrency: usize,
    ) -> Result<(Vec<LatestPrice>, Vec<SymbolError>), NotConfigured> {
        let key = self.key.as_deref().ok_or(NotConfigured)?;
        // This loop takes each permit before it starts the request, so the
        // requests start in the input order. A task that gets a 429 sets
        // `limited` before it gives its permit back, so the loop sees it
        // before the next request starts.
        let permits = Arc::new(Semaphore::new(concurrency.max(1)));
        let limited = Arc::new(AtomicBool::new(false));
        let mut tasks = Vec::with_capacity(symbols.len());
        for symbol in symbols {
            let permit = permits
                .clone()
                .acquire_owned()
                .await
                .expect("the semaphore is never closed");
            if limited.load(Ordering::SeqCst) {
                tasks.push(None);
                continue;
            }
            // The symbol goes into the URL as JavaScript writes it, with no
            // encoding. URL parsing then encodes it as `fetch` does.
            let url = format!(
                "{}/tiingo/daily/{}/prices?token={key}",
                self.base_url,
                js_string(symbol)
            );
            let client = self.client.clone();
            let symbol = symbol.clone();
            let limited = limited.clone();
            tasks.push(Some(tokio::spawn(async move {
                let result = fetch_symbol(&client, &url, &symbol).await;
                if matches!(&result, Err(failure) if failure.kind == FailureKind::RateLimited) {
                    limited.store(true, Ordering::SeqCst);
                }
                drop(permit);
                result
            })));
        }
        let mut prices = Vec::new();
        let mut errors = Vec::new();
        for (task, symbol) in tasks.into_iter().zip(symbols) {
            let outcome = match task {
                Some(task) => task.await,
                None => Ok(Err(Failure {
                    error: "Not fetched: the Tiingo request limit was reached".to_owned(),
                    kind: FailureKind::NotSent,
                })),
            };
            match outcome {
                Ok(Ok(price)) => prices.push(price),
                Ok(Err(failure)) => errors.push(SymbolError {
                    symbol: js_json(symbol),
                    error: failure.error,
                    kind: failure.kind,
                }),
                Err(_) => errors.push(SymbolError {
                    symbol: js_json(symbol),
                    error: "Unknown error".to_owned(),
                    kind: FailureKind::Other,
                }),
            }
        }
        Ok((prices, errors))
    }
}

/// JavaScript truthiness of a parsed JSON value.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(number) => number.as_f64() != Some(0.0),
        Value::String(value) => !value.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `data.length === 0`. Only an array, a string, and an object with a
/// `length` property have a length.
fn has_zero_length(value: &Value) -> bool {
    match value {
        Value::Array(items) => items.is_empty(),
        Value::String(text) => text.is_empty(),
        Value::Object(object) => object
            .get("length")
            .and_then(Value::as_f64)
            .is_some_and(|length| length == 0.0),
        _ => false,
    }
}

/// `data[0]`. `None` is undefined.
fn first_element(value: &Value) -> Option<Value> {
    match value {
        Value::Array(items) => items.first().cloned(),
        Value::String(text) => text.chars().next().map(|first| Value::String(first.into())),
        Value::Object(object) => object.get("0").cloned(),
        _ => None,
    }
}

/// `value.<property>`, which only an object has here. `None` is undefined.
fn property(value: &Value, name: &str) -> Option<Value> {
    value
        .as_object()
        .and_then(|object| object.get(name))
        .cloned()
}

/// The V8 TypeError for a property read on null or undefined.
fn unreadable(value: Option<&Value>, name: &str) -> String {
    let base = if value.is_some() { "null" } else { "undefined" };
    format!("Cannot read properties of {base} (reading '{name}')")
}

/// The body of the async callback in `fetchLatestTiingoPrices`, in its
/// order of evaluation.
async fn fetch_symbol(client: &Client, url: &str, symbol: &Value) -> Result<LatestPrice, Failure> {
    let text = js_string(symbol);
    // `fetch` rejects every network failure with this message.
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|_| "fetch failed".to_owned())?;
    let status = response.status();
    if !status.is_success() {
        // `statusText` is the phrase on the status line, as the server sent it.
        let reason = response
            .extensions()
            .get::<hyper::ext::ReasonPhrase>()
            .map(|reason| String::from_utf8_lossy(reason.as_bytes()).into_owned())
            .or_else(|| status.canonical_reason().map(str::to_owned))
            .unwrap_or_default();
        return Err(Failure {
            error: format!("Failed to fetch price for {text}: {reason}"),
            kind: match status {
                reqwest::StatusCode::NOT_FOUND => FailureKind::NotFound,
                reqwest::StatusCode::TOO_MANY_REQUESTS => FailureKind::RateLimited,
                _ => FailureKind::Other,
            },
        });
    }
    Ok(latest_price(response, symbol).await?)
}

/// The newest price in a successful response.
async fn latest_price(response: reqwest::Response, symbol: &Value) -> Result<LatestPrice, String> {
    let text = js_string(symbol);
    let body = response
        .bytes()
        .await
        .map_err(|_| "fetch failed".to_owned())?;
    let data: Value = from_json_bytes(&body)
        .map_err(|cause| format!("Tiingo sent a body that is not JSON for {text}: {cause}"))?;
    if !truthy(&data) || has_zero_length(&data) {
        return Err(format!("No price data available for {text}"));
    }
    let latest = first_element(&data);
    let symbol = match symbol {
        Value::String(symbol) => symbol.to_uppercase(),
        Value::Null => return Err(unreadable(Some(symbol), "toUpperCase")),
        _ => return Err("symbol.toUpperCase is not a function".to_owned()),
    };
    let latest = match latest {
        Some(Value::Null) | None => return Err(unreadable(latest.as_ref(), "adjClose")),
        Some(latest) => latest,
    };
    let date = match property(&latest, "date") {
        Some(Value::String(date)) => date.split('T').next().unwrap_or_default().to_owned(),
        date @ (Some(Value::Null) | None) => return Err(unreadable(date.as_ref(), "split")),
        Some(_) => return Err("latestPrice.date.split is not a function".to_owned()),
    };
    Ok(LatestPrice {
        symbol,
        price: property(&latest, "adjClose"),
        date,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn javascript_checks_on_the_response_body() {
        for value in [json!(null), json!(false), json!(0), json!(""), json!([])] {
            assert!(!truthy(&value) || has_zero_length(&value), "{value}");
        }
        assert!(has_zero_length(&json!({ "length": 0 })));
        assert!(!has_zero_length(&json!({ "length": "0" })));
        assert_eq!(first_element(&json!("abc")), Some(json!("a")));
        assert_eq!(first_element(&json!({ "0": 7 })), Some(json!(7)));
        assert_eq!(first_element(&json!(5)), None);
        assert_eq!(
            unreadable(None, "adjClose"),
            "Cannot read properties of undefined (reading 'adjClose')"
        );
    }

    #[tokio::test]
    async fn starts_no_request_after_a_429() {
        use axum::{Router, extract::Path, http::StatusCode, response::IntoResponse, routing::get};
        use std::sync::Mutex;

        let requests = Arc::new(Mutex::new(Vec::new()));
        let seen = requests.clone();
        let app = Router::new().route(
            "/tiingo/daily/{symbol}/prices",
            get(move |Path(symbol): Path<String>| {
                let seen = seen.clone();
                async move {
                    seen.lock().unwrap().push(symbol.clone());
                    match symbol.as_str() {
                        "LIMITED" => StatusCode::TOO_MANY_REQUESTS.into_response(),
                        // Still running when the 429 comes back.
                        _ => {
                            tokio::time::sleep(Duration::from_millis(300)).await;
                            axum::Json(json!([{ "date": "2026-07-02", "adjClose": 1 }]))
                                .into_response()
                        }
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let host = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(axum::serve(listener, app).into_future());

        let tiingo = Tiingo::new(Some("key".into()), Some(host));
        let symbols = [
            json!("LIMITED"),
            json!("SLOW"),
            json!("LATER"),
            json!("LAST"),
        ];
        let (prices, errors) = tiingo.fetch_latest_prices(&symbols, 2).await.unwrap();
        server.abort();

        // Two requests start at once. The third waits for a permit, and the
        // 429 gives one back first.
        let mut requested = requests.lock().unwrap().clone();
        requested.sort();
        assert_eq!(requested, ["LIMITED", "SLOW"]);
        assert_eq!(prices.len(), 1);
        let kinds: Vec<_> = errors.iter().map(|error| error.kind).collect();
        assert_eq!(
            kinds,
            [
                FailureKind::RateLimited,
                FailureKind::NotSent,
                FailureKind::NotSent
            ]
        );
        assert_eq!(
            errors[1].error,
            "Not fetched: the Tiingo request limit was reached"
        );
    }

    #[tokio::test]
    async fn needs_a_key_and_reports_a_network_failure_as_fetch_does() {
        let unset = Tiingo::new(Some(String::new()), None);
        assert!(!unset.is_configured());
        assert!(unset.fetch_latest_prices(&[json!("VTI")], 1).await.is_err());

        // Nothing listens on the discard port of the loopback address.
        let tiingo = Tiingo::new(Some("key".into()), Some("http://127.0.0.1:9".into()));
        let (prices, errors) = tiingo
            .fetch_latest_prices(&[json!("VTI")], 1)
            .await
            .unwrap();
        assert!(prices.is_empty());
        assert_eq!(
            errors,
            vec![SymbolError {
                symbol: json!("VTI"),
                error: "fetch failed".into(),
                kind: FailureKind::Other,
            }]
        );
    }
}
