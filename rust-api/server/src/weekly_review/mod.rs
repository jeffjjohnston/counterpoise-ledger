//! The weekly review (guides/weekly-review.md): once a week, each book that
//! opts in sends its week to Claude and stores a summary and a list of
//! items. The review only suggests. It never writes a transaction, a rule or
//! a payee.
//!
//! A run has four steps. `start` inserts a `running` review in one write
//! transaction. `run` reads the data in one read transaction, then calls
//! Claude with no transaction open, then `save` writes the result in one
//! write transaction, but only when the revision of the book has not changed
//! since `start`. A change (the user turned the feature off, or cleared it)
//! makes the review `failed` with `discarded`.

pub(crate) mod anthropic;
pub(crate) mod input;
pub(crate) mod output;

use crate::{
    book_scope::{BookAccess, Write},
    routes::transactions::now_millis,
};
use ledger_db::{
    Database, Sql,
    locks::FOR_UPDATE,
    sql,
    store::{self, params},
};
use std::collections::HashSet;

/// Each book keeps its newest reviews and their items.
pub(crate) const KEEP_REVIEWS: i64 = 12;

/// A `running` review older than this is dead (see `start`).
pub(crate) const STALE_RUN: chrono::TimeDelta = chrono::TimeDelta::minutes(15);

pub(crate) const SYSTEM_PROMPT: &str = "\
You review one week of the double-entry bookkeeping of a household for its owner.

The input is a JSON document:
- period: the first and the last day of the week.
- accounts: each account, with its type (asset, liability, equity, income, expense).
- transactions: each transaction of the week, with its splits. Amounts are in cents. \
Assets and expenses have positive normal balances. Liabilities, equity and income have \
negative normal balances. A card purchase is a positive expense split and a negative \
liability split. A floating transaction has today as its date; its date is not an error.
- history: monthly totals in cents for the 13 months before the week, per payee and per \
income or expense account.
- recurringRules: each active recurring rule, with its next date and its amounts.

Write a summary of the week in 1 to 3 sentences.

Then list at most 12 items, the most important first. There are two kinds:
- check: a probable error that the owner must fix. Categories: duplicate (the same \
payment entered two times), missed_payment (a regular payment or a rule that did not \
occur when it should), unusual_amount (an amount far from the usual amount of its payee \
or account), other.
- insight: information that needs no fix. Categories: price_change (a regular payment \
that costs more or less than before), new_recurring (a new regular payment with no \
recurring rule), spending_change (a category that is clearly higher or lower than in \
its usual months), other.

Rules:
- Use only transaction IDs and recurring rule IDs from the input. A check item must \
name at least one of them. Use null for recurringRuleId when no rule applies.
- The title names the payee or the category and the amount in dollars, in less than \
80 characters. The detail has 1 or 2 plain sentences that say why the item matters.
- Do not list an item only because a transaction exists. When nothing needs \
attention, return an empty list.";

/// The result of `start`.
#[derive(Debug, PartialEq)]
pub(crate) enum Start {
    Started(i64),
    /// A review of this book is running.
    Running,
    /// The book has not opted in (or does not exist).
    NotEnabled,
}

