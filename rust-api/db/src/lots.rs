//! Persistence for the FIFO lot engine, ported from `lib/lots-db.ts`.
//!
//! `rebuild_lots` is the only code that inserts rows into `investment_lots`
//! or `investment_lot_allocations`. A write path calls it inside the same
//! transaction as the write, so a pair's splits and its lots change together.
//! Rows also disappear through foreign-key cascades when a transaction, an
//! investment split, or a lot is deleted. Those cascades are in the DDL, not
//! in this file.

use crate::store::{Database, Error, Sql, params};
use std::collections::{HashMap, HashSet};

use chrono::Utc;
use ledger_core::{
    accounting::InvestmentAction,
    lots::{ReplaySplit, replay_lots},
};

/// One (account, security) pair. Account and security IDs are global serials,
/// so the pair alone identifies a set of lots.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct LotPair {
    pub account_id: i32,
    pub security_id: i32,
}

/// The effective date: a floating transaction resolves to today in the
/// session time zone, as `effectiveDateSql` does.
use crate::sql::{self, EFFECTIVE_DATE};

/// Rows per bulk insert. Each insert binds one JSON parameter for its rows,
/// so this bounds only the size of that value.
const INSERT_CHUNK_ROWS: usize = 1_000;

fn investment_action(value: &str) -> Result<InvestmentAction, Error> {
    serde_json::from_value(serde_json::Value::String(value.to_owned()))
        .map_err(|cause| Error::Invalid(format!("investment action {value:?}: {cause}")))
}

