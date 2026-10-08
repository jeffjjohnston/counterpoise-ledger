//! `GET /api/b/{book_id}/accounts/{id}/balance-history`: the balance of one
//! account at each month end, for the register chart. The account lookup and
//! the balance before a date are shared with the MCP tool
//! `get_account_balance_history`.

use crate::{
    book_auth::{AccessLevel, authenticate_book},
    error::{ApiError, ApiResult, error, internal_error},
    state::AppState,
    validation::{first_query_values, local_today, parse_int_auto_radix, query_date_param},
};
use axum::{
    Json,
    extract::{Path, RawQuery, State},
    http::{HeaderMap, StatusCode},
};
use chrono::NaiveDate;
use ledger_core::net_worth::point_dates;
use ledger_db::{engine::DbPool, sql::EFFECTIVE_DATE};
use serde::Serialize;
use serde_json::{json, to_value};

const FAILURE: &str = "Failed to fetch account balance history";

/// An account of a book.
pub(crate) struct BookAccount {
    pub(crate) id: i32,
    pub(crate) name: String,
    pub(crate) account_type: String,
}

/// The account `account_id` when it belongs to the book, else `None`.
pub(crate) async fn find_book_account(
    pool: &DbPool,
    book_id: i32,
    account_id: i32,
) -> Result<Option<BookAccount>, sqlx::Error> {
    let row: Option<(i32, String, String)> =
        sqlx::query_as("SELECT id, name, type FROM accounts WHERE book_id = $1 AND id = $2")
            .bind(book_id)
            .bind(account_id)
            .fetch_optional(pool)
            .await?;
    Ok(row.map(|(id, name, account_type)| BookAccount {
        id,
        name,
        account_type,
    }))
}

/// The sum of the own splits of the account with an effective date before
/// `date`. The splits of a child account are not included, as in the
/// register.
pub(crate) async fn balance_before(
    pool: &DbPool,
    book_id: i32,
    account_id: i32,
    date: &str,
) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar(&format!(
        "SELECT CAST(COALESCE(SUM(s.amount), 0) AS INTEGER) FROM transaction_splits s
         JOIN transactions t ON s.transaction_id = t.id
         WHERE s.book_id = $1 AND s.account_id = $2 AND {EFFECTIVE_DATE} < $3"
    ))
    .bind(book_id)
    .bind(account_id)
    .bind(date)
    .fetch_one(pool)
    .await
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct BalancePoint {
    date: String,
    balance_cents: i64,
}

pub(crate) async fn account_balance_history(
    State(state): State<AppState>,
    Path((raw_book_id, raw_id)): Path<(String, String)>,
    RawQuery(raw_query): RawQuery,
    headers: HeaderMap,
) -> ApiResult {
    let book =
        authenticate_book(&state, &headers, &raw_book_id, AccessLevel::Read, FAILURE).await?;
    let account_id = parse_int_auto_radix(&raw_id)
        .and_then(|id| i32::try_from(id).ok())
        .ok_or_else(|| error(StatusCode::BAD_REQUEST, "Invalid account id"))?;
    let params = first_query_values(raw_query.as_deref());
    let start_date = query_date_param(&params, "startDate")?;
    let end_date = query_date_param(&params, "endDate")?.unwrap_or_else(local_today);
    if start_date
        .as_deref()
        .is_some_and(|start| start > end_date.as_str())
    {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "startDate must not be after endDate",
        ));
    }
    let pool = &state.pool;
    let book_id = book.book_id;
    let db_error = |cause| internal_error(cause, FAILURE);
    let account = find_book_account(pool, book_id, account_id)
        .await
        .map_err(db_error)?
        .ok_or_else(|| error(StatusCode::NOT_FOUND, "Account not found"))?;

    // The first point is in the month of the later of the start date and the
    // first split. An account with no split, or one whose first split is after
    // the end, has no points.
    let first = first_split_date(pool, book_id, account.id)
        .await
        .map_err(db_error)?
        .map(|first| match start_date {
            Some(start) if start > first => start,
            _ => first,
        });
    let Some(first) = first.filter(|first| first.as_str() <= end_date.as_str()) else {
        return Ok(Json(json!({ "points": [] })));
    };
    let dates = point_dates(parse_date(&first)?, parse_date(&end_date)?);
    let starting = balance_before(pool, book_id, account.id, &first)
        .await
        .map_err(db_error)?;
    let days = day_totals(pool, book_id, account.id, &first, &end_date)
        .await
        .map_err(db_error)?;
    let points = balance_points(&dates, starting, &days);
    Ok(Json(
        json!({ "points": to_value(points).expect("points serialize") }),
    ))
}

