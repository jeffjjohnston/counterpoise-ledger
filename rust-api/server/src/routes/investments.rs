use crate::{
    book_auth::{AccessLevel, authenticate_book},
    error::{ApiError, ApiResult, error, internal_error},
    state::AppState,
    validation::{first_query_values, local_today, parse_js_number, query_date_param},
};
use axum::{
    Json,
    extract::{Path, RawQuery, State},
    http::{HeaderMap, StatusCode},
};
use ledger_core::{
    accounting::InvestmentAction,
    investments::{
        InvestmentSplitRow, MarketValueInput, PositionInput, PositionSummary, SecurityPriceRow,
        SecurityRow, aggregate_market_values_by_account, aggregate_positions, fixed_price_row,
    },
};
use serde_json::to_value;
use sqlx::{PgPool, Postgres, QueryBuilder, Row, postgres::PgRow};
use std::collections::{HashMap, HashSet};

/// `effectiveDateSql`: a floating transaction resolves to today in the
/// session time zone.
pub(crate) const EFFECTIVE_DATE: &str =
    "CASE WHEN t.is_floating THEN CURRENT_DATE::text ELSE t.date END";

/// The largest integer JavaScript represents exactly. Zod's `int()` rejects
/// anything beyond it.
pub(crate) const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

pub(super) fn investment_action(value: &str) -> Result<InvestmentAction, sqlx::Error> {
    serde_json::from_value(serde_json::Value::String(value.to_owned()))
        .map_err(|cause| sqlx::Error::Decode(Box::new(cause)))
}

fn split_row(row: &PgRow) -> Result<InvestmentSplitRow, sqlx::Error> {
    Ok(InvestmentSplitRow {
        security_id: i64::from(row.try_get::<i32, _>("security_id")?),
        shares_micros: row.try_get("shares_micros")?,
        price_micros: row.try_get("price_micros")?,
        fees_cents: i64::from(row.try_get::<i32, _>("fees_cents")?),
        action: investment_action(row.try_get("action")?)?,
        split_numerator: row
            .try_get::<Option<i32>, _>("split_numerator")?
            .map(i64::from),
        split_denominator: row
            .try_get::<Option<i32>, _>("split_denominator")?
            .map(i64::from),
        transaction_date: row.try_get("transaction_date")?,
        account_id: row.try_get::<Option<i32>, _>("account_id")?.map(i64::from),
    })
}

fn split_query<'a>() -> QueryBuilder<'a, Postgres> {
    QueryBuilder::new(format!(
        "SELECT s.account_id, s.security_id, s.shares_micros, s.price_micros, s.fees_cents,
                s.action, s.split_numerator, s.split_denominator,
                {EFFECTIVE_DATE} AS transaction_date
         FROM investment_splits s JOIN transactions t ON t.id = s.transaction_id
         WHERE s.book_id = "
    ))
}

/// `getLatestPrices`: the newest recorded price of each security. A fixed
/// price replaces every recorded price, dated today so it wins every "newest"
/// comparison.
pub(super) async fn latest_prices(
    pool: &PgPool,
    book_id: i32,
) -> Result<Vec<SecurityPriceRow>, sqlx::Error> {
    let recorded: Vec<(i32, i64, String)> = sqlx::query_as(
        "SELECT s.id, latest.price_micros, latest.price_date
         FROM securities s
         CROSS JOIN LATERAL (
           SELECT p.price_micros, p.price_date FROM security_prices p
           WHERE p.security_id = s.id AND p.book_id = $1
           ORDER BY p.price_date DESC LIMIT 1
         ) latest
         WHERE s.book_id = $1",
    )
    .bind(book_id)
    .fetch_all(pool)
    .await?;
    let fixed: Vec<(i32, i64)> = sqlx::query_as(
        "SELECT id, fixed_price_micros FROM securities
         WHERE book_id = $1 AND fixed_price_micros IS NOT NULL",
    )
    .bind(book_id)
    .fetch_all(pool)
    .await?;
    let fixed_ids: HashSet<i32> = fixed.iter().map(|(id, _)| *id).collect();
    let today = local_today();
    Ok(recorded
        .into_iter()
        .filter(|(id, _, _)| !fixed_ids.contains(id))
        .map(|(id, price_micros, price_date)| SecurityPriceRow {
            security_id: i64::from(id),
            price_micros,
            price_date,
        })
        .chain(
            fixed
                .into_iter()
                .map(|(id, price)| fixed_price_row(i64::from(id), price, &today)),
        )
        .collect())
}

