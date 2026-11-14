//! Entry suggestions (guides/typesafe-experiment.md, "Entry suggestions"):
//! the patterns of a payee in an account, the TypeSafe pick, and the outcome.

use crate::{
    book_auth::{AccessLevel, authenticate_book},
    book_scope::{BookAccess, Write},
    db_scope::write_transaction_or,
    entry_patterns::{
        AccountInfo, Entry, entry_question, entry_state, group, load, pattern_json, snapshot,
    },
    error::{ApiError, error, internal_error},
    platform,
    routes::transactions::now_millis,
    state::AppState,
    typesafe::is_configured,
    typesafe_client::evaluate,
    typesafe_questions::fingerprint,
    validation::{from_json_bytes, js_stringify},
};
use axum::{
    Json,
    body::Bytes,
    extract::{Path, RawQuery, State},
    http::{HeaderMap, StatusCode},
};
use chrono::{NaiveDate, NaiveDateTime, TimeDelta};
use ledger_db::Database;
use ledger_db::locks::FOR_UPDATE;
use ledger_db::sql;
use ledger_db::store::{self, Sql, params};
use serde_json::{Value, json};
use std::collections::HashMap;

const FAILURE: &str = "Failed to fetch entry patterns";

/// A positive integer ID, or `None`.
pub(crate) fn positive(raw: &str) -> Option<i64> {
    raw.parse::<i64>().ok().filter(|id| *id > 0)
}

/// The row of `table` belongs to the book. `table` is a constant of this
/// module, never request text.
pub(crate) fn owned(
    sql: &impl Sql,
    table: &'static str,
    book_id: i32,
    id: i64,
) -> Result<bool, store::Error> {
    let found: Option<i64> = sql.query_optional(
        &format!("SELECT id FROM {table} WHERE id = ?1 AND book_id = ?2"),
        &params![id, book_id],
    )?;
    Ok(found.is_some())
}

fn account_param(raw_query: Option<String>) -> Option<i64> {
    raw_query?
        .split('&')
        .find_map(|pair| pair.strip_prefix("accountId="))
        .and_then(positive)
}

pub(crate) async fn get_entry_patterns(
    State(state): State<AppState>,
    Path((raw_book_id, raw_payee_id)): Path<(String, String)>,
    RawQuery(raw_query): RawQuery,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let book =
        authenticate_book(&state, &headers, &raw_book_id, AccessLevel::Read, FAILURE).await?;
    let book_id = book.book_id();
    let payee_id = positive(&raw_payee_id)
        .ok_or_else(|| error(StatusCode::BAD_REQUEST, "Invalid payee id"))?;
    let account_id = account_param(raw_query)
        .ok_or_else(|| error(StatusCode::BAD_REQUEST, "Invalid account id"))?;
    let failed = |cause: store::Error| internal_error(cause, FAILURE);
    if !owned(&state.database, "payees", book_id, payee_id).map_err(failed)? {
        return Err(error(StatusCode::NOT_FOUND, "Payee not found"));
    }
    if !owned(&state.database, "accounts", book_id, account_id).map_err(failed)? {
        return Err(error(StatusCode::NOT_FOUND, "Account not found"));
    }
    let uses = load(&state.database, book_id, payee_id, account_id).map_err(failed)?;
    let patterns: Vec<Value> = group(account_id, &uses).iter().map(pattern_json).collect();
    Ok(Json(json!({ "patterns": patterns })))
}

const LEASE: TimeDelta = TimeDelta::seconds(30);
const RETRY: TimeDelta = TimeDelta::seconds(60);
const DAILY_ATTEMPTS: i32 = 100;
const UNAVAILABLE: &str = "AI suggestions are temporarily unavailable";
const OFF: &str = "Entry suggestions are off for this book";

/// No cause in the log: it can hold request data.
fn unavailable<T>(_cause: T) -> ApiError {
    tracing::error!("TypeSafe entry suggestion failed");
    error(StatusCode::SERVICE_UNAVAILABLE, UNAVAILABLE)
}

