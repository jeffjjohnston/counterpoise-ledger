//! `sync/accounts/[id]/reconcile/suggestion`: the TypeSafe evaluation flow.
//! POST asks for a suggestion, PATCH
//! records that the browser showed it, and PUT confirms it through the
//! ordinary reconciliation resolver.
//!
//! The network call holds no database transaction. The book row lock
//! serializes claims. A lease of 30 seconds, a new attempt UUID per claim,
//! and the settings revision fence off old results. The fingerprint of the
//! snapshot proves, at display and at confirmation, that nothing it read has
//! changed.

use crate::platform;
use crate::typesafe::read_json_column;
use crate::{
    book_auth::{AccessLevel, authenticate_book},
    book_scope::{BookAccess, Write},
    error::{ApiError, error, error_owned},
    routes::{
        payees::normalize_name,
        reconcile::{
            Action, EFFECTIVE_DATE, ReconcileError, ReconcileInput, apply, load_item, load_row,
            match_candidates, reconcilable_link, suggest_counter_account,
        },
        transactions::now_millis,
    },
    state::AppState,
    typesafe::{Observation, is_configured, property, proposal, record_decision, strict_equal},
    typesafe_client::evaluate,
    typesafe_questions::{
        LoneSurrogate, MATCH_PROMPT_VERSION, Payee, TYPESAFE_MODEL, build_payee_options,
        build_questions, build_state, fingerprint, js_cmp, merchant_text,
    },
    validation::{js_number, js_stringify},
};
use axum::{
    Json,
    body::Bytes,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
};
use chrono::{Days, NaiveDateTime, TimeDelta};
use ledger_db::Database;
use ledger_db::locks::{FOR_SHARE, FOR_UPDATE};
use ledger_db::sql::{in_integers, json, json_array, today_literal};
use ledger_db::store::{self, Sql, Transaction, params};
use serde_json::{Map, Value, json};

const LEASE: TimeDelta = TimeDelta::seconds(30);
const RETRY: TimeDelta = TimeDelta::seconds(60);
const DAILY_ATTEMPTS: i32 = 100;
const MAX_CANDIDATE_COUNTERPART_ACCOUNTS: usize = 5;
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
const UNAVAILABLE: &str = "TypeSafe is temporarily unavailable";
const STALE_REVIEW: &str =
    "This TypeSafe suggestion is stale. Refresh and review the transaction again.";

