//! The bank-sync and reconciliation tools.

use std::collections::HashSet;

use axum::http::Method;
use rmcp::model::CallToolResult;
use serde_json::{Map, Value, json};

use crate::{
    mcp::call::{
        Caller, Level, ToolResult, fail, integer, invalid_arguments, ok, thrown, with_query,
        without,
    },
    routes::investments::MAX_SAFE_INTEGER,
    routes::plaid_sync::{SyncError, sync_token},
    validation::{is_js_whitespace, js_number, js_to_number},
};

pub(crate) const PLAID_ACCOUNT_ID_REQUIRED: &str = "Each assignment must include plaidAccountId";
pub(crate) const COUNTERPOISE_ACCOUNT_ID_INVALID: &str =
    "counterpoiseAccountId must be a positive integer or null";
pub(crate) const UPDATE_TOKEN_REQUIRED: &str = "financialInstitution and itemId are required";

fn sync_path(book_id: i64) -> String {
    format!("/api/b/{book_id}/sync")
}

fn token_path(book_id: i64, token_id: i64) -> String {
    format!("{}/tokens/{token_id}", sync_path(book_id))
}

fn is_blank(value: &str) -> bool {
    value.trim_matches(is_js_whitespace).is_empty()
}

/// The routes say "Token not found". The library names the token.
fn token_not_found(token_id: i64) -> Box<CallToolResult> {
    fail(&format!("Plaid token {token_id} not found")).into()
}

/// A request to a token route, with the library's not-found message.
async fn token_request(
    caller: &Caller,
    method: Method,
    path: &str,
    token_id: i64,
    body: Option<&Value>,
) -> ToolResult<Value> {
    match caller.request_found(method, path, body).await? {
        Some(value) => Ok(value),
        None => Err(token_not_found(token_id)),
    }
}

/// `update_plaid_token`: zod trims both fields before `min(1)`. The JSON
/// Schema has no trim, so a value of only whitespace is refused here, with
/// the zod message, before the schema check.
pub(super) fn check_token_fields(tool: &str, arguments: &Map<String, Value>) -> ToolResult<()> {
    for field in ["financialInstitution", "itemId"] {
        if let Some(Value::String(value)) = arguments.get(field)
            && is_blank(value)
        {
            return Err(
                invalid_arguments(tool, &[format!("{field}: {UPDATE_TOKEN_REQUIRED}")]).into(),
            );
        }
    }
    Ok(())
}

/// `set_plaid_token_accounts`: zod checks each item in order, trims its
/// `plaidAccountId` before `min(1)`, and only when every item is valid
/// refuses a repeated `plaidAccountId` (as trimmed) or a repeated
/// `counterpoiseAccountId`. The JSON Schema holds neither the trim nor the
/// repeats, so the items are checked here, before the schema check, in zod's
/// order and with zod's messages. A value that is not an array is left to
/// the schema check.
pub(super) fn check_assignments(tool: &str, arguments: &Map<String, Value>) -> ToolResult<()> {
    let Some(assignments) = arguments.get("assignments").and_then(Value::as_array) else {
        return Ok(());
    };
    let refuse = |path: String, message: &str| -> ToolResult<()> {
        Err(invalid_arguments(tool, &[format!("{path}: {message}")]).into())
    };
    for (index, item) in assignments.iter().enumerate() {
        if !item.is_object() {
            return refuse(format!("assignments/{index}"), PLAID_ACCOUNT_ID_REQUIRED);
        }
        if !matches!(item.get("plaidAccountId"), Some(Value::String(id)) if !is_blank(id)) {
            return refuse(
                format!("assignments/{index}/plaidAccountId"),
                PLAID_ACCOUNT_ID_REQUIRED,
            );
        }
        let valid_local = match item.get("counterpoiseAccountId") {
            Some(Value::Null) => true,
            Some(Value::Number(number)) => {
                let number = js_number(number);
                number.fract() == 0.0 && number > 0.0 && number <= MAX_SAFE_INTEGER
            }
            _ => false,
        };
        if !valid_local {
            return refuse(
                format!("assignments/{index}/counterpoiseAccountId"),
                COUNTERPOISE_ACCOUNT_ID_INVALID,
            );
        }
    }
    let plaid_ids: HashSet<&str> = assignments
        .iter()
        .filter_map(|item| item["plaidAccountId"].as_str())
        .map(|id| id.trim_matches(is_js_whitespace))
        .collect();
    if plaid_ids.len() != assignments.len() {
        return refuse(
            "assignments".to_owned(),
            "Duplicate plaidAccountId in assignments",
        );
    }
    let local_ids: Vec<String> = assignments
        .iter()
        .map(|item| &item["counterpoiseAccountId"])
        .filter(|id| !id.is_null())
        .map(Value::to_string)
        .collect();
    if local_ids.iter().collect::<HashSet<_>>().len() != local_ids.len() {
        return refuse(
            "assignments".to_owned(),
            "A Counterpoise account cannot be assigned to more than one Plaid account",
        );
    }
    Ok(())
}