/// Deletes and regenerates the lots and allocations of one pair by replaying
/// its investment splits.
///
/// Run it inside a write transaction, a [`Database::transaction`]. The
/// transaction holds the write lock of the file from its start, so no other
/// rebuild of the pair runs between the read of the splits and the inserts.
pub fn rebuild_lots(
    sql: &impl Sql,
    book_id: i32,
    account_id: i32,
    security_id: i32,
) -> Result<(), Error> {
    // A stock split has no account and applies to every account that holds
    // the security, so it is read with this account's own rows.
    let query = format!(
        "SELECT s.id, s.transaction_id, s.action, s.shares_micros, s.price_micros, s.fees_cents,
                s.split_numerator, s.split_denominator, {EFFECTIVE_DATE} AS transaction_date
         FROM investment_splits s
         JOIN transactions t ON t.id = s.transaction_id
         WHERE s.book_id = ?1 AND s.security_id = ?2
           AND (s.account_id = ?3 OR (s.account_id IS NULL AND s.action = 'split'))
         ORDER BY {EFFECTIVE_DATE}, t.id, s.id"
    );
    type SplitRow = (
        i32,
        i32,
        String,
        i64,
        i64,
        i32,
        Option<i32>,
        Option<i32>,
        String,
    );
    let rows: Vec<SplitRow> = sql.query(&query, &params![book_id, security_id, account_id])?;
    let splits = rows
        .into_iter()
        .map(
            |(
                id,
                transaction_id,
                action,
                shares_micros,
                price_micros,
                fees_cents,
                split_numerator,
                split_denominator,
                transaction_date,
            )| {
                Ok(ReplaySplit {
                    investment_split_id: i64::from(id),
                    transaction_id: i64::from(transaction_id),
                    action: investment_action(&action)?,
                    shares_micros,
                    price_micros,
                    fees_cents: i64::from(fees_cents),
                    split_numerator: split_numerator.map(i64::from),
                    split_denominator: split_denominator.map(i64::from),
                    transaction_date,
                })
            },
        )
        .collect::<Result<Vec<_>, Error>>()?;

    // Allocations cascade from lots, so deleting the lots clears both.
    sql.execute(
        "DELETE FROM investment_lots WHERE book_id = ?1 AND account_id = ?2 AND security_id = ?3",
        &params![book_id, account_id, security_id],
    )?;

    let result = replay_lots(&splits);
    if result.lots.is_empty() {
        return Ok(());
    }
    // The cents columns were `integer` in PostgreSQL, and the readers decode
    // them as 32-bit integers. SQLite stores any 64-bit value, so a value out
    // of that range is refused here, as PostgreSQL refused it at the insert.
    // The transaction routes bound these values already; an imported price
    // is not bound.
    let cents = result
        .lots
        .iter()
        .flat_map(|lot| {
            [
                ("original_basis_cents", lot.original_basis_cents),
                ("remaining_basis_cents", lot.remaining_basis_cents),
            ]
        })
        .chain(result.allocations.iter().flat_map(|allocation| {
            [
                ("basis_cents", allocation.basis_cents),
                ("proceeds_cents", allocation.proceeds_cents),
            ]
        }));
    for (column, value) in cents {
        if i32::try_from(value).is_err() {
            return Err(Error::Invalid(format!(
                "rebuild_lots: {column} {value} is out of the integer range \
                 (book {book_id}, account {account_id}, security {security_id})"
            )));
        }
    }

    // acquired_date is the buy's effective date at rebuild time. For a
    // floating buy it is a snapshot of today, which stays fixed until the next
    // rebuild of this pair.
    let now = Utc::now().naive_utc();
    let mut lot_ids: HashMap<i64, i32> = HashMap::new();
    for chunk in result.lots.chunks(INSERT_CHUNK_ROWS) {
        let rows: Vec<_> = chunk
            .iter()
            .map(|lot| {
                (
                    &lot.acquired_date,
                    lot.opened_split_id,
                    lot.opened_transaction_id,
                    lot.closed_transaction_id,
                    lot.original_shares_micros,
                    lot.original_basis_cents,
                    lot.remaining_shares_micros,
                    lot.remaining_basis_cents,
                )
            })
            .collect();
        let insert = format!(
            "INSERT INTO investment_lots (book_id, account_id, security_id, acquired_date,
               opened_split_id, opened_transaction_id, closed_transaction_id,
               original_shares_micros, original_basis_cents, remaining_shares_micros,
               remaining_basis_cents, created_at)
             {} RETURNING id, opened_split_id",
            sql::json_rows(
                &[
                    "?1", "?2", "?3", "#0", "#1", "#2", "#3", "#4", "#5", "#6", "#7", "?4"
                ],
                "?5"
            )
        );
        let inserted: Vec<(i32, Option<i32>)> = sql.query(
            &insert,
            &params![
                book_id,
                account_id,
                security_id,
                now,
                sql::json_array(&rows)
            ],
        )?;
        // Map by opened_split_id, which is unique per lot, not by the order of
        // the RETURNING rows.
        for (id, opened) in inserted {
            if let Some(opened) = opened {
                lot_ids.insert(i64::from(opened), id);
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
                Error::Invalid(format!(
                    "rebuild_lots: no persisted lot for key {} (book {book_id}, account {account_id}, security {security_id})",
                    allocation.lot_key
                ))
            })?;
            rows.push((
                lot_id,
                allocation.sell_split_id,
                allocation.transaction_id,
                allocation.shares_micros,
                allocation.basis_cents,
                allocation.proceeds_cents,
            ));
        }
        let insert = format!(
            "INSERT INTO investment_lot_allocations (book_id, lot_id, sell_split_id,
               transaction_id, shares_micros, basis_cents, proceeds_cents) {}",
            sql::json_rows(&["?1", "#0", "#1", "#2", "#3", "#4", "#5"], "?2")
        );
        sql.execute(&insert, &params![book_id, sql::json_array(&rows)])?;
    }
    Ok(())
}

/// Rebuilds each distinct pair once, in (account, security) order.
pub fn rebuild_lots_for_pairs(
    sql: &impl Sql,
    book_id: i32,
    pairs: &[LotPair],
) -> Result<(), Error> {
    let mut ordered: Vec<LotPair> = pairs
        .iter()
        .copied()
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    ordered.sort();
    for pair in ordered {
        rebuild_lots(sql, book_id, pair.account_id, pair.security_id)?;
    }
    Ok(())
}

