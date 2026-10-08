//! GET /transactions/changes: the delta sync of a native client.
//!
//! Without `since`, the route pages the transactions of the book by ID. With
//! `since`, it gives the transactions that changed after that cursor, from the
//! log that the triggers of migration 0003 write. The cursor is the newest
//! `seq` of the full log. The handler reads in one read transaction, so the
//! cursor and the rows agree.
//!
//! A log row of book 0 is a floor marker (`SYNC_FLOOR_BOOK_ID`). A cursor
//! below the newest marker is from before a restore, and gets 410.

use crate::{
    book_auth::{AccessLevel, authenticate_book},
    error::{ApiError, ApiResult, error, internal_error},
    routes::transactions::load_transactions,
    state::AppState,
    validation::first_query_values,
};
use axum::{
    Json,
    extract::{Path, RawQuery, State},
    http::{HeaderMap, StatusCode},
};
use ledger_db::{backup::SYNC_FLOOR_BOOK_ID, locks};
use serde_json::json;
use std::collections::{HashMap, HashSet};

const FAILURE: &str = "Failed to fetch transaction changes";
const DEFAULT_LIMIT: i64 = 2000;
const MAX_LIMIT: i64 = 5000;
/// A delta with more changed transactions than this is refused. The client
/// then downloads the full book, which costs less.
const MAX_DELTA: usize = 5000;
const FUTURE_CURSOR: &str =
    "The sync cursor is newer than the change log. Download all transactions again.";
const RESTORED: &str =
    "The database was restored after the sync cursor. Download all transactions again.";
const TOO_MANY_CHANGES: &str =
    "Too many transactions changed since the sync cursor. Download all transactions again.";

#[derive(Debug, PartialEq)]
enum Mode {
    Full { after_id: i64, limit: i64 },
    Delta { since: i64 },
}

/// A query value as a non-negative integer: decimal digits only, in the
/// range of `i64`. A cursor has 16 digits or more, because the log starts at
/// the time of migration 0003 in microseconds.
fn non_negative(value: &str, message: &'static str) -> Result<i64, ApiError> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(error(StatusCode::BAD_REQUEST, message));
    }
    value
        .parse()
        .map_err(|_| error(StatusCode::BAD_REQUEST, message))
}

fn validate_query(params: &HashMap<String, String>) -> Result<Mode, ApiError> {
    let after_id = params.get("afterId");
    let limit = params.get("limit");
    if let Some(since) = params.get("since") {
        if after_id.is_some() || limit.is_some() {
            return Err(error(
                StatusCode::BAD_REQUEST,
                "since cannot be combined with afterId or limit",
            ));
        }
        return Ok(Mode::Delta {
            since: non_negative(since, "Invalid since")?,
        });
    }
    let limit = match limit {
        None => DEFAULT_LIMIT,
        Some(value) => match non_negative(value, "Invalid limit")? {
            limit @ 1..=MAX_LIMIT => limit,
            _ => return Err(error(StatusCode::BAD_REQUEST, "Invalid limit")),
        },
    };
    Ok(Mode::Full {
        after_id: after_id
            .map(|value| non_negative(value, "Invalid afterId"))
            .transpose()?
            .unwrap_or(0),
        limit,
    })
}