/// The fence of one claim: a new value for each attempt.
fn attempt_token() -> Result<String, ApiError> {
    let mut bytes = [0u8; 16];
    platform::random(&mut bytes).map_err(unavailable)?;
    Ok(hex::encode(bytes))
}

struct Request {
    account_id: i64,
    payee_id: i64,
    date: NaiveDate,
    amount: Option<i64>,
}

/// Exactly `{ accountId, payeeId, date, amount }`.
fn request(body: &Value) -> Option<Request> {
    let object = body.as_object()?;
    if object.len() != 4 {
        return None;
    }
    let id = |key: &str| object.get(key)?.as_i64().filter(|id| *id > 0);
    let amount = match object.get("amount")? {
        Value::Null => None,
        // Signed: negative when money leaves the account. i64::MIN has no
        // magnitude in i64, so it is refused.
        value => Some(
            value
                .as_i64()
                .filter(|cents| cents.checked_abs().is_some())?,
        ),
    };
    Some(Request {
        account_id: id("accountId")?,
        payee_id: id("payeeId")?,
        date: NaiveDate::parse_from_str(object.get("date")?.as_str()?, "%Y-%m-%d").ok()?,
        amount,
    })
}

#[derive(ledger_db::store::FromRow)]
struct Stored {
    id: i64,
    status: String,
    choice: Option<String>,
    confidence: Option<f64>,
    error_code: Option<String>,
    started_at: NaiveDateTime,
}

const STORED: &str = "id, status, choice, confidence, error_code, started_at";

/// The answer of a stored evaluation.
fn public(row: &Stored) -> Value {
    match row.status.as_str() {
        "ready" => json!({
            "status": "ready",
            "evaluationId": row.id,
            "choice": row.choice,
            "confidence": row.confidence,
        }),
        "skipped" => json!({ "status": "skipped", "evaluationId": row.id }),
        "error" => json!({ "status": "failed", "evaluationId": row.id, "error": row.error_code }),
        _ => json!({ "status": "stale" }),
    }
}

/// A claimed evaluation: the call to make, and its fence.
struct Claimed {
    id: i64,
    attempt: String,
    revision: i32,
    snapshot: Value,
    started_at: NaiveDateTime,
}

enum Claim {
    Done(Value),
    Ask(Box<Claimed>),
}

/// The entry opt-in and the revision, under the book-row lock.
fn lock_book(sql: &impl Sql, book_id: i32) -> Result<Option<(bool, i32)>, store::Error> {
    sql.query_optional(
        &format!(
            "SELECT typesafe_entry_enabled, typesafe_revision FROM books WHERE id = ?1{FOR_UPDATE}"
        ),
        &params![book_id],
    )
}

fn account_info(sql: &impl Sql, book_id: i32) -> Result<HashMap<i64, AccountInfo>, store::Error> {
    let rows: Vec<(i64, String, String, Option<String>)> = sql.query(
        "SELECT id, name, type, subtype FROM accounts WHERE book_id = ?1",
        &params![book_id],
    )?;
    Ok(rows
        .into_iter()
        .map(|(id, name, kind, subtype)| {
            (
                id,
                AccountInfo {
                    name,
                    kind,
                    subtype,
                },
            )
        })
        .collect())
}

