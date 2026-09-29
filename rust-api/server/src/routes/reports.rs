use crate::{
    book_auth::{AccessLevel, authenticate_book},
    error::{ApiResult, error, internal_error},
    state::AppState,
    validation::{first_query_values, local_today, parse_int_prefix, query_date_param},
};
use axum::{
    Json,
    extract::{Path, RawQuery, State},
    http::{HeaderMap, StatusCode},
};
use serde::Serialize;
use serde_json::{json, to_value};
use sqlx::{PgPool, Postgres, QueryBuilder};

/// One row of `getReportSplits()`. The data route does not send the
/// description; the MCP tool `get_report_data` does.
#[derive(sqlx::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReportSplit {
    pub(crate) split_id: i32,
    pub(crate) transaction_id: i32,
    pub(crate) date: String,
    #[serde(skip)]
    pub(crate) description: Option<String>,
    pub(crate) amount: i32,
    pub(crate) account_id: i32,
    pub(crate) account_name: String,
    pub(crate) account_type: String,
    pub(crate) account_parent_id: Option<i32>,
    pub(crate) payee_id: Option<i32>,
    pub(crate) payee_name: Option<String>,
}

#[derive(sqlx::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReportAccount {
    id: i32,
    name: String,
    #[serde(rename = "type")]
    account_type: String,
    parent_id: Option<i32>,
}

/// One row of `getIncomeStatement()`: an income or expense account and its
/// balance in the date range, with the ledger sign.
#[derive(sqlx::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IncomeRow {
    pub(crate) account_id: i32,
    pub(crate) name: String,
    #[serde(rename = "type")]
    pub(crate) account_type: String,
    pub(crate) balance: i32,
}

/// `getReportSplits()`: the splits of the book in effective-date order,
/// with their account and payee. With `limit`, only the first rows, and the
/// count of all the rows that match; without it, every row and their count.
pub(crate) async fn report_splits(
    pool: &PgPool,
    book_id: i32,
    start_date: Option<&str>,
    end_date: Option<&str>,
    account_ids: &[i64],
    account_types: &[&str],
    limit: Option<i64>,
) -> Result<(Vec<ReportSplit>, i64), sqlx::Error> {
    let today = local_today();
    let push_filters = |query: &mut QueryBuilder<'_, Postgres>| {
        if let Some(start) = start_date {
            query.push(" AND date >= ").push_bind(start.to_owned());
        }
        if let Some(end) = end_date {
            query.push(" AND date <= ").push_bind(end.to_owned());
        }
        if !account_ids.is_empty() {
            query.push(" AND account_id IN (");
            for (index, id) in account_ids.iter().enumerate() {
                if index > 0 {
                    query.push(", ");
                }
                query.push_bind(*id);
            }
            query.push(")");
        }
        if !account_types.is_empty() {
            query.push(" AND account_type IN (");
            for (index, account_type) in account_types.iter().enumerate() {
                if index > 0 {
                    query.push(", ");
                }
                query.push_bind(account_type.to_string());
            }
            query.push(")");
        }
    };
    let rows_sql = |select: &str| {
        let mut query = QueryBuilder::<Postgres>::new(
            "WITH report_rows AS (SELECT s.id AS split_id, t.id AS transaction_id,
                CASE WHEN t.is_floating THEN ",
        );
        query.push_bind(today.clone()).push(
            " ELSE t.date END AS date, t.description, s.amount, s.account_id,
                a.name AS account_name, a.type AS account_type, a.parent_id AS account_parent_id,
                p.id AS payee_id, p.name AS payee_name
         FROM transaction_splits s JOIN transactions t ON t.id = s.transaction_id
         JOIN accounts a ON a.id = s.account_id LEFT JOIN payees p ON p.id = t.payee_id
         WHERE t.book_id = ",
        );
        query
            .push_bind(book_id)
            .push(format!(") SELECT {select} FROM report_rows WHERE TRUE"));
        push_filters(&mut query);
        query
    };
    let mut query = rows_sql("*");
    query.push(" ORDER BY date, transaction_id, split_id");
    if let Some(limit) = limit {
        query.push(" LIMIT ").push_bind(limit);
    }
    let splits: Vec<ReportSplit> = query.build_query_as().fetch_all(pool).await?;
    let total = match limit {
        None => splits.len() as i64,
        Some(_) => {
            rows_sql("CAST(COUNT(*) AS bigint)")
                .build_query_scalar()
                .fetch_one(pool)
                .await?
        }
    };
    Ok((splits, total))
}

