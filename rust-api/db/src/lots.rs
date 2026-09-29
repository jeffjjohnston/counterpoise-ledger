//! Persistence for the FIFO lot engine, ported from `lib/lots-db.ts`.
//!
//! `rebuild_lots` is the only code that inserts rows into `investment_lots`
//! or `investment_lot_allocations`. A write path calls it inside the same
//! transaction as the write, so a pair's splits and its lots change together.
//! Rows also disappear through foreign-key cascades when a transaction, an
//! investment split, or a lot is deleted. Those cascades are in the DDL, not
//! in this file.

use std::collections::{HashMap, HashSet};

use chrono::Utc;
use ledger_core::{
    accounting::InvestmentAction,
    lots::{ReplaySplit, replay_lots},
};
use sqlx::{PgConnection, PgPool, Postgres, QueryBuilder, Row};

/// One (account, security) pair. Account and security IDs are global serials,
/// so the pair alone identifies a set of lots.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct LotPair {
    pub account_id: i32,
    pub security_id: i32,
}

/// The effective date: a floating transaction resolves to today in the
/// session time zone, as `effectiveDateSql` does.
const EFFECTIVE_DATE: &str = "CASE WHEN t.is_floating THEN CURRENT_DATE::text ELSE t.date END";

/// PostgreSQL accepts at most 65,535 bind parameters in one statement.
const INSERT_CHUNK_ROWS: usize = 1_000;

fn investment_action(value: &str) -> Result<InvestmentAction, sqlx::Error> {
    serde_json::from_value(serde_json::Value::String(value.to_owned()))
        .map_err(|cause| sqlx::Error::Decode(Box::new(cause)))
}