/// Under the book-row lock: checks the opt-in, builds the snapshot, and
/// returns a stored answer or claims a new evaluation (quota, lease).
fn claim(
    sql: &impl Sql,
    access: &BookAccess<'_, Write>,
    input: &Request,
) -> Result<Claim, ApiError> {
    let book_id = access.book_id();
    let (enabled, revision) = lock_book(sql, book_id)
        .map_err(unavailable)?
        .ok_or_else(|| error(StatusCode::NOT_FOUND, "Book not found"))?;
    if !enabled || !is_configured() {
        return Err(error(StatusCode::CONFLICT, OFF));
    }
    if !owned(sql, "accounts", book_id, input.account_id).map_err(unavailable)? {
        return Err(error(StatusCode::NOT_FOUND, "Account not found"));
    }
    let payee: Option<String> = sql
        .query_optional(
            "SELECT name FROM payees WHERE id = ?1 AND book_id = ?2",
            &params![input.payee_id, book_id],
        )
        .map_err(unavailable)?;
    let payee = payee.ok_or_else(|| error(StatusCode::NOT_FOUND, "Payee not found"))?;
    let uses = load(sql, book_id, input.payee_id, input.account_id).map_err(unavailable)?;
    let patterns = group(input.account_id, &uses);
    let accounts = account_info(sql, book_id).map_err(unavailable)?;
    let entry = Entry {
        payee,
        date: input.date,
        amount: input.amount,
        account: accounts[&input.account_id].clone(),
    };
    let value = snapshot(
        revision,
        input.account_id,
        input.payee_id,
        &entry,
        &patterns,
        &uses,
        &accounts,
    );
    let hash = fingerprint(&value);
    let now = now_millis();
    let existing: Option<Stored> = sql
        .query_optional(
            &format!(
                "SELECT {STORED} FROM typesafe_entry_evaluations
                 WHERE book_id = ?1 AND fingerprint = ?2"
            ),
            &params![book_id, &hash],
        )
        .map_err(unavailable)?;
    if let Some(row) = &existing {
        match row.status.as_str() {
            "ready" | "skipped" => return Ok(Claim::Done(public(row))),
            "error" if now - row.started_at < RETRY => return Ok(Claim::Done(public(row))),
            "pending" if now - row.started_at < LEASE => {
                return Ok(Claim::Done(json!({ "status": "busy" })));
            }
            _ => {}
        }
    }
    let asks = patterns.len() >= 2;
    if asks {
        // One evaluation of the book at a time: another fingerprint in flight
        // holds the lease.
        let active: Option<i64> = sql
            .query_optional(
                "SELECT id FROM typesafe_entry_evaluations
                 WHERE book_id = ?1 AND status = 'pending' AND started_at > ?2
                   AND fingerprint <> ?3
                 LIMIT 1",
                &params![book_id, now - LEASE, &hash],
            )
            .map_err(unavailable)?;
        if active.is_some() {
            return Ok(Claim::Done(json!({ "status": "busy" })));
        }
        let day = now.format("%Y-%m-%d").to_string();
        let attempts: Option<i32> = sql
            .query_optional(
                "SELECT attempts FROM typesafe_quotas WHERE book_id = ?1 AND day = ?2",
                &params![book_id, &day],
            )
            .map_err(unavailable)?;
        if attempts.unwrap_or(0) >= DAILY_ATTEMPTS {
            return Ok(Claim::Done(json!({ "status": "limited" })));
        }
        sql.execute(
            "INSERT INTO typesafe_quotas (book_id, day, attempts) VALUES (?1, ?2, 1)
             ON CONFLICT (book_id, day) DO UPDATE SET attempts = typesafe_quotas.attempts + 1",
            &params![book_id, &day],
        )
        .map_err(unavailable)?;
    }
    let attempt = attempt_token()?;
    let row: Stored = sql
        .query_row(
            &format!(
                "INSERT INTO typesafe_entry_evaluations
           (book_id, account_id, payee_id, revision, fingerprint, attempt, snapshot, status,
            baseline_key, started_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, {}, ?8, ?9, ?10)
         ON CONFLICT (book_id, fingerprint) DO UPDATE SET
           revision = excluded.revision, attempt = excluded.attempt, snapshot = excluded.snapshot,
           status = excluded.status, started_at = excluded.started_at, completed_at = NULL,
           choice = NULL, probabilities = NULL, confidence = NULL, usage = NULL,
           error_code = NULL, latency_ms = NULL
         RETURNING {STORED}",
                sql::json("?7")
            ),
            &params![
                book_id,
                input.account_id,
                input.payee_id,
                revision,
                &hash,
                &attempt,
                js_stringify(&value),
                if asks { "pending" } else { "skipped" },
                value["baselineKey"].as_str().unwrap_or_default(),
                now
            ],
        )
        .map_err(unavailable)?;
    if !asks {
        return Ok(Claim::Done(public(&row)));
    }
    Ok(Claim::Ask(Box::new(Claimed {
        id: row.id,
        attempt,
        revision,
        snapshot: value,
        started_at: row.started_at,
    })))
}

