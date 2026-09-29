//! The investment tools. Both give amounts in
//! dollars and shares in whole units, as JavaScript doubles.

use axum::http::Method;
use ledger_core::formatters::to_fixed_2_js;
use rmcp::model::CallToolResult;
use serde_json::{Map, Value, json};

use crate::{
    mcp::call::{Caller, Level, ToolResult, integer, js_double, ok, thrown},
    routes::realized_gains::{Filters, report},
};

const MICROS: f64 = 1_000_000.0;

fn micros(value: i64) -> Value {
    js_double(value as f64 / MICROS)
}

fn cents(value: i64) -> Value {
    js_double(value as f64 / 100.0)
}

fn nullable(value: &Value, scale: fn(i64) -> Value) -> Value {
    value.as_i64().map_or(Value::Null, scale)
}

/// The positions of `getPositions()`, from the positions route, in dollars.
/// With `includeAccountValues`, the market value of each account too.
pub(super) async fn positions(
    caller: &Caller,
    arguments: &Map<String, Value>,
) -> ToolResult<CallToolResult> {
    let book_id = integer(arguments, "bookId");
    caller.book(book_id, Level::Read).await?;
    let account_id = arguments.get("accountId").and_then(Value::as_i64);
    let path = match account_id {
        Some(account_id) => {
            format!("/api/b/{book_id}/investments/positions?accountId={account_id}")
        }
        None => format!("/api/b/{book_id}/investments/positions"),
    };
    let rows = caller.request(Method::GET, &path, None).await?;
    let positions: Vec<Value> = rows
        .as_array()
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .map(|row| {
            let cost_cents = row["costBasisCents"].as_i64().unwrap_or(0);
            let cost = cost_cents as f64 / 100.0;
            let market_cents = row["marketValueCents"].as_i64();
            let gain = market_cents.map(|market| (market - cost_cents) as f64 / 100.0);
            let percent = match gain {
                Some(gain) if cost != 0.0 => format!("{}%", to_fixed_2_js(gain / cost * 100.0)),
                _ => "N/A".to_owned(),
            };
            json!({
                "securityId": row["securityId"],
                "securityName": row["securityName"],
                "securitySymbol": row["securitySymbol"],
                "shares": micros(row["sharesMicros"].as_i64().unwrap_or(0)),
                "costBasis": js_double(cost),
                "currentPrice": nullable(&row["priceMicros"], micros),
                "priceDate": row["priceDate"],
                "marketValue": nullable(&row["marketValueCents"], cents),
                "gainLoss": gain.map_or(Value::Null, js_double),
                "gainLossPercent": percent,
            })
        })
        .collect();

    let mut result = Map::new();
    result.insert("positions".to_owned(), Value::Array(positions));
    if arguments
        .get("includeAccountValues")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        let values = caller
            .request(
                Method::GET,
                &format!("/api/b/{book_id}/investments/account-values"),
                None,
            )
            .await?;
        let values: Vec<Value> = values
            .as_array()
            .map_or(&[][..], Vec::as_slice)
            .iter()
            .filter(|value| account_id.is_none() || value["accountId"].as_i64() == account_id)
            .map(|value| {
                json!({
                    "accountId": value["accountId"],
                    "marketValue": cents(value["marketValueCents"].as_i64().unwrap_or(0)),
                })
            })
            .collect();
        result.insert("accountValues".to_owned(), Value::Array(values));
    }
    Ok(ok(&Value::Object(result)))
}

/// The route requires both dates or neither. The tool takes either one
/// alone, so it calls the shared report directly.
pub(super) async fn realized_gains(
    caller: &Caller,
    arguments: &Map<String, Value>,
) -> ToolResult<CallToolResult> {
    let book_id = integer(arguments, "bookId");
    caller.book(book_id, Level::Read).await?;
    let book = i32::try_from(book_id).map_err(|cause| thrown(&cause.to_string()))?;
    let text = |key: &str| {
        arguments
            .get(key)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    };
    let account_id = arguments.get("accountId").and_then(Value::as_i64);
    let filters = Filters {
        start_date: text("startDate"),
        end_date: text("endDate"),
        account_id: account_id.map(|id| id as f64),
    };
    // PostgreSQL refuses an ID outside the int4 range, as it does for Node.
    let account_id = account_id
        .map(|id| {
            i32::try_from(id).map_err(|_| Box::new(thrown("value out of range for type integer")))
        })
        .transpose()?;
    let result = report(&caller.state().pool, book, &filters, account_id)
        .await
        .map_err(|cause| thrown(&cause.to_string()))?;
    let disposals: Vec<Value> = result["rows"]
        .as_array()
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .map(|row| {
            json!({
                "sellDate": row["sellDate"],
                "security": row["securitySymbol"],
                "account": row["accountName"],
                "shares": micros(row["sharesMicros"].as_i64().unwrap_or(0)),
                "acquired": row["acquiredDate"],
                "proceeds": cents(row["proceedsCents"].as_i64().unwrap_or(0)),
                "costBasis": nullable(&row["basisCents"], cents),
                "gainLoss": nullable(&row["gainCents"], cents),
                "term": row["term"],
            })
        })
        .collect();
    let totals = &result["totals"];
    let total = |key: &str| cents(totals[key].as_i64().unwrap_or(0));
    Ok(ok(&json!({
        "disposals": disposals,
        "totals": {
            "shortTermGain": total("shortTermGainCents"),
            "longTermGain": total("longTermGainCents"),
            "proceeds": total("proceedsCents"),
            "costBasis": total("basisCents"),
            "unknownBasisDisposals": totals["unknownBasisRows"],
        },
    })))
}