/// `pendingTransactionsQuery.accountId` is `z.coerce.number().int()`, so zod
/// takes `"42"` as 42. The JSON Schema cannot hold a coercion and refuses a
/// string, so the argument changes here, before the schema check, as
/// JavaScript `Number()` changes it. A value that does not become a safe
/// integer stays as it is, and the schema check refuses it with zod's message.
pub(super) fn prepare_pending(arguments: &mut Map<String, Value>) {
    let Some(value) = arguments.get("accountId") else {
        return;
    };
    if value.is_number() {
        return;
    }
    let number = js_to_number(Some(value));
    if number.is_finite() && number.fract() == 0.0 && number.abs() <= MAX_SAFE_INTEGER {
        arguments.insert("accountId".to_owned(), json!(number as i64));
    }
}

/// The connections, the pending count, the stale manual transactions and
/// the mapped accounts. `getPlaidStatus()` reads these four at once; the
/// tool reads them from their four routes.
pub(super) async fn status(
    caller: &Caller,
    arguments: &Map<String, Value>,
) -> ToolResult<CallToolResult> {
    let book_id = integer(arguments, "bookId");
    caller.book(book_id, Level::Read).await?;
    let base = sync_path(book_id);
    let get = |path: String| async move { caller.request(Method::GET, &path, None).await };
    let (tokens, pending, stale, assigned) = tokio::try_join!(
        get(format!("{base}/tokens")),
        get(format!("{base}/pending-count")),
        get(format!("{base}/stale-unmatched")),
        get(format!("{base}/assigned-accounts")),
    )?;
    Ok(ok(&json!({
        "tokens": tokens,
        "pendingCount": pending["count"],
        "staleUnmatched": stale,
        "assignedAccounts": assigned,
    })))
}

/// The accounts of a connection, from local data only. The route also takes
/// `refresh`, which calls Plaid; the tool has no such argument.
pub(super) async fn token_accounts(
    caller: &Caller,
    arguments: &Map<String, Value>,
) -> ToolResult<CallToolResult> {
    let book_id = integer(arguments, "bookId");
    let token_id = integer(arguments, "tokenId");
    caller.book(book_id, Level::Read).await?;
    let path = format!("{}/accounts", token_path(book_id, token_id));
    Ok(ok(&token_request(
        caller,
        Method::GET,
        &path,
        token_id,
        None,
    )
    .await?))
}

/// The route also writes an access token when the body has one. The tool's
/// schema has no such field, and the dispatcher drops unknown arguments, so
/// the body holds only the two fields.
pub(super) async fn update_token(
    caller: &Caller,
    arguments: &Map<String, Value>,
) -> ToolResult<CallToolResult> {
    let book_id = integer(arguments, "bookId");
    let token_id = integer(arguments, "tokenId");
    caller.book(book_id, Level::Owner).await?;
    let body = without(arguments, &["bookId", "tokenId"]);
    Ok(ok(&token_request(
        caller,
        Method::PUT,
        &token_path(book_id, token_id),
        token_id,
        Some(&body),
    )
    .await?))
}

pub(super) async fn delete_token(
    caller: &Caller,
    arguments: &Map<String, Value>,
) -> ToolResult<CallToolResult> {
    let book_id = integer(arguments, "bookId");
    let token_id = integer(arguments, "tokenId");
    caller.book(book_id, Level::Owner).await?;
    token_request(
        caller,
        Method::DELETE,
        &token_path(book_id, token_id),
        token_id,
        None,
    )
    .await?;
    Ok(ok(&json!({ "success": true, "tokenId": token_id })))
}

pub(super) async fn set_token_accounts(
    caller: &Caller,
    arguments: &Map<String, Value>,
) -> ToolResult<CallToolResult> {
    let book_id = integer(arguments, "bookId");
    let token_id = integer(arguments, "tokenId");
    caller.book(book_id, Level::Owner).await?;
    let path = format!("{}/accounts", token_path(book_id, token_id));
    let body = without(arguments, &["bookId", "tokenId"]);
    Ok(ok(&token_request(
        caller,
        Method::PUT,
        &path,
        token_id,
        Some(&body),
    )
    .await?))
}

/// The sync runs outside the route, so that the auto-match events that
/// the sync records reach PostHog. A route that runs for a tool records
/// nothing.
pub(super) async fn sync(
    caller: &Caller,
    arguments: &Map<String, Value>,
) -> ToolResult<CallToolResult> {
    let book_id = integer(arguments, "bookId");
    let token_id = integer(arguments, "tokenId");
    caller.book(book_id, Level::Write).await?;
    let book = i32::try_from(book_id).map_err(|cause| thrown(&cause.to_string()))?;
    let Ok(token) = i32::try_from(token_id) else {
        // PostgreSQL refuses the ID in the lock query, as it does for Node.
        return Err(thrown(&format!(
            "value \"{token_id}\" is out of range for type integer"
        ))
        .into());
    };
    match sync_token(caller.state(), book, token).await {
        Ok(result) => Ok(ok(&result.to_json())),
        Err(SyncError::Refused(_, message)) => Err(fail(message).into()),
        Err(SyncError::Failed(message)) => Err(thrown(&message).into()),
    }
}

