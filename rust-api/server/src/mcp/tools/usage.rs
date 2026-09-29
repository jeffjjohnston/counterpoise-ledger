//! The usage tool. It has no route: it queries the
//! PostHog project of this server.

use chrono::{Duration, Utc};
use rmcp::model::CallToolResult;
use serde_json::{Map, Value, json};

use crate::{
    mcp::call::{Caller, ToolResult, ok, thrown},
    posthog_query::{escape_string, parse_properties, run},
    validation::{js_number, parse_js_number},
};

/// `String(value)` for a HogQL column.
fn js_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => "null".to_owned(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number_text(js_number(number)),
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => js_string(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

fn number_text(value: f64) -> String {
    if value.is_finite() && value.fract() == 0.0 && value.abs() < 1e21 {
        format!("{value:.0}")
    } else {
        value.to_string()
    }
}

/// `Number(value)` for a HogQL column.
fn js_numeric(value: &Value) -> f64 {
    match value {
        Value::Number(number) => js_number(number),
        Value::String(text) => parse_js_number(text).unwrap_or(f64::NAN),
        Value::Bool(flag) => f64::from(u8::from(*flag)),
        Value::Null => 0.0,
        Value::Array(items) if items.is_empty() => 0.0,
        Value::Array(items) if items.len() == 1 => js_numeric(&items[0]),
        _ => f64::NAN,
    }
}

/// A number as `JSON.stringify` writes it: an integer without a fraction, and
/// `null` for NaN or an infinity.
fn json_number(value: f64) -> Value {
    if !value.is_finite() {
        Value::Null
    } else if value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        json!(value as i64)
    } else {
        json!(value)
    }
}

fn column(row: &Value, index: usize) -> &Value {
    row.get(index).unwrap_or(&Value::Null)
}

pub(super) async fn analyze(
    caller: &Caller,
    arguments: &Map<String, Value>,
) -> ToolResult<CallToolResult> {
    let user_id = caller.user().await?;
    // The schema default is 7. The JSON Schema validator does not apply it.
    let days = arguments.get("days").and_then(Value::as_f64).unwrap_or(7.0);
    let lookback = days.floor().clamp(1.0, 90.0) as i64;
    let after = (Utc::now() - Duration::milliseconds(lookback * 86_400_000))
        .format("%Y-%m-%d")
        .to_string();

    let event_filter = arguments
        .get("eventType")
        .and_then(Value::as_str)
        .filter(|event| !event.is_empty())
        .map(|event| format!(" AND event = '{}'", escape_string(event)))
        .unwrap_or_default();
    // Each event has distinct_id String(userId), so this filter keeps the
    // events of other users out of the result.
    let user_filter = format!(
        " AND distinct_id = '{}'",
        escape_string(&user_id.to_string())
    );
    let filter = format!("timestamp > now() - INTERVAL {lookback} DAY{user_filter}{event_filter}");

    let counts_query = format!(
        "SELECT event, count() FROM events WHERE {filter} GROUP BY event ORDER BY count() DESC"
    );
    let recent_query = format!(
        "SELECT event, timestamp, properties FROM events WHERE {filter} ORDER BY timestamp DESC LIMIT 20"
    );
    let (counts, recent) = tokio::try_join!(run(&counts_query), run(&recent_query))
        .map_err(|message| thrown(&message))?;

    let counts: Vec<(String, f64)> = counts
        .iter()
        .map(|row| (js_string(column(row, 0)), js_numeric(column(row, 1))))
        .collect();
    let total: f64 = counts.iter().map(|(_, count)| count).sum();
    let summary = json!({
        "totalEvents": json_number(total),
        "period": format!("last {lookback} days (since {after})"),
        "eventCounts": counts
            .iter()
            .map(|(event, count)| json!({ "event": event, "count": json_number(*count) }))
            .collect::<Vec<_>>(),
        "recentEvents": recent
            .iter()
            .map(|row| {
                json!({
                    "event": js_string(column(row, 0)),
                    "timestamp": js_string(column(row, 1)),
                    "properties": parse_properties(column(row, 2)),
                })
            })
            .collect::<Vec<_>>(),
    });
    Ok(ok(&summary))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn columns_convert_as_javascript_does() {
        assert_eq!(js_string(&json!("$pageview")), "$pageview");
        assert_eq!(js_string(&json!(3)), "3");
        assert_eq!(js_string(&json!(1.5)), "1.5");
        assert_eq!(js_string(&Value::Null), "null");
        assert_eq!(js_numeric(&json!(3)), 3.0);
        assert_eq!(js_numeric(&json!("4")), 4.0);
        assert!(js_numeric(&json!("x")).is_nan());
        assert_eq!(json_number(3.0), json!(3));
        assert_eq!(json_number(f64::NAN), Value::Null);
    }
}