/// Deletes and regenerates the lots and allocations of one pair by replaying
/// its investment splits.
///
/// The advisory lock is the first statement, before the read that drives the
/// inserts. It serializes concurrent rebuilds of one pair, including a new
/// pair whose DELETE matches no rows. It is released at commit or rollback, so
/// the caller must pass a connection inside an explicit transaction.
pub async fn rebuild_lots(
    connection: &mut PgConnection,
    book_id: i32,
    account_id: i32,
    security_id: i32,
) -> Result<(), sqlx::Error> {
    sqlx::query("SELECT pg_advisory_xact_lock($1, $2)")
        .bind(account_id)
        .bind(security_id)
        .execute(&mut *connection)
        .await?;

    // A stock split has no account and applies to every account that holds
    // the security, so it is read with this account's own rows.
    let query = format!(
        "SELECT s.id, s.transaction_id, s.action, s.shares_micros, s.price_micros, s.fees_cents,
                s.split_numerator, s.split_denominator, {EFFECTIVE_DATE} AS transaction_date
         FROM investment_splits s
         JOIN transactions t ON t.id = s.transaction_id
         WHERE s.book_id = $1 AND s.security_id = $2
           AND (s.account_id = $3 OR (s.account_id IS NULL AND s.action = 'split'))
         ORDER BY {EFFECTIVE_DATE}, t.id, s.id"
    );
    let rows = sqlx::query(&query)
        .bind(book_id)
        .bind(security_id)
        .bind(account_id)
        .fetch_all(&mut *connection)
        .await?;
    let splits = rows
        .iter()
        .map(|row| {
            Ok(ReplaySplit {
                investment_split_id: i64::from(row.try_get::<i32, _>("id")?),
                transaction_id: i64::from(row.try_get::<i32, _>("transaction_id")?),
                action: investment_action(row.try_get("action")?)?,
                shares_micros: row.try_get("shares_micros")?,
                price_micros: row.try_get("price_micros")?,
                fees_cents: i64::from(row.try_get::<i32, _>("fees_cents")?),
                split_numerator: row
                    .try_get::<Option<i32>, _>("split_numerator")?
                    .map(i64::from),
                split_denominator: row
                    .try_get::<Option<i32>, _>("split_denominator")?
                    .map(i64::from),
                transaction_date: row.try_get("transaction_date")?,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()?;

    // Allocations cascade from lots, so deleting the lots clears both.
    sqlx::query(
        "DELETE FROM investment_lots WHERE book_id = $1 AND account_id = $2 AND security_id = $3",
    )
    .bind(book_id)
    .bind(account_id)
    .bind(security_id)
    .execute(&mut *connection)
    .await?;

    let result = replay_lots(&splits);
    if result.lots.is_empty() {
        return Ok(());
    }

    // acquired_date is the buy's effective date at rebuild time. For a
    // floating buy it is a snapshot of today, which stays fixed until the next
    // rebuild of this pair.
    let now = Utc::now().naive_utc();
    let mut lot_ids: HashMap<i64, i32> = HashMap::new();
    for chunk in result.lots.chunks(INSERT_CHUNK_ROWS) {
        let mut insert = QueryBuilder::<Postgres>::new(
            "INSERT INTO investment_lots (book_id, account_id, security_id, acquired_date,
               opened_split_id, opened_transaction_id, closed_transaction_id,
               original_shares_micros, original_basis_cents, remaining_shares_micros,
               remaining_basis_cents, created_at) ",
        );
        insert.push_values(chunk, |mut values, lot| {
            values
                .push_bind(book_id)
                .push_bind(account_id)
                .push_bind(security_id)
                .push_bind(&lot.acquired_date)
                .push_bind(lot.opened_split_id)
                .push_bind(lot.opened_transaction_id)
                .push_bind(lot.closed_transaction_id)
                .push_bind(lot.original_shares_micros)
                .push_bind(lot.original_basis_cents)
                .push_bind(lot.remaining_shares_micros)
                .push_bind(lot.remaining_basis_cents)
                .push_bind(now);
        });
        insert.push(" RETURNING id, opened_split_id");
        // Map by opened_split_id, which is unique per lot, not by the order of
        // the RETURNING rows.
        for row in insert.build().fetch_all(&mut *connection).await? {
            let opened: Option<i32> = row.try_get("opened_split_id")?;
            if let Some(opened) = opened {
                lot_ids.insert(i64::from(opened), row.try_get("id")?);
            }
        }
    }

    if result.allocations.is_empty() {
        return Ok(());
    }
    let id_by_key: HashMap<usize, i32> = result
        .lots
        .iter()
        .filter_map(|lot| {
            lot_ids
                .get(&lot.opened_split_id)
                .map(|id| (lot.lot_key, *id))
        })
        .collect();
    for chunk in result.allocations.chunks(INSERT_CHUNK_ROWS) {
        let mut rows = Vec::with_capacity(chunk.len());
        for allocation in chunk {
            let lot_id = *id_by_key.get(&allocation.lot_key).ok_or_else(|| {
                sqlx::Error::Protocol(format!(
                    "rebuild_lots: no persisted lot for key {} (book {book_id}, account {account_id}, security {security_id})",
                    allocation.lot_key
                ))
            })?;
            rows.push((lot_id, allocation));
        }
        let mut insert = QueryBuilder::<Postgres>::new(
            "INSERT INTO investment_lot_allocations (book_id, lot_id, sell_split_id,
               transaction_id, shares_micros, basis_cents, proceeds_cents) ",
        );
        insert.push_values(rows, |mut values, (lot_id, allocation)| {
            values
                .push_bind(book_id)
                .push_bind(lot_id)
                .push_bind(allocation.sell_split_id)
                .push_bind(allocation.transaction_id)
                .push_bind(allocation.shares_micros)
                .push_bind(allocation.basis_cents)
                .push_bind(allocation.proceeds_cents);
        });
        insert.build().execute(&mut *connection).await?;
    }
    Ok(())
}

/// Rebuilds each distinct pair once, in (account, security) order. Every
/// caller takes the advisory locks in the same order, so two callers with
/// overlapping pairs queue and cannot deadlock.
pub async fn rebuild_lots_for_pairs(
    connection: &mut PgConnection,
    book_id: i32,
    pairs: &[LotPair],
) -> Result<(), sqlx::Error> {
    let mut ordered: Vec<LotPair> = pairs
        .iter()
        .copied()
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    ordered.sort();
    for pair in ordered {
        rebuild_lots(connection, book_id, pair.account_id, pair.security_id).await?;
    }
    Ok(())
}

async fn find_pairs(
    connection: &mut PgConnection,
    book_id: i32,
    security_id: Option<i32>,
) -> Result<Vec<LotPair>, sqlx::Error> {
    let rows: Vec<(i32, i32)> = sqlx::query_as(
        "SELECT DISTINCT account_id, security_id FROM investment_splits
         WHERE book_id = $1 AND action IN ('buy', 'sell') AND account_id IS NOT NULL
           AND ($2::integer IS NULL OR security_id = $2)
         ORDER BY account_id, security_id",
    )
    .bind(book_id)
    .bind(security_id)
    .fetch_all(&mut *connection)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(account_id, security_id)| LotPair {
            account_id,
            security_id,
        })
        .collect())
}

