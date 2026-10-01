//! The report tools. Each one reads the shared
//! report queries or the rows directly: the report routes check their dates
//! more strictly than the tools, and leave out fields the tools report.

use ledger_core::accounting::display_balance;
use rmcp::model::CallToolResult;
use serde_json::{Map, Value, json};

use crate::{
    mcp::call::{Caller, Level, ToolResult, compact_error, integer, ok, thrown},
    routes::{
        investments::EFFECTIVE_DATE,
        reports::{income_rows, report_splits},
    },
};

fn db_error(cause: sqlx::Error) -> Box<CallToolResult> {
    thrown(&cause.to_string()).into()
}

fn text<'a>(arguments: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    arguments.get(key).and_then(Value::as_str)
}

fn book_key(book_id: i64) -> ToolResult<i32> {
    // The book gate has accepted the ID, so it is in the int4 range.
    i32::try_from(book_id).map_err(|cause| thrown(&cause.to_string()).into())
}

/// The income and expense accounts with a balance in the range, shown
/// positive, and the totals. An account with no activity is left out.
pub(super) async fn income_statement(
    caller: &Caller,
    arguments: &Map<String, Value>,
) -> ToolResult<CallToolResult> {
    let book_id = integer(arguments, "bookId");
    caller.book(book_id, Level::Read).await?;
    let start = text(arguments, "startDate").unwrap_or_default();
    let end = text(arguments, "endDate").unwrap_or_default();
    let include_inactive = arguments
        .get("includeInactive")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let rows = income_rows(
        &caller.state().pool,
        book_key(book_id)?,
        Some((start, end)),
        include_inactive,
    )
    .await
    .map_err(db_error)?;
    let (mut income, mut expenses) = (Vec::new(), Vec::new());
    let (mut total_income, mut total_expenses) = (0_i64, 0_i64);
    for row in rows {
        let display = display_balance(i64::from(row.balance), &row.account_type);
        if display == 0 {
            continue;
        }
        let entry = json!({ "id": row.account_id, "name": row.name, "balanceCents": display });
        if row.account_type == "income" {
            income.push(entry);
            total_income += display;
        } else {
            expenses.push(entry);
            total_expenses += display;
        }
    }
    Ok(ok(&json!({
        "startDate": start,
        "endDate": end,
        "income": income,
        "expenses": expenses,
        "totals": {
            "incomeCents": total_income,
            "expensesCents": total_expenses,
            "netIncomeCents": total_income - total_expenses,
        },
    })))
}

/// The split rows of the range, oldest first, cut at `limit`. The data
/// route has no limit and no description.
pub(super) async fn report_data(
    caller: &Caller,
    arguments: &Map<String, Value>,
) -> ToolResult<CallToolResult> {
    let book_id = integer(arguments, "bookId");
    caller.book(book_id, Level::Read).await?;
    // The schema default. The JSON Schema validator does not apply it.
    let limit = arguments
        .get("limit")
        .and_then(Value::as_i64)
        .unwrap_or(2000);
    let account_ids: Vec<i64> = arguments
        .get("accountIds")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .filter_map(Value::as_i64)
        .collect();
    let account_types: Vec<&str> = arguments
        .get("accountTypes")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .filter_map(Value::as_str)
        .collect();
    let (splits, total) = report_splits(
        &caller.state().pool,
        book_key(book_id)?,
        text(arguments, "startDate"),
        text(arguments, "endDate"),
        &account_ids,
        &account_types,
        Some(limit),
    )
    .await
    .map_err(db_error)?;
    let rows: Vec<Value> = splits
        .into_iter()
        .map(|split| {
            json!({
                "date": split.date,
                "description": split.description,
                "payeeName": split.payee_name,
                "accountId": split.account_id,
                "accountName": split.account_name,
                "accountType": split.account_type,
                "amountCents": split.amount,
            })
        })
        .collect();
    Ok(ok(&json!({
        "rowCount": rows.len(),
        "totalCount": total,
        "truncated": total > limit,
        "data": rows,
    })))
}

/// The running balance of one account, entry by entry, oldest first. No
/// route gives this.
pub(super) async fn balance_history(
    caller: &Caller,
    arguments: &Map<String, Value>,
) -> ToolResult<CallToolResult> {
    let book_id = integer(arguments, "bookId");
    caller.book(book_id, Level::Read).await?;
    let account_id = integer(arguments, "accountId");
    // The schema default. The JSON Schema validator does not apply it.
    let limit = arguments
        .get("limit")
        .and_then(Value::as_i64)
        .unwrap_or(200);
    let start = text(arguments, "startDate");
    let end = text(arguments, "endDate");
    let pool = &caller.state().pool;

    let account: Option<(i32, String, String)> = match i32::try_from(account_id) {
        Ok(key) => {
            sqlx::query_as("SELECT id, name, type FROM accounts WHERE book_id = $1 AND id = $2")
                .bind(book_key(book_id)?)
                .bind(key)
                .fetch_optional(pool)
                .await
                .map_err(db_error)?
        }
        Err(_) => None,
    };
    let Some((id, name, account_type)) = account else {
        // This failure is compact JSON, unlike `fail()`. Clients see the text.
        return Err(compact_error(&format!("Account {account_id} not found")).into());
    };

    let starting: i32 = match start {
        Some(start) => sqlx::query_scalar(&format!(
            "SELECT CAST(COALESCE(SUM(s.amount), 0) AS INTEGER) FROM transaction_splits s
             JOIN transactions t ON s.transaction_id = t.id
             WHERE s.account_id = $1 AND {EFFECTIVE_DATE} < $2"
        ))
        .bind(id)
        .bind(start)
        .fetch_one(pool)
        .await
        .map_err(db_error)?,
        None => 0,
    };

    let mut sql = format!(
        "SELECT {EFFECTIVE_DATE} AS date, t.description, s.amount, s.transaction_id
         FROM transaction_splits s JOIN transactions t ON s.transaction_id = t.id
         WHERE s.account_id = $1"
    );
    if start.is_some() {
        sql.push_str(&format!(" AND {EFFECTIVE_DATE} >= $2"));
    }
    if end.is_some() {
        let index = if start.is_some() { 3 } else { 2 };
        sql.push_str(&format!(" AND {EFFECTIVE_DATE} <= ${index}"));
    }
    let limit_index = 2 + usize::from(start.is_some()) + usize::from(end.is_some());
    sql.push_str(&format!(
        " ORDER BY {EFFECTIVE_DATE}, s.id LIMIT COALESCE(${limit_index}, -1)"
    ));
    let mut query = sqlx::query_as::<_, (String, Option<String>, i32, i32)>(&sql).bind(id);
    if let Some(start) = start {
        query = query.bind(start);
    }
    if let Some(end) = end {
        query = query.bind(end);
    }
    let rows = query.bind(limit).fetch_all(pool).await.map_err(db_error)?;

    let mut running = i64::from(starting);
    let entries: Vec<Value> = rows
        .into_iter()
        .map(|(date, description, amount, transaction_id)| {
            running += i64::from(amount);
            json!({
                "date": date,
                "description": description,
                "changeCents": amount,
                "balanceCents": running,
                "displayBalance": display_balance(running, &account_type),
                "transactionId": transaction_id,
            })
        })
        .collect();
    Ok(ok(&json!({
        "account": { "id": id, "name": name, "type": account_type },
        "startingBalanceCents": starting,
        "entries": entries,
    })))
}