fn find_pairs(
    sql: &impl Sql,
    book_id: i32,
    security_id: Option<i32>,
) -> Result<Vec<LotPair>, Error> {
    let rows: Vec<(i32, i32)> = sql.query(
        "SELECT DISTINCT account_id, security_id FROM investment_splits
         WHERE book_id = ?1 AND action IN ('buy', 'sell') AND account_id IS NOT NULL
           AND (?2 IS NULL OR security_id = ?2)
         ORDER BY account_id, security_id",
        &params![book_id, security_id],
    )?;
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
pub fn find_all_lot_pairs(sql: &impl Sql, book_id: i32) -> Result<Vec<LotPair>, Error> {
    find_pairs(sql, book_id, None)
}

/// Every pair that the investment splits of one transaction can change. A
/// stock split applies to every account that holds the security, so it
/// expands to all of them. The expansion reads splits, not lots, so it is
/// correct before any lot exists.
pub fn collect_affected_pairs(
    sql: &impl Sql,
    book_id: i32,
    transaction_id: i32,
) -> Result<Vec<LotPair>, Error> {
    let rows: Vec<(Option<i32>, i32, String)> = sql.query(
        "SELECT account_id, security_id, action FROM investment_splits
         WHERE book_id = ?1 AND transaction_id = ?2",
        &params![book_id, transaction_id],
    )?;
    let mut pairs = Vec::new();
    for (account_id, security_id, action) in rows {
        if action == "split" {
            pairs.extend(find_pairs(sql, book_id, Some(security_id))?);
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

/// The backfill guard alone: true when the file has a buy or a sell and no
/// allocation, as a converted or restored database does. A Durable Object
/// checks it at construction; it cannot rebuild every lot there.
pub fn lots_missing(database: &Database) -> Result<bool, Error> {
    let allocations: i64 =
        database.query_row("SELECT COUNT(*) FROM investment_lot_allocations", &[])?;
    let trades: i64 = database.query_row(
        "SELECT COUNT(*) FROM investment_splits WHERE action IN ('buy', 'sell')",
        &[],
    )?;
    Ok(allocations == 0 && trades > 0)
}

/// Whether the file has a buy that opens a lot and no lot at all: a file
/// that the stepped rebuild ([`rebuild_lots_step`]) must fill. Unlike
/// [`lots_missing`], it is false for a file whose trades are all buys, which
/// has lots and no allocation, for a file of sells alone, which a rebuild
/// leaves with no lot, and for a file that a stepped rebuild has started on.
pub fn lots_absent(database: &Database) -> Result<bool, Error> {
    // The replay opens a lot for each buy of more than zero shares in an
    // account.
    database.query_row(
        "SELECT NOT EXISTS (SELECT 1 FROM investment_lots)
           AND EXISTS (SELECT 1 FROM investment_splits
             WHERE action = 'buy' AND shares_micros > 0 AND account_id IS NOT NULL)",
        &[],
    )
}

/// The startup backfill: the server runs it before it serves, and
/// `ledger-cli rebuild-lots` runs it by hand.
///
/// Without `force`, it does nothing when allocations already exist or when no
/// buy or sell exists. Every book and pair is rebuilt in one transaction. With
/// one transaction per pair, a crash and restart part way through would let
/// the guard read partial progress as "already populated" and skip the
/// remaining pairs, which would then report zero cost basis.
pub fn backfill_lots(database: &Database, force: bool) -> Result<BackfillResult, Error> {
    if !force && !lots_missing(database)? {
        return Ok(BackfillResult {
            books_processed: 0,
            pairs_rebuilt: 0,
            skipped: true,
        });
    }

    // The count is returned only after the commit succeeds, so no result
    // reports pairs that did not commit.
    database.transaction(|tx| {
        let books: Vec<i32> = tx.query("SELECT id FROM books ORDER BY id", &[])?;
        let mut pairs_rebuilt = 0;
        for book_id in &books {
            for pair in find_all_lot_pairs(tx, *book_id)? {
                rebuild_lots(tx, *book_id, pair.account_id, pair.security_id)?;
                pairs_rebuilt += 1;
            }
        }
        Ok(BackfillResult {
            books_processed: books.len(),
            pairs_rebuilt,
            skipped: false,
        })
    })
}

/// Where a stepped rebuild of every lot ([`rebuild_lots_step`]) goes on:
/// after this book and pair.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct RebuildCursor {
    pub book_id: i32,
    pub pair: LotPair,
}

impl std::fmt::Display for RebuildCursor {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let LotPair {
            account_id,
            security_id,
        } = self.pair;
        write!(formatter, "{}:{account_id}:{security_id}", self.book_id)
    }
}

impl std::str::FromStr for RebuildCursor {
    type Err = Error;

    fn from_str(text: &str) -> Result<Self, Error> {
        let invalid = || Error::Invalid(format!("lot rebuild cursor {text:?}"));
        let parts: Vec<i32> = text
            .split(':')
            .map(str::parse)
            .collect::<Result<_, _>>()
            .map_err(|_| invalid())?;
        match parts[..] {
            [book_id, account_id, security_id] => Ok(Self {
                book_id,
                pair: LotPair {
                    account_id,
                    security_id,
                },
            }),
            _ => Err(invalid()),
        }
    }
}

/// One step of a rebuild of every lot in the file, for a host whose events
/// have a time limit (a Durable Object). It rebuilds at most `limit` pairs,
/// in (book, account, security) order, from the first after `after`, in one
/// transaction. It returns the last pair rebuilt when more remain: where
/// the next step starts.
///
/// The caller keeps that cursor between steps, because neither guard
/// ([`lots_missing`], [`lots_absent`]) tells a rebuild that stopped half way
/// from one that is done.
pub fn rebuild_lots_step(
    database: &Database,
    after: Option<RebuildCursor>,
    limit: usize,
) -> Result<Option<RebuildCursor>, Error> {
    database.transaction(|tx| {
        let books: Vec<i32> = tx.query(
            "SELECT id FROM books WHERE id >= ?1 ORDER BY id",
            &params![after.map_or(i32::MIN, |after| after.book_id)],
        )?;
        let mut last = None;
        let mut done = 0;
        for book_id in books {
            for pair in find_all_lot_pairs(tx, book_id)? {
                let at = RebuildCursor { book_id, pair };
                if after.is_some_and(|after| at <= after) {
                    continue;
                }
                if done == limit {
                    return Ok(last);
                }
                rebuild_lots(tx, book_id, pair.account_id, pair.security_id)?;
                last = Some(at);
                done += 1;
            }
        }
        Ok(None)
    })
}

#[cfg(test)]
mod tests {
    use super::investment_action;
    use crate::store::Sql;
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

    /// The steps of a stepped rebuild, one pair each, write the lots that
    /// the whole rebuild writes, and a step after the last does nothing.
    #[test]
    fn a_stepped_rebuild_writes_the_lots_of_a_whole_rebuild() {
        let file = crate::testing::TempDatabase::new();
        let database = file.database();
        database
            .exec_batch(
                "INSERT INTO users (id, username, password_hash, created_at)
                   VALUES (1, 'u', 'h', '2025-01-01 00:00:00');
                 INSERT INTO books (id, user_id, name, created_at, updated_at)
                   VALUES (1, 1, 'A', '2025-01-01 00:00:00', '2025-01-01 00:00:00'),
                          (2, 1, 'B', '2025-01-01 00:00:00', '2025-01-01 00:00:00');",
            )
            .unwrap();
        for book_id in [1, 2] {
            database
                .transaction(|tx| {
                    crate::seed::seed_book(
                        tx,
                        book_id,
                        crate::seed::DemoDataset::Household,
                        chrono::NaiveDate::from_ymd_opt(2025, 12, 31).unwrap(),
                        &mut |_| {},
                    )
                })
                .unwrap();
        }
        let whole = crate::testing::lot_rows(database);
        assert!(whole.len() > 1, "the seed has lots");
        database
            .exec_batch("DELETE FROM investment_lot_allocations; DELETE FROM investment_lots;")
            .unwrap();
        assert!(super::lots_missing(database).unwrap());
        assert!(super::lots_absent(database).unwrap());

        let mut cursors = Vec::new();
        let mut after = None;
        while let Some(next) = super::rebuild_lots_step(database, after, 1).unwrap() {
            assert_eq!(
                next.to_string().parse::<super::RebuildCursor>().unwrap(),
                next
            );
            cursors.push(next);
            after = Some(next);
            // A rebuild that has started is not asked for again.
            assert!(!super::lots_absent(database).unwrap());
        }
        assert_eq!(crate::testing::lot_rows(database), whole);
        // Each step rebuilt one pair, and the steps went through both books.
        let pairs: usize = [1, 2]
            .iter()
            .map(|book| super::find_all_lot_pairs(database, *book).unwrap().len())
            .sum();
        assert_eq!(cursors.len() + 1, pairs);
        assert!(cursors.windows(2).all(|pair| pair[0] < pair[1]));
        assert!(cursors.iter().any(|cursor| cursor.book_id == 2));
    }

    /// A file whose trades are all buys has lots and no allocation: the
    /// backfill guard reads it as missing its lots, the hosted guard does
    /// not. Nor does the hosted guard ask a rebuild for sells alone.
    #[test]
    fn a_file_of_buys_alone_has_its_lots() {
        let file = crate::testing::TempDatabase::new();
        let database = file.database();
        database
            .exec_batch(
                "INSERT INTO users (id, username, password_hash, created_at)
                   VALUES (1, 'u', 'h', '2025-01-01 00:00:00');
                 INSERT INTO books (id, user_id, name, created_at, updated_at)
                   VALUES (1, 1, 'B', '2025-01-01 00:00:00', '2025-01-01 00:00:00');
                 INSERT INTO accounts (id, book_id, name, type, created_at, updated_at)
                   VALUES (10, 1, 'Brokerage', 'asset', '2025-01-01 00:00:00', '2025-01-01 00:00:00');
                 INSERT INTO securities (id, book_id, name, symbol, security_type, created_at)
                   VALUES (20, 1, 'Fund', 'FND', 'stock', '2025-01-01 00:00:00');
                 INSERT INTO transactions (id, book_id, date, created_at, updated_at)
                   VALUES (30, 1, '2025-01-02', '2025-01-02 00:00:00', '2025-01-02 00:00:00');
                 INSERT INTO investment_splits
                   (book_id, transaction_id, account_id, security_id, action, shares_micros, price_micros)
                   VALUES (1, 30, 10, 20, 'sell', 1000000, 10000000);",
            )
            .unwrap();
        // A sell alone opens no lot, so a rebuild would leave none.
        assert!(!super::lots_absent(database).unwrap());
        database
            .exec_batch("UPDATE investment_splits SET action = 'buy'")
            .unwrap();
        assert!(super::lots_absent(database).unwrap());
        database
            .transaction(|tx| super::rebuild_lots(tx, 1, 10, 20))
            .unwrap();
        assert!(super::lots_missing(database).unwrap());
        assert!(!super::lots_absent(database).unwrap());
    }

    /// A basis that does not fit a 32-bit integer is refused, and no lot is
    /// written: the readers could not decode it.
    #[test]
    fn a_basis_out_of_the_integer_range_is_refused() {
        let file = crate::testing::TempDatabase::new();
        let database = file.database();
        database.exec_batch(
            "INSERT INTO users (id, username, password_hash, created_at)
               VALUES (1, 'u', 'h', '2025-01-01 00:00:00');
             INSERT INTO books (id, user_id, name, created_at, updated_at)
               VALUES (1, 1, 'B', '2025-01-01 00:00:00', '2025-01-01 00:00:00');
             INSERT INTO accounts (id, book_id, name, type, created_at, updated_at)
               VALUES (10, 1, 'Brokerage', 'asset', '2025-01-01 00:00:00', '2025-01-01 00:00:00');
             INSERT INTO securities (id, book_id, name, symbol, security_type, created_at)
               VALUES (20, 1, 'Fund', 'FND', 'stock', '2025-01-01 00:00:00');
             INSERT INTO transactions (id, book_id, date, created_at, updated_at)
               VALUES (30, 1, '2025-01-02', '2025-01-02 00:00:00', '2025-01-02 00:00:00');
             -- One share at $30,000,000: a basis of 3,000,000,000 cents.
             INSERT INTO investment_splits
               (book_id, transaction_id, account_id, security_id, action, shares_micros, price_micros)
               VALUES (1, 30, 10, 20, 'buy', 1000000, 30000000000000);",
        )
        .unwrap();
        let refused = database
            .transaction(|tx| super::rebuild_lots(tx, 1, 10, 20))
            .err()
            .map(|cause| cause.to_string())
            .unwrap_or_default();
        assert!(
            refused.contains("original_basis_cents 3000000000"),
            "{refused}"
        );
        let lots: i64 = database
            .query_row("SELECT COUNT(*) FROM investment_lots", &[])
            .unwrap();
        assert_eq!(lots, 0);
    }
}
