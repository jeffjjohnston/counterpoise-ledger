//! The transaction tools: the register, search, and the writes.

use axum::http::{Method, StatusCode};
use rmcp::model::CallToolResult;
use serde_json::{Map, Value, json};

use crate::{
    mcp::call::{
        Caller, Level, ToolResult, fail, integer, invalid_arguments, ok, outcome, thrown,
        with_query, without,
    },
    routes::search::search_book,
    transaction_input::iso_datetime_millis,
    validation::local_today,
};

fn transactions_path(book_id: i64) -> String {
    format!("/api/b/{book_id}/transactions")
}

/// `expectedUpdatedAt` is `z.iso.datetime()` with a custom message for any
/// failure. It refuses an offset such as `+02:00`, which the JSON Schema
/// `date-time` format accepts, and the JSON Schema check words its failures
/// in its own text. `precheck()` runs this before that check.
pub(super) fn check_expected_updated_at(
    tool: &str,
    arguments: &Map<String, Value>,
) -> ToolResult<()> {
    match arguments.get("expectedUpdatedAt") {
        None => Ok(()),
        Some(Value::String(value)) if iso_datetime_millis(value).is_some() => Ok(()),
        Some(_) => Err(invalid_arguments(
            tool,
            &["expectedUpdatedAt: expectedUpdatedAt must be an ISO timestamp".to_owned()],
        )
        .into()),
    }
}

/// A page of the register, newest first, with the splits, the payee and the
/// investment splits of each transaction. The register route selects the
/// page and loads each transaction in full; the tool keeps the fields it
/// reports.
pub(super) async fn list(
    caller: &Caller,
    arguments: &Map<String, Value>,
) -> ToolResult<CallToolResult> {
    let book_id = integer(arguments, "bookId");
    caller.book(book_id, Level::Read).await?;
    // The schema defaults. The JSON Schema validator does not apply them.
    let limit = arguments.get("limit").and_then(Value::as_i64).unwrap_or(50);
    let offset = arguments.get("offset").and_then(Value::as_i64).unwrap_or(0);
    let mut query = Map::new();
    // accountIds takes precedence over accountId.
    match arguments.get("accountIds").and_then(Value::as_array) {
        Some(ids) => {
            let ids: Vec<String> = ids.iter().map(Value::to_string).collect();
            query.insert("accountIds".to_owned(), json!(ids.join(",")));
        }
        None => {
            if let Some(id) = arguments.get("accountId") {
                query.insert("accountId".to_owned(), id.clone());
            }
        }
    }
    for key in ["payeeId", "startDate", "endDate"] {
        if let Some(value) = arguments.get(key) {
            query.insert(key.to_owned(), value.clone());
        }
    }
    query.insert("limit".to_owned(), json!(limit));
    query.insert("offset".to_owned(), json!(offset));
    query.insert("includeMeta".to_owned(), json!("true"));
    let path = with_query(
        transactions_path(book_id),
        &query,
        &[
            "accountIds",
            "accountId",
            "payeeId",
            "startDate",
            "endDate",
            "limit",
            "offset",
            "includeMeta",
        ],
    );
    let page = caller.request(Method::GET, &path, None).await?;
    let today = local_today();
    let transactions: Vec<Value> = page["transactions"]
        .as_array()
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .map(|transaction| {
            let floating = transaction["isFloating"].as_bool().unwrap_or(false);
            let effective_date = if floating {
                json!(today)
            } else {
                transaction["date"].clone()
            };
            let payee = match &transaction["payee"] {
                Value::Object(payee) => json!({ "id": payee["id"], "name": payee["name"] }),
                _ => Value::Null,
            };
            let splits: Vec<Value> = transaction["splits"]
                .as_array()
                .map_or(&[][..], Vec::as_slice)
                .iter()
                .map(|split| {
                    json!({
                        "id": split["id"],
                        "accountId": split["accountId"],
                        "accountName": split["account"]["name"],
                        "accountType": split["account"]["type"],
                        "amount": split["amount"],
                    })
                })
                .collect();
            let investment: Vec<Value> = transaction["investmentSplits"]
                .as_array()
                .map_or(&[][..], Vec::as_slice)
                .iter()
                .map(|split| {
                    json!({
                        "id": split["id"],
                        "accountId": split["accountId"],
                        "securityId": split["securityId"],
                        "securitySymbol": split["security"]["symbol"],
                        "action": split["action"],
                        "sharesMicros": split["sharesMicros"],
                        "priceMicros": split["priceMicros"],
                        "feesCents": split["feesCents"],
                    })
                })
                .collect();
            let mut row = json!({
                "id": transaction["id"],
                "date": transaction["date"],
                "effectiveDate": effective_date,
                "isFloating": transaction["isFloating"],
                "description": transaction["description"],
                "notes": transaction["notes"],
                "checkNumber": transaction["checkNumber"],
                "isReconciled": transaction["isReconciled"],
                "payee": payee,
                "splits": splits,
            });
            // The key is left out when there are none.
            if !investment.is_empty() {
                row["investmentSplits"] = Value::Array(investment);
            }
            row
        })
        .collect();
    Ok(ok(&json!({
        "transactions": transactions,
        "totalCount": page["totalCount"],
        "limit": limit,
        "offset": offset,
    })))
}