/// `getPositions`: shares, price, and market value from the split replay;
/// cost basis from the open FIFO lots. `account_id` follows the Node truthy
/// check, so zero means the whole book.
pub(super) async fn positions(
    pool: &PgPool,
    book_id: i32,
    account_id: Option<i32>,
) -> Result<Vec<PositionSummary>, sqlx::Error> {
    let mut query = split_query();
    query.push_bind(book_id);
    if let Some(account_id) = account_id {
        // A stock split has no account and applies to every account.
        query
            .push(" AND (s.account_id = ")
            .push_bind(account_id)
            .push(" OR (s.account_id IS NULL AND s.action = 'split'))");
    }
    query.push(format!(" ORDER BY {EFFECTIVE_DATE}, t.id, s.id"));
    let splits = query
        .build()
        .fetch_all(pool)
        .await?
        .iter()
        .map(split_row)
        .collect::<Result<Vec<_>, _>>()?;
    let securities: Vec<(i32, String, String)> =
        sqlx::query_as("SELECT id, name, symbol FROM securities WHERE book_id = $1")
            .bind(book_id)
            .fetch_all(pool)
            .await?;
    let prices = latest_prices(pool, book_id).await?;
    let positions = aggregate_positions(&PositionInput {
        splits,
        securities: securities
            .into_iter()
            .map(|(id, name, symbol)| SecurityRow {
                id: i64::from(id),
                name,
                symbol,
            })
            .collect(),
        prices,
    });

    let mut basis = QueryBuilder::<Postgres>::new(
        "SELECT security_id, CAST(COALESCE(SUM(remaining_basis_cents), 0) AS integer)
         FROM investment_lots WHERE book_id = ",
    );
    basis.push_bind(book_id);
    if let Some(account_id) = account_id {
        basis.push(" AND account_id = ").push_bind(account_id);
    }
    basis.push(" AND remaining_shares_micros > 0 GROUP BY security_id");
    let basis: HashMap<i64, i64> = basis
        .build_query_as::<(i32, i32)>()
        .fetch_all(pool)
        .await?
        .into_iter()
        .map(|(security_id, cents)| (i64::from(security_id), i64::from(cents)))
        .collect();
    let missing = positions
        .iter()
        .filter(|position| !basis.contains_key(&position.security_id))
        .count();
    if missing > 0 {
        tracing::warn!(
            book_id,
            missing,
            "positions have shares but no lot-basis row; run the lot rebuild"
        );
    }
    Ok(positions
        .into_iter()
        .map(|position| PositionSummary {
            cost_basis_cents: basis.get(&position.security_id).copied().unwrap_or(0),
            ..position
        })
        .collect())
}

/// `positionsQuery`: an explicit empty `accountId` is invalid, and the value
/// passes through `Number()` and zod's safe-integer check.
fn positions_account_id(raw: Option<&String>) -> Result<Option<i64>, ApiError> {
    let Some(raw) = raw else { return Ok(None) };
    let invalid = || error(StatusCode::BAD_REQUEST, "Invalid accountId");
    if raw.is_empty() {
        return Err(invalid());
    }
    let value = parse_js_number(raw)
        .filter(|value| {
            value.is_finite() && value.fract() == 0.0 && value.abs() <= MAX_SAFE_INTEGER
        })
        .ok_or_else(invalid)?;
    Ok(Some(value as i64))
}

pub(crate) async fn get_positions(
    State(state): State<AppState>,
    Path(raw_book_id): Path<String>,
    RawQuery(raw_query): RawQuery,
    headers: HeaderMap,
) -> ApiResult {
    const FAILURE: &str = "Failed to fetch positions";
    let book =
        authenticate_book(&state, &headers, &raw_book_id, AccessLevel::Read, FAILURE).await?;
    let params = first_query_values(raw_query.as_deref());
    let account_id = match positions_account_id(params.get("accountId"))? {
        None | Some(0) => None,
        // Node sends the number to an integer column, which rejects a value
        // outside the int4 range.
        Some(id) => {
            Some(i32::try_from(id).map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, FAILURE))?)
        }
    };
    let rows = positions(&state.pool, book.book_id, account_id)
        .await
        .map_err(|cause| internal_error(cause, FAILURE))?;
    Ok(Json(to_value(rows).expect("positions serialize")))
}

pub(crate) async fn account_values(
    State(state): State<AppState>,
    Path(raw_book_id): Path<String>,
    RawQuery(raw_query): RawQuery,
    headers: HeaderMap,
) -> ApiResult {
    const FAILURE: &str = "Failed to fetch account market values";
    let book =
        authenticate_book(&state, &headers, &raw_book_id, AccessLevel::Read, FAILURE).await?;
    let params = first_query_values(raw_query.as_deref());
    let as_of_date = query_date_param(&params, "asOfDate")?;
    let mut query = split_query();
    query.push_bind(book.book_id);
    if let Some(as_of_date) = &as_of_date {
        query
            .push(format!(" AND {EFFECTIVE_DATE} <= "))
            .push_bind(as_of_date);
    }
    query.push(format!(" ORDER BY {EFFECTIVE_DATE}, t.id, s.id"));
    let splits = query
        .build()
        .fetch_all(&state.pool)
        .await
        .map_err(|cause| internal_error(cause, FAILURE))?
        .iter()
        .map(split_row)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|cause| internal_error(cause, FAILURE))?;
    // Prices are not limited by asOfDate: an as-of value combines that date's
    // shares with today's prices, as the Node route does.
    let prices = latest_prices(&state.pool, book.book_id)
        .await
        .map_err(|cause| internal_error(cause, FAILURE))?;
    let values = aggregate_market_values_by_account(&MarketValueInput { splits, prices });
    Ok(Json(to_value(values).expect("market values serialize")))
}

#[cfg(test)]
mod tests {
    use super::positions_account_id;

    #[test]
    fn positions_account_id_matches_the_zod_schema() {
        let parse = |raw: &str| positions_account_id(Some(&raw.to_owned())).ok().flatten();
        assert_eq!(parse(" "), Some(0));
        assert_eq!(parse("0x10"), Some(16));
        assert_eq!(parse("-3"), Some(-3));
        for raw in ["", "5.5", "1e20", "Infinity", "abc", "9007199254740993"] {
            assert!(
                positions_account_id(Some(&raw.to_owned())).is_err(),
                "{raw}"
            );
        }
        assert_eq!(positions_account_id(None).unwrap(), None);
    }
}