/// The errors of `typeSafeHttpError`.
enum Failure {
    /// `TypeSafeRequestError`: its status and message.
    Request(StatusCode, &'static str),
    /// `ReconcileNotFoundError` and `ReconcileValidationError`.
    Reconcile(ReconcileError),
    /// Anything else: 503.
    Unavailable,
}

impl From<store::Error> for Failure {
    fn from(_: store::Error) -> Self {
        Self::Unavailable
    }
}

impl From<LoneSurrogate> for Failure {
    fn from(_: LoneSurrogate) -> Self {
        Self::Unavailable
    }
}

impl From<ReconcileError> for Failure {
    fn from(cause: ReconcileError) -> Self {
        Self::Reconcile(cause)
    }
}

impl Failure {
    fn into_api(self) -> ApiError {
        match self {
            Self::Request(status, message) => error(status, message),
            Self::Reconcile(ReconcileError::NotFound(message)) => {
                error(StatusCode::NOT_FOUND, message)
            }
            Self::Reconcile(ReconcileError::Invalid(message)) => {
                error_owned(StatusCode::BAD_REQUEST, message)
            }
            Self::Reconcile(_) | Self::Unavailable => {
                // As in Node, the log names no cause.
                tracing::error!("TypeSafe request failed");
                error(StatusCode::SERVICE_UNAVAILABLE, UNAVAILABLE)
            }
        }
    }
}

type Result<T> = std::result::Result<T, Failure>;

/// An ID from the path or the body as PostgreSQL takes it for an integer
/// column: a value beyond int4 fails the query, and the route answers 503.
fn column(value: i64) -> Result<i32> {
    i32::try_from(value).map_err(|_| Failure::Unavailable)
}

fn stale(message: &'static str) -> Failure {
    Failure::Request(StatusCode::CONFLICT, message)
}

/// `lockTypeSafeBook`: the enabled flag and revision, under the row lock.
fn lock_book(sql: &impl Sql, book_id: i32) -> Result<(bool, i32)> {
    let book: Option<(bool, i32)> = sql.query_optional(
        &format!(
            "SELECT typesafe_reconciliation_enabled, typesafe_revision FROM books
         WHERE id = ?1{FOR_UPDATE}"
        ),
        &params![book_id],
    )?;
    book.ok_or(Failure::Request(StatusCode::NOT_FOUND, "Book not found"))
}

/// `getTypeSafeSettings`: enabled and revision, without a lock.
fn settings(sql: &impl Sql, book_id: i32) -> Result<(bool, i32)> {
    let book: Option<(bool, i32)> = sql.query_optional(
        "SELECT typesafe_reconciliation_enabled, typesafe_revision FROM books WHERE id = ?1",
        &params![book_id],
    )?;
    book.ok_or(Failure::Request(StatusCode::NOT_FOUND, "Book not found"))
}

fn merchant_key(row: &crate::routes::reconcile::ReconRow) -> String {
    normalize_name(row.merchant()).to_lowercase()
}

/// `snapshot`: everything the request reads, in the key order of the Node
/// object literal, so that its fingerprint is the Node fingerprint. `None`
/// means that no request applies.
fn snapshot(
    sql: &impl Sql,
    book_id: i32,
    link_id: i64,
    reconciliation_id: i64,
) -> Result<Option<Value>> {
    let (enabled, revision) = settings(sql, book_id)?;
    if !enabled || !is_configured() {
        return Ok(None);
    }
    let link = reconcilable_link(sql, book_id, column(link_id)?)?;
    let token: Option<bool> = sql.query_optional(
        "SELECT t.is_demo FROM plaid_accounts pa JOIN plaid_tokens t ON t.id = pa.token_id
         WHERE pa.id = ?1 AND pa.book_id = ?2 AND t.book_id = ?2",
        &params![link.link_id, book_id],
    )?;
    let row = load_row(
        sql,
        link.link_id,
        column(reconciliation_id)?,
        book_id,
        false,
    )?
    .ok_or(Failure::Request(
        StatusCode::NOT_FOUND,
        "Reconciliation row not found",
    ))?;
    if token.is_none_or(|is_demo| is_demo)
        || row.pending
        || row
            .review_reason
            .as_deref()
            .is_some_and(|reason| !reason.is_empty())
        || row.matched_transaction_id.is_some_and(|id| id != 0)
        || row.resolution_status != "pending"
    {
        return Ok(None);
    }
    let currency: Option<String> = sql.query_row(
        "SELECT iso_currency_code FROM plaid_transaction_reconciliation WHERE id = ?1",
        &params![row.id],
    )?;
    let candidates = match_candidates(sql, &row, link.account_id)?;
    let key = merchant_key(&row);
    let seen_before: Option<i32> = sql.query_optional(
        "SELECT r.id FROM plaid_transaction_reconciliation r
         WHERE r.book_id = ?1 AND r.resolution_status = 'matched' AND r.merchant_key = ?2
         LIMIT 1",
        &params![book_id, &key],
    )?;
    let candidate_id = |candidate: &Value| {
        property(Some(candidate), "transactionId")
            .and_then(Value::as_i64)
            .unwrap_or_default() as i32
    };
    // The exact amount is the total on the linked account, even with more
    // than one split on that account.
    let totals: Vec<(i32, i64)> = if candidates.is_empty() {
        Vec::new()
    } else {
        sql.query(
            &format!(
                "SELECT transaction_id, CAST(sum(amount) AS bigint) FROM transaction_splits
             WHERE book_id = ?1 AND account_id = ?2 AND transaction_id {}
             GROUP BY transaction_id",
                in_integers("?3")
            ),
            &params![
                book_id,
                link.account_id,
                json_array(&candidates.iter().map(candidate_id).collect::<Vec<_>>(),)
            ],
        )?
    };
    let expected = -i64::from(row.amount_cents);
    let eligible: Vec<&Value> = candidates
        .iter()
        .filter(|candidate| {
            property(Some(candidate), "alreadyLinked") == Some(&Value::Bool(false))
                && property(Some(candidate), "amountDelta").and_then(Value::as_i64) == Some(0)
                && totals
                    .iter()
                    .any(|(id, total)| *id == candidate_id(candidate) && *total == expected)
        })
        .collect();
    // Only category-like counterparts are evidence. Every joined table is
    // scoped to the book.
    let counterparts: Vec<(i32, String, String)> = if eligible.is_empty() {
        Vec::new()
    } else {
        sql.query(
            &format!(
                "SELECT DISTINCT s.transaction_id, a.name, a.type
             FROM transaction_splits s
             JOIN transactions t ON t.id = s.transaction_id AND t.book_id = ?1
             JOIN accounts a ON a.id = s.account_id AND a.book_id = ?1
             WHERE s.book_id = ?1 AND s.transaction_id {}
               AND a.type IN ('income', 'expense')",
                in_integers("?2")
            ),
            &params![
                book_id,
                json_array(&eligible.iter().map(|c| candidate_id(c)).collect::<Vec<_>>(),)
            ],
        )?
    };
    let day: String = sql.query_row(
        &format!("SELECT {} FROM books WHERE id = ?1", today_literal()),
        &params![book_id],
    )?;
    // The payee that earlier resolved rows for this merchant used most.
    let merchant_payee: Option<(i32, String)> = sql.query_optional(
        "SELECT p.id, p.name FROM plaid_transaction_reconciliation r
         JOIN transactions t ON t.id = r.matched_transaction_id
         JOIN payees p ON p.id = t.payee_id
         WHERE r.book_id = ?1 AND t.book_id = ?1
           AND r.resolution_status IN ('matched', 'created') AND r.merchant_key = ?2
         GROUP BY p.id, p.name ORDER BY count(*) DESC, p.id LIMIT 1",
        &params![book_id, &key],
    )?;
    let payee_categories: Vec<(String, i32)> = match &merchant_payee {
        None => Vec::new(),
        Some((payee_id, _)) => sql.query(
            "SELECT a.name, CAST(count(*) AS integer) FROM transaction_splits s
                 JOIN transactions t ON t.id = s.transaction_id
                 JOIN accounts a ON a.id = s.account_id
                 WHERE t.book_id = ?1 AND t.payee_id = ?2 AND a.type IN ('income', 'expense')
                 GROUP BY a.id, a.name ORDER BY count(*) DESC, a.name LIMIT 3",
            &params![book_id, payee_id],
        )?,
    };
    let payees: Vec<Payee> = sql
        .query::<(i32, String)>(
            "SELECT id, name FROM payees WHERE book_id = ?1 ORDER BY id",
            &params![book_id],
        )?
        .into_iter()
        .map(|(id, name)| Payee { id, name })
        .collect();
    // Active income and expense accounts. Beyond 254, keep the ones with the
    // most splits in the last 365 days; a floating transaction counts as today.
    let mut categories: Vec<(i32, String, String)> = sql.query(
        &format!(
            "SELECT a.id, a.name, a.type FROM accounts a
         LEFT JOIN transaction_splits s ON s.account_id = a.id
         LEFT JOIN transactions t ON t.id = s.transaction_id
           AND {EFFECTIVE_DATE} >= ?2
         WHERE a.book_id = ?1 AND a.is_active = true AND a.type IN ('income', 'expense')
         GROUP BY a.id, a.name, a.type ORDER BY count(t.id) DESC, a.name LIMIT 254"
        ),
        &params![book_id, (platform::today() - Days::new(365)).to_string()],
    )?;
    // Code-unit order, not locale order, so that the fingerprint is stable.
    categories.sort_by(|a, b| js_cmp(&a.1, &b.1));
    let baseline_category = suggest_counter_account(sql, &row, link.account_id, book_id)?;

    let raw_merchant = row.merchant().to_owned();
    let merchant_payee = merchant_payee.map(|(id, name)| Payee { id, name });
    let snapshot_candidates = eligible
        .iter()
        .enumerate()
        .map(|(i, candidate)| -> Result<Value> {
            let id = candidate_id(candidate);
            let mut accounts: Vec<&(i32, String, String)> =
                counterparts.iter().filter(|(t, _, _)| *t == id).collect();
            accounts.sort_by(|a, b| js_cmp(&a.2, &b.2).then_with(|| js_cmp(&a.1, &b.1)));
            Ok(json!({
                "label": format!("candidate_{}", i + 1),
                "transactionId": id,
                "payee": merchant_text(property(Some(candidate), "payeeName").and_then(Value::as_str))?,
                "date": property(Some(candidate), "date"),
                "amountCents": property(Some(candidate), "linkedSplitAmount"),
                "counterpartAccounts": accounts
                    .into_iter()
                    .take(MAX_CANDIDATE_COUNTERPART_ACCOUNTS)
                    .map(|(_, name, kind)| json!({ "name": name, "kind": kind }))
                    .collect::<Vec<_>>(),
            }))
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(Some(json!({
        "bookId": book_id,
        "linkId": link_id,
        "reconciliationId": reconciliation_id,
        "revision": revision,
        "mappedAccountId": link.account_id,
        "effectiveDay": day,
        "model": TYPESAFE_MODEL,
        "promptVersion": MATCH_PROMPT_VERSION,
        "merchantSeenBefore": seen_before.is_some(),
        "bank": {
            "merchant": merchant_text(Some(&raw_merchant))?,
            "name": merchant_text(Some(&row.name))?,
            "amountCents": expected,
            "authorizedDate": row.authorized_date,
            "postedDate": row.date,
            "currency": currency,
        },
        "baselineIds": candidates.iter().map(candidate_id).collect::<Vec<_>>(),
        "candidates": snapshot_candidates,
        "history": {
            "merchantPayee": merchant_payee.as_ref().map(|payee| payee.name.clone()),
            "payeeCategories": payee_categories
                .into_iter()
                .map(|(account, count)| json!({ "account": account, "count": count }))
                .collect::<Vec<_>>(),
        },
        "payeeOptions": build_payee_options(&raw_merchant, merchant_payee.as_ref(), &payees),
        "categoryOptions": categories
            .into_iter()
            .enumerate()
            .map(|(i, (id, name, kind))| json!({
                "label": format!("category_{}", i + 1),
                "accountId": id,
                "name": name,
                "kind": kind,
            }))
            .collect::<Vec<_>>(),
        "baselineCategoryId": baseline_category,
    })))
}

/// An evaluation row. Its JSON columns are read as text, then put in jsonb
/// key order by `read_json_column`, as the PostgreSQL release returned them.
#[derive(ledger_db::store::FromRow)]
struct StoredEvaluation {
    id: i32,
    reconciliation_id: i32,
    revision: i32,
    fingerprint: String,
    attempt: String,
    status: String,
    started_at: NaiveDateTime,
    displayed_at: Option<NaiveDateTime>,
    choice: Option<String>,
    snapshot: String,
    answers: Option<String>,
}

const EVALUATION_COLUMNS: &str = "id, reconciliation_id, revision, fingerprint, attempt, status,
    started_at, displayed_at, choice, CAST(snapshot AS TEXT) AS snapshot,
    CAST(answers AS TEXT) AS answers";

struct Evaluation {
    row: StoredEvaluation,
    snapshot: Value,
    answers: Option<Value>,
}

impl Evaluation {
    fn read(row: StoredEvaluation) -> Result<Self> {
        let parse = |text: &str| read_json_column(text).map_err(|_| Failure::Unavailable);
        Ok(Self {
            snapshot: parse(&row.snapshot)?,
            answers: row.answers.as_deref().map(parse).transpose()?,
            row,
        })
    }

    fn choice(&self) -> Value {
        self.row
            .choice
            .clone()
            .map(Value::String)
            .unwrap_or(Value::Null)
    }

    /// The candidate that the answer chose, if any.
    fn chosen(&self) -> Result<Option<&Value>> {
        let choice = self.choice();
        match property(Some(&self.snapshot), "candidates") {
            Some(Value::Array(candidates)) => Ok(candidates
                .iter()
                .find(|c| strict_equal(property(Some(c), "label"), Some(&choice)))),
            _ => Err(Failure::Unavailable),
        }
    }

    /// `proposalFor` as `{ payee: { name, payeeId }, category: { accountId, name } }`.
    fn proposal(&self) -> Result<Option<Value>> {
        let answers = self.answers.as_ref().filter(|answers| !answers.is_null());
        let found = proposal(&self.snapshot, answers).map_err(|_| Failure::Unavailable)?;
        Ok(found.map(|(payee, category)| {
            let fields = |source: &Value, keys: &[&str]| -> Value {
                Value::Object(
                    keys.iter()
                        .filter_map(|key| {
                            Some(((*key).to_owned(), property(Some(source), key)?.clone()))
                        })
                        .collect(),
                )
            };
            json!({
                "payee": fields(payee, &["name", "payeeId"]),
                "category": fields(category, &["accountId", "name"]),
            })
        }))
    }

    /// `publicResult`.
    fn public(&self) -> Result<Value> {
        let transaction_id = self
            .chosen()?
            .and_then(|candidate| property(Some(candidate), "transactionId"))
            .cloned()
            .unwrap_or(Value::Null);
        Ok(json!({
            "status": "ready",
            "evaluationId": self.row.id,
            "revision": self.row.revision,
            "transactionId": transaction_id,
            "proposal": self.proposal()?,
        }))
    }
}

fn status(status: &str, evaluation_id: Option<i32>) -> Value {
    match evaluation_id {
        Some(id) => json!({ "status": status, "evaluationId": id }),
        None => json!({ "status": status }),
    }
}

/// A random UUID version 4, as `randomUUID()`.
fn random_uuid() -> Result<String> {
    let mut bytes = [0u8; 16];
    platform::random(&mut bytes).map_err(|_| Failure::Unavailable)?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex = hex::encode(bytes);
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    ))
}

enum Claim {
    Done(Value),
    Claimed(Box<Evaluation>),
}

/// The first transaction of `requestMatchSuggestion`: take the lease, or
/// answer from what is stored.
fn claim(
    sql: &impl Sql,
    access: &BookAccess<'_, Write>,
    link_id: i64,
    reconciliation_id: i64,
) -> Result<Claim> {
    let book_id = access.book_id();
    let (enabled, _) = lock_book(sql, book_id)?;
    if !enabled || !is_configured() {
        return Ok(Claim::Done(status("disabled", None)));
    }
    let Some(input) = snapshot(sql, book_id, link_id, reconciliation_id)? else {
        return Ok(Claim::Done(status("skipped", None)));
    };
    let hash = fingerprint(&input);
    let asks = !build_questions(&input)?.is_empty();
    let existing: Option<StoredEvaluation> = sql.query_optional(&format!(
        "SELECT {EVALUATION_COLUMNS} FROM typesafe_evaluations WHERE book_id = ?1 AND fingerprint = ?2"
    ), &params![book_id, &hash])?;
    let now = now_millis();
    if let Some(existing) = existing {
        match existing.status.as_str() {
            "ready" => return Ok(Claim::Done(Evaluation::read(existing)?.public()?)),
            "skipped" => return Ok(Claim::Done(status("skipped", Some(existing.id)))),
            "error" if now - existing.started_at < RETRY => {
                return Ok(Claim::Done(status("unavailable", Some(existing.id))));
            }
            _ => {}
        }
    }
    let active: Option<i32> = sql.query_optional(
        "SELECT id FROM typesafe_evaluations
         WHERE book_id = ?1 AND status = 'pending' AND started_at > ?2 LIMIT 1",
        &params![book_id, now - LEASE],
    )?;
    if active.is_some() {
        return Ok(Claim::Done(status("busy", None)));
    }
    if asks {
        let day = now.format("%Y-%m-%d").to_string();
        let attempts: Option<i32> = sql.query_optional(
            "SELECT attempts FROM typesafe_quotas WHERE book_id = ?1 AND day = ?2",
            &params![book_id, &day],
        )?;
        if attempts.unwrap_or(0) >= DAILY_ATTEMPTS {
            return Ok(Claim::Done(status("limited", None)));
        }
        sql.execute(
            "INSERT INTO typesafe_quotas (book_id, day, attempts) VALUES (?1, ?2, 1)
             ON CONFLICT (book_id, day) DO UPDATE SET attempts = typesafe_quotas.attempts + 1",
            &params![book_id, &day],
        )?;
    }
    let revision = property(Some(&input), "revision")
        .and_then(Value::as_i64)
        .unwrap_or_default();
    let snapshot_json = json("?6");
    let record: StoredEvaluation = sql.query_row(&format!(
        "INSERT INTO typesafe_evaluations
           (book_id, link_id, reconciliation_id, revision, fingerprint, snapshot, attempt, status,
            started_at, completed_at, error_code, choice, probabilities, confidence, usage, answers,
            displayed_at, latency_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, {snapshot_json}, ?7, ?8, ?9, NULL, NULL, NULL, NULL, NULL, NULL,
                 NULL, NULL, NULL)
         ON CONFLICT (book_id, fingerprint) DO UPDATE SET
           book_id = excluded.book_id, link_id = excluded.link_id,
           reconciliation_id = excluded.reconciliation_id, revision = excluded.revision,
           fingerprint = excluded.fingerprint, snapshot = excluded.snapshot,
           attempt = excluded.attempt, status = excluded.status, started_at = excluded.started_at,
           completed_at = NULL, error_code = NULL, choice = NULL, probabilities = NULL,
           confidence = NULL, usage = NULL, answers = NULL, displayed_at = NULL, latency_ms = NULL
         RETURNING {EVALUATION_COLUMNS}"
    ), &params![book_id, column(link_id)?, column(reconciliation_id)?, column(revision)?, &hash, js_stringify(&input), random_uuid()?, if asks { "pending" } else { "skipped" }, now])?;
    if !asks {
        return Ok(Claim::Done(status("skipped", Some(record.id))));
    }
    Ok(Claim::Claimed(Box::new(Evaluation::read(record)?)))
}

/// Runs `work` in one transaction: commit on success, roll back on failure.
fn in_transaction<T>(
    database: &Database,
    work: impl FnOnce(&Transaction<'_>) -> Result<T>,
) -> Result<T> {
    database.transaction(work)
}

/// `requestMatchSuggestion`.
async fn request_suggestion(
    database: &Database,
    access: &BookAccess<'_, Write>,
    link_id: i64,
    reconciliation_id: i64,
) -> Result<Value> {
    let book_id = access.book_id();
    let record = match in_transaction(database, |sql| {
        claim(sql, access, link_id, reconciliation_id)
    })? {
        Claim::Done(result) => return Ok(result),
        Claim::Claimed(record) => record,
    };
    // Network happens outside every database transaction. Once sent, the
    // data cannot be recalled, even if the book turns the feature off.
    let answer = match settings(database, book_id) {
        Ok((enabled, revision))
            if enabled && is_configured() && revision == record.row.revision =>
        {
            match (
                build_state(&record.snapshot),
                build_questions(&record.snapshot),
            ) {
                (Ok(state), Ok(questions)) => evaluate(&state, &questions).await,
                _ => Err("unavailable"),
            }
        }
        Ok(_) => Err("stale"),
        Err(_) => Err("unavailable"),
    };
    in_transaction(database, |sql| {
        let (enabled, revision) = lock_book(sql, book_id)?;
        let current: Option<i32> = sql.query_optional("SELECT id FROM typesafe_evaluations WHERE id = ?1 AND attempt = ?2 AND status = 'pending'", &params![record.row.id, &record.row.attempt])?;
        if current.is_none() {
            return Ok(status("stale", None));
        }
        let fresh = if enabled && revision == record.row.revision && is_configured() {
            // A deleted or unmapped row invalidates the answer.
            snapshot(sql, book_id, link_id, reconciliation_id)
                .ok()
                .flatten()
        } else {
            None
        };
        let is_stale = fresh.is_none_or(|fresh| fingerprint(&fresh) != record.row.fingerprint);
        let now = now_millis();
        let latency = (now - record.row.started_at).num_milliseconds();
        let answers = answer.as_ref().ok().map(|evaluated| &evaluated.answers);
        let matched = answers.and_then(|answers| answers.get("match"));
        let field = |key: &str| -> Option<String> {
            matched
                .and_then(|answer| property(Some(answer), key))
                .filter(|_| !is_stale)
                .map(js_stringify)
        };
        let choice = matched
            .and_then(|answer| property(Some(answer), "choice"))
            .and_then(Value::as_str)
            .filter(|_| !is_stale);
        let new_status = if is_stale {
            "stale"
        } else if answer.is_ok() {
            "ready"
        } else {
            "error"
        };
        let error_code = if is_stale {
            Some("stale")
        } else {
            answer.as_ref().err().copied()
        };
        let stored_answers = answers
            .filter(|_| !is_stale)
            .map(|answers| js_stringify(&Value::Object(answers.clone())));
        // `usage: answer?.usage`: without an answer the column is not set.
        let usage = answer
            .as_ref()
            .ok()
            .map(|evaluated| evaluated.usage.as_ref().map(js_stringify));
        let (probabilities, confidence, answers, usage_json) =
            (json("?8"), json("?9"), json("?10"), json("?12"));
        let updated: StoredEvaluation = sql.query_row(
            &format!(
                "UPDATE typesafe_evaluations SET status = ?3, completed_at = ?4, latency_ms = ?5,
               error_code = ?6, choice = ?7, probabilities = {probabilities},
               confidence = {confidence}, answers = {answers},
               usage = CASE WHEN ?11 THEN {usage_json} ELSE usage END
             WHERE id = ?1 AND attempt = ?2
             RETURNING {EVALUATION_COLUMNS}"
            ),
            &params![
                record.row.id,
                &record.row.attempt,
                new_status,
                now,
                i32::try_from(latency).unwrap_or(i32::MAX),
                error_code,
                choice,
                field("probabilities"),
                field("confidence"),
                stored_answers,
                usage.is_some(),
                usage.flatten()
            ],
        )?;
        if is_stale {
            Ok(status("stale", None))
        } else if answer.is_ok() {
            Evaluation::read(updated)?.public()
        } else {
            Ok(status("unavailable", Some(record.row.id)))
        }
    })
}

/// `validEvaluation`: a ready evaluation whose snapshot still has the same
/// fingerprint. Anything else is stale.
fn valid_evaluation(
    sql: &impl Sql,
    book_id: i32,
    link_id: i64,
    evaluation_id: i64,
) -> Result<Evaluation> {
    let record: Option<StoredEvaluation> = sql.query_optional(
        &format!(
            "SELECT {EVALUATION_COLUMNS} FROM typesafe_evaluations
         WHERE id = ?1 AND book_id = ?2 AND link_id = ?3 AND status = 'ready'"
        ),
        &params![column(evaluation_id)?, book_id, column(link_id)?],
    )?;
    let Some(record) = record else {
        return Err(stale(STALE_REVIEW));
    };
    let input = snapshot(sql, book_id, link_id, i64::from(record.reconciliation_id))
        .ok()
        .flatten();
    if input.is_none_or(|input| fingerprint(&input) != record.fingerprint) {
        return Err(stale(STALE_REVIEW));
    }
    Evaluation::read(record)
}

/// `markSuggestionDisplayed`.
fn mark_displayed(
    database: &Database,
    access: &BookAccess<'_, Write>,
    link_id: i64,
    evaluation_id: i64,
) -> Result<Value> {
    let book_id = access.book_id();
    in_transaction(database, |sql| {
        lock_book(sql, book_id)?;
        let record = valid_evaluation(sql, book_id, link_id, evaluation_id)?;
        sql.execute("UPDATE typesafe_evaluations SET displayed_at = coalesce(displayed_at, ?2) WHERE id = ?1", &params![record.row.id, record.row.displayed_at.unwrap_or_else(now_millis)])?;
        record.public()
    })
}

/// `lockConfirmation`: locks what a confirmation reads until the resolver
/// commits, in a fixed order.
fn lock_confirmation(sql: &impl Sql, link_id: i64, record: &Evaluation) -> Result<()> {
    sql.query::<store::Row>(
        &format!("SELECT id FROM plaid_accounts WHERE id = ?1{FOR_UPDATE}"),
        &params![column(link_id)?],
    )?;
    sql.query::<store::Row>(
        &format!("SELECT id FROM plaid_transaction_reconciliation WHERE id = ?1{FOR_UPDATE}"),
        &params![record.row.reconciliation_id],
    )?;
    let mut ids: Vec<i32> = match property(Some(&record.snapshot), "candidates") {
        Some(Value::Array(candidates)) => candidates
            .iter()
            .map(|c| {
                property(Some(c), "transactionId")
                    .and_then(Value::as_i64)
                    .and_then(|id| i32::try_from(id).ok())
                    .ok_or(Failure::Unavailable)
            })
            .collect::<Result<_>>()?,
        _ => return Err(Failure::Unavailable),
    };
    ids.sort_unstable();
    if !ids.is_empty() {
        let payee_ids: Vec<Option<i32>> = sql.query(
            &format!(
                "SELECT payee_id FROM transactions WHERE id {} ORDER BY id{FOR_UPDATE}",
                in_integers("?1")
            ),
            &params![json_array(&ids)],
        )?;
        sql.query::<store::Row>(
            &format!(
                "SELECT id FROM transaction_splits WHERE transaction_id {} ORDER BY id{FOR_UPDATE}",
                in_integers("?1")
            ),
            &params![json_array(&ids)],
        )?;
        let mut payee_ids: Vec<i32> = payee_ids.into_iter().flatten().collect();
        payee_ids.sort_unstable();
        payee_ids.dedup();
        if !payee_ids.is_empty() {
            sql.query::<store::Row>(
                &format!(
                    "SELECT id FROM payees WHERE id {} ORDER BY id{FOR_SHARE}",
                    in_integers("?1")
                ),
                &params![json_array(&payee_ids)],
            )?;
        }
    }
    if let Some(proposal) = record.proposal()? {
        let id = |path: [&str; 2]| {
            property(property(Some(&proposal), path[0]), path[1])
                .and_then(Value::as_i64)
                .map(|id| i32::try_from(id).map_err(|_| Failure::Unavailable))
                .transpose()
        };
        if let Some(account_id) = id(["category", "accountId"])? {
            sql.query::<store::Row>(
                &format!("SELECT id FROM accounts WHERE id = ?1{FOR_SHARE}"),
                &params![account_id],
            )?;
        }
        if let Some(payee_id) = id(["payee", "payeeId"])? {
            sql.query::<store::Row>(
                &format!("SELECT id FROM payees WHERE id = ?1{FOR_SHARE}"),
                &params![payee_id],
            )?;
        }
    }
    Ok(())
}

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Match,
    Create,
}

/// `confirmMatchSuggestion` and `confirmCreateProposal`: the ordinary
/// resolver runs in the same transaction as the checks. Returns the
/// resolved item and the decision it applied.
fn confirm(
    database: &Database,
    access: &BookAccess<'_, Write>,
    link_id: i64,
    evaluation_id: i64,
    kind: Kind,
    shown_at: NaiveDateTime,
    actor: i32,
) -> Result<(Value, ReconcileInput)> {
    let book_id = access.book_id();
    let (link, row_id, input) = in_transaction(database, |sql| {
        lock_book(sql, book_id)?;
        let record: Option<StoredEvaluation> = sql.query_optional(
            &format!(
                "SELECT {EVALUATION_COLUMNS} FROM typesafe_evaluations
             WHERE id = ?1 AND book_id = ?2 AND link_id = ?3"
            ),
            &params![column(evaluation_id)?, book_id, column(link_id)?],
        )?;
        let record = Evaluation::read(record.ok_or(stale(
            "This TypeSafe suggestion is stale. Refresh and review again.",
        ))?)?;
        lock_confirmation(sql, link_id, &record)?;
        let valid = valid_evaluation(sql, book_id, link_id, evaluation_id)?;
        // A click proves that the suggestion was on screen, even when the
        // display report has not arrived yet.
        if valid.row.displayed_at.is_none() {
            sql.execute(
                "UPDATE typesafe_evaluations SET displayed_at = ?2 WHERE id = ?1",
                &params![valid.row.id, shown_at],
            )?;
        }
        let reconciliation_id = f64::from(valid.row.reconciliation_id);
        let input = match kind {
            Kind::Match => {
                let candidate = valid
                    .chosen()?
                    .ok_or(stale("This TypeSafe suggestion is stale or has no match."))?;
                ReconcileInput {
                    reconciliation_id,
                    action: Action::Match,
                    transaction_id: property(Some(candidate), "transactionId").cloned(),
                    counter_account_id: None,
                    payee_name: None,
                }
            }
            Kind::Create => {
                let proposal = valid.proposal()?.ok_or(stale(
                    "This TypeSafe suggestion has no new transaction to create.",
                ))?;
                ReconcileInput {
                    reconciliation_id,
                    action: Action::Create,
                    transaction_id: None,
                    counter_account_id: property(
                        property(Some(&proposal), "category"),
                        "accountId",
                    )
                    .cloned(),
                    payee_name: property(property(Some(&proposal), "payee"), "name").cloned(),
                }
            }
        };
        let link = reconcilable_link(sql, book_id, column(link_id)?)?;
        let row_id = apply(sql, access, link, &input, actor, now_millis())?;
        Ok((link, row_id, input))
    })?;
    let sql = database;
    let row = load_row(sql, link.link_id, row_id, book_id, false)?.ok_or(Failure::Reconcile(
        ReconcileError::NotFound("Updated row not found"),
    ))?;
    let item = load_item(sql, &row, link.account_id, book_id)?;
    Ok((item, input))
}

/// `z.number().int().positive()`, as a safe integer.
fn positive_id(value: Option<&Value>) -> Option<i64> {
    let number = js_number(value?.as_number()?);
    (number.fract() == 0.0 && number > 0.0 && number <= MAX_SAFE_INTEGER).then_some(number as i64)
}

/// A strict object: only these keys.
fn only_keys(object: &Map<String, Value>, allowed: &[&str]) -> bool {
    object.keys().all(|key| allowed.contains(&key.as_str()))
}

fn path_id(raw: &str) -> Option<i64> {
    let mut chars = raw.chars();
    let well_formed = chars
        .next()
        .is_some_and(|first| ('1'..='9').contains(&first))
        && chars.all(|c| c.is_ascii_digit());
    // Number(id): a very long ID is not an int4 and fails its query.
    well_formed.then(|| raw.parse::<i64>().unwrap_or(i64::MAX))
}

/// The shared start of the three methods: the ID shapes, write access, and
/// the JSON body.
async fn prepare(
    state: &AppState,
    headers: &HeaderMap,
    raw_book_id: &str,
    raw_link_id: &str,
    body: &Bytes,
) -> std::result::Result<
    (
        crate::book_auth::AuthenticatedBook,
        i64,
        Map<String, Value>,
        Value,
    ),
    ApiError,
> {
    let (Some(_), Some(link_id)) = (path_id(raw_book_id), path_id(raw_link_id)) else {
        return Err(error(StatusCode::BAD_REQUEST, "Invalid book or link ID"));
    };
    let book = authenticate_book(state, headers, raw_book_id, AccessLevel::Write, UNAVAILABLE)
        .await
        .map_err(|denied| {
            if denied.status() == StatusCode::INTERNAL_SERVER_ERROR {
                Failure::Unavailable.into_api()
            } else {
                denied
            }
        })?;
    let body: Value = crate::validation::from_json_bytes(body)
        .map_err(|_| error(StatusCode::BAD_REQUEST, "Invalid JSON"))?;
    let object = body.as_object().cloned().unwrap_or_default();
    Ok((book, link_id, object, body))
}

pub(crate) async fn request_route(
    State(state): State<AppState>,
    Path((raw_book_id, raw_link_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> std::result::Result<Json<Value>, ApiError> {
    let (book, link_id, object, body) =
        prepare(&state, &headers, &raw_book_id, &raw_link_id, &body).await?;
    let access = book.write()?;
    let reconciliation_id = body
        .is_object()
        .then(|| positive_id(object.get("reconciliationId")))
        .flatten()
        .filter(|_| only_keys(&object, &["reconciliationId"]))
        .ok_or_else(|| error(StatusCode::BAD_REQUEST, "Invalid reconciliation ID"))?;
    request_suggestion(&state.database, &access, link_id, reconciliation_id)
        .await
        .map(Json)
        .map_err(Failure::into_api)
}

pub(crate) async fn display_route(
    State(state): State<AppState>,
    Path((raw_book_id, raw_link_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> std::result::Result<Json<Value>, ApiError> {
    let (book, link_id, object, body) =
        prepare(&state, &headers, &raw_book_id, &raw_link_id, &body).await?;
    let access = book.write()?;
    let evaluation_id = body
        .is_object()
        .then(|| positive_id(object.get("evaluationId")))
        .flatten()
        .filter(|_| only_keys(&object, &["evaluationId"]))
        .ok_or_else(|| error(StatusCode::BAD_REQUEST, "Invalid evaluation ID"))?;
    mark_displayed(&state.database, &access, link_id, evaluation_id)
        .map(Json)
        .map_err(Failure::into_api)
}

/// `typesafeConfirmationSchema`: the evaluation, an optional review time,
/// and an optional kind. Leaving out the kind means a match.
fn confirmation(body: &Value, object: &Map<String, Value>) -> Option<(i64, Option<f64>, Kind)> {
    if !body.is_object() || !only_keys(object, &["evaluationId", "activeReviewMs", "kind"]) {
        return None;
    }
    let evaluation_id = positive_id(object.get("evaluationId"))?;
    let active_review_ms = match object.get("activeReviewMs") {
        None => None,
        Some(value) => {
            let number = js_number(value.as_number()?);
            (number.fract() == 0.0 && (0.0..=3_600_000.0).contains(&number))
                .then_some(Some(number))?
        }
    };
    let kind = match object.get("kind") {
        None => Kind::Match,
        Some(value) => match value.as_str()? {
            "match" => Kind::Match,
            "create" => Kind::Create,
            _ => return None,
        },
    };
    Some((evaluation_id, active_review_ms, kind))
}

pub(crate) async fn confirm_route(
    State(state): State<AppState>,
    Path((raw_book_id, raw_link_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> std::result::Result<Json<Value>, ApiError> {
    let started_at = now_millis();
    let (book, link_id, object, body) =
        prepare(&state, &headers, &raw_book_id, &raw_link_id, &body).await?;
    let access = book.write()?;
    let (evaluation_id, active_review_ms, kind) = confirmation(&body, &object)
        .ok_or_else(|| error(StatusCode::BAD_REQUEST, "Invalid evaluation ID"))?;
    let (item, mut input) = confirm(
        &state.database,
        &access,
        link_id,
        evaluation_id,
        kind,
        started_at,
        book.user_id(),
    )
    .map_err(Failure::into_api)?;
    // The decision names the transaction that the resolver linked.
    input.transaction_id = property(Some(&item), "matchedTransactionId")
        .filter(|id| id.is_number())
        .cloned();
    if kind == Kind::Match {
        input.reconciliation_id = property(Some(&item), "id")
            .and_then(Value::as_number)
            .map(js_number)
            .unwrap_or(input.reconciliation_id);
    }
    // Best-effort evidence after a committed ledger write; it never fails
    // the response.
    record_decision(
        &state.database,
        &access,
        &input,
        &Observation::accepted(evaluation_id as f64, active_review_ms),
        started_at,
    );
    Ok(Json(item))
}