pub(crate) async fn report_data(
    State(state): State<AppState>,
    Path(raw_book_id): Path<String>,
    RawQuery(raw_query): RawQuery,
    headers: HeaderMap,
) -> ApiResult {
    let book = authenticate_book(
        &state,
        &headers,
        &raw_book_id,
        AccessLevel::Read,
        "Failed to fetch report data",
    )
    .await?;
    let params = first_query_values(raw_query.as_deref());
    let start_date = query_date_param(&params, "startDate")?;
    let end_date = query_date_param(&params, "endDate")?;
    let account_ids: Vec<i64> = params
        .get("accountIds")
        .into_iter()
        .flat_map(|value| value.split(','))
        .filter_map(parse_int_prefix)
        .collect();
    let account_types: Vec<&str> = params
        .get("accountTypes")
        .into_iter()
        .flat_map(|value| value.split(','))
        .filter(|value| ["asset", "liability", "equity", "income", "expense"].contains(value))
        .collect();
    let (splits, _) = report_splits(
        &state.pool,
        book.book_id,
        start_date.as_deref(),
        end_date.as_deref(),
        &account_ids,
        &account_types,
        None,
    )
    .await
    .map_err(|cause| internal_error(cause, "Failed to fetch report data"))?;
    let accounts: Vec<ReportAccount> = sqlx::query_as(
        "SELECT id, name, type AS account_type, parent_id FROM accounts WHERE book_id = $1",
    )
    .bind(book.book_id)
    .fetch_all(&state.pool)
    .await
    .map_err(|cause| internal_error(cause, "Failed to fetch report data"))?;
    state.analytics.capture_event(
        book.user_id,
        "report_generated",
        Some(json!({
            "bookId": book.book_id, "reportType": "balance-sheet",
        })),
    );
    Ok(Json(
        json!({ "splits": to_value(splits).expect("splits serialize"), "accounts": accounts }),
    ))
}

/// `getIncomeStatement()`: each income and expense account with the sum of
/// its splits in the effective-date range, or of all its splits without
/// one, ordered by type and name.
pub(crate) async fn income_rows(
    pool: &PgPool,
    book_id: i32,
    range: Option<(&str, &str)>,
    include_inactive: bool,
) -> Result<Vec<IncomeRow>, sqlx::Error> {
    let today = local_today();
    let mut query = QueryBuilder::<Postgres>::new(
        "SELECT a.id AS account_id, a.name, a.type AS account_type,
                CAST(COALESCE(SUM(",
    );
    if let Some((start, end)) = range {
        query
            .push("CASE WHEN (CASE WHEN t.is_floating THEN ")
            .push_bind(today.clone())
            .push(" ELSE t.date END) >= ")
            .push_bind(start.to_owned())
            .push(" AND (CASE WHEN t.is_floating THEN ")
            .push_bind(today)
            .push(" ELSE t.date END) <= ")
            .push_bind(end.to_owned())
            .push(" THEN s.amount ELSE 0 END");
    } else {
        query.push("s.amount");
    }
    query
        .push(
            "), 0) AS integer) AS balance
         FROM accounts a LEFT JOIN transaction_splits s ON s.account_id = a.id
         LEFT JOIN transactions t ON t.id = s.transaction_id
         WHERE a.book_id = ",
        )
        .push_bind(book_id)
        .push(" AND a.type IN ('income', 'expense')");
    if !include_inactive {
        query.push(" AND a.is_active");
    }
    query.push(" GROUP BY a.id ORDER BY a.type, a.name");
    query.build_query_as().fetch_all(pool).await
}

pub(crate) async fn income_statement(
    State(state): State<AppState>,
    Path(raw_book_id): Path<String>,
    RawQuery(raw_query): RawQuery,
    headers: HeaderMap,
) -> ApiResult {
    let book = authenticate_book(
        &state,
        &headers,
        &raw_book_id,
        AccessLevel::Read,
        "Failed to fetch income statement",
    )
    .await?;
    let params = first_query_values(raw_query.as_deref());
    let start_date = query_date_param(&params, "startDate")?;
    let end_date = query_date_param(&params, "endDate")?;
    if start_date.is_some() != end_date.is_some() {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "Both startDate and endDate are required",
        ));
    }
    let include_inactive = params
        .get("includeInactive")
        .is_some_and(|value| value == "true");
    let rows = income_rows(
        &state.pool,
        book.book_id,
        start_date.as_deref().zip(end_date.as_deref()),
        include_inactive,
    )
    .await
    .map_err(|cause| internal_error(cause, "Failed to fetch income statement"))?;
    let mut income: i64 = 0;
    let mut expense: i64 = 0;
    for row in &rows {
        if row.account_type == "income" {
            income += i64::from(row.balance);
        } else {
            expense += i64::from(row.balance);
        }
    }
    state.analytics.capture_event(
        book.user_id,
        "report_generated",
        Some(json!({
            "bookId": book.book_id, "reportType": "income-statement",
        })),
    );
    Ok(Json(
        json!({ "accounts": rows, "totals": { "income": income, "expense": expense } }),
    ))
}