/// The shared search, with the fields the tool reports. The search route
/// leaves out the notes and the active flag, so the tool calls the shared
/// search directly.
pub(super) async fn search(
    caller: &Caller,
    arguments: &Map<String, Value>,
) -> ToolResult<CallToolResult> {
    let book_id = integer(arguments, "bookId");
    caller.book(book_id, Level::Read).await?;
    let book = i32::try_from(book_id).map_err(|cause| thrown(&cause.to_string()))?;
    let text = |key: &str| arguments.get(key).and_then(Value::as_str);
    let results = search_book(
        &caller.state().pool,
        book,
        text("query").unwrap_or_default(),
        text("startDate"),
        text("endDate"),
    )
    .await
    .map_err(|cause| thrown(&cause.to_string()))?;
    let accounts = &results["accounts"];
    let items: Vec<Value> = accounts["items"]
        .as_array()
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .map(|account| {
            json!({
                "id": account["id"],
                "name": account["name"],
                "type": account["type"],
                "subtype": account["subtype"],
                "isActive": account["isActive"],
                "isFavorite": account["isFavorite"],
            })
        })
        .collect();
    let transactions: Vec<Value> = results["transactions"]
        .as_array()
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .map(|transaction| {
            json!({
                "id": transaction["id"],
                "date": transaction["date"],
                "description": transaction["description"],
                "notes": transaction["notes"],
                "payeeName": transaction["payee"]["name"],
                "checkNumber": transaction["checkNumber"],
                "splits": transaction["splits"],
            })
        })
        .collect();
    Ok(ok(&json!({
        "accounts": {
            "items": items,
            "total": accounts["total"],
            "truncated": accounts["truncated"],
        },
        "payees": results["payees"],
        "transactions": transactions,
        "recurringRules": results["recurringRules"],
    })))
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
            &transactions_path(book_id),
            Some(&without(arguments, &["bookId"])),
        )
        .await?))
}

pub(super) async fn update(
    caller: &Caller,
    arguments: &Map<String, Value>,
) -> ToolResult<CallToolResult> {
    let book_id = integer(arguments, "bookId");
    let transaction_id = integer(arguments, "transactionId");
    caller.book(book_id, Level::Write).await?;
    Ok(ok(&caller
        .request(
            Method::PUT,
            &format!("{}/{transaction_id}", transactions_path(book_id)),
            Some(&without(arguments, &["bookId", "transactionId"])),
        )
        .await?))
}

/// The route says "Transaction not found" for a missing transaction. The
/// library says so only when `expectedUpdatedAt` is given, because its lock
/// check finds the row missing first; otherwise the delete itself finds
/// nothing, and its message names the transaction and the book.
pub(super) async fn delete(
    caller: &Caller,
    arguments: &Map<String, Value>,
) -> ToolResult<CallToolResult> {
    let book_id = integer(arguments, "bookId");
    let transaction_id = integer(arguments, "transactionId");
    caller.book(book_id, Level::Write).await?;
    let path = with_query(
        format!("{}/{transaction_id}", transactions_path(book_id)),
        arguments,
        &["expectedUpdatedAt"],
    );
    let (status, body) = caller.send(Method::DELETE, &path, None).await?;
    if status == StatusCode::NOT_FOUND {
        let message = if arguments.contains_key("expectedUpdatedAt") {
            "Transaction not found".to_owned()
        } else {
            format!("Transaction {transaction_id} not found in book {book_id}")
        };
        return Err(fail(&message).into());
    }
    outcome(status, body)?;
    Ok(ok(
        &json!({ "success": true, "transactionId": transaction_id }),
    ))
}
