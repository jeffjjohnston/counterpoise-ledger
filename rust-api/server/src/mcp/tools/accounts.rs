//! The account tools.

use axum::http::Method;
use ledger_core::{accounting::display_balance, accounts::build_account_tree};
use rmcp::model::CallToolResult;
use serde_json::{Map, Value, json};

use crate::{
    mcp::call::{Caller, Level, ToolResult, integer, invalid_arguments, ok, thrown, without},
    routes::accounts::{AccountQuery, accounts_with_balances},
    validation::account_icon,
};

fn accounts_path(book_id: i64) -> String {
    format!("/api/b/{book_id}/accounts")
}

/// `accountIconSchema` trims the icon and then requires one character. The
/// JSON Schema holds only the type, so the check is here. It runs before the
/// book gate: an input error comes before an access error.
fn check_icon(tool: &str, arguments: &Map<String, Value>) -> ToolResult<()> {
    match arguments.get("icon").map(account_icon) {
        Some(Err(cause)) => {
            Err(invalid_arguments(tool, &[format!("icon: {}", cause.message())]).into())
        }
        _ => Ok(()),
    }
}

/// `formatCurrencyString()` of `lib/formatters.ts`: a Unicode minus, a
/// dollar sign and two decimals, with no thousands separator.
fn formatted_balance(cents: i64) -> String {
    let sign = if cents < 0 { "\u{2212}" } else { "" };
    let cents = cents.unsigned_abs();
    format!("{sign}${}.{:02}", cents / 100, cents % 100)
}

async fn rows(caller: &Caller, book_id: i64, query: &AccountQuery) -> ToolResult<Vec<Value>> {
    // The book gate has accepted the ID, so it is in the int4 range.
    let book_id = i32::try_from(book_id).map_err(|cause| thrown(&cause.to_string()))?;
    accounts_with_balances(&caller.state().pool, book_id, query)
        .await
        .map_err(|cause| thrown(&cause.to_string()).into())
}

/// A flat list with display balances. `GET /accounts` gives a tree and drops
/// an account whose parent the filter leaves out, so the tool reads the rows
/// directly.
pub(super) async fn list(
    caller: &Caller,
    arguments: &Map<String, Value>,
) -> ToolResult<CallToolResult> {
    let book_id = integer(arguments, "bookId");
    caller.book(book_id, Level::Read).await?;
    let text = |name: &str| {
        arguments
            .get(name)
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    let query = AccountQuery {
        account_type: text("type"),
        include_inactive: arguments
            .get("includeInactive")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        as_of_date: text("asOfDate"),
    };
    let result: Vec<Value> = rows(caller, book_id, &query)
        .await?
        .iter()
        .map(|row| {
            let balance = row["balanceCents"].as_i64().unwrap_or_default();
            let display = display_balance(balance, row["type"].as_str().unwrap_or_default());
            json!({
                "id": row["id"],
                "name": row["name"],
                "type": row["type"],
                "subtype": row["subtype"],
                "parentId": row["parentId"],
                "isActive": row["isActive"],
                "isFavorite": row["isFavorite"],
                "isInvestmentCash": row["isInvestmentCash"],
                "balanceCents": balance,
                "displayBalance": display,
                "formattedBalance": formatted_balance(display),
            })
        })
        .collect();
    Ok(ok(&Value::Array(result)))
}

/// The active accounts, grouped by type in the order of the rows, with a
/// tree for each type. A node keeps its row fields and adds `balance`, the
/// ledger-signed balance, and `children`.
pub(super) async fn tree(
    caller: &Caller,
    arguments: &Map<String, Value>,
) -> ToolResult<CallToolResult> {
    let book_id = integer(arguments, "bookId");
    caller.book(book_id, Level::Read).await?;
    let mut grouped: Map<String, Value> = Map::new();
    for mut row in rows(caller, book_id, &AccountQuery::default()).await? {
        let account_type = row["type"].as_str().unwrap_or_default().to_owned();
        if let Some(object) = row.as_object_mut() {
            let balance = object.get("balanceCents").cloned().unwrap_or(json!(0));
            object.insert("balance".to_owned(), balance);
            object.insert("children".to_owned(), json!([]));
        }
        grouped
            .entry(account_type)
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .expect("an array was inserted")
            .push(row);
    }
    for accounts in grouped.values_mut() {
        let rows = std::mem::take(accounts);
        *accounts = Value::Array(build_account_tree(
            rows.as_array().map_or(&[], Vec::as_slice),
        ));
    }
    Ok(ok(&Value::Object(grouped)))
}

/// The route adds `balance`, `hasTransactions` and `children` for the web
/// form. The tool returns the stored row only.
pub(super) async fn create(
    caller: &Caller,
    arguments: &Map<String, Value>,
) -> ToolResult<CallToolResult> {
    check_icon("create_account", arguments)?;
    let book_id = integer(arguments, "bookId");
    caller.book(book_id, Level::Write).await?;
    let mut account = caller
        .request(
            Method::POST,
            &accounts_path(book_id),
            Some(&without(arguments, &["bookId"])),
        )
        .await?;
    if let Some(object) = account.as_object_mut() {
        for key in ["balance", "hasTransactions", "children"] {
            object.shift_remove(key);
        }
    }
    Ok(ok(&account))
}

pub(super) async fn update(
    caller: &Caller,
    arguments: &Map<String, Value>,
) -> ToolResult<CallToolResult> {
    check_icon("update_account", arguments)?;
    let book_id = integer(arguments, "bookId");
    let account_id = integer(arguments, "accountId");
    caller.book(book_id, Level::Write).await?;
    let account = caller
        .request(
            Method::PUT,
            &format!("{}/{account_id}", accounts_path(book_id)),
            Some(&without(arguments, &["bookId", "accountId"])),
        )
        .await?;
    Ok(ok(&account))
}

pub(super) async fn delete(
    caller: &Caller,
    arguments: &Map<String, Value>,
) -> ToolResult<CallToolResult> {
    let book_id = integer(arguments, "bookId");
    let account_id = integer(arguments, "accountId");
    caller.book(book_id, Level::Write).await?;
    caller
        .request(
            Method::DELETE,
            &format!("{}/{account_id}", accounts_path(book_id)),
            None,
        )
        .await?;
    Ok(ok(&json!({ "success": true, "accountId": account_id })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formatted_balance_matches_the_typescript_tool() {
        assert_eq!(formatted_balance(0), "$0.00");
        assert_eq!(formatted_balance(5), "$0.05");
        assert_eq!(formatted_balance(123_456), "$1234.56");
        assert_eq!(formatted_balance(-1005), "\u{2212}$10.05");
        assert_eq!(
            formatted_balance(i64::from(i32::MIN)),
            "\u{2212}$21474836.48"
        );
    }

    #[test]
    fn icon_check_refuses_more_than_one_character() {
        let arguments = |icon: Value| json!({ "icon": icon }).as_object().unwrap().clone();
        assert!(check_icon("create_account", &arguments(json!("🍔"))).is_ok());
        assert!(check_icon("create_account", &arguments(json!("  "))).is_ok());
        assert!(check_icon("create_account", &arguments(Value::Null)).is_ok());
        let refused = check_icon("create_account", &arguments(json!("ab"))).unwrap_err();
        assert_eq!(
            refused.content[0].as_text().unwrap().text,
            "MCP error -32602: Input validation error: Invalid arguments for tool \
             create_account: icon: Icon must be a single character"
        );
    }
}