/// Every pair with at least one buy or sell in the book. A stock split has no
/// account and only changes pairs that a buy already established.
pub async fn find_all_lot_pairs(
    connection: &mut PgConnection,
    book_id: i32,
) -> Result<Vec<LotPair>, sqlx::Error> {
    find_pairs(connection, book_id, None).await
}

/// Every pair that the investment splits of one transaction can change. A
/// stock split applies to every account that holds the security, so it
/// expands to all of them. The expansion reads splits, not lots, so it is
/// correct before any lot exists.
pub async fn collect_affected_pairs(
    connection: &mut PgConnection,
    book_id: i32,
    transaction_id: i32,
) -> Result<Vec<LotPair>, sqlx::Error> {
    let rows: Vec<(Option<i32>, i32, String)> = sqlx::query_as(
        "SELECT account_id, security_id, action FROM investment_splits
         WHERE book_id = $1 AND transaction_id = $2",
    )
    .bind(book_id)
    .bind(transaction_id)
    .fetch_all(&mut *connection)
    .await?;
    let mut pairs = Vec::new();
    for (account_id, security_id, action) in rows {
        if action == "split" {
            pairs.extend(find_pairs(connection, book_id, Some(security_id)).await?);
        } else if let Some(account_id) = account_id {
            pairs.push(LotPair {
                account_id,
                security_id,
            });
        }
    }
    Ok(pairs)
}

#[derive(Debug, Eq, PartialEq)]
pub struct BackfillResult {
    pub books_processed: usize,
    pub pairs_rebuilt: usize,
    pub skipped: bool,
}

/// The deploy-time backfill from `scripts/rebuild-lots.ts`.
///
/// Without `force`, it does nothing when allocations already exist or when no
/// buy or sell exists. Every book and pair is rebuilt in one transaction. With
/// one transaction per pair, a crash and restart part way through would let
/// the guard read partial progress as "already populated" and skip the
/// remaining pairs, which would then report zero cost basis.
pub async fn backfill_lots(pool: &PgPool, force: bool) -> Result<BackfillResult, sqlx::Error> {
    if !force {
        let allocations: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM investment_lot_allocations")
                .fetch_one(pool)
                .await?;
        if allocations > 0 {
            return Ok(BackfillResult {
                books_processed: 0,
                pairs_rebuilt: 0,
                skipped: true,
            });
        }
        let trades: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM investment_splits WHERE action IN ('buy', 'sell')",
        )
        .fetch_one(pool)
        .await?;
        if trades == 0 {
            return Ok(BackfillResult {
                books_processed: 0,
                pairs_rebuilt: 0,
                skipped: true,
            });
        }
    }

    let mut transaction = pool.begin().await?;
    let books: Vec<i32> = sqlx::query_scalar("SELECT id FROM books ORDER BY id")
        .fetch_all(&mut *transaction)
        .await?;
    let mut pairs_rebuilt = 0;
    for book_id in &books {
        for pair in find_all_lot_pairs(&mut transaction, *book_id).await? {
            rebuild_lots(
                &mut transaction,
                *book_id,
                pair.account_id,
                pair.security_id,
            )
            .await?;
            pairs_rebuilt += 1;
        }
    }
    // The count is returned only after the commit succeeds, so no result
    // reports pairs that did not commit.
    transaction.commit().await?;
    Ok(BackfillResult {
        books_processed: books.len(),
        pairs_rebuilt,
        skipped: false,
    })
}

#[cfg(test)]
mod tests {
    use super::investment_action;
    use ledger_core::accounting::InvestmentAction;

    #[test]
    fn database_actions_decode() {
        assert_eq!(
            investment_action("capGain").unwrap(),
            InvestmentAction::CapGain
        );
        assert_eq!(investment_action("split").unwrap(), InvestmentAction::Split);
        assert!(investment_action("short").is_err());
    }
}