/// A date that the validator or the database gave as "YYYY-MM-DD".
fn parse_date(text: &str) -> Result<NaiveDate, ApiError> {
    NaiveDate::parse_from_str(text, "%Y-%m-%d")
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, FAILURE))
}

async fn first_split_date(
    pool: &DbPool,
    book_id: i32,
    account_id: i32,
) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar(&format!(
        "SELECT MIN({EFFECTIVE_DATE}) FROM transaction_splits s
         JOIN transactions t ON s.transaction_id = t.id
         WHERE s.book_id = $1 AND s.account_id = $2"
    ))
    .bind(book_id)
    .bind(account_id)
    .fetch_one(pool)
    .await
}

/// The split sum of the account on each effective date from `start` to
/// `end`, ascending. A date without splits has no row.
async fn day_totals(
    pool: &DbPool,
    book_id: i32,
    account_id: i32,
    start: &str,
    end: &str,
) -> Result<Vec<(String, i64)>, sqlx::Error> {
    sqlx::query_as(&format!(
        "SELECT {EFFECTIVE_DATE} AS day, CAST(SUM(s.amount) AS INTEGER)
         FROM transaction_splits s
         JOIN transactions t ON s.transaction_id = t.id
         WHERE s.book_id = $1 AND s.account_id = $2
           AND {EFFECTIVE_DATE} >= $3 AND {EFFECTIVE_DATE} <= $4
         GROUP BY day
         ORDER BY day"
    ))
    .bind(book_id)
    .bind(account_id)
    .bind(start)
    .bind(end)
    .fetch_all(pool)
    .await
}

/// The balance at each date: `starting` plus the day totals on or before it.
/// `dates` and `days` are ascending.
fn balance_points(dates: &[String], starting: i64, days: &[(String, i64)]) -> Vec<BalancePoint> {
    let mut balance = starting;
    let mut next = days.iter().peekable();
    dates
        .iter()
        .map(|date| {
            while let Some((_, amount)) = next.next_if(|(day, _)| day <= date) {
                balance += amount;
            }
            BalancePoint {
                date: date.clone(),
                balance_cents: balance,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn day(date: &str, amount: i64) -> (String, i64) {
        (date.to_owned(), amount)
    }

    #[test]
    fn each_point_adds_the_days_up_to_and_including_its_date() {
        let dates = ["2026-01-31", "2026-02-28", "2026-03-20"].map(str::to_owned);
        let days = [
            day("2026-01-05", 500),
            day("2026-01-31", -100),
            day("2026-03-01", 40),
        ];
        let points = balance_points(&dates, 1_000, &days);
        let balances: Vec<i64> = points.iter().map(|point| point.balance_cents).collect();
        // 1,000 + 500 - 100 on Jan 31, no change in February, + 40 in March.
        assert_eq!(balances, [1_400, 1_400, 1_440]);
    }

    #[test]
    fn no_days_keeps_the_starting_balance() {
        let dates = ["2026-01-31".to_owned()];
        assert_eq!(
            balance_points(&dates, -250, &[]),
            [BalancePoint {
                date: "2026-01-31".to_owned(),
                balance_cents: -250,
            }]
        );
    }
}
