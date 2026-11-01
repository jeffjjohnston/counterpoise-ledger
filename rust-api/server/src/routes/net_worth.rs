//! `GET /api/b/{book_id}/reports/net-worth-history`: the net worth at each
//! month end, for the dashboard chart. With `groupBy=account`, each point
//! also has the value of each top-level asset and liability account.
//! `ledger_core::net_worth` holds the calculation. This module reads the rows.

use crate::{
    book_auth::{AccessLevel, authenticate_book},
    error::{ApiResult, error, internal_error},
    routes::investments::investment_splits,
    state::AppState,
    validation::{first_query_values, local_today, query_date_param},
};
use axum::{
    Json,
    extract::{Path, RawQuery, State},
    http::{HeaderMap, StatusCode},
};
use chrono::NaiveDate;
use ledger_core::{
    investments::SecurityPriceRow,
    net_worth::{
        FixedPrice, MonthTotal, NetWorthInput, TreeAccount, net_worth_by_group, net_worth_series,
        point_dates,
    },
};
use ledger_db::sql::EFFECTIVE_DATE;
use ledger_db::store::{self, Sql, params};
use serde_json::{json, to_value};

const FAILURE: &str = "Failed to fetch net worth history";

pub(crate) async fn net_worth_history(
    State(state): State<AppState>,
    Path(raw_book_id): Path<String>,
    RawQuery(raw_query): RawQuery,
    headers: HeaderMap,
) -> ApiResult {
    let book =
        authenticate_book(&state, &headers, &raw_book_id, AccessLevel::Read, FAILURE).await?;
    let params = first_query_values(raw_query.as_deref());
    let start_date = query_date_param(&params, "startDate")?;
    let end_date = query_date_param(&params, "endDate")?.unwrap_or_else(local_today);
    let by_account = match params.get("groupBy").map(String::as_str) {
        None => false,
        Some("account") => true,
        Some(_) => return Err(error(StatusCode::BAD_REQUEST, "Invalid groupBy")),
    };
    if start_date
        .as_deref()
        .is_some_and(|start| start > end_date.as_str())
    {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "startDate must not be after endDate",
        ));
    }
    let pool = &*state.database;
    let book_id = book.book_id();
    // The first point is the later of the start date and the first transaction.
    // A book with no transaction, or one that starts after the end, has no points.
    let first = first_transaction_date(pool, book_id)
        .map_err(|cause| internal_error(cause, FAILURE))?
        .map(|first| match start_date {
            Some(start) if start > first => start,
            _ => first,
        });
    let Some(first) = first.filter(|first| first.as_str() <= end_date.as_str()) else {
        return Ok(Json(if by_account {
            json!({ "groups": [], "points": [] })
        } else {
            json!({ "points": [] })
        }));
    };
    let dates = point_dates(parse_date(&first)?, parse_date(&end_date)?);
    let input = NetWorthInput {
        dates,
        book_months: book_months(pool, book_id, &end_date)
            .map_err(|cause| internal_error(cause, FAILURE))?,
        splits: investment_splits(pool, book_id, None, Some(&end_date))
            .map_err(|cause| internal_error(cause, FAILURE))?,
        prices: recorded_prices(pool, book_id).map_err(|cause| internal_error(cause, FAILURE))?,
        fixed_prices: fixed_prices(pool, book_id)
            .map_err(|cause| internal_error(cause, FAILURE))?,
        investment_account_ids: investment_accounts(pool, book_id)
            .map_err(|cause| internal_error(cause, FAILURE))?,
    };
    if by_account {
        let accounts =
            book_accounts(pool, book_id).map_err(|cause| internal_error(cause, FAILURE))?;
        let grouped = net_worth_by_group(&input, &accounts);
        return Ok(Json(to_value(grouped).expect("groups serialize")));
    }
    let points = net_worth_series(&input);
    Ok(Json(
        json!({ "points": to_value(points).expect("points serialize") }),
    ))
}