/// Claims, asks TypeSafe with no database transaction open, and stores the
/// answer when the claim and the settings revision still hold.
async fn ask(
    database: &Database,
    access: &BookAccess<'_, Write>,
    input: Request,
) -> Result<Value, ApiError> {
    let book_id = access.book_id();
    let claimed = match write_transaction_or(database, unavailable, |tx| claim(tx, access, &input))?
    {
        Claim::Done(answer) => return Ok(answer),
        Claim::Ask(claimed) => claimed,
    };
    // The network call holds no database transaction. Once sent, the data
    // cannot be recalled.
    let answer = match (
        entry_state(&claimed.snapshot),
        entry_question(&claimed.snapshot),
    ) {
        (Ok(state), Ok(question)) => evaluate(&state, &[question]).await,
        _ => Err("unavailable"),
    };
    let usage = answer
        .as_ref()
        .ok()
        .and_then(|evaluated| evaluated.usage.as_ref())
        .map(js_stringify);
    let row = write_transaction_or(database, unavailable, |tx| {
        let book = lock_book(tx, book_id).map_err(unavailable)?;
        let current: Option<i64> = tx
            .query_optional(
                "SELECT id FROM typesafe_entry_evaluations
             WHERE id = ?1 AND attempt = ?2 AND status = 'pending'",
                &params![claimed.id, &claimed.attempt],
            )
            .map_err(unavailable)?;
        let fresh = matches!(book, Some((true, revision)) if revision == claimed.revision)
            && is_configured()
            && current.is_some();
        let now = now_millis();
        let latency =
            i32::try_from((now - claimed.started_at).num_milliseconds()).unwrap_or(i32::MAX);
        let picked = answer
            .as_ref()
            .ok()
            .and_then(|evaluated| evaluated.answers.get("pattern"))
            .filter(|_| fresh);
        let label = picked
            .and_then(|answer| answer.get("choice"))
            .and_then(Value::as_str);
        // "P2" is the key of option 2; "none" is no key.
        let choice = label.and_then(|label| {
            claimed.snapshot["options"]
                .as_array()?
                .iter()
                .find(|option| option["label"] == label)?["key"]
                .as_str()
                .map(str::to_owned)
        });
        let (status, error_code) = match (&answer, fresh) {
            (_, false) => ("stale", Some("stale")),
            (Err(code), true) => ("error", Some(*code)),
            (Ok(_), true) => ("ready", None),
        };
        let row: Option<Stored> = tx
            .query_optional(
                &format!(
        "UPDATE typesafe_entry_evaluations SET status = ?3, completed_at = ?4, latency_ms = ?5,
           error_code = ?6, choice = ?7, probabilities = {}, confidence = ?9, usage = {}
         WHERE id = ?1 AND attempt = ?2
         RETURNING {STORED}",
        sql::json("?8"),
        sql::json("?10"),
            ),
                &params![
                    claimed.id,
                    &claimed.attempt,
                    status,
                    now,
                    latency,
                    error_code,
                    choice,
                    picked
                        .and_then(|answer| answer.get("probabilities"))
                        .map(js_stringify),
                    picked
                        .and_then(|answer| answer.get("confidence"))
                        .and_then(Value::as_f64),
                    &usage
                ],
            )
            .map_err(unavailable)?;
        Ok(row)
    })?;
    // A clear deleted the row: the answer is stale.
    Ok(row.map_or_else(|| json!({ "status": "stale" }), |row| public(&row)))
}