pub(crate) async fn list_transaction_changes(
    State(state): State<AppState>,
    Path(raw_book_id): Path<String>,
    RawQuery(raw_query): RawQuery,
    headers: HeaderMap,
) -> ApiResult {
    let book =
        authenticate_book(&state, &headers, &raw_book_id, AccessLevel::Read, FAILURE).await?;
    let mode = validate_query(&first_query_values(raw_query.as_deref()))?;
    let db_error = |cause| internal_error(cause, FAILURE);

    let mut connection = state.pool.acquire().await.map_err(db_error)?;
    let mut transaction = locks::begin_read(&mut connection).await.map_err(db_error)?;
    // The first read takes the snapshot of the transaction.
    let cursor: i64 = sqlx::query_scalar("SELECT coalesce(max(seq), 0) FROM transaction_changes")
        .fetch_one(&mut *transaction)
        .await
        .map_err(db_error)?;

    let body = match mode {
        Mode::Full { after_id, limit } => {
            let mut ids: Vec<i32> = sqlx::query_scalar(
                "SELECT id FROM transactions WHERE book_id = $1 AND id > $2 ORDER BY id LIMIT $3",
            )
            .bind(book.book_id)
            .bind(after_id)
            .bind(limit + 1)
            .fetch_all(&mut *transaction)
            .await
            .map_err(db_error)?;
            let has_more = ids.len() as i64 > limit;
            ids.truncate(limit as usize);
            let transactions = load_transactions(&mut transaction, book.book_id, &ids)
                .await
                .map_err(db_error)?;
            json!({
                "cursor": cursor,
                "transactions": transactions,
                "deletedIds": [],
                "hasMore": has_more,
            })
        }
        Mode::Delta { since } => {
            // A cursor from a newer log, for example from before a restore.
            if since > cursor {
                return Err(error(StatusCode::GONE, FUTURE_CURSOR));
            }
            let floor: i64 = sqlx::query_scalar(
                "SELECT coalesce(max(seq), 0) FROM transaction_changes WHERE book_id = $1",
            )
            .bind(SYNC_FLOOR_BOOK_ID)
            .fetch_one(&mut *transaction)
            .await
            .map_err(db_error)?;
            if since < floor {
                return Err(error(StatusCode::GONE, RESTORED));
            }
            let ids: Vec<i32> = sqlx::query_scalar(
                "SELECT DISTINCT transaction_id FROM transaction_changes
                 WHERE book_id = $1 AND seq > $2 ORDER BY transaction_id LIMIT $3",
            )
            .bind(book.book_id)
            .bind(since)
            .bind(MAX_DELTA as i64 + 1)
            .fetch_all(&mut *transaction)
            .await
            .map_err(db_error)?;
            if ids.len() > MAX_DELTA {
                return Err(error(StatusCode::GONE, TOO_MANY_CHANGES));
            }
            let transactions = load_transactions(&mut transaction, book.book_id, &ids)
                .await
                .map_err(db_error)?;
            // A logged ID that is not a transaction of this book is deleted.
            let found: HashSet<i64> = transactions
                .iter()
                .filter_map(|transaction| transaction["id"].as_i64())
                .collect();
            let deleted_ids: Vec<i32> = ids
                .into_iter()
                .filter(|id| !found.contains(&i64::from(*id)))
                .collect();
            json!({
                "cursor": cursor,
                "transactions": transactions,
                "deletedIds": deleted_ids,
                "hasMore": false,
            })
        }
    };
    transaction.commit().await.map_err(db_error)?;
    Ok(Json(body))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn query(pairs: &[(&str, &str)]) -> Result<Mode, ApiError> {
        validate_query(
            &pairs
                .iter()
                .map(|(key, value)| (key.to_string(), value.to_string()))
                .collect(),
        )
    }

    #[test]
    fn full_mode_has_defaults_and_bounds() {
        assert_eq!(
            query(&[]).unwrap(),
            Mode::Full {
                after_id: 0,
                limit: 2000
            }
        );
        assert_eq!(
            query(&[("afterId", "17"), ("limit", "5000")]).unwrap(),
            Mode::Full {
                after_id: 17,
                limit: 5000
            }
        );
        for limit in ["0", "5001", "", "-1", "1.5", "abc", "99999999999999999999"] {
            assert!(query(&[("limit", limit)]).is_err(), "limit {limit}");
        }
        for after_id in ["", "-1", "+1", "1e3"] {
            assert!(
                query(&[("afterId", after_id)]).is_err(),
                "afterId {after_id}"
            );
        }
    }

    #[test]
    fn delta_mode_takes_since_alone() {
        assert_eq!(query(&[("since", "0")]).unwrap(), Mode::Delta { since: 0 });
        // A cursor from the migration's floor marker, and the largest i64.
        assert_eq!(
            query(&[("since", "1791047750000000")]).unwrap(),
            Mode::Delta {
                since: 1_791_047_750_000_000
            }
        );
        assert_eq!(
            query(&[("since", "9223372036854775807")]).unwrap(),
            Mode::Delta { since: i64::MAX }
        );
        assert!(query(&[("since", "9223372036854775808")]).is_err());
        assert!(query(&[("since", "-1")]).is_err());
        assert!(query(&[("since", "1"), ("afterId", "1")]).is_err());
        assert!(query(&[("since", "1"), ("limit", "10")]).is_err());
    }
}
