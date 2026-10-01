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
use ledger_db::engine::{Db, DbPool};
use serde_json::to_value;
use sqlx::QueryBuilder;
use std::collections::{HashMap, HashSet};

/// `effectiveDateSql`: a floating transaction resolves to today in the
/// session time zone.
pub(crate) const EFFECTIVE_DATE: &str = ledger_db::sql::EFFECTIVE_DATE;

/// The largest integer JavaScript represents exactly. Zod's `int()` rejects
/// anything beyond it.
pub(crate) const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// One investment split, as an element of the JSON array that
/// [`investment_splits`] reads. The types are the column types.
type SplitJson = (
    Option<i32>,
    i32,
    i64,
    i64,
    i32,
    InvestmentAction,
    Option<i32>,
    Option<i32>,
    String,
);

/// Pushes the effective date of the transaction `t`, with today bound as a
/// value. [`EFFECTIVE_DATE`] calls `cp_today()` for each row.
fn push_effective_date(query: &mut QueryBuilder<'_, Db>, today: &str) {
    query
        .push("(CASE WHEN t.is_floating THEN ")
        .push_bind(today.to_owned())
        .push(" ELSE t.date END)");
}

/// The investment splits of the book in the order of the replay: the
/// effective date, then the transaction id, then the split id. With
/// `account_id`, only the splits of that account and the stock splits, which
/// have no account. With `as_of_date`, only the splits on or before that
/// effective date.
///
/// The query gives all the splits as one JSON array in one value. sqlx
/// copies each column value of each row. In the production image (musl), the
/// 4,041 splits of a large book took about 10 ms as rows and 2.2 ms as one
/// array, and the query without its output took 0.9 ms.
async fn investment_splits(
    pool: &DbPool,
    book_id: i32,
    account_id: Option<i32>,
    as_of_date: Option<&str>,
) -> Result<Vec<InvestmentSplitRow>, sqlx::Error> {
    let today = local_today();
    let mut query = QueryBuilder::<Db>::new(
        "SELECT json_group_array(json_array(s.account_id, s.security_id, s.shares_micros,
                s.price_micros, s.fees_cents, s.action, s.split_numerator,
                s.split_denominator, ",
    );
    push_effective_date(&mut query, &today);
    query.push(") ORDER BY ");
    push_effective_date(&mut query, &today);
    query
        .push(
            ", t.id, s.id)
         FROM investment_splits s JOIN transactions t ON t.id = s.transaction_id
         WHERE s.book_id = ",
        )
        .push_bind(book_id);
    if let Some(account_id) = account_id {
        // A stock split has no account and applies to every account.
        query
            .push(" AND (s.account_id = ")
            .push_bind(account_id)
            .push(" OR (s.account_id IS NULL AND s.action = 'split'))");
    }
    if let Some(as_of_date) = as_of_date {
        query.push(" AND ");
        push_effective_date(&mut query, &today);
        query.push(" <= ").push_bind(as_of_date.to_owned());
    }
    let text: String = query.build_query_scalar().fetch_one(pool).await?;
    let splits: Vec<SplitJson> =
        serde_json::from_str(&text).map_err(|cause| sqlx::Error::Decode(Box::new(cause)))?;
    Ok(splits
        .into_iter()
        .map(
            |(
                account_id,
                security_id,
                shares_micros,
                price_micros,
                fees_cents,
                action,
                split_numerator,
                split_denominator,
                transaction_date,
            )| InvestmentSplitRow {
                security_id: i64::from(security_id),
                shares_micros,
                price_micros,
                fees_cents: i64::from(fees_cents),
                action,
                split_numerator: split_numerator.map(i64::from),
                split_denominator: split_denominator.map(i64::from),
                transaction_date,
                account_id: account_id.map(i64::from),
            },
        )
        .collect())
}

