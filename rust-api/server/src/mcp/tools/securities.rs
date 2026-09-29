//! The security tools.

use std::collections::HashMap;

use axum::http::{Method, StatusCode};
use rmcp::model::CallToolResult;
use serde_json::{Map, Value, json};

use crate::{
    mcp::call::{
        Caller, Level, ToolResult, fail, integer, js_double, ok, outcome, thrown, without,
    },
    routes::{investments::EFFECTIVE_DATE, securities::clashing_symbol},
    validation::is_js_whitespace,
};

const MICROS: f64 = 1_000_000.0;

fn securities_path(book_id: i64) -> String {
    format!("/api/b/{book_id}/securities")
}

/// The library names the ID in its not-found message, and the route does
/// not. A 404 of the security routes gives the library's message.
fn not_found(security_id: i64) -> Box<CallToolResult> {
    fail(&format!("Security {security_id} not found")).into()
}

pub(super) async fn create(
    caller: &Caller,
    arguments: &Map<String, Value>,
) -> ToolResult<CallToolResult> {
    let book_id = integer(arguments, "bookId");
    caller.book(book_id, Level::Write).await?;
    Ok(ok(&caller
        .request(
            Method::POST,
            &securities_path(book_id),
            Some(&without(arguments, &["bookId"])),
        )
        .await?))
}

pub(super) async fn list(
    caller: &Caller,
    arguments: &Map<String, Value>,
) -> ToolResult<CallToolResult> {
    let book_id = integer(arguments, "bookId");
    caller.book(book_id, Level::Read).await?;
    Ok(ok(&caller
        .request(Method::GET, &securities_path(book_id), None)
        .await?))
}

/// The route answers a symbol that another security in the book has with
/// its 500 message. The tool gives the text of `SecurityDuplicateError` as a
/// thrown error.
pub(super) async fn update(
    caller: &Caller,
    arguments: &Map<String, Value>,
) -> ToolResult<CallToolResult> {
    let book_id = integer(arguments, "bookId");
    let security_id = integer(arguments, "securityId");
    caller.book(book_id, Level::Write).await?;
    let (status, body) = caller
        .send(
            Method::PUT,
            &format!("{}/{security_id}", securities_path(book_id)),
            Some(&without(arguments, &["bookId", "securityId"])),
        )
        .await?;
    if status == StatusCode::NOT_FOUND {
        return Err(not_found(security_id));
    }
    if status == StatusCode::INTERNAL_SERVER_ERROR
        && let Some(symbol) = arguments.get("symbol").and_then(Value::as_str)
        && let (Ok(book), Ok(security)) = (i32::try_from(book_id), i32::try_from(security_id))
    {
        let symbol = symbol.trim_matches(is_js_whitespace);
        if let Some(existing) = clashing_symbol(&caller.state().pool, book, security, symbol)
            .await
            .map_err(db_error)?
        {
            return Err(thrown(&format!(
                "A security with symbol \"{symbol}\" already exists (id {existing})"
            ))
            .into());
        }
    }
    Ok(ok(&outcome(status, body)?))
}

pub(super) async fn delete(
    caller: &Caller,
    arguments: &Map<String, Value>,
) -> ToolResult<CallToolResult> {
    let book_id = integer(arguments, "bookId");
    let security_id = integer(arguments, "securityId");
    caller.book(book_id, Level::Write).await?;
    let (status, body) = caller
        .send(
            Method::DELETE,
            &format!("{}/{security_id}", securities_path(book_id)),
            None,
        )
        .await?;
    if status == StatusCode::NOT_FOUND {
        return Err(not_found(security_id));
    }
    outcome(status, body)?;
    Ok(ok(&json!({ "success": true })))
}

fn db_error(cause: sqlx::Error) -> Box<CallToolResult> {
    thrown(&cause.to_string()).into()
}

fn micros(value: i64) -> Value {
    js_double(value as f64 / MICROS)
}

fn cents(value: i64) -> Value {
    js_double(value as f64 / 100.0)
}