/// A date that the validator or the database gave as "YYYY-MM-DD".
fn parse_date(text: &str) -> Result<NaiveDate, crate::error::ApiError> {
    NaiveDate::parse_from_str(text, "%Y-%m-%d")
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, FAILURE))
}

fn first_transaction_date(pool: &impl Sql, book_id: i32) -> Result<Option<String>, store::Error> {
    pool.query_row(
        &format!("SELECT MIN({EFFECTIVE_DATE}) FROM transactions t WHERE t.book_id = ?1"),
        &params![book_id],
    )
}

/// The split sums by account and month of the asset and liability accounts
/// that are not investment accounts. An investment cash child is an
/// ordinary asset account here.
fn book_months(
    pool: &impl Sql,
    book_id: i32,
    end_date: &str,
) -> Result<Vec<MonthTotal>, store::Error> {
    let rows: Vec<(i32, String, i64)> = pool.query(
        &format!(
            "SELECT s.account_id, substr({EFFECTIVE_DATE}, 1, 7) AS month,
                CAST(SUM(s.amount) AS INTEGER)
         FROM transaction_splits s
         JOIN transactions t ON t.id = s.transaction_id
         JOIN accounts a ON a.id = s.account_id
         WHERE s.book_id = ?1
           AND a.type IN ('asset', 'liability')
           AND (a.subtype IS NULL OR a.subtype <> 'investment')
           AND {EFFECTIVE_DATE} <= ?2
         GROUP BY s.account_id, month
         ORDER BY month, s.account_id"
        ),
        &params![book_id, end_date],
    )?;
    Ok(rows
        .into_iter()
        .map(|(account_id, month, amount_cents)| MonthTotal {
            account_id: i64::from(account_id),
            month,
            amount_cents,
        })
        .collect())
}

fn recorded_prices(pool: &impl Sql, book_id: i32) -> Result<Vec<SecurityPriceRow>, store::Error> {
    let rows: Vec<(i32, i64, String)> = pool.query(
        "SELECT security_id, price_micros, price_date FROM security_prices WHERE book_id = ?1",
        &params![book_id],
    )?;
    Ok(rows
        .into_iter()
        .map(|(security_id, price_micros, price_date)| SecurityPriceRow {
            security_id: i64::from(security_id),
            price_micros,
            price_date,
        })
        .collect())
}

fn fixed_prices(pool: &impl Sql, book_id: i32) -> Result<Vec<FixedPrice>, store::Error> {
    let rows: Vec<(i32, i64)> = pool.query(
        "SELECT id, fixed_price_micros FROM securities
         WHERE book_id = ?1 AND fixed_price_micros IS NOT NULL",
        &params![book_id],
    )?;
    Ok(rows
        .into_iter()
        .map(|(security_id, price_micros)| FixedPrice {
            security_id: i64::from(security_id),
            price_micros,
        })
        .collect())
}

fn investment_accounts(pool: &impl Sql, book_id: i32) -> Result<Vec<i64>, store::Error> {
    let ids: Vec<i32> = pool.query(
        "SELECT id FROM accounts WHERE book_id = ?1 AND subtype = 'investment'",
        &params![book_id],
    )?;
    Ok(ids.into_iter().map(i64::from).collect())
}

/// Each account of the book, with its parent, so that a value can go to its
/// top-level account.
fn book_accounts(pool: &impl Sql, book_id: i32) -> Result<Vec<TreeAccount>, store::Error> {
    let rows: Vec<(i32, Option<i32>, String)> = pool.query(
        "SELECT id, parent_id, name FROM accounts WHERE book_id = ?1",
        &params![book_id],
    )?;
    Ok(rows
        .into_iter()
        .map(|(id, parent_id, name)| TreeAccount {
            id: i64::from(id),
            parent_id: parent_id.map(i64::from),
            name,
        })
        .collect())
}
