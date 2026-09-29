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
use std::{fmt, time::Duration};

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
    /// The requests run at the same time. A failure goes into the errors for
    /// its symbol and does not stop the batch. Both lists keep the input
    /// order.
    pub(crate) async fn fetch_latest_prices(
        &self,
        symbols: &[Value],
    ) -> Result<(Vec<LatestPrice>, Vec<SymbolError>), NotConfigured> {
        let key = self.key.as_deref().ok_or(NotConfigured)?;
        let tasks: Vec<_> = symbols
            .iter()
            .map(|symbol| {
                // The symbol goes into the URL as JavaScript writes it, with
                // no encoding. URL parsing then encodes it as `fetch` does.
                let url = format!(
                    "{}/tiingo/daily/{}/prices?token={key}",
                    self.base_url,
                    js_string(symbol)
                );
                let client = self.client.clone();
                let symbol = symbol.clone();
                tokio::spawn(async move { fetch_symbol(&client, &url, &symbol).await })
            })
            .collect();
        let mut prices = Vec::new();
        let mut errors = Vec::new();
        for (task, symbol) in tasks.into_iter().zip(symbols) {
            match task.await {
                Ok(Ok(price)) => prices.push(price),
                Ok(Err(error)) => errors.push(SymbolError {
                    symbol: js_json(symbol),
                    error,
                }),
                Err(_) => errors.push(SymbolError {
                    symbol: js_json(symbol),
                    error: "Unknown error".to_owned(),
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
async fn fetch_symbol(client: &Client, url: &str, symbol: &Value) -> Result<LatestPrice, String> {
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
        return Err(format!("Failed to fetch price for {text}: {reason}"));
    }
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
    async fn needs_a_key_and_reports_a_network_failure_as_fetch_does() {
        let unset = Tiingo::new(Some(String::new()), None);
        assert!(!unset.is_configured());
        assert!(unset.fetch_latest_prices(&[json!("VTI")]).await.is_err());

        // Nothing listens on the discard port of the loopback address.
        let tiingo = Tiingo::new(Some("key".into()), Some("http://127.0.0.1:9".into()));
        let (prices, errors) = tiingo.fetch_latest_prices(&[json!("VTI")]).await.unwrap();
        assert!(prices.is_empty());
        assert_eq!(
            errors,
            vec![SymbolError {
                symbol: json!("VTI"),
                error: "fetch failed".into()
            }]
        );
    }
}
