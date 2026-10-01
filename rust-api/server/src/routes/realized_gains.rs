use super::investments::EFFECTIVE_DATE;
use crate::{
    book_auth::{AccessLevel, authenticate_book},
    error::{ApiError, ApiResult, error, internal_error},
    state::AppState,
    validation::{first_query_values, parse_js_number, query_date_param},
};
use axum::{
    Json,
    extract::{Path, RawQuery, State},
    http::{HeaderMap, StatusCode},
};
use chrono::{Datelike, NaiveDate};
use ledger_core::accounting::gross_amount_cents;
use ledger_db::engine::{Db, DbPool};
use serde::Serialize;
use serde_json::{Value, json};
use sqlx::{FromRow, QueryBuilder};

const FAILURE: &str = "Failed to generate realized gains report";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GainRow {
    sell_date: String,
    transaction_id: i32,
    security_id: i32,
    security_symbol: String,
    security_name: String,
    account_id: i32,
    account_name: String,
    shares_micros: i64,
    acquired_date: Option<String>,
    proceeds_cents: i64,
    basis_cents: Option<i64>,
    gain_cents: Option<i64>,
    term: &'static str,
}

#[derive(FromRow)]
struct AllocationRecord {
    sell_date: String,
    transaction_id: i32,
    security_id: i32,
    security_symbol: String,
    security_name: String,
    account_id: i32,
    account_name: String,
    shares_micros: i64,
    acquired_date: String,
    proceeds_cents: i32,
    basis_cents: i32,
}

#[derive(FromRow)]
struct SellRecord {
    sell_date: String,
    transaction_id: i32,
    security_id: i32,
    security_symbol: String,
    security_name: String,
    account_id: i32,
    account_name: String,
    shares_micros: i64,
    price_micros: i64,
    fees_cents: i32,
    allocated_micros: i64,
    allocated_proceeds_cents: i64,
}

/// True when the holding period is longer than one year. JavaScript's
/// `setUTCFullYear` moves 29 February to 1 March in a year without it. A
/// date that JavaScript cannot parse compares false, so the row is short.
fn is_long_term(acquired: &str, sold: &str) -> bool {
    let (Ok(acquired), Ok(sold)) = (
        NaiveDate::parse_from_str(acquired, "%Y-%m-%d"),
        NaiveDate::parse_from_str(sold, "%Y-%m-%d"),
    ) else {
        return false;
    };
    let year = acquired.year() + 1;
    let one_year_later = NaiveDate::from_ymd_opt(year, acquired.month(), acquired.day())
        .or_else(|| NaiveDate::from_ymd_opt(year, 3, 1));
    one_year_later.is_some_and(|limit| sold > limit)
}

/// The filters of `getRealizedGains()`. Each one is optional, and a start
/// date without an end date is valid here: only the route requires the pair.
pub(crate) struct Filters {
    pub(crate) start_date: Option<String>,
    pub(crate) end_date: Option<String>,
    pub(crate) account_id: Option<f64>,
}

/// `realizedGainsQuery`: date formats first, then the date pair, then
/// `Number(accountId)`, which must be a positive integer.
fn parse_filters(raw_query: Option<&str>) -> Result<Filters, ApiError> {
    let params = first_query_values(raw_query);
    let start_date = query_date_param(&params, "startDate")?;
    let end_date = query_date_param(&params, "endDate")?;
    if start_date.is_some() != end_date.is_some() {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "Both startDate and endDate are required",
        ));
    }
    let account_id = match params.get("accountId").filter(|raw| !raw.is_empty()) {
        None => None,
        Some(raw) => Some(
            parse_js_number(raw)
                .filter(|value| value.is_finite() && value.fract() == 0.0 && *value > 0.0)
                .ok_or_else(|| error(StatusCode::BAD_REQUEST, "Invalid accountId"))?,
        ),
    };
    Ok(Filters {
        start_date,
        end_date,
        account_id,
    })
}

fn push_filters(
    query: &mut QueryBuilder<'_, Db>,
    filters: &Filters,
    account_column: &str,
    account_id: Option<i32>,
) {
    if let Some(start) = &filters.start_date {
        query
            .push(format!(" AND {EFFECTIVE_DATE} >= "))
            .push_bind(start.clone());
    }
    if let Some(end) = &filters.end_date {
        query
            .push(format!(" AND {EFFECTIVE_DATE} <= "))
            .push_bind(end.clone());
    }
    if let Some(account_id) = account_id {
        query
            .push(format!(" AND {account_column} = "))
            .push_bind(account_id);
    }
}