/// The security, its position, a page of its prices, every investment split
/// with the cash of each dividend and capital gain, and on request its open
/// lots. No one route gives this, so the tool reads the rows itself. The
/// position comes from the positions route.
pub(super) async fn detail(
    caller: &Caller,
    arguments: &Map<String, Value>,
) -> ToolResult<CallToolResult> {
    let book_id = integer(arguments, "bookId");
    let security_id = integer(arguments, "securityId");
    caller.book(book_id, Level::Read).await?;
    // The schema defaults. The JSON Schema validator does not apply them.
    let price_limit = arguments
        .get("priceLimit")
        .and_then(Value::as_i64)
        .unwrap_or(50);
    let price_offset = arguments
        .get("priceOffset")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let include_lots = arguments
        .get("includeLots")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let Some(security) = caller
        .find(&format!("{}/{security_id}", securities_path(book_id)))
        .await?
    else {
        return Err(fail(&format!("Security with id {security_id} not found")).into());
    };
    // The security route found it in this book, so both IDs fit in int4.
    let book = i32::try_from(book_id).map_err(|cause| thrown(&cause.to_string()))?;
    let security_key = i32::try_from(security_id).map_err(|cause| thrown(&cause.to_string()))?;
    let pool = &caller.state().pool;

    let prices: Vec<(String, i64)> = sqlx::query_as(
        "SELECT price_date, price_micros FROM security_prices WHERE security_id = $1
         ORDER BY price_date DESC LIMIT $2 OFFSET $3",
    )
    .bind(security_key)
    .bind(price_limit)
    .bind(price_offset)
    .fetch_all(pool)
    .await
    .map_err(db_error)?;
    let recent_prices: Vec<Value> = prices
        .into_iter()
        .map(|(date, price)| json!({ "date": date, "price": micros(price) }))
        .collect();

    type SplitRow = (
        String,
        Option<String>,
        String,
        i64,
        i64,
        i32,
        Option<i32>,
        Option<i32>,
        Option<String>,
        i32,
    );
    let splits: Vec<SplitRow> = sqlx::query_as(&format!(
        "SELECT {EFFECTIVE_DATE} AS date, t.description, s.action, s.shares_micros,
                s.price_micros, s.fees_cents, s.split_numerator, s.split_denominator,
                a.name, s.transaction_id
         FROM investment_splits s
         JOIN transactions t ON t.id = s.transaction_id
         LEFT JOIN accounts a ON a.id = s.account_id
         WHERE s.security_id = $1
         ORDER BY {EFFECTIVE_DATE} DESC"
    ))
    .bind(security_key)
    .fetch_all(pool)
    .await
    .map_err(db_error)?;

    let is_income = |action: &str| action == "dividend" || action == "capGain";
    let income_ids: Vec<i32> = splits
        .iter()
        .filter(|split| is_income(&split.2))
        .map(|split| split.9)
        .collect();
    let mut cash: HashMap<i32, i64> = HashMap::new();
    if !income_ids.is_empty() {
        let rows: Vec<(i32, i32)> = sqlx::query_as(
            "SELECT ts.transaction_id, ts.amount FROM transaction_splits ts
             JOIN accounts a ON a.id = ts.account_id
             WHERE ts.transaction_id = ANY($1) AND a.type = 'asset'",
        )
        .bind(&income_ids)
        .fetch_all(pool)
        .await
        .map_err(db_error)?;
        for (transaction_id, amount) in rows {
            if amount > 0 {
                *cash.entry(transaction_id).or_default() += i64::from(amount);
            }
        }
    }
    let transactions: Vec<Value> = splits
        .into_iter()
        .map(
            |(
                date,
                description,
                action,
                shares,
                price,
                fees,
                numerator,
                denominator,
                account,
                transaction_id,
            )| {
                let cash_amount = if is_income(&action) {
                    cents(cash.get(&transaction_id).copied().unwrap_or(0))
                } else {
                    Value::Null
                };
                json!({
                    "date": date,
                    "description": description,
                    "action": action,
                    "shares": micros(shares),
                    "price": micros(price),
                    "fees": cents(i64::from(fees)),
                    "splitNumerator": numerator,
                    "splitDenominator": denominator,
                    "account": account,
                    "cashAmount": cash_amount,
                })
            },
        )
        .collect();

    let positions = caller
        .request(
            Method::GET,
            &format!("/api/b/{book_id}/investments/positions"),
            None,
        )
        .await?;
    let position = positions
        .as_array()
        .and_then(|rows| {
            rows.iter()
                .find(|row| row["securityId"].as_i64() == Some(security_id))
        })
        .map(|row| {
            let nullable =
                |key: &str, scale: fn(i64) -> Value| row[key].as_i64().map_or(Value::Null, scale);
            json!({
                "shares": micros(row["sharesMicros"].as_i64().unwrap_or(0)),
                "costBasis": cents(row["costBasisCents"].as_i64().unwrap_or(0)),
                "marketValue": nullable("marketValueCents", cents),
                "latestPrice": nullable("priceMicros", micros),
                "priceDate": row["priceDate"],
            })
        })
        .unwrap_or(Value::Null);

    let mut result = Map::new();
    result.insert("security".to_owned(), security);
    result.insert("position".to_owned(), position);
    result.insert("recentPrices".to_owned(), Value::Array(recent_prices));
    result.insert("transactions".to_owned(), Value::Array(transactions));
    if include_lots {
        let lots: Vec<(i32, i32, String, String, i64, i64)> = sqlx::query_as(
            "SELECT l.id, l.account_id, a.name, l.acquired_date, l.remaining_shares_micros,
                    CAST(l.remaining_basis_cents AS bigint)
             FROM investment_lots l JOIN accounts a ON a.id = l.account_id
             WHERE l.book_id = $1 AND l.security_id = $2 AND l.remaining_shares_micros > 0
             ORDER BY l.acquired_date ASC, l.id ASC",
        )
        .bind(book)
        .bind(security_key)
        .fetch_all(pool)
        .await
        .map_err(db_error)?;
        let lots: Vec<Value> = lots
            .into_iter()
            .map(
                |(lot_id, account_id, account_name, acquired, shares, basis)| {
                    json!({
                        "lotId": lot_id,
                        "accountId": account_id,
                        "accountName": account_name,
                        "acquiredDate": acquired,
                        "shares": micros(shares),
                        "costBasis": cents(basis),
                    })
                },
            )
            .collect();
        result.insert("lots".to_owned(), Value::Array(lots));
    }
    Ok(ok(&Value::Object(result)))
}