pub(super) async fn clear_sync_data(
    caller: &Caller,
    arguments: &Map<String, Value>,
) -> ToolResult<CallToolResult> {
    let book_id = integer(arguments, "bookId");
    let token_id = integer(arguments, "tokenId");
    caller.book(book_id, Level::Write).await?;
    let path = format!("{}/sync", token_path(book_id, token_id));
    token_request(caller, Method::DELETE, &path, token_id, None).await?;
    Ok(ok(&json!({ "success": true })))
}

pub(super) async fn pending_transactions(
    caller: &Caller,
    arguments: &Map<String, Value>,
) -> ToolResult<CallToolResult> {
    let book_id = integer(arguments, "bookId");
    caller.book(book_id, Level::Read).await?;
    let path = with_query(
        format!("{}/pending-transactions", sync_path(book_id)),
        arguments,
        &["accountId"],
    );
    Ok(ok(&caller.request(Method::GET, &path, None).await?))
}

fn plaid_link_path(book_id: i64, transaction_id: i64) -> String {
    format!("/api/b/{book_id}/transactions/{transaction_id}/plaid")
}

pub(super) async fn transaction_link(
    caller: &Caller,
    arguments: &Map<String, Value>,
) -> ToolResult<CallToolResult> {
    let book_id = integer(arguments, "bookId");
    let transaction_id = integer(arguments, "transactionId");
    caller.book(book_id, Level::Read).await?;
    Ok(ok(&caller
        .request(Method::GET, &plaid_link_path(book_id, transaction_id), None)
        .await?))
}

pub(super) async fn unlink(
    caller: &Caller,
    arguments: &Map<String, Value>,
) -> ToolResult<CallToolResult> {
    let book_id = integer(arguments, "bookId");
    let transaction_id = integer(arguments, "transactionId");
    caller.book(book_id, Level::Write).await?;
    caller
        .request(
            Method::POST,
            &format!("{}/unlink", plaid_link_path(book_id, transaction_id)),
            None,
        )
        .await?;
    Ok(ok(&json!({ "success": true })))
}

/// The queue of one linked account, or of every linked account in the book.
/// Each route gives its queue in the order the tool reports.
pub(super) async fn reconcile_candidates(
    caller: &Caller,
    arguments: &Map<String, Value>,
) -> ToolResult<CallToolResult> {
    let book_id = integer(arguments, "bookId");
    caller.book(book_id, Level::Read).await?;
    // The schema defaults. The JSON Schema validator does not apply them.
    let mut page = Map::new();
    page.insert(
        "limit".to_owned(),
        json!(arguments.get("limit").and_then(Value::as_i64).unwrap_or(25)),
    );
    page.insert(
        "offset".to_owned(),
        json!(arguments.get("offset").and_then(Value::as_i64).unwrap_or(0)),
    );
    let path = match arguments.get("plaidAccountLinkId").and_then(Value::as_i64) {
        Some(link_id) => format!("{}/accounts/{link_id}/reconcile", sync_path(book_id)),
        None => format!("{}/reconcile", sync_path(book_id)),
    };
    let path = with_query(path, &page, &["limit", "offset"]);
    Ok(ok(&caller.request(Method::GET, &path, None).await?))
}

pub(super) async fn reconcile(
    caller: &Caller,
    arguments: &Map<String, Value>,
) -> ToolResult<CallToolResult> {
    let book_id = integer(arguments, "bookId");
    let link_id = integer(arguments, "plaidAccountLinkId");
    caller.book(book_id, Level::Write).await?;
    Ok(ok(&caller
        .request(
            Method::POST,
            &format!("{}/accounts/{link_id}/reconcile", sync_path(book_id)),
            Some(&without(arguments, &["bookId", "plaidAccountLinkId"])),
        )
        .await?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_account_id_is_coerced_as_javascript_number_does() {
        let prepared = |value: Value| {
            let mut arguments = Map::new();
            arguments.insert("accountId".to_owned(), value);
            prepare_pending(&mut arguments);
            arguments["accountId"].clone()
        };
        assert_eq!(prepared(json!("42")), json!(42));
        assert_eq!(prepared(json!(" 7 ")), json!(7));
        assert_eq!(prepared(json!("0x10")), json!(16));
        assert_eq!(prepared(json!(null)), json!(0));
        assert_eq!(prepared(json!("abc")), json!("abc"));
        assert_eq!(prepared(json!("1.5")), json!("1.5"));
        assert_eq!(prepared(json!(3)), json!(3));
    }
}