/// Sell shares that no lot could satisfy. They are reported with an unknown
/// basis, because a dropped disposal would understate a gain.
async fn unallocated_rows(
    pool: &DbPool,
    book_id: i32,
    filters: &Filters,
    account_id: Option<i32>,
) -> Result<Vec<GainRow>, sqlx::Error> {
    let mut query = QueryBuilder::<Db>::new(format!(
        "SELECT {EFFECTIVE_DATE} AS sell_date, s.transaction_id, s.security_id,
                sec.symbol AS security_symbol, sec.name AS security_name, s.account_id,
                a.name AS account_name, s.shares_micros, s.price_micros, s.fees_cents,
                CAST(COALESCE((SELECT SUM(x.shares_micros) FROM investment_lot_allocations x
                  WHERE x.sell_split_id = s.id), 0) AS bigint) AS allocated_micros,
                CAST(COALESCE((SELECT SUM(x.proceeds_cents) FROM investment_lot_allocations x
                  WHERE x.sell_split_id = s.id), 0) AS bigint) AS allocated_proceeds_cents
         FROM investment_splits s
         JOIN transactions t ON t.id = s.transaction_id
         JOIN securities sec ON sec.id = s.security_id
         JOIN accounts a ON a.id = s.account_id
         WHERE s.book_id = "
    ));
    query.push_bind(book_id).push(" AND s.action = 'sell'");
    push_filters(&mut query, filters, "s.account_id", account_id);
    let sells: Vec<SellRecord> = query.build_query_as().fetch_all(pool).await?;
    Ok(sells
        .into_iter()
        .filter_map(|sell| {
            let unallocated = sell.shares_micros - sell.allocated_micros;
            if unallocated <= 0 {
                return None;
            }
            // The remainder of the sell's net proceeds after its allocations,
            // so the allocated and unallocated parts sum to it exactly.
            let net = gross_amount_cents(sell.shares_micros, sell.price_micros)
                - i64::from(sell.fees_cents);
            Some(GainRow {
                sell_date: sell.sell_date,
                transaction_id: sell.transaction_id,
                security_id: sell.security_id,
                security_symbol: sell.security_symbol,
                security_name: sell.security_name,
                account_id: sell.account_id,
                account_name: sell.account_name,
                shares_micros: unallocated,
                acquired_date: None,
                proceeds_cents: net - sell.allocated_proceeds_cents,
                basis_cents: None,
                gain_cents: None,
                term: "unknown",
            })
        })
        .collect())
}