/// Inserts a `running` review for the 7 days that end yesterday.
pub(crate) fn start(
    database: &Database,
    access: &BookAccess<'_, Write>,
    source: &'static str,
) -> Result<Start, store::Error> {
    let book_id = access.book_id();
    database.transaction(|tx| {
        let book: Option<(bool, i64)> = tx.query_optional(
            &format!(
                "SELECT weekly_review_enabled, weekly_review_revision FROM books WHERE id = ?1{FOR_UPDATE}"
            ),
            &params![book_id],
        )?;
        let Some((true, revision)) = book else {
            return Ok(Start::NotEnabled);
        };
        // A run takes at most the 5-minute call timeout plus two short
        // transactions. A row that is still `running` long after that lost
        // its save (for example a database that stayed busy, or a panic): it
        // must not block the book until the next restart.
        let now = now_millis();
        tx.execute(
            "UPDATE weekly_reviews SET status = 'failed', error = 'interrupted', completed_at = ?2
             WHERE book_id = ?1 AND status = 'running' AND started_at < ?3",
            &params![book_id, now, now - STALE_RUN],
        )?;
        let running: bool = tx.query_row(
            "SELECT EXISTS (SELECT 1 FROM weekly_reviews WHERE book_id = ?1 AND status = 'running')",
            &params![book_id],
        )?;
        if running {
            return Ok(Start::Running);
        }
        let id: i64 = tx.query_row(
            &format!(
                "INSERT INTO weekly_reviews
                   (book_id, source, period_start, period_end, status, revision, started_at)
                 VALUES (?1, ?2, date({today}, '-7 days'), date({today}, '-1 day'), 'running', ?3, ?4)
                 RETURNING id",
                today = ledger_db::sql::today_literal()
            ),
            &params![book_id, source, revision, now],
        )?;
        Ok(Start::Started(id))
    })
}

type Outcome = Result<anthropic::Reply, &'static str>;

/// Reads, asks and saves one review. It does not return an error: a
/// failure is stored on the review, and the log has only the error code.
/// `true` when the review is complete.
pub(crate) async fn run(
    database: &Database,
    access: BookAccess<'static, Write>,
    review_id: i64,
) -> bool {
    let book_id = access.book_id();
    let outcome = ask(database, book_id, review_id).await;
    if let Err(code) = &outcome {
        tracing::warn!(book_id, review_id, error = code, "Weekly review failed");
    }
    match save(database, &access, review_id, outcome) {
        Ok(complete) => complete,
        Err(cause) => {
            tracing::error!(book_id, review_id, error = %cause, "Could not save a weekly review");
            // The row must not stay `running`, or it blocks the book.
            let _ = fail(database, book_id, review_id, "database_error");
            false
        }
    }
}

async fn ask(database: &Database, book_id: i32, review_id: i64) -> Outcome {
    let period: Option<(String, String)> = database
        .query_optional(
            "SELECT period_start, period_end FROM weekly_reviews WHERE id = ?1 AND book_id = ?2",
            &params![review_id, book_id],
        )
        .map_err(|_| "database_error")?;
    let (start, end) = period.ok_or("discarded")?;
    let data = input::load(database, book_id, &start, &end).map_err(|cause| {
        tracing::error!(book_id, review_id, error = %cause, "Could not read the data of a weekly review");
        "database_error"
    })?;
    anthropic::ask(SYSTEM_PROMPT, &input::document(&data), &output::schema()).await
}

