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

use crate::typesafe::read_json_column;
use crate::{
    book_auth::{AccessLevel, authenticate_book},
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
use chrono::{Days, Local, NaiveDateTime, TimeDelta};
use ledger_db::engine::{DbConnection, DbExecutor, DbPool};
use ledger_db::locks::{FOR_SHARE, FOR_UPDATE};
use ledger_db::sql::{self, MERCHANT_KEY};
use serde_json::{Map, Value, json};
use sqlx::FromRow;

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

impl From<sqlx::Error> for Failure {
    fn from(_: sqlx::Error) -> Self {
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
async fn lock_book(connection: &mut DbConnection, book_id: i32) -> Result<(bool, i32)> {
    let book: Option<(bool, i32)> = sqlx::query_as(&format!(
        "SELECT typesafe_reconciliation_enabled, typesafe_revision FROM books
         WHERE id = $1{FOR_UPDATE}"
    ))
    .bind(book_id)
    .fetch_optional(&mut *connection)
    .await?;
    book.ok_or(Failure::Request(StatusCode::NOT_FOUND, "Book not found"))
}

/// `getTypeSafeSettings`: enabled and revision, without a lock.
async fn settings<'e, E: DbExecutor<'e>>(executor: E, book_id: i32) -> Result<(bool, i32)> {
    let book: Option<(bool, i32)> = sqlx::query_as(
        "SELECT typesafe_reconciliation_enabled, typesafe_revision FROM books WHERE id = $1",
    )
    .bind(book_id)
    .fetch_optional(executor)
    .await?;
    book.ok_or(Failure::Request(StatusCode::NOT_FOUND, "Book not found"))
}

fn merchant_key(row: &crate::routes::reconcile::ReconRow) -> String {
    normalize_name(row.merchant()).to_lowercase()
}

/// `snapshot`: everything the request reads, in the key order of the Node
/// object literal, so that its fingerprint is the Node fingerprint. `None`
/// means that no request applies.
async fn snapshot(
    connection: &mut DbConnection,
    book_id: i32,
    link_id: i64,
    reconciliation_id: i64,
) -> Result<Option<Value>> {
    let (enabled, revision) = settings(&mut *connection, book_id).await?;
    if !enabled || !is_configured() {
        return Ok(None);
    }
    let link = reconcilable_link(&mut *connection, book_id, column(link_id)?).await?;
    let token: Option<bool> = sqlx::query_scalar(
        "SELECT t.is_demo FROM plaid_accounts pa JOIN plaid_tokens t ON t.id = pa.token_id
         WHERE pa.id = $1 AND pa.book_id = $2 AND t.book_id = $2",
    )
    .bind(link.link_id)
    .bind(book_id)
    .fetch_optional(&mut *connection)
    .await?;
    let row = load_row(
        connection,
        link.link_id,
        column(reconciliation_id)?,
        book_id,
        false,
    )
    .await?
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
    let currency: Option<String> = sqlx::query_scalar(
        "SELECT iso_currency_code FROM plaid_transaction_reconciliation WHERE id = $1",
    )
    .bind(row.id)
    .fetch_one(&mut *connection)
    .await?;
    let candidates = match_candidates(connection, &row, link.account_id).await?;
    let key = merchant_key(&row);
    let seen_before: Option<i32> = sqlx::query_scalar(&format!(
        "SELECT r.id FROM plaid_transaction_reconciliation r
         WHERE r.book_id = $1 AND r.resolution_status = 'matched' AND {MERCHANT_KEY} = $2
         LIMIT 1"
    ))
    .bind(book_id)
    .bind(&key)
    .fetch_optional(&mut *connection)
    .await?;
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
        sqlx::query_as(&format!(
            "SELECT transaction_id, CAST(sum(amount) AS bigint) FROM transaction_splits
             WHERE book_id = $1 AND account_id = $2 AND transaction_id {}
             GROUP BY transaction_id",
            sql::in_integers("$3")
        ))
        .bind(book_id)
        .bind(link.account_id)
        .bind(sql::json_array(
            &candidates.iter().map(candidate_id).collect::<Vec<_>>(),
        ))
        .fetch_all(&mut *connection)
        .await?
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
        sqlx::query_as(&format!(
            "SELECT DISTINCT s.transaction_id, a.name, a.type
             FROM transaction_splits s
             JOIN transactions t ON t.id = s.transaction_id AND t.book_id = $1
             JOIN accounts a ON a.id = s.account_id AND a.book_id = $1
             WHERE s.book_id = $1 AND s.transaction_id {}
               AND a.type IN ('income', 'expense')",
            sql::in_integers("$2")
        ))
        .bind(book_id)
        .bind(sql::json_array(
            &eligible.iter().map(|c| candidate_id(c)).collect::<Vec<_>>(),
        ))
        .fetch_all(&mut *connection)
        .await?
    };
    let day: String = sqlx::query_scalar(concat!(
        "SELECT ",
        ledger_db::today!(),
        " FROM books WHERE id = $1"
    ))
    .bind(book_id)
    .fetch_one(&mut *connection)
    .await?;
    // The payee that earlier resolved rows for this merchant used most.
    let merchant_payee: Option<(i32, String)> = sqlx::query_as(&format!(
        "SELECT p.id, p.name FROM plaid_transaction_reconciliation r
         JOIN transactions t ON t.id = r.matched_transaction_id
         JOIN payees p ON p.id = t.payee_id
         WHERE r.book_id = $1 AND t.book_id = $1
           AND r.resolution_status IN ('matched', 'created') AND {MERCHANT_KEY} = $2
         GROUP BY p.id, p.name ORDER BY count(*) DESC, p.id LIMIT 1"
    ))
    .bind(book_id)
    .bind(&key)
    .fetch_optional(&mut *connection)
    .await?;
    let payee_categories: Vec<(String, i32)> = match &merchant_payee {
        None => Vec::new(),
        Some((payee_id, _)) => {
            sqlx::query_as(
                "SELECT a.name, CAST(count(*) AS integer) FROM transaction_splits s
                 JOIN transactions t ON t.id = s.transaction_id
                 JOIN accounts a ON a.id = s.account_id
                 WHERE t.book_id = $1 AND t.payee_id = $2 AND a.type IN ('income', 'expense')
                 GROUP BY a.id, a.name ORDER BY count(*) DESC, a.name LIMIT 3",
            )
            .bind(book_id)
            .bind(payee_id)
            .fetch_all(&mut *connection)
            .await?
        }
    };
    let payees: Vec<Payee> = sqlx::query_as::<_, (i32, String)>(
        "SELECT id, name FROM payees WHERE book_id = $1 ORDER BY id",
    )
    .bind(book_id)
    .fetch_all(&mut *connection)
    .await?
    .into_iter()
    .map(|(id, name)| Payee { id, name })
    .collect();
    // Active income and expense accounts. Beyond 254, keep the ones with the
    // most splits in the last 365 days; a floating transaction counts as today.
    let mut categories: Vec<(i32, String, String)> = sqlx::query_as(&format!(
        "SELECT a.id, a.name, a.type FROM accounts a
         LEFT JOIN transaction_splits s ON s.account_id = a.id
         LEFT JOIN transactions t ON t.id = s.transaction_id
           AND {EFFECTIVE_DATE} >= $2
         WHERE a.book_id = $1 AND a.is_active = true AND a.type IN ('income', 'expense')
         GROUP BY a.id, a.name, a.type ORDER BY count(t.id) DESC, a.name LIMIT 254"
    ))
    .bind(book_id)
    .bind((Local::now().date_naive() - Days::new(365)).to_string())
    .fetch_all(&mut *connection)
    .await?;
    // Code-unit order, not locale order, so that the fingerprint is stable.
    categories.sort_by(|a, b| js_cmp(&a.1, &b.1));
    let baseline_category =
        suggest_counter_account(connection, &row, link.account_id, book_id).await?;

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
#[derive(FromRow)]
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
    getrandom::fill(&mut bytes).map_err(|_| Failure::Unavailable)?;
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
async fn claim(
    connection: &mut DbConnection,
    book_id: i32,
    link_id: i64,
    reconciliation_id: i64,
) -> Result<Claim> {
    let (enabled, _) = lock_book(connection, book_id).await?;
    if !enabled || !is_configured() {
        return Ok(Claim::Done(status("disabled", None)));
    }
    let Some(input) = snapshot(connection, book_id, link_id, reconciliation_id).await? else {
        return Ok(Claim::Done(status("skipped", None)));
    };
    let hash = fingerprint(&input);
    let asks = !build_questions(&input)?.is_empty();
    let existing: Option<StoredEvaluation> = sqlx::query_as(&format!(
        "SELECT {EVALUATION_COLUMNS} FROM typesafe_evaluations WHERE book_id = $1 AND fingerprint = $2"
    ))
    .bind(book_id)
    .bind(&hash)
    .fetch_optional(&mut *connection)
    .await?;
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
    let active: Option<i32> = sqlx::query_scalar(
        "SELECT id FROM typesafe_evaluations
         WHERE book_id = $1 AND status = 'pending' AND started_at > $2 LIMIT 1",
    )
    .bind(book_id)
    .bind(now - LEASE)
    .fetch_optional(&mut *connection)
    .await?;
    if active.is_some() {
        return Ok(Claim::Done(status("busy", None)));
    }
    if asks {
        let day = now.format("%Y-%m-%d").to_string();
        let attempts: Option<i32> = sqlx::query_scalar(
            "SELECT attempts FROM typesafe_quotas WHERE book_id = $1 AND day = $2",
        )
        .bind(book_id)
        .bind(&day)
        .fetch_optional(&mut *connection)
        .await?;
        if attempts.unwrap_or(0) >= DAILY_ATTEMPTS {
            return Ok(Claim::Done(status("limited", None)));
        }
        sqlx::query(
            "INSERT INTO typesafe_quotas (book_id, day, attempts) VALUES ($1, $2, 1)
             ON CONFLICT (book_id, day) DO UPDATE SET attempts = typesafe_quotas.attempts + 1",
        )
        .bind(book_id)
        .bind(&day)
        .execute(&mut *connection)
        .await?;
    }
    let revision = property(Some(&input), "revision")
        .and_then(Value::as_i64)
        .unwrap_or_default();
    let snapshot_json = sql::json("$6");
    let record: StoredEvaluation = sqlx::query_as(&format!(
        "INSERT INTO typesafe_evaluations
           (book_id, link_id, reconciliation_id, revision, fingerprint, snapshot, attempt, status,
            started_at, completed_at, error_code, choice, probabilities, confidence, usage, answers,
            displayed_at, latency_ms)
         VALUES ($1, $2, $3, $4, $5, {snapshot_json}, $7, $8, $9, NULL, NULL, NULL, NULL, NULL, NULL,
                 NULL, NULL, NULL)
         ON CONFLICT (book_id, fingerprint) DO UPDATE SET
           book_id = excluded.book_id, link_id = excluded.link_id,
           reconciliation_id = excluded.reconciliation_id, revision = excluded.revision,
           fingerprint = excluded.fingerprint, snapshot = excluded.snapshot,
           attempt = excluded.attempt, status = excluded.status, started_at = excluded.started_at,
           completed_at = NULL, error_code = NULL, choice = NULL, probabilities = NULL,
           confidence = NULL, usage = NULL, answers = NULL, displayed_at = NULL, latency_ms = NULL
         RETURNING {EVALUATION_COLUMNS}"
    ))
    .bind(book_id)
    .bind(column(link_id)?)
    .bind(column(reconciliation_id)?)
    .bind(column(revision)?)
    .bind(&hash)
    .bind(js_stringify(&input))
    .bind(random_uuid()?)
    .bind(if asks { "pending" } else { "skipped" })
    .bind(now)
    .fetch_one(&mut *connection)
    .await?;
    if !asks {
        return Ok(Claim::Done(status("skipped", Some(record.id))));
    }
    Ok(Claim::Claimed(Box::new(Evaluation::read(record)?)))
}

/// Runs `work` in one transaction: commit on success, roll back on failure.
async fn in_transaction<T>(
    pool: &DbPool,
    work: impl AsyncFnOnce(&mut DbConnection) -> Result<T>,
) -> Result<T> {
    let mut transaction = ledger_db::locks::begin_pool(pool).await?;
    let result = work(transaction.as_mut()).await;
    match result {
        Ok(value) => {
            transaction.commit().await?;
            Ok(value)
        }
        Err(failure) => {
            let _ = transaction.rollback().await;
            Err(failure)
        }
    }
}

/// `requestMatchSuggestion`.
async fn request_suggestion(
    pool: &DbPool,
    book_id: i32,
    link_id: i64,
    reconciliation_id: i64,
) -> Result<Value> {
    let record = match in_transaction(pool, async |connection| {
        claim(connection, book_id, link_id, reconciliation_id).await
    })
    .await?
    {
        Claim::Done(result) => return Ok(result),
        Claim::Claimed(record) => record,
    };
    // Network happens outside every database transaction. Once sent, the
    // data cannot be recalled, even if the book turns the feature off.
    let answer = match settings(pool, book_id).await {
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
    in_transaction(pool, async |connection| {
        let (enabled, revision) = lock_book(connection, book_id).await?;
        let current: Option<i32> = sqlx::query_scalar(
            "SELECT id FROM typesafe_evaluations WHERE id = $1 AND attempt = $2 AND status = 'pending'",
        )
        .bind(record.row.id)
        .bind(&record.row.attempt)
        .fetch_optional(&mut *connection)
        .await?;
        if current.is_none() {
            return Ok(status("stale", None));
        }
        let fresh = if enabled && revision == record.row.revision && is_configured() {
            // A deleted or unmapped row invalidates the answer.
            snapshot(connection, book_id, link_id, reconciliation_id)
                .await
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
        let usage = answer.as_ref().ok().map(|evaluated| {
            evaluated
                .usage
                .as_ref()
                .map(js_stringify)
        });
        let (probabilities, confidence, answers, usage_json) = (
            sql::json("$8"),
            sql::json("$9"),
            sql::json("$10"),
            sql::json("$12"),
        );
        let updated: StoredEvaluation = sqlx::query_as(&format!(
            "UPDATE typesafe_evaluations SET status = $3, completed_at = $4, latency_ms = $5,
               error_code = $6, choice = $7, probabilities = {probabilities},
               confidence = {confidence}, answers = {answers},
               usage = CASE WHEN $11 THEN {usage_json} ELSE usage END
             WHERE id = $1 AND attempt = $2
             RETURNING {EVALUATION_COLUMNS}"
        ))
        .bind(record.row.id)
        .bind(&record.row.attempt)
        .bind(new_status)
        .bind(now)
        .bind(i32::try_from(latency).unwrap_or(i32::MAX))
        .bind(error_code)
        .bind(choice)
        .bind(field("probabilities"))
        .bind(field("confidence"))
        .bind(stored_answers)
        .bind(usage.is_some())
        .bind(usage.flatten())
        .fetch_one(&mut *connection)
        .await?;
        if is_stale {
            Ok(status("stale", None))
        } else if answer.is_ok() {
            Evaluation::read(updated)?.public()
        } else {
            Ok(status("unavailable", Some(record.row.id)))
        }
    })
    .await
}

/// `validEvaluation`: a ready evaluation whose snapshot still has the same
/// fingerprint. Anything else is stale.
async fn valid_evaluation(
    connection: &mut DbConnection,
    book_id: i32,
    link_id: i64,
    evaluation_id: i64,
) -> Result<Evaluation> {
    let record: Option<StoredEvaluation> = sqlx::query_as(&format!(
        "SELECT {EVALUATION_COLUMNS} FROM typesafe_evaluations
         WHERE id = $1 AND book_id = $2 AND link_id = $3 AND status = 'ready'"
    ))
    .bind(column(evaluation_id)?)
    .bind(book_id)
    .bind(column(link_id)?)
    .fetch_optional(&mut *connection)
    .await?;
    let Some(record) = record else {
        return Err(stale(STALE_REVIEW));
    };
    let input = snapshot(
        connection,
        book_id,
        link_id,
        i64::from(record.reconciliation_id),
    )
    .await
    .ok()
    .flatten();
    if input.is_none_or(|input| fingerprint(&input) != record.fingerprint) {
        return Err(stale(STALE_REVIEW));
    }
    Evaluation::read(record)
}

/// `markSuggestionDisplayed`.
async fn mark_displayed(
    pool: &DbPool,
    book_id: i32,
    link_id: i64,
    evaluation_id: i64,
) -> Result<Value> {
    in_transaction(pool, async |connection| {
        lock_book(connection, book_id).await?;
        let record = valid_evaluation(connection, book_id, link_id, evaluation_id).await?;
        sqlx::query(
            "UPDATE typesafe_evaluations SET displayed_at = coalesce(displayed_at, $2) WHERE id = $1",
        )
        .bind(record.row.id)
        .bind(record.row.displayed_at.unwrap_or_else(now_millis))
        .execute(&mut *connection)
        .await?;
        record.public()
    })
    .await
}

/// `lockConfirmation`: locks what a confirmation reads until the resolver
/// commits, in a fixed order.
async fn lock_confirmation(
    connection: &mut DbConnection,
    link_id: i64,
    record: &Evaluation,
) -> Result<()> {
    sqlx::query(&format!(
        "SELECT id FROM plaid_accounts WHERE id = $1{FOR_UPDATE}"
    ))
    .bind(column(link_id)?)
    .execute(&mut *connection)
    .await?;
    sqlx::query(&format!(
        "SELECT id FROM plaid_transaction_reconciliation WHERE id = $1{FOR_UPDATE}"
    ))
    .bind(record.row.reconciliation_id)
    .execute(&mut *connection)
    .await?;
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
        let payee_ids: Vec<Option<i32>> = sqlx::query_scalar(&format!(
            "SELECT payee_id FROM transactions WHERE id {} ORDER BY id{FOR_UPDATE}",
            sql::in_integers("$1")
        ))
        .bind(sql::json_array(&ids))
        .fetch_all(&mut *connection)
        .await?;
        sqlx::query(&format!(
            "SELECT id FROM transaction_splits WHERE transaction_id {} ORDER BY id{FOR_UPDATE}",
            sql::in_integers("$1")
        ))
        .bind(sql::json_array(&ids))
        .execute(&mut *connection)
        .await?;
        let mut payee_ids: Vec<i32> = payee_ids.into_iter().flatten().collect();
        payee_ids.sort_unstable();
        payee_ids.dedup();
        if !payee_ids.is_empty() {
            sqlx::query(&format!(
                "SELECT id FROM payees WHERE id {} ORDER BY id{FOR_SHARE}",
                sql::in_integers("$1")
            ))
            .bind(sql::json_array(&payee_ids))
            .execute(&mut *connection)
            .await?;
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
            sqlx::query(&format!("SELECT id FROM accounts WHERE id = $1{FOR_SHARE}"))
                .bind(account_id)
                .execute(&mut *connection)
                .await?;
        }
        if let Some(payee_id) = id(["payee", "payeeId"])? {
            sqlx::query(&format!("SELECT id FROM payees WHERE id = $1{FOR_SHARE}"))
                .bind(payee_id)
                .execute(&mut *connection)
                .await?;
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
async fn confirm(
    pool: &DbPool,
    book_id: i32,
    link_id: i64,
    evaluation_id: i64,
    kind: Kind,
    shown_at: NaiveDateTime,
    actor: i32,
) -> Result<(Value, ReconcileInput)> {
    let (link, row_id, input) = in_transaction(pool, async |connection| {
        lock_book(connection, book_id).await?;
        let record: Option<StoredEvaluation> = sqlx::query_as(&format!(
            "SELECT {EVALUATION_COLUMNS} FROM typesafe_evaluations
             WHERE id = $1 AND book_id = $2 AND link_id = $3"
        ))
        .bind(column(evaluation_id)?)
        .bind(book_id)
        .bind(column(link_id)?)
        .fetch_optional(&mut *connection)
        .await?;
        let record = Evaluation::read(record.ok_or(stale(
            "This TypeSafe suggestion is stale. Refresh and review again.",
        ))?)?;
        lock_confirmation(connection, link_id, &record).await?;
        let valid = valid_evaluation(connection, book_id, link_id, evaluation_id).await?;
        // A click proves that the suggestion was on screen, even when the
        // display report has not arrived yet.
        if valid.row.displayed_at.is_none() {
            sqlx::query("UPDATE typesafe_evaluations SET displayed_at = $2 WHERE id = $1")
                .bind(valid.row.id)
                .bind(shown_at)
                .execute(&mut *connection)
                .await?;
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
        let link = reconcilable_link(&mut *connection, book_id, column(link_id)?).await?;
        let row_id = apply(connection, book_id, link, &input, actor, now_millis()).await?;
        Ok((link, row_id, input))
    })
    .await?;
    let mut connection = pool.acquire().await?;
    let row = load_row(&mut connection, link.link_id, row_id, book_id, false)
        .await?
        .ok_or(Failure::Reconcile(ReconcileError::NotFound(
            "Updated row not found",
        )))?;
    let item = load_item(&mut connection, &row, link.account_id, book_id).await?;
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
    let reconciliation_id = body
        .is_object()
        .then(|| positive_id(object.get("reconciliationId")))
        .flatten()
        .filter(|_| only_keys(&object, &["reconciliationId"]))
        .ok_or_else(|| error(StatusCode::BAD_REQUEST, "Invalid reconciliation ID"))?;
    request_suggestion(&state.pool, book.book_id, link_id, reconciliation_id)
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
    let evaluation_id = body
        .is_object()
        .then(|| positive_id(object.get("evaluationId")))
        .flatten()
        .filter(|_| only_keys(&object, &["evaluationId"]))
        .ok_or_else(|| error(StatusCode::BAD_REQUEST, "Invalid evaluation ID"))?;
    mark_displayed(&state.pool, book.book_id, link_id, evaluation_id)
        .await
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
    let (evaluation_id, active_review_ms, kind) = confirmation(&body, &object)
        .ok_or_else(|| error(StatusCode::BAD_REQUEST, "Invalid evaluation ID"))?;
    let (item, mut input) = confirm(
        &state.pool,
        book.book_id,
        link_id,
        evaluation_id,
        kind,
        started_at,
        book.user_id,
    )
    .await
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
        &state.pool,
        book.book_id,
        &input,
        &Observation::accepted(evaluation_id as f64, active_review_ms),
        started_at,
    )
    .await;
    Ok(Json(item))
}

#[cfg(test)]
mod merchant_key_tests {
    use super::MERCHANT_KEY;
    use crate::routes::payees::normalize_name;

    /// The SQL merchant key and the Rust merchant key must agree, or a
    /// learned payee is not found again. The engine must keep this.
    #[tokio::test]
    async fn sql_merchant_key_equals_the_rust_key() {
        let database = ledger_db::testing::TempDatabase::new(1).await;
        let pool = database.pool().clone();
        let cases: [(Option<&str>, &str); 8] = [
            (Some("  Blue\u{2019}s   CAFE "), "ignored"),
            (None, "\tCRÈME\n BRÛLÉE  Co"),
            (Some("ÉCLAIR \u{2018}Bakery\u{2019}"), "x"),
            (Some(""), "the name is not used"),
            (Some("a`b\u{00B4}c\u{2032}d\u{201A}e\u{201B}"), "x"),
            (None, "ÄÖÜ straße"),
            (None, "ONE  two\r\nTHREE"),
            (Some("  "), "x"),
        ];
        for (merchant, name) in cases {
            let sql: String = sqlx::query_scalar(&format!(
                "SELECT {MERCHANT_KEY} FROM (SELECT CAST($1 AS text) AS merchant_name,
                 CAST($2 AS text) AS name) r"
            ))
            .bind(merchant)
            .bind(name)
            .fetch_one(&pool)
            .await
            .unwrap();
            let rust = normalize_name(merchant.unwrap_or(name)).to_lowercase();
            assert_eq!(sql, rust, "merchant {merchant:?}, name {name:?}");
        }
    }
}