/// `getRealizedGains()`: one row for each lot a sell drew from, plus a row
/// with an unknown basis for sell shares that no lot covered, and the totals.
/// The route calls this after its query checks; the MCP tool calls it with
/// its own arguments.
pub(crate) async fn report(
    pool: &DbPool,
    book_id: i32,
    filters: &Filters,
    account_id: Option<i32>,
) -> Result<Value, sqlx::Error> {
    let mut query = QueryBuilder::<Db>::new(format!(
        "SELECT {EFFECTIVE_DATE} AS sell_date, al.transaction_id, l.security_id,
                sec.symbol AS security_symbol, sec.name AS security_name, l.account_id,
                a.name AS account_name, al.shares_micros, l.acquired_date, al.proceeds_cents,
                al.basis_cents
         FROM investment_lot_allocations al
         JOIN investment_lots l ON l.id = al.lot_id
         JOIN transactions t ON t.id = al.transaction_id
         JOIN securities sec ON sec.id = l.security_id
         JOIN accounts a ON a.id = l.account_id
         WHERE al.book_id = "
    ));
    query.push_bind(book_id);
    push_filters(&mut query, filters, "l.account_id", account_id);
    query.push(format!(" ORDER BY {EFFECTIVE_DATE}, al.id"));
    let allocations: Vec<AllocationRecord> = query.build_query_as().fetch_all(pool).await?;

    let mut rows: Vec<GainRow> = allocations
        .into_iter()
        .map(|row| {
            let term = if is_long_term(&row.acquired_date, &row.sell_date) {
                "long"
            } else {
                "short"
            };
            GainRow {
                gain_cents: Some(i64::from(row.proceeds_cents) - i64::from(row.basis_cents)),
                sell_date: row.sell_date,
                transaction_id: row.transaction_id,
                security_id: row.security_id,
                security_symbol: row.security_symbol,
                security_name: row.security_name,
                account_id: row.account_id,
                account_name: row.account_name,
                shares_micros: row.shares_micros,
                acquired_date: Some(row.acquired_date),
                proceeds_cents: i64::from(row.proceeds_cents),
                basis_cents: Some(i64::from(row.basis_cents)),
                term,
            }
        })
        .collect();
    rows.extend(unallocated_rows(pool, book_id, filters, account_id).await?);
    rows.sort_by(|a, b| a.sell_date.cmp(&b.sell_date));

    // An unknown-basis row stays out of the totals, so a data gap cannot move
    // a reported gain.
    let (mut short, mut long, mut proceeds, mut basis, mut unknown) =
        (0_i64, 0_i64, 0_i64, 0_i64, 0);
    for row in &rows {
        match (row.term, row.basis_cents, row.gain_cents) {
            ("unknown", _, _) | (_, None, _) | (_, _, None) => unknown += 1,
            (term, Some(row_basis), Some(gain)) => {
                proceeds += row.proceeds_cents;
                basis += row_basis;
                if term == "long" {
                    long += gain;
                } else {
                    short += gain;
                }
            }
        }
    }
    Ok(json!({
        "rows": rows,
        "totals": {
            "shortTermGainCents": short,
            "longTermGainCents": long,
            "proceedsCents": proceeds,
            "basisCents": basis,
            "unknownBasisRows": unknown,
        },
    }))
}

pub(crate) async fn realized_gains(
    State(state): State<AppState>,
    Path(raw_book_id): Path<String>,
    RawQuery(raw_query): RawQuery,
    headers: HeaderMap,
) -> ApiResult {
    let book =
        authenticate_book(&state, &headers, &raw_book_id, AccessLevel::Read, FAILURE).await?;
    let filters = parse_filters(raw_query.as_deref())?;
    // Node sends Number(accountId) to an integer column, which rejects a
    // value outside the int4 range.
    let account_id = filters
        .account_id
        .map(|value| {
            (value <= f64::from(i32::MAX))
                .then_some(value as i32)
                .ok_or_else(|| error(StatusCode::INTERNAL_SERVER_ERROR, FAILURE))
        })
        .transpose()?;

    let report = report(&state.pool, book.book_id, &filters, account_id)
        .await
        .map_err(|cause| internal_error(cause, FAILURE))?;
    state.analytics.capture_event(
        book.user_id,
        "report_generated",
        Some(json!({ "bookId": book.book_id, "reportType": "realized_gains" })),
    );
    Ok(Json(report))
}

#[cfg(test)]
mod tests {
    use super::{is_long_term, parse_filters};

    #[test]
    fn holding_period_follows_javascript_dates() {
        assert!(!is_long_term("2024-01-15", "2025-01-15"));
        assert!(is_long_term("2024-01-15", "2025-01-16"));
        // 2024-02-29 plus one year is 2025-03-01 in JavaScript.
        assert!(!is_long_term("2024-02-29", "2025-03-01"));
        assert!(is_long_term("2024-02-29", "2025-03-02"));
        assert!(!is_long_term("not a date", "2030-01-01"));
    }

    #[test]
    fn filters_report_errors_in_schema_order() {
        let message = |raw: &str| {
            parse_filters(Some(raw))
                .err()
                .map(|error| format!("{error:?}"))
                .unwrap_or_default()
        };
        assert!(message("startDate=bad&accountId=x").contains("Invalid ISO date"));
        assert!(message("startDate=2025-01-01&accountId=x").contains("Both startDate"));
        assert!(message("accountId=1.5").contains("Invalid accountId"));
        assert!(message("accountId=0").contains("Invalid accountId"));
        assert!(message("accountId=Infinity").contains("Invalid accountId"));
        assert_eq!(
            parse_filters(Some("accountId=%205%20")).unwrap().account_id,
            Some(5.0)
        );
        assert_eq!(
            parse_filters(Some("accountId=1e20")).unwrap().account_id,
            Some(1e20)
        );
        assert_eq!(parse_filters(Some("accountId=")).unwrap().account_id, None);
    }
}
