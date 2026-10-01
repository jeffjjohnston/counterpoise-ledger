use crate::{
    book_auth::{AccessLevel, authenticate_book},
    error::{ApiError, ApiResult, error, internal_error},
    state::AppState,
    validation::{
        first_query_values, local_today, parse_int_auto_radix, parse_json_body,
        require_account_parent, validate_account_create, validate_account_update,
    },
};
use axum::{
    Json,
    body::Bytes,
    extract::{Path, RawQuery, State},
    http::{HeaderMap, StatusCode},
};
use chrono::{NaiveDate, NaiveDateTime, SecondsFormat, Utc};
use ledger_db::engine::{Db, DbConnection, DbPool};
use serde::{Serialize, Serializer};
use serde_json::{Value, json};
use sqlx::QueryBuilder;
use std::collections::{HashMap, HashSet};

/// The filter of `accounts_with_balances()`.
#[derive(Default)]
pub(crate) struct AccountQuery {
    pub(crate) account_type: Option<String>,
    pub(crate) include_inactive: bool,
    pub(crate) as_of_date: Option<String>,
}

fn parse_account_query(raw: Option<&str>) -> Result<AccountQuery, ApiError> {
    let mut first = first_query_values(raw);
    let account_type = first.remove("type");
    if let Some(value) = &account_type
        && !["asset", "liability", "equity", "income", "expense"].contains(&value.as_str())
    {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "Invalid option: expected one of \"asset\"|\"liability\"|\"equity\"|\"income\"|\"expense\"",
        ));
    }
    let include_inactive = first
        .get("includeInactive")
        .is_some_and(|value| value == "true");
    let as_of_date = first.remove("asOfDate");
    if let Some(value) = &as_of_date
        && (!matches!(value.as_bytes(), [y0, y1, y2, y3, b'-', m0, m1, b'-', d0, d1]
            if [y0, y1, y2, y3, m0, m1, d0, d1].iter().all(|digit| digit.is_ascii_digit()))
            || NaiveDate::parse_from_str(value, "%Y-%m-%d").is_err())
    {
        return Err(error(StatusCode::BAD_REQUEST, "Invalid ISO date"));
    }
    Ok(AccountQuery {
        account_type,
        include_inactive,
        as_of_date,
    })
}

const ACCOUNT_COLUMNS: &str = "id, book_id, name, type AS account_type, subtype, parent_id,
    is_active, is_favorite, is_investment_cash, icon, created_at, updated_at";