/// `getLatestPrices`: the newest recorded price of each security. A fixed
/// price replaces every recorded price, dated today so it wins every "newest"
/// comparison.
pub(super) async fn latest_prices(
    pool: &DbPool,
    book_id: i32,
) -> Result<Vec<SecurityPriceRow>, sqlx::Error> {
    let recorded: Vec<(i32, i64, String)> = sqlx::query_as(
        "SELECT s.id, p.price_micros, p.price_date
         FROM securities s
         JOIN security_prices p ON p.security_id = s.id AND p.book_id = $1
         WHERE s.book_id = $1
           AND p.price_date = (SELECT MAX(q.price_date) FROM security_prices q
                               WHERE q.security_id = s.id AND q.book_id = $1)",
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
    pool: &DbPool,
    book_id: i32,
    account_id: Option<i32>,
) -> Result<Vec<PositionSummary>, sqlx::Error> {
    let splits = investment_splits(pool, book_id, account_id, None).await?;
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

    let mut basis = QueryBuilder::<Db>::new(
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
    let splits = investment_splits(&state.pool, book.book_id, None, as_of_date.as_deref())
        .await
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
    use super::{investment_splits, positions_account_id};
    use ledger_core::accounting::InvestmentAction::{self, Buy, Sell, Split};

    type Columns = (
        Option<i64>,
        i64,
        i64,
        i64,
        i64,
        InvestmentAction,
        Option<i64>,
        Option<i64>,
        String,
    );

    /// Each column of each split, in the replay order: the effective date,
    /// then the transaction id, then the split id. A floating transaction
    /// is dated today. The account filter keeps the stock split, which has
    /// no account, and the date filter uses the effective date.
    #[tokio::test]
    async fn investment_splits_read_each_column_in_replay_order() {
        let database = ledger_db::testing::TempDatabase::new(1).await;
        let pool = database.pool();
        let now = chrono::Utc::now().naive_utc();
        for sql in [
            "INSERT INTO users (id, username, password_hash, created_at) VALUES (1, 'u', 'h', $1)",
            "INSERT INTO books (id, user_id, name, created_at, updated_at) VALUES (1, 1, 'A', $1, $1)",
            "INSERT INTO accounts (id, book_id, name, type, created_at, updated_at) VALUES
               (1, 1, 'Brokerage', 'asset', $1, $1), (2, 1, 'IRA', 'asset', $1, $1)",
            "INSERT INTO securities (id, book_id, name, symbol, security_type, created_at)
               VALUES (7, 1, 'Fund', 'FND', 'fund', $1)",
            "INSERT INTO transactions (id, book_id, date, is_floating, created_at, updated_at) VALUES
               (1, 1, '2025-01-05', 0, $1, $1), (2, 1, '2025-01-05', 0, $1, $1),
               (3, 1, '2024-12-01', 1, $1, $1), (4, 1, '2025-02-01', 0, $1, $1)",
            "INSERT INTO investment_splits (id, book_id, transaction_id, account_id, security_id,
               action, shares_micros, price_micros, fees_cents, split_numerator, split_denominator)
             VALUES (1, 1, 2, 1, 7, 'buy', 3000000, 10000000, 5, NULL, NULL),
                    (2, 1, 1, 1, 7, 'sell', 1000000, 11000000, 0, NULL, NULL),
                    (3, 1, 3, 1, 7, 'buy', 2000000, 12000000, 0, NULL, NULL),
                    (4, 1, 4, NULL, 7, 'split', 0, 0, 0, 2, 1),
                    (5, 1, 1, 2, 7, 'buy', 4000000, 9000000, 1, NULL, NULL)",
        ] {
            sqlx::query(sql).bind(now).execute(pool).await.unwrap();
        }
        let today = crate::validation::local_today();
        let splits = |account_id, as_of_date| async move {
            investment_splits(pool, 1, account_id, as_of_date)
                .await
                .unwrap()
                .into_iter()
                .map(|row| {
                    (
                        row.account_id,
                        row.security_id,
                        row.shares_micros,
                        row.price_micros,
                        row.fees_cents,
                        row.action,
                        row.split_numerator,
                        row.split_denominator,
                        row.transaction_date,
                    )
                })
                .collect::<Vec<Columns>>()
        };
        let row = |id: usize| -> Columns {
            let date = |value: &str| value.to_owned();
            match id {
                1 => (
                    Some(1),
                    7,
                    3_000_000,
                    10_000_000,
                    5,
                    Buy,
                    None,
                    None,
                    date("2025-01-05"),
                ),
                2 => (
                    Some(1),
                    7,
                    1_000_000,
                    11_000_000,
                    0,
                    Sell,
                    None,
                    None,
                    date("2025-01-05"),
                ),
                3 => (
                    Some(1),
                    7,
                    2_000_000,
                    12_000_000,
                    0,
                    Buy,
                    None,
                    None,
                    today.clone(),
                ),
                4 => (
                    None,
                    7,
                    0,
                    0,
                    0,
                    Split,
                    Some(2),
                    Some(1),
                    date("2025-02-01"),
                ),
                _ => (
                    Some(2),
                    7,
                    4_000_000,
                    9_000_000,
                    1,
                    Buy,
                    None,
                    None,
                    date("2025-01-05"),
                ),
            }
        };
        assert_eq!(
            splits(None, None).await,
            [row(2), row(5), row(1), row(4), row(3)]
        );
        assert_eq!(
            splits(Some(1), None).await,
            [row(2), row(1), row(4), row(3)]
        );
        assert_eq!(
            splits(None, Some("2025-01-31")).await,
            [row(2), row(5), row(1)]
        );
    }

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