pub(crate) async fn request_entry_suggestion(
    State(state): State<AppState>,
    Path(raw_book_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<Value>, ApiError> {
    let book = authenticate_book(
        &state,
        &headers,
        &raw_book_id,
        AccessLevel::Write,
        UNAVAILABLE,
    )
    .await?;
    let access = book.write()?;
    let body: Value =
        from_json_bytes(&body).map_err(|_| error(StatusCode::BAD_REQUEST, "Invalid JSON"))?;
    let input = request(&body).ok_or_else(|| {
        error(
            StatusCode::BAD_REQUEST,
            "Expected accountId, payeeId, date and amount",
        )
    })?;
    ask(&state.database, &access, input).await.map(Json)
}

const OUTCOMES: [&str; 5] = [
    "kept",
    "changed_amount",
    "picked_other",
    "changed_accounts",
    "abandoned",
];
const SOURCES: [&str; 2] = ["history", "typesafe"];

struct Outcome {
    evaluation_id: Option<i64>,
    outcome: String,
    source: String,
    chip_visible: bool,
    picked_index: Option<i64>,
    transaction_id: Option<i64>,
}

/// `null`, or a positive integer.
fn optional_id(value: &Value) -> Option<Option<i64>> {
    match value {
        Value::Null => Some(None),
        other => other.as_i64().filter(|id| *id > 0).map(Some),
    }
}

/// Exactly the six outcome fields.
fn outcome(body: &Value) -> Option<Outcome> {
    let object = body.as_object()?;
    if object.len() != 6 {
        return None;
    }
    let text = |key: &str, allowed: &[&str]| {
        object
            .get(key)?
            .as_str()
            .filter(|value| allowed.contains(value))
            .map(str::to_owned)
    };
    let picked_index = match object.get("pickedIndex")? {
        Value::Null => None,
        value => Some(value.as_i64().filter(|index| *index >= 0)?),
    };
    Some(Outcome {
        evaluation_id: optional_id(object.get("evaluationId")?)?,
        outcome: text("outcome", &OUTCOMES)?,
        source: text("source", &SOURCES)?,
        chip_visible: object.get("chipVisible")?.as_bool()?,
        picked_index,
        transaction_id: optional_id(object.get("transactionId")?)?,
    })
}

/// The user's final choice in the entry form, after a save or a cancel.
pub(crate) async fn record_entry_outcome(
    State(state): State<AppState>,
    Path(raw_book_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<Value>, ApiError> {
    let book = authenticate_book(
        &state,
        &headers,
        &raw_book_id,
        AccessLevel::Write,
        UNAVAILABLE,
    )
    .await?;
    let access = book.write()?;
    let book_id = access.book_id();
    let body: Value =
        from_json_bytes(&body).map_err(|_| error(StatusCode::BAD_REQUEST, "Invalid JSON"))?;
    let input = outcome(&body).ok_or_else(|| error(StatusCode::BAD_REQUEST, "Invalid outcome"))?;
    write_transaction_or(&state.database, unavailable, |tx| {
        let enabled = lock_book(tx, book_id)
            .map_err(unavailable)?
            .is_some_and(|(on, _)| on);
        if !enabled {
            return Err(error(StatusCode::CONFLICT, OFF));
        }
        for (table, id) in [
            ("typesafe_entry_evaluations", input.evaluation_id),
            ("transactions", input.transaction_id),
        ] {
            if let Some(id) = id
                && !owned(tx, table, book_id, id).map_err(unavailable)?
            {
                return Err(error(StatusCode::NOT_FOUND, "Not found"));
            }
        }
        tx.execute(
            "INSERT INTO typesafe_entry_outcomes
               (book_id, evaluation_id, outcome, source, chip_visible, picked_index,
                transaction_id, decided_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            &params![
                book_id,
                input.evaluation_id,
                &input.outcome,
                &input.source,
                input.chip_visible,
                input.picked_index,
                input.transaction_id,
                now_millis()
            ],
        )
        .map_err(unavailable)?;
        Ok(())
    })?;
    Ok(Json(json!({ "success": true })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_request_refuses_an_amount_without_a_magnitude() {
        let body = |amount: Value| json!({ "accountId": 1, "payeeId": 2, "date": "2026-10-12", "amount": amount });
        assert!(request(&body(json!(-5000))).is_some());
        assert!(request(&body(json!(i64::MIN))).is_none());
    }
}