#[derive(Clone, sqlx::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
struct AccountRow {
    id: i32,
    book_id: i32,
    name: String,
    #[serde(rename = "type")]
    account_type: String,
    subtype: Option<String>,
    parent_id: Option<i32>,
    is_active: bool,
    is_favorite: bool,
    is_investment_cash: bool,
    icon: Option<String>,
    #[serde(serialize_with = "serialize_timestamp")]
    created_at: NaiveDateTime,
    #[serde(serialize_with = "serialize_timestamp")]
    updated_at: NaiveDateTime,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AccountNode {
    #[serde(flatten)]
    account: AccountRow,
    balance: i32,
    has_transactions: bool,
    children: Vec<AccountNode>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AccountDetail {
    #[serde(flatten)]
    account: AccountRow,
    balance: i32,
    has_transactions: bool,
    children: Vec<AccountRow>,
}

fn iso_timestamp(value: NaiveDateTime) -> String {
    value.and_utc().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn serialize_timestamp<S: Serializer>(
    value: &NaiveDateTime,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(&iso_timestamp(*value))
}

/// The account row and its raw child rows, as the Node relational query
/// `findFirst({ with: { children: true } })` returns them.
#[derive(Serialize)]
struct AccountWithChildren {
    #[serde(flatten)]
    account: AccountRow,
    children: Vec<AccountRow>,
}

async fn account_with_children(
    pool: &DbPool,
    book_id: i32,
    account_id: i32,
    failure_message: &'static str,
) -> Result<Option<AccountWithChildren>, ApiError> {
    let query = format!("SELECT {ACCOUNT_COLUMNS} FROM accounts WHERE book_id = $1 AND id = $2");
    let Some(account) = sqlx::query_as::<_, AccountRow>(&query)
        .bind(book_id)
        .bind(account_id)
        .fetch_optional(pool)
        .await
        .map_err(|cause| internal_error(cause, failure_message))?
    else {
        return Ok(None);
    };
    let query = format!(
        "SELECT {ACCOUNT_COLUMNS} FROM accounts WHERE book_id = $1 AND parent_id = $2 ORDER BY id"
    );
    let children = sqlx::query_as::<_, AccountRow>(&query)
        .bind(book_id)
        .bind(account_id)
        .fetch_all(pool)
        .await
        .map_err(|cause| internal_error(cause, failure_message))?;
    Ok(Some(AccountWithChildren { account, children }))
}

/// The account `[id]` handlers in Node call `parseInt(id)` with no radix, so
/// `0x1F` is account 31. NaN or a value outside the int4 range makes the Node
/// query fail, and the caller returns its 500 message.
fn account_path_id(raw: &str) -> Option<i32> {
    parse_int_auto_radix(raw)?.try_into().ok()
}

fn is_investment_account(account_type: &str, subtype: Option<&str>) -> bool {
    account_type == "asset" && subtype == Some("investment")
}

/// Creates or renames the automatic cash sub-account of an investment
/// account. The caller's transaction also holds the investment account's own
/// write, so the pair changes together.
async fn ensure_investment_cash_account(
    connection: &mut DbConnection,
    book_id: i32,
    account_id: i32,
    account_name: &str,
) -> Result<(), sqlx::Error> {
    let desired_name = format!("{account_name} Cash");
    let existing: Option<(i32, String)> = sqlx::query_as(
        "SELECT id, name FROM accounts
         WHERE book_id = $1 AND parent_id = $2 AND is_investment_cash = true
         LIMIT 1",
    )
    .bind(book_id)
    .bind(account_id)
    .fetch_optional(&mut *connection)
    .await?;
    let now = Utc::now().naive_utc();
    match existing {
        None => {
            sqlx::query(
                "INSERT INTO accounts
                   (name, type, subtype, parent_id, is_active, is_investment_cash, book_id,
                    created_at, updated_at)
                 VALUES ($1, 'asset', 'cash', $2, true, true, $3, $4, $4)",
            )
            .bind(desired_name)
            .bind(account_id)
            .bind(book_id)
            .bind(now)
            .execute(&mut *connection)
            .await?;
        }
        Some((cash_id, name)) if name != desired_name => {
            sqlx::query(
                "UPDATE accounts SET name = $1, updated_at = $2 WHERE id = $3 AND book_id = $4",
            )
            .bind(desired_name)
            .bind(now)
            .bind(cash_id)
            .bind(book_id)
            .execute(&mut *connection)
            .await?;
        }
        Some(_) => {}
    }
    Ok(())
}

pub(crate) async fn create_account(
    State(state): State<AppState>,
    Path(raw_book_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult {
    const FAILURE: &str = "Failed to create account";
    let book =
        authenticate_book(&state, &headers, &raw_book_id, AccessLevel::Write, FAILURE).await?;
    let input = validate_account_create(&parse_json_body(&body, FAILURE)?)?;
    require_account_parent(&state.pool, book.book_id, input.parent_id, FAILURE).await?;
    let parent_id = input.parent_id.map(|id| id as i32);

    let mut transaction = ledger_db::locks::begin_pool(&state.pool)
        .await
        .map_err(|cause| internal_error(cause, FAILURE))?;
    let now = Utc::now().naive_utc();
    let query = format!(
        "INSERT INTO accounts
           (name, type, subtype, parent_id, icon, is_active, book_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, true, $6, $7, $7)
         RETURNING {ACCOUNT_COLUMNS}"
    );
    let account: AccountRow = sqlx::query_as(&query)
        .bind(&input.name)
        .bind(&input.account_type)
        .bind(&input.subtype)
        .bind(parent_id)
        .bind(&input.icon)
        .bind(book.book_id)
        .bind(now)
        .fetch_one(&mut *transaction)
        .await
        .map_err(|cause| internal_error(cause, FAILURE))?;
    if is_investment_account(&account.account_type, account.subtype.as_deref()) {
        ensure_investment_cash_account(&mut transaction, book.book_id, account.id, &account.name)
            .await
            .map_err(|cause| internal_error(cause, FAILURE))?;
    }
    transaction
        .commit()
        .await
        .map_err(|cause| internal_error(cause, FAILURE))?;

    state.analytics.capture_event(
        book.user_id,
        "account_created",
        Some(json!({
            "bookId": book.book_id,
            "type": account.account_type,
            "subtype": account.subtype,
        })),
    );
    Ok(Json(
        serde_json::to_value(AccountNode {
            account,
            balance: 0,
            has_transactions: false,
            children: Vec::new(),
        })
        .expect("account node serializes"),
    ))
}

pub(crate) async fn update_account(
    State(state): State<AppState>,
    Path((raw_book_id, raw_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult {
    const FAILURE: &str = "Failed to update account";
    let book =
        authenticate_book(&state, &headers, &raw_book_id, AccessLevel::Write, FAILURE).await?;
    let input = validate_account_update(&parse_json_body(&body, FAILURE)?)?;
    require_account_parent(
        &state.pool,
        book.book_id,
        input.parent_id.flatten(),
        FAILURE,
    )
    .await?;
    let account_id = account_path_id(&raw_id)
        .ok_or_else(|| error(StatusCode::INTERNAL_SERVER_ERROR, FAILURE))?;

    let mut transaction = ledger_db::locks::begin_pool(&state.pool)
        .await
        .map_err(|cause| internal_error(cause, FAILURE))?;
    let query = format!("SELECT {ACCOUNT_COLUMNS} FROM accounts WHERE id = $1 AND book_id = $2");
    let existing: AccountRow = sqlx::query_as(&query)
        .bind(account_id)
        .bind(book.book_id)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(|cause| internal_error(cause, FAILURE))?
        .ok_or_else(|| error(StatusCode::NOT_FOUND, "Account not found"))?;

    let now = Utc::now().naive_utc();
    let mut update = QueryBuilder::<Db>::new("UPDATE accounts SET updated_at = ");
    update.push_bind(now);
    if let Some(name) = &input.name {
        update.push(", name = ").push_bind(name);
    }
    if let Some(subtype) = &input.subtype {
        update.push(", subtype = ").push_bind(subtype);
    }
    if let Some(parent_id) = input.parent_id {
        update
            .push(", parent_id = ")
            .push_bind(parent_id.map(|id| id as i32));
    }
    if let Some(is_active) = input.is_active {
        update.push(", is_active = ").push_bind(is_active);
    }
    if let Some(is_favorite) = input.is_favorite {
        update.push(", is_favorite = ").push_bind(is_favorite);
    }
    if let Some(icon) = &input.icon {
        update.push(", icon = ").push_bind(icon);
    }
    update
        .push(" WHERE id = ")
        .push_bind(account_id)
        .push(" AND book_id = ")
        .push_bind(book.book_id);
    update
        .build()
        .execute(&mut *transaction)
        .await
        .map_err(|cause| internal_error(cause, FAILURE))?;

    // Node derives the pair rule with `??`, so a subtype sent as null falls
    // back to the stored subtype here, although the row now holds NULL.
    let name = input.name.as_deref().unwrap_or(&existing.name);
    let subtype = input
        .subtype
        .as_ref()
        .and_then(Option::as_deref)
        .or(existing.subtype.as_deref());
    if is_investment_account(&existing.account_type, subtype) {
        ensure_investment_cash_account(&mut transaction, book.book_id, account_id, name)
            .await
            .map_err(|cause| internal_error(cause, FAILURE))?;
        if let Some(is_active) = input.is_active {
            sqlx::query(
                "UPDATE accounts SET is_active = $1, updated_at = $2
                 WHERE parent_id = $3 AND is_investment_cash = true AND book_id = $4",
            )
            .bind(is_active)
            .bind(Utc::now().naive_utc())
            .bind(account_id)
            .bind(book.book_id)
            .execute(&mut *transaction)
            .await
            .map_err(|cause| internal_error(cause, FAILURE))?;
        }
    }
    transaction
        .commit()
        .await
        .map_err(|cause| internal_error(cause, FAILURE))?;

    let updated = account_with_children(&state.pool, book.book_id, account_id, FAILURE)
        .await?
        .ok_or_else(|| error(StatusCode::NOT_FOUND, "Account not found"))?;
    Ok(Json(
        serde_json::to_value(updated).expect("account with children serializes"),
    ))
}

pub(crate) async fn delete_account(
    State(state): State<AppState>,
    Path((raw_book_id, raw_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> ApiResult {
    const FAILURE: &str = "Failed to delete account";
    let book =
        authenticate_book(&state, &headers, &raw_book_id, AccessLevel::Write, FAILURE).await?;
    let account_id = account_path_id(&raw_id)
        .ok_or_else(|| error(StatusCode::INTERNAL_SERVER_ERROR, FAILURE))?;
    // Node checks in this order: transactions, sub-accounts, then the delete.
    let split_count: i32 = sqlx::query_scalar(
        "SELECT CAST(COUNT(*) AS integer) FROM transaction_splits
         WHERE account_id = $1 AND book_id = $2",
    )
    .bind(account_id)
    .bind(book.book_id)
    .fetch_one(&state.pool)
    .await
    .map_err(|cause| internal_error(cause, FAILURE))?;
    if split_count > 0 {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "Cannot delete account with transactions",
        ));
    }
    let child_count: i32 = sqlx::query_scalar(
        "SELECT CAST(COUNT(*) AS integer) FROM accounts WHERE parent_id = $1 AND book_id = $2",
    )
    .bind(account_id)
    .bind(book.book_id)
    .fetch_one(&state.pool)
    .await
    .map_err(|cause| internal_error(cause, FAILURE))?;
    if child_count > 0 {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "Cannot delete account with sub-accounts",
        ));
    }
    let deleted = sqlx::query("DELETE FROM accounts WHERE id = $1 AND book_id = $2")
        .bind(account_id)
        .bind(book.book_id)
        .execute(&state.pool)
        .await
        .map_err(|cause| internal_error(cause, FAILURE))?;
    if deleted.rows_affected() == 0 {
        return Err(error(StatusCode::NOT_FOUND, "Account not found"));
    }
    Ok(Json(json!({ "success": true })))
}

pub(crate) async fn get_account(
    State(state): State<AppState>,
    Path((raw_book_id, raw_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> ApiResult {
    let book = authenticate_book(
        &state,
        &headers,
        &raw_book_id,
        AccessLevel::Read,
        "Failed to fetch account",
    )
    .await?;
    let Some(account_id) = account_path_id(&raw_id) else {
        return Err(error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to fetch account",
        ));
    };
    let AccountWithChildren { account, children } = account_with_children(
        &state.pool,
        book.book_id,
        account_id,
        "Failed to fetch account",
    )
    .await?
    .ok_or_else(|| error(StatusCode::NOT_FOUND, "Account not found"))?;
    let (balance, count): (i32, i32) = sqlx::query_as(
        "SELECT COALESCE(CAST(SUM(amount) AS integer), 0), CAST(COUNT(*) AS integer)
         FROM transaction_splits WHERE account_id = $1 AND book_id = $2",
    )
    .bind(account_id)
    .bind(book.book_id)
    .fetch_one(&state.pool)
    .await
    .map_err(|cause| internal_error(cause, "Failed to fetch account"))?;
    Ok(Json(
        serde_json::to_value(AccountDetail {
            account,
            balance,
            has_transactions: count > 0,
            children,
        })
        .expect("account detail serializes"),
    ))
}

fn account_tree(rows: Vec<AccountRow>, balances: Vec<(i32, i32, i32)>) -> Vec<AccountNode> {
    let totals: HashMap<i32, (i32, i32)> = balances
        .into_iter()
        .map(|(id, sum, count)| (id, (sum, count)))
        .collect();
    let mut nodes: HashMap<i32, AccountNode> = rows
        .iter()
        .map(|row| {
            let (balance, count) = totals.get(&row.id).copied().unwrap_or((0, 0));
            (
                row.id,
                AccountNode {
                    account: row.clone(),
                    balance,
                    has_transactions: count > 0,
                    children: Vec::new(),
                },
            )
        })
        .collect();
    let mut children: HashMap<i32, Vec<i32>> = HashMap::new();
    for row in &rows {
        if let Some(parent_id) = row.parent_id {
            children.entry(parent_id).or_default().push(row.id);
        }
    }
    fn take_node(
        id: i32,
        nodes: &mut HashMap<i32, AccountNode>,
        children: &HashMap<i32, Vec<i32>>,
        seen: &mut HashSet<i32>,
    ) -> Option<AccountNode> {
        if !seen.insert(id) {
            return None;
        }
        let mut node = nodes.remove(&id)?;
        if let Some(ids) = children.get(&id) {
            node.children = ids
                .iter()
                .filter_map(|child| take_node(*child, nodes, children, seen))
                .collect();
        }
        Some(node)
    }
    let mut seen = HashSet::new();
    rows.iter()
        .filter(|row| row.parent_id.is_none())
        .filter_map(|row| take_node(row.id, &mut nodes, &children, &mut seen))
        .collect()
}

/// The accounts that `query` selects, ordered by type and then name, and the
/// split total and split count of each account that has splits.
async fn account_rows(
    pool: &DbPool,
    book_id: i32,
    query: &AccountQuery,
) -> sqlx::Result<(Vec<AccountRow>, Vec<(i32, i32, i32)>)> {
    let mut account_sql =
        format!("SELECT {ACCOUNT_COLUMNS} FROM accounts WHERE book_id = $1 AND ($2 OR is_active)");
    if query.account_type.is_some() {
        account_sql.push_str(" AND type = $3");
    }
    account_sql.push_str(" ORDER BY type, name");
    let mut account_query = sqlx::query_as::<_, AccountRow>(&account_sql)
        .bind(book_id)
        .bind(query.include_inactive);
    if let Some(account_type) = &query.account_type {
        account_query = account_query.bind(account_type);
    }
    let rows = account_query.fetch_all(pool).await?;

    let mut balance_query = QueryBuilder::<Db>::new("");
    push_balance_query(&mut balance_query, book_id, query.as_of_date.as_deref());
    let balances: Vec<(i32, i32, i32)> = balance_query.build_query_as().fetch_all(pool).await?;
    Ok((rows, balances))
}

/// Pushes the query for the split total and the split count of each account
/// of the book that has splits. With `as_of_date`, it counts only the splits
/// whose transaction has an effective date on or before that date.
///
/// Only the date filter reads the transaction. Without a date, the query
/// reads only the index idx_transaction_splits_book_account. On a large book,
/// the join alone made the query more than five times slower.
fn push_balance_query(builder: &mut QueryBuilder<'_, Db>, book_id: i32, as_of_date: Option<&str>) {
    builder.push(
        "SELECT s.account_id, CAST(SUM(s.amount) AS integer), CAST(COUNT(*) AS integer)
         FROM transaction_splits s",
    );
    if as_of_date.is_some() {
        builder.push(" LEFT JOIN transactions t ON t.id = s.transaction_id");
    }
    builder.push(" WHERE s.book_id = ").push_bind(book_id);
    if let Some(as_of_date) = as_of_date {
        builder
            .push(" AND (CASE WHEN t.is_floating THEN ")
            .push_bind(local_today())
            .push(" ELSE t.date END) <= ")
            .push_bind(as_of_date.to_owned());
    }
    builder.push(" GROUP BY s.account_id");
}

/// A flat list of account
/// rows, each with `balanceCents` and `hasTransactions`. An account whose
/// parent the filter leaves out stays in the list. The MCP tools
/// `list_accounts` and `get_account_tree` shape this list; `GET /accounts`
/// gives a tree that drops such an account, so the tools cannot use it.
pub(crate) async fn accounts_with_balances(
    pool: &DbPool,
    book_id: i32,
    query: &AccountQuery,
) -> sqlx::Result<Vec<Value>> {
    let (rows, balances) = account_rows(pool, book_id, query).await?;
    let totals: HashMap<i32, (i32, i32)> = balances
        .into_iter()
        .map(|(id, sum, count)| (id, (sum, count)))
        .collect();
    Ok(rows
        .into_iter()
        .map(|row| {
            let (balance, count) = totals.get(&row.id).copied().unwrap_or((0, 0));
            let mut value = serde_json::to_value(row).expect("account row serializes");
            if let Some(object) = value.as_object_mut() {
                object.insert("balanceCents".to_owned(), json!(balance));
                object.insert("hasTransactions".to_owned(), json!(count > 0));
            }
            value
        })
        .collect())
}

pub(crate) async fn list_accounts(
    State(state): State<AppState>,
    Path(raw_book_id): Path<String>,
    RawQuery(raw_query): RawQuery,
    headers: HeaderMap,
) -> ApiResult {
    let authenticated = authenticate_book(
        &state,
        &headers,
        &raw_book_id,
        AccessLevel::Read,
        "Failed to fetch accounts",
    )
    .await?;
    let book_id = authenticated.book_id;

    let query = parse_account_query(raw_query.as_deref())?;
    let (rows, balances) = account_rows(&state.pool, book_id, &query)
        .await
        .map_err(|cause| internal_error(cause, "Failed to fetch accounts"))?;
    Ok(Json(
        serde_json::to_value(account_tree(rows, balances)).expect("account tree serializes"),
    ))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::parse_account_query;
    use axum::{body::to_bytes, http::StatusCode, response::IntoResponse};
    use serde_json::{Value, json};

    #[tokio::test]
    async fn query_first_value_and_error_bodies_match_node() {
        let query = parse_account_query(Some("type=asset&type=banana&includeInactive=1&ignored=x"))
            .unwrap();
        assert_eq!(query.account_type.as_deref(), Some("asset"));
        assert!(!query.include_inactive);
        for (raw, expected) in [
            ("asOfDate=2025-02-30", json!({"error":"Invalid ISO date"})),
            ("asOfDate=2025-01-%201", json!({"error":"Invalid ISO date"})),
            ("asOfDate=%202025-1-01", json!({"error":"Invalid ISO date"})),
            ("asOfDate=%2B202-01-01", json!({"error":"Invalid ISO date"})),
            (
                "type=banana",
                json!({"error":"Invalid option: expected one of \"asset\"|\"liability\"|\"equity\"|\"income\"|\"expense\""}),
            ),
        ] {
            let response = parse_account_query(Some(raw))
                .err()
                .unwrap()
                .into_response();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
            let body: Value =
                serde_json::from_slice(&to_bytes(response.into_body(), 1024).await.unwrap())
                    .unwrap();
            assert_eq!(body, expected);
        }
    }

    /// Book 1: checking (1), salary (2, income), groceries (3, expense) and
    /// an inactive expense (4). One transaction floats: its effective date is
    /// today. Book 2 has an account (5) with splits that book 1 must not
    /// count.
    pub(crate) async fn balance_fixture() -> ledger_db::testing::TempDatabase {
        let database = ledger_db::testing::TempDatabase::new(1).await;
        let now = chrono::Utc::now().naive_utc();
        for sql in [
            "INSERT INTO users (id, username, password_hash, created_at) VALUES (1, 'u', 'h', $1)",
            "INSERT INTO books (id, user_id, name, created_at, updated_at) VALUES (1, 1, 'A', $1, $1), (2, 1, 'B', $1, $1)",
            "INSERT INTO accounts (id, book_id, name, type, is_active, created_at, updated_at) VALUES
               (1, 1, 'Checking', 'asset', 1, $1, $1), (2, 1, 'Salary', 'income', 1, $1, $1),
               (3, 1, 'Groceries', 'expense', 1, $1, $1), (4, 1, 'Old', 'expense', 0, $1, $1),
               (5, 2, 'Other', 'expense', 1, $1, $1)",
            "INSERT INTO transactions (id, book_id, date, is_floating, created_at, updated_at) VALUES
               (1, 1, '2025-01-10', 0, $1, $1), (2, 1, '2025-02-01', 0, $1, $1),
               (3, 1, '2024-12-31', 1, $1, $1), (4, 1, '2025-03-01', 0, $1, $1),
               (5, 2, '2025-01-10', 0, $1, $1)",
            "INSERT INTO transaction_splits (book_id, transaction_id, account_id, amount) VALUES
               (1, 1, 1, 500000), (1, 1, 2, -500000), (1, 2, 3, 1234), (1, 2, 1, -1234),
               (1, 3, 3, 700), (1, 3, 1, -700), (1, 4, 4, 100), (1, 4, 1, -100),
               (2, 5, 5, 999), (2, 5, 5, -1)",
        ] {
            sqlx::query(sql)
                .bind(now)
                .execute(database.pool())
                .await
                .unwrap();
        }
        database
    }

    /// The `detail` column of each step of the query plan.
    pub(crate) async fn plan(
        pool: &ledger_db::engine::DbPool,
        push: impl FnOnce(&mut sqlx::QueryBuilder<'_, ledger_db::engine::Db>),
    ) -> Vec<String> {
        let mut query = sqlx::QueryBuilder::new("EXPLAIN QUERY PLAN ");
        push(&mut query);
        query
            .build_query_as::<(i64, i64, i64, String)>()
            .fetch_all(pool)
            .await
            .unwrap()
            .into_iter()
            .map(|(_, _, _, detail)| detail)
            .collect()
    }

    async fn balances(
        pool: &ledger_db::engine::DbPool,
        as_of_date: Option<&str>,
    ) -> Vec<(i32, i32, i32)> {
        let mut query = sqlx::QueryBuilder::new("");
        super::push_balance_query(&mut query, 1, as_of_date);
        let mut rows: Vec<(i32, i32, i32)> = query.build_query_as().fetch_all(pool).await.unwrap();
        rows.sort_unstable();
        rows
    }

    /// Without a date, the query does not read the transactions, and a date
    /// after every transaction (the floating one included) gives the same
    /// totals and counts.
    #[tokio::test]
    async fn balances_with_and_without_a_date_agree() {
        let database = balance_fixture().await;
        let pool = database.pool();
        let all = vec![
            (1, 497_966, 4),
            (2, -500_000, 1),
            (3, 1_934, 2),
            (4, 100, 1),
        ];
        assert_eq!(balances(pool, None).await, all);
        assert_eq!(balances(pool, Some("9999-12-31")).await, all);
        // The floating transaction is dated today, after this date.
        assert_eq!(
            balances(pool, Some("2025-01-31")).await,
            vec![(1, 500_000, 1), (2, -500_000, 1)]
        );
    }

    /// Without a date, the query reads only the covering index of
    /// migration 0002: no split row and no transaction. The join to the
    /// transactions made the account list five times slower on a large book.
    #[tokio::test]
    async fn balances_without_a_date_read_only_the_covering_index() {
        let database = balance_fixture().await;
        assert_eq!(
            plan(database.pool(), |query| super::push_balance_query(
                query, 1, None
            ))
            .await,
            ["SEARCH s USING COVERING INDEX idx_transaction_splits_book_account (book_id=?)"]
        );
    }
}