fn save(
    database: &Database,
    access: &BookAccess<'_, Write>,
    review_id: i64,
    outcome: Outcome,
) -> Result<bool, store::Error> {
    let book_id = access.book_id();
    let complete = database.transaction(|tx| -> Result<Option<bool>, store::Error> {
        let current: Option<i64> = tx.query_optional(
            &format!("SELECT weekly_review_revision FROM books WHERE id = ?1{FOR_UPDATE}"),
            &params![book_id],
        )?;
        let started: Option<i64> = tx.query_optional(
            "SELECT revision FROM weekly_reviews WHERE id = ?1 AND book_id = ?2 AND status = 'running'",
            &params![review_id, book_id],
        )?;
        // A clear deleted the review, or a restart marked it interrupted.
        let Some(started) = started else {
            return Ok(None);
        };
        let result = if current != Some(started) {
            Err("discarded")
        } else {
            outcome.and_then(|reply| {
                output::parse(&reply.text)
                    .map(|answer| (reply, answer))
                    .ok_or("invalid_response")
            })
        };
        let now = now_millis();
        let complete = result.is_ok();
        match result {
            Err(code) => {
                tx.execute(
                    "UPDATE weekly_reviews SET status = 'failed', error = ?3, completed_at = ?4
                     WHERE id = ?1 AND book_id = ?2",
                    &params![review_id, book_id, code, now],
                )?;
            }
            Ok((reply, answer)) => {
                let (transaction_ids, rule_ids) = output::named_ids(&answer.items);
                let known = |table: &str, ids: &[i64]| -> Result<HashSet<i64>, store::Error> {
                    let ids: Vec<i64> = tx.query(
                        &format!(
                            "SELECT id FROM {table} WHERE book_id = ?1 AND id {}",
                            sql::in_integers("?2")
                        ),
                        &params![book_id, sql::json_array(ids)],
                    )?;
                    Ok(ids.into_iter().collect())
                };
                let transactions = known("transactions", &transaction_ids)?;
                let rules = known("recurring_rules", &rule_ids)?;
                let dismissed: Vec<String> = tx.query(
                    "SELECT fingerprint FROM weekly_review_items
                     WHERE book_id = ?1 AND dismissed_at IS NOT NULL",
                    &params![book_id],
                )?;
                let dismissed: HashSet<String> = dismissed.into_iter().collect();
                let items = output::checked(answer.items, &transactions, &rules, &dismissed);
                for (position, item) in items.iter().enumerate() {
                    tx.execute(
                        &format!(
                            "INSERT INTO weekly_review_items
                               (book_id, review_id, position, kind, category, title, detail,
                                transaction_ids, recurring_rule_id, fingerprint)
                             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, {}, ?9, ?10)",
                            sql::json("?8")
                        ),
                        &params![
                            book_id,
                            review_id,
                            position as i64,
                            &item.kind,
                            &item.category,
                            &item.title,
                            &item.detail,
                            sql::json_array(&item.transaction_ids),
                            item.recurring_rule_id,
                            &item.fingerprint
                        ],
                    )?;
                }
                tx.execute(
                    "UPDATE weekly_reviews
                     SET status = 'complete', summary = ?3, model = ?4, input_tokens = ?5,
                         output_tokens = ?6, completed_at = ?7
                     WHERE id = ?1 AND book_id = ?2",
                    &params![
                        review_id,
                        book_id,
                        &answer.summary,
                        &reply.model,
                        reply.input_tokens,
                        reply.output_tokens,
                        now
                    ],
                )?;
            }
        }
        Ok(Some(complete))
    })?;
    let Some(complete) = complete else {
        return Ok(false);
    };
    // The review is saved. A failed cleanup does not change its result: the
    // next save prunes again.
    if let Err(cause) = prune(database, book_id) {
        tracing::warn!(book_id, review_id, error = %cause, "Could not prune old weekly reviews");
    }
    Ok(complete)
}

fn fail(database: &Database, book_id: i32, review_id: i64, code: &str) -> Result<(), store::Error> {
    database
        .execute(
            "UPDATE weekly_reviews SET status = 'failed', error = ?3, completed_at = ?4
             WHERE id = ?1 AND book_id = ?2 AND status = 'running'",
            &params![review_id, book_id, code, now_millis()],
        )
        .map(|_| ())
}

/// Deletes the reviews of the book beyond the newest `KEEP_REVIEWS`. Their
/// items go with them (cascade). A review that holds a dismissed item stays:
/// its fingerprint keeps that item out of later reviews.
fn prune(database: &Database, book_id: i32) -> Result<(), store::Error> {
    database
        .execute(
            "DELETE FROM weekly_reviews
             WHERE book_id = ?1 AND status <> 'running'
               AND NOT EXISTS (SELECT 1 FROM weekly_review_items i
                               WHERE i.review_id = weekly_reviews.id AND i.dismissed_at IS NOT NULL)
               AND id NOT IN (
               SELECT id FROM weekly_reviews WHERE book_id = ?1
               ORDER BY started_at DESC, id DESC LIMIT ?2)",
            &params![book_id, KEEP_REVIEWS],
        )
        .map(|_| ())
}

/// At startup: a review that a restart stopped becomes `failed` with
/// `interrupted`, so that it does not block its book.
pub(crate) fn mark_interrupted(database: &Database) -> Result<u64, store::Error> {
    database.execute(
        "UPDATE weekly_reviews SET status = 'failed', error = 'interrupted', completed_at = ?1
         WHERE status = 'running'",
        &params![now_millis()],
    )
}
