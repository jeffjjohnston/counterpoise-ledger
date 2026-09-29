//! Plaid reconciliation: the queue of
//! staged bank transactions that need a decision, and the six decisions.
//!
//! The resolver takes no advisory lock. It changes one staged row, which it
//! reads `FOR UPDATE`, so PostgreSQL row locking serializes two resolves of
//! the same row.

use crate::{
    book_auth::{AccessLevel, authenticate_book},
    error::{ApiError, ApiResult, error, error_owned, internal_error},
    routes::{
        payees::normalize_name,
        plaid_sync::{day_delta, pick_matched_date},
        sync::{database_id, finite_path_id, iso_timestamp},
        transactions::now_millis,
    },
    state::AppState,
    typesafe::{Observation, record_decision},
    validation::{first_query_values, js_number, parse_js_number, parse_json_body},
};
use axum::{
    Json,
    body::Bytes,
    extract::{Path, RawQuery, State},
    http::{HeaderMap, StatusCode},
};
use chrono::{Days, NaiveDate, NaiveDateTime, Utc};
use serde_json::{Value, json};
use sqlx::{FromRow, PgConnection, PgPool};
use std::collections::{HashMap, HashSet};

const INVALID_LINK_ID: &str = "Invalid linked account id";
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
/// `effectiveDateSql` for the transaction alias `t`.
pub(crate) const EFFECTIVE_DATE: &str =
    "(CASE WHEN t.is_floating THEN CURRENT_DATE::text ELSE t.date END)";

/// A reconciliation failure. Each route maps these to its own responses.
pub(crate) enum ReconcileError {
    /// `ReconcileNotFoundError`: 404 with the message.
    NotFound(&'static str),
    /// `ReconcileValidationError`: 400 with the message.
    Invalid(String),
    /// Any other error: the route's 500.
    Failed(sqlx::Error),
    /// An error whose message Node repeats in its 500 response.
    Message(&'static str),
}

impl From<sqlx::Error> for ReconcileError {
    fn from(cause: sqlx::Error) -> Self {
        Self::Failed(cause)
    }
}

impl ReconcileError {
    /// The response. `failure_message` is the 500 message of the route.
    fn into_api(self, failure_message: &'static str) -> ApiError {
        match self {
            Self::NotFound(message) => error(StatusCode::NOT_FOUND, message),
            Self::Invalid(message) => error_owned(StatusCode::BAD_REQUEST, message),
            Self::Failed(cause) => internal_error(cause, failure_message),
            Self::Message(message) => error(StatusCode::INTERNAL_SERVER_ERROR, message),
        }
    }
}

fn invalid(message: &str) -> ReconcileError {
    ReconcileError::Invalid(message.to_owned())
}

/// A Plaid account link that belongs to this book and points at an asset or
/// liability account.
#[derive(Clone, Copy)]
pub(crate) struct Link {
    pub(crate) link_id: i32,
    pub(crate) account_id: i32,
}

/// `getReconcilableLink`.
pub(crate) async fn reconcilable_link<'e, E: sqlx::PgExecutor<'e>>(
    pool: E,
    book_id: i32,
    link_id: i32,
) -> Result<Link, ReconcileError> {
    let row: Option<(i32, i32, String)> = sqlx::query_as(
        "SELECT pa.id, pa.counterpoise_account_id, a.type
         FROM plaid_accounts pa JOIN accounts a ON pa.counterpoise_account_id = a.id
         WHERE pa.id = $1 AND pa.book_id = $2 AND a.book_id = $2 LIMIT 1",
    )
    .bind(link_id)
    .bind(book_id)
    .fetch_optional(pool)
    .await?;
    let (link_id, account_id, kind) =
        row.ok_or(ReconcileError::NotFound("Linked sync account not found"))?;
    if kind != "asset" && kind != "liability" {
        return Err(invalid(
            "Only asset or liability Counterpoise accounts can be reconciled against Plaid transactions",
        ));
    }
    Ok(Link {
        link_id,
        account_id,
    })
}

const ROW_COLUMNS: &str = "r.id, r.book_id, r.plaid_account_link_id, r.plaid_transaction_id,
    r.date, r.authorized_date, r.amount_cents, r.name, r.merchant_name, r.original_description,
    r.resolution_status, r.review_reason, r.matched_transaction_id, r.pending, r.first_seen_at,
    r.last_seen_at";

#[derive(FromRow)]
pub(crate) struct ReconRow {
    pub(crate) id: i32,
    pub(crate) book_id: i32,
    pub(crate) plaid_account_link_id: i32,
    pub(crate) plaid_transaction_id: String,
    pub(crate) date: String,
    pub(crate) authorized_date: Option<String>,
    pub(crate) amount_cents: i32,
    pub(crate) name: String,
    pub(crate) merchant_name: Option<String>,
    pub(crate) original_description: Option<String>,
    pub(crate) resolution_status: String,
    pub(crate) review_reason: Option<String>,
    pub(crate) matched_transaction_id: Option<i32>,
    pub(crate) pending: bool,
    pub(crate) first_seen_at: NaiveDateTime,
    pub(crate) last_seen_at: NaiveDateTime,
}

impl ReconRow {
    /// The bank date: the authorization date, else the posted date.
    pub(crate) fn bank_date(&self) -> &str {
        self.authorized_date.as_deref().unwrap_or(&self.date)
    }

    pub(crate) fn merchant(&self) -> &str {
        self.merchant_name.as_deref().unwrap_or(&self.name)
    }
}

/// `loadReconciliationRow`: the row with this ID on this link in this book.
pub(crate) async fn load_row(
    connection: &mut PgConnection,
    link_id: i32,
    reconciliation_id: i32,
    book_id: i32,
    for_update: bool,
) -> Result<Option<ReconRow>, sqlx::Error> {
    let lock = if for_update { " FOR UPDATE" } else { "" };
    sqlx::query_as(&format!(
        "SELECT {ROW_COLUMNS} FROM plaid_transaction_reconciliation r
         WHERE r.id = $1 AND r.plaid_account_link_id = $2 AND r.book_id = $3 LIMIT 1{lock}"
    ))
    .bind(reconciliation_id)
    .bind(link_id)
    .bind(book_id)
    .fetch_optional(&mut *connection)
    .await
}

// ---------------------------------------------------------------------------
// Candidates and the suggested counter account
// ---------------------------------------------------------------------------

/// `addDays` on a local calendar date. A value that is not a date fails as
/// `toDateString` fails on an invalid Date.
fn add_days(date: &str, delta: i64) -> Result<String, ReconcileError> {
    let parsed = NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .map_err(|_| ReconcileError::Message("Invalid date passed to toDateString"))?;
    let moved = if delta >= 0 {
        parsed.checked_add_days(Days::new(delta.unsigned_abs()))
    } else {
        parsed.checked_sub_days(Days::new(delta.unsigned_abs()))
    };
    moved
        .map(|date| date.format("%Y-%m-%d").to_string())
        .ok_or(ReconcileError::Message(
            "Invalid date passed to toDateString",
        ))
}

/// `normalizePayeeName(value).toLowerCase()`, or "" for an empty value.
fn match_text(value: Option<&str>) -> String {
    value
        .filter(|value| !value.is_empty())
        .map(|value| normalize_name(value).to_lowercase())
        .unwrap_or_default()
}

/// `buildScoreTagsAndValue`. An empty payee or description is contained in
/// every target, so it counts as a similar name, as in Node.
fn score(
    amount_delta: i64,
    day_delta_abs: i64,
    target: &str,
    payee_name: Option<&str>,
    description: Option<&str>,
    already_linked: bool,
) -> (i64, Vec<&'static str>) {
    let mut score = 0;
    let mut tags = Vec::new();
    if amount_delta == 0 {
        score += 100;
        tags.push("exact_amount");
    } else {
        score += (50 - amount_delta).max(0);
        tags.push("amount_close");
    }
    if day_delta_abs == 0 {
        score += 30;
        tags.push("same_day");
    } else {
        score += (30 - day_delta_abs * 3).max(0);
        tags.push("date_close");
    }
    let payee = match_text(payee_name);
    let description = match_text(description);
    let target = match_text(Some(target));
    if !target.is_empty() && (target == payee || target == description) {
        score += 25;
        tags.push("name_exact");
    } else if !target.is_empty()
        && ((!payee.is_empty() && payee.contains(&target))
            || (!description.is_empty() && description.contains(&target))
            || target.contains(&payee)
            || target.contains(&description))
    {
        score += 10;
        tags.push("name_similar");
    }
    if already_linked {
        score -= 80;
        tags.push("already_linked");
    }
    (score, tags)
}

#[derive(FromRow)]
struct CandidateRow {
    transaction_id: i32,
    date: String,
    description: Option<String>,
    payee_name: Option<String>,
    check_number: Option<String>,
    linked_split_amount: i32,
}

/// `findMatchCandidates`: the five best transactions on the mapped account
/// within seven days of the bank date.
pub(crate) async fn match_candidates(
    connection: &mut PgConnection,
    row: &ReconRow,
    mapped_account_id: i32,
) -> Result<Vec<Value>, ReconcileError> {
    let expected = -i64::from(row.amount_cents);
    let bank_date = row.bank_date();
    let start = add_days(bank_date, -7)?;
    let end = add_days(bank_date, 7)?;
    // No book filter here, as in Node: the mapped account is in this book.
    // The detail query below filters the book.
    let rows: Vec<CandidateRow> = sqlx::query_as(&format!(
        "SELECT t.id AS transaction_id, {EFFECTIVE_DATE} AS date, t.description,
                p.name AS payee_name, t.check_number, s.amount AS linked_split_amount
         FROM transaction_splits s
         JOIN transactions t ON s.transaction_id = t.id
         LEFT JOIN payees p ON t.payee_id = p.id
         WHERE s.account_id = $1 AND {EFFECTIVE_DATE} >= $2 AND {EFFECTIVE_DATE} <= $3
         ORDER BY {EFFECTIVE_DATE} DESC, t.id DESC
         LIMIT 200"
    ))
    .bind(mapped_account_id)
    .bind(&start)
    .bind(&end)
    .fetch_all(&mut *connection)
    .await?;
    let mut seen = HashSet::new();
    let rows: Vec<CandidateRow> = rows
        .into_iter()
        .filter(|candidate| seen.insert(candidate.transaction_id))
        .collect();
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let ids: Vec<i32> = rows.iter().map(|row| row.transaction_id).collect();
    let splits: Vec<(i32, i32, String)> = sqlx::query_as(
        "SELECT s.transaction_id, s.account_id, a.name
         FROM transaction_splits s
         JOIN transactions t ON t.id = s.transaction_id
         JOIN accounts a ON a.id = s.account_id
         WHERE t.book_id = $1 AND t.id = ANY($2)
         ORDER BY s.id",
    )
    .bind(row.book_id)
    .bind(&ids)
    .fetch_all(&mut *connection)
    .await?;
    let mut details: HashMap<i32, Vec<(i32, String)>> = HashMap::new();
    for (transaction_id, account_id, name) in splits {
        details
            .entry(transaction_id)
            .or_default()
            .push((account_id, name));
    }
    let linked: HashSet<i32> = sqlx::query_scalar::<_, i32>(
        "SELECT matched_transaction_id FROM plaid_transaction_reconciliation
         WHERE plaid_account_link_id = $1 AND matched_transaction_id IS NOT NULL
           AND matched_transaction_id = ANY($2) AND id <> $3",
    )
    .bind(row.plaid_account_link_id)
    .bind(&ids)
    .bind(row.id)
    .fetch_all(&mut *connection)
    .await?
    .into_iter()
    .collect();

    let target = row.merchant();
    let mut candidates: Vec<(i64, i64, i64, Value)> = Vec::new();
    for candidate in &rows {
        let Some(splits) = details.get(&candidate.transaction_id) else {
            continue;
        };
        let counterparts: Vec<&str> = splits
            .iter()
            .filter(|(account_id, _)| *account_id != mapped_account_id)
            .map(|(_, name)| name.as_str())
            .collect();
        let amount_delta = (i64::from(candidate.linked_split_amount) - expected).abs();
        let days = day_delta(bank_date, &candidate.date).unwrap_or(0);
        let already_linked = linked.contains(&candidate.transaction_id);
        let (score, tags) = score(
            amount_delta,
            days.abs(),
            target,
            candidate.payee_name.as_deref(),
            candidate.description.as_deref(),
            already_linked,
        );
        candidates.push((
            score,
            amount_delta,
            days.abs(),
            json!({
                "transactionId": candidate.transaction_id,
                "date": candidate.date,
                "description": candidate.description,
                "payeeName": candidate.payee_name,
                "checkNumber": candidate.check_number,
                "linkedSplitAmount": candidate.linked_split_amount,
                "expectedAmount": expected,
                "amountDelta": amount_delta,
                "dayDelta": days,
                "counterpartAccountNames": counterparts,
                "splitCount": splits.len(),
                "score": score,
                "scoreTags": tags,
                "alreadyLinked": already_linked,
            }),
        ));
    }
    // A stable sort, as `Array.prototype.sort` is.
    candidates.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)).then(a.2.cmp(&b.2)));
    Ok(candidates
        .into_iter()
        .take(5)
        .map(|(_, _, _, candidate)| candidate)
        .collect())
}

/// `suggestCounterAccountId`: the counter account from the history of the
/// payee that has the bank's merchant name.
pub(crate) async fn suggest_counter_account(
    connection: &mut PgConnection,
    row: &ReconRow,
    mapped_account_id: i32,
    book_id: i32,
) -> Result<Option<i32>, sqlx::Error> {
    let source = normalize_name(row.merchant());
    if source.is_empty() {
        return Ok(None);
    }
    let payee_id: Option<i32> =
        sqlx::query_scalar("SELECT id FROM payees WHERE book_id = $1 AND lower(name) = $2 LIMIT 1")
            .bind(book_id)
            .bind(source.to_lowercase())
            .fetch_optional(&mut *connection)
            .await?;
    let Some(payee_id) = payee_id else {
        return Ok(None);
    };
    let transaction_ids: Vec<i32> = sqlx::query_scalar(&format!(
        "SELECT t.id FROM transactions t WHERE t.book_id = $1 AND t.payee_id = $2
         ORDER BY {EFFECTIVE_DATE} DESC, t.id DESC LIMIT 25"
    ))
    .bind(book_id)
    .bind(payee_id)
    .fetch_all(&mut *connection)
    .await?;
    if transaction_ids.is_empty() {
        return Ok(None);
    }
    let counterparts: Vec<(i32, i32)> = sqlx::query_as(
        "SELECT account_id, amount FROM transaction_splits
         WHERE book_id = $1 AND transaction_id = ANY($2) AND account_id <> $3
         ORDER BY transaction_id DESC, id",
    )
    .bind(book_id)
    .bind(&transaction_ids)
    .bind(mapped_account_id)
    .fetch_all(&mut *connection)
    .await?;
    if let Some((account_id, _)) = counterparts
        .iter()
        .find(|(_, amount)| *amount == row.amount_cents)
    {
        return Ok(Some(*account_id));
    }
    // The account that the payee's history uses most often. A tie goes to
    // the account of the most recent transaction.
    let mut counts: HashMap<i32, usize> = HashMap::new();
    for (account_id, _) in &counterparts {
        *counts.entry(*account_id).or_default() += 1;
    }
    let mut winner = None;
    let mut best = 0;
    for (account_id, _) in &counterparts {
        if counts[account_id] > best {
            best = counts[account_id];
            winner = Some(*account_id);
        }
    }
    Ok(winner)
}

/// `loadReconciliationItem`: the row with its candidates and suggestion.
pub(crate) async fn load_item(
    connection: &mut PgConnection,
    row: &ReconRow,
    mapped_account_id: i32,
    book_id: i32,
) -> Result<Value, ReconcileError> {
    let candidates = match_candidates(connection, row, mapped_account_id).await?;
    let suggested = suggest_counter_account(connection, row, mapped_account_id, book_id).await?;
    Ok(json!({
        "id": row.id,
        "plaidAccountLinkId": row.plaid_account_link_id,
        "plaidTransactionId": row.plaid_transaction_id,
        "date": row.date,
        "authorizedDate": row.authorized_date,
        "amountCents": row.amount_cents,
        "name": row.name,
        "merchantName": row.merchant_name,
        "originalDescription": row.original_description,
        "resolutionStatus": row.resolution_status,
        "reviewReason": row.review_reason,
        "matchedTransactionId": row.matched_transaction_id,
        "pending": row.pending,
        "firstSeenAt": iso_timestamp(row.first_seen_at),
        "lastSeenAt": iso_timestamp(row.last_seen_at),
        "candidates": candidates,
        "suggestedCounterAccountId": suggested,
    }))
}

// ---------------------------------------------------------------------------
// The queues
// ---------------------------------------------------------------------------

/// `z.coerce.number().int()` with a check: `Number(value)` must be a safe
/// integer that passes `accept`.
fn coerced_integer(value: Option<&String>, accept: impl Fn(f64) -> bool) -> Option<f64> {
    let number = parse_js_number(value?)?;
    (number.is_finite()
        && number.fract() == 0.0
        && number.abs() <= MAX_SAFE_INTEGER
        && accept(number))
    .then_some(number)
}

/// `reconcileListQuery`: a malformed limit is 25 and a malformed offset is 0.
/// An empty value counts as absent.
fn page_query(params: &HashMap<String, String>) -> (f64, f64) {
    let value = |key: &str| params.get(key).filter(|value| !value.is_empty());
    let limit = coerced_integer(value("limit"), |number| number > 0.0).unwrap_or(25.0);
    let offset = coerced_integer(value("offset"), |number| number >= 0.0).unwrap_or(0.0);
    // `-0` is written as 0.
    (limit, offset + 0.0)
}

fn page(items: Vec<Value>, total_count: i64, offset: f64, limit: f64) -> Value {
    let has_more = offset + (items.len() as f64) < total_count as f64;
    json!({
        "items": items,
        "totalCount": total_count,
        "offset": offset as i64,
        "limit": limit as i64,
        "hasMore": has_more,
    })
}

/// GET `sync/accounts/[id]/reconcile`: the queue of one link, rows that need
/// review first, then the most recently seen.
pub(crate) async fn link_queue(
    State(state): State<AppState>,
    Path((raw_book_id, raw_id)): Path<(String, String)>,
    RawQuery(raw_query): RawQuery,
    headers: HeaderMap,
) -> ApiResult {
    const FAILURE: &str = "Failed to load reconciliation queue";
    let book =
        authenticate_book(&state, &headers, &raw_book_id, AccessLevel::Read, FAILURE).await?;
    let link_id = finite_path_id(&raw_id, INVALID_LINK_ID)?;
    let (limit, offset) = page_query(&first_query_values(raw_query.as_deref()));
    let link_id = database_id(link_id, FAILURE)?;
    let result: Result<Value, ReconcileError> = async {
        let link = reconcilable_link(&state.pool, book.book_id, link_id).await?;
        let mut connection = state.pool.acquire().await?;
        let queue = "r.plaid_account_link_id = $1
                     AND (r.resolution_status = 'pending' OR r.review_reason IS NOT NULL)";
        let rows: Vec<ReconRow> = sqlx::query_as(&format!(
            "SELECT {ROW_COLUMNS} FROM plaid_transaction_reconciliation r WHERE {queue}
             ORDER BY CASE WHEN r.review_reason IS NOT NULL THEN 1 ELSE 0 END DESC,
                      r.last_seen_at DESC, r.id DESC
             LIMIT $2 OFFSET $3"
        ))
        .bind(link.link_id)
        .bind(limit as i64)
        .bind(offset as i64)
        .fetch_all(&mut *connection)
        .await?;
        let total: i64 = sqlx::query_scalar(&format!(
            "SELECT COUNT(*) FROM plaid_transaction_reconciliation r WHERE {queue}"
        ))
        .bind(link.link_id)
        .fetch_one(&mut *connection)
        .await?;
        let mut items = Vec::with_capacity(rows.len());
        for row in &rows {
            items.push(load_item(&mut connection, row, link.account_id, book.book_id).await?);
        }
        Ok(page(items, total, offset, limit))
    }
    .await;
    result.map(Json).map_err(|cause| cause.into_api(FAILURE))
}

/// GET `sync/reconcile`: the queue of every reconcilable link in the book,
/// or of one link. Rows that need review come first, then the newest bank
/// date.
pub(crate) async fn book_queue(
    State(state): State<AppState>,
    Path(raw_book_id): Path<String>,
    RawQuery(raw_query): RawQuery,
    headers: HeaderMap,
) -> ApiResult {
    const FAILURE: &str = "Failed to load reconciliation queue";
    let book =
        authenticate_book(&state, &headers, &raw_book_id, AccessLevel::Read, FAILURE).await?;
    let params = first_query_values(raw_query.as_deref());
    let (limit, offset) = page_query(&params);
    // Each row runs several queries, so the page is at most 100 rows.
    let limit = limit.min(100.0);
    let link_id = match params.get("linkId").filter(|value| !value.is_empty()) {
        None => None,
        Some(value) => Some(
            coerced_integer(Some(value), |number| number > 0.0)
                .ok_or_else(|| error(StatusCode::BAD_REQUEST, "Invalid linkId"))?,
        ),
    };
    let link_id = link_id
        .map(|link_id| database_id(link_id, FAILURE))
        .transpose()?;
    let result: Result<Value, ReconcileError> = async {
        if let Some(link_id) = link_id {
            reconcilable_link(&state.pool, book.book_id, link_id).await?;
        }
        let mut connection = state.pool.acquire().await?;
        let queue = "r.book_id = $1 AND pa.book_id = $1 AND a.book_id = $1
                     AND a.type IN ('asset', 'liability')
                     AND ($2::integer IS NULL OR pa.id = $2)
                     AND (r.resolution_status = 'pending' OR r.review_reason IS NOT NULL)";
        let joins = "FROM plaid_transaction_reconciliation r
                     JOIN plaid_accounts pa ON r.plaid_account_link_id = pa.id
                     JOIN accounts a ON pa.counterpoise_account_id = a.id";
        let rows: Vec<(i32, i32)> = sqlx::query_as(&format!(
            "SELECT r.id, a.id {joins} WHERE {queue}
             ORDER BY CASE WHEN r.review_reason IS NOT NULL THEN 1 ELSE 0 END DESC,
                      COALESCE(r.authorized_date, r.date) DESC, r.id DESC
             LIMIT $3 OFFSET $4"
        ))
        .bind(book.book_id)
        .bind(link_id)
        .bind(limit as i64)
        .bind(offset as i64)
        .fetch_all(&mut *connection)
        .await?;
        let total: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) {joins} WHERE {queue}"))
            .bind(book.book_id)
            .bind(link_id)
            .fetch_one(&mut *connection)
            .await?;
        let mut items = Vec::with_capacity(rows.len());
        for (id, mapped_account_id) in rows {
            let row: ReconRow = sqlx::query_as(&format!(
                "SELECT {ROW_COLUMNS} FROM plaid_transaction_reconciliation r WHERE r.id = $1"
            ))
            .bind(id)
            .fetch_one(&mut *connection)
            .await?;
            items.push(load_item(&mut connection, &row, mapped_account_id, book.book_id).await?);
        }
        Ok(page(items, total, offset, limit))
    }
    .await;
    // Node answers every unexpected error on this route with its own message.
    result.map(Json).map_err(|cause| match cause {
        ReconcileError::Message(_) => error(StatusCode::INTERNAL_SERVER_ERROR, FAILURE),
        cause => cause.into_api(FAILURE),
    })
}

// ---------------------------------------------------------------------------
// The six decisions
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Action {
    Match,
    MatchUpdateAmount,
    Create,
    Ignore,
    KeepLocal,
    Unlink,
}

impl Action {
    fn parse(value: &Value) -> Option<Self> {
        Some(match value.as_str()? {
            "match" => Self::Match,
            "match_update_amount" => Self::MatchUpdateAmount,
            "create" => Self::Create,
            "ignore" => Self::Ignore,
            "keep_local" => Self::KeepLocal,
            "unlink" => Self::Unlink,
            _ => return None,
        })
    }

    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Match => "match",
            Self::MatchUpdateAmount => "match_update_amount",
            Self::Create => "create",
            Self::Ignore => "ignore",
            Self::KeepLocal => "keep_local",
            Self::Unlink => "unlink",
        }
    }

    /// `RECONCILE_EVENT_NAMES`.
    fn event_name(self) -> &'static str {
        match self {
            Self::Match => "sync_transaction_matched",
            Self::MatchUpdateAmount => "sync_transaction_amount_updated",
            Self::Create => "sync_transaction_created",
            Self::Ignore => "sync_transaction_ignored",
            Self::KeepLocal => "sync_transaction_kept_local",
            Self::Unlink => "sync_transaction_unlinked",
        }
    }
}

/// The parsed body of a decision. The optional fields keep the value as sent.
pub(crate) struct ReconcileInput {
    pub(crate) reconciliation_id: f64,
    pub(crate) action: Action,
    pub(crate) transaction_id: Option<Value>,
    pub(crate) counter_account_id: Option<Value>,
    pub(crate) payee_name: Option<Value>,
}

impl ReconcileInput {
    /// The transaction of a match, or the message of `reconcileActionIssue`.
    /// The TypeSafe confirm does not validate its input, so `apply` also
    /// uses this check.
    fn transaction(&self) -> Result<f64, &'static str> {
        js_integer(self.transaction_id.as_ref()).ok_or(match self.action {
            Action::MatchUpdateAmount => "transactionId is required for match_update_amount",
            _ => "transactionId is required for match",
        })
    }

    /// The counter account of a create, or the message of
    /// `reconcileActionIssue`.
    fn counter_account(&self) -> Result<f64, &'static str> {
        js_integer(self.counter_account_id.as_ref())
            .filter(|id| *id > 0.0)
            .ok_or("counterAccountId is required for create")
    }
}

/// `Number.isInteger(value)` for a parsed JSON value.
fn js_integer(value: Option<&Value>) -> Option<f64> {
    let number = js_number(value?.as_number()?);
    (number.is_finite() && number.fract() == 0.0).then_some(number)
}

/// `reconcileSchema`: the first field issue in key order, and then the
/// action rule of `reconcileActionIssue`, which zod runs only on a body
/// without field issues.
fn validate_reconcile(body: &Value) -> Result<ReconcileInput, ApiError> {
    const RECONCILIATION_ID: &str = "reconciliationId is required";
    let bad = |message: &'static str| error(StatusCode::BAD_REQUEST, message);
    let object = body.as_object().ok_or_else(|| bad(RECONCILIATION_ID))?;
    let reconciliation_id = js_integer(object.get("reconciliationId"))
        .filter(|id| id.abs() <= MAX_SAFE_INTEGER)
        .ok_or_else(|| bad(RECONCILIATION_ID))?;
    let action = object
        .get("action")
        .and_then(Action::parse)
        .ok_or_else(|| bad("Invalid action"))?;
    let input = ReconcileInput {
        reconciliation_id,
        action,
        transaction_id: object.get("transactionId").cloned(),
        counter_account_id: object.get("counterAccountId").cloned(),
        payee_name: object.get("payeeName").cloned(),
    };
    match action {
        Action::Match | Action::MatchUpdateAmount => {
            input.transaction().map_err(bad)?;
        }
        Action::Create => {
            input.counter_account().map_err(bad)?;
        }
        _ => {}
    }
    Ok(input)
}

/// The payee of a created transaction: a case-insensitive match, or a new
/// payee. The insert has no conflict clause, as in the former TypeScript
/// resolver. JavaScript
/// and PostgreSQL can lowercase a name differently (a final sigma), so the
/// match can miss a payee with the same name; the insert then fails on the
/// unique index and the decision rolls back.
async fn resolve_payee(
    connection: &mut PgConnection,
    book_id: i32,
    payee_name: &str,
) -> Result<Option<i32>, sqlx::Error> {
    let name = normalize_name(payee_name);
    if name.is_empty() {
        return Ok(None);
    }
    let existing: Option<i32> =
        sqlx::query_scalar("SELECT id FROM payees WHERE book_id = $1 AND lower(name) = $2 LIMIT 1")
            .bind(book_id)
            .bind(name.to_lowercase())
            .fetch_optional(&mut *connection)
            .await?;
    if existing.is_some() {
        return Ok(existing);
    }
    sqlx::query_scalar(
        "INSERT INTO payees (name, book_id, created_at) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(&name)
    .bind(book_id)
    .bind(now_millis())
    .fetch_optional(&mut *connection)
    .await
}

/// An ID from the body as Node binds it to an integer column: PostgreSQL
/// refuses a value outside the int4 range, and the route answers 500.
fn body_id(value: f64) -> Result<i32, ReconcileError> {
    if (f64::from(i32::MIN)..=f64::from(i32::MAX)).contains(&value) {
        Ok(value as i32)
    } else {
        Err(ReconcileError::Message("Failed to resolve reconciliation"))
    }
}

/// `markMatchedTransaction`: reconciled, and settled when it is floating. A
/// floating transaction's stored date is its entry date, so it gets the
/// matched date in the same write. Another transaction keeps its date.
async fn mark_matched(
    connection: &mut PgConnection,
    book_id: i32,
    transaction_id: i32,
    row: &ReconRow,
    now: NaiveDateTime,
    actor: i32,
) -> Result<(), ReconcileError> {
    let floating: Option<bool> = sqlx::query_scalar(
        "SELECT is_floating FROM transactions WHERE id = $1 AND book_id = $2 LIMIT 1",
    )
    .bind(transaction_id)
    .bind(book_id)
    .fetch_optional(&mut *connection)
    .await?;
    let settle = floating == Some(true);
    let updated: Option<i32> = sqlx::query_scalar(
        "UPDATE transactions SET is_reconciled = true, updated_at = $3, updated_by = $4,
                is_floating = CASE WHEN $5 THEN false ELSE is_floating END,
                date = CASE WHEN $5 THEN $6 ELSE date END
         WHERE id = $1 AND book_id = $2 RETURNING id",
    )
    .bind(transaction_id)
    .bind(book_id)
    .bind(now)
    .bind(actor)
    .bind(settle)
    .bind(pick_matched_date(row.authorized_date.as_deref(), &row.date))
    .fetch_optional(&mut *connection)
    .await?;
    updated
        .map(|_| ())
        .ok_or(ReconcileError::NotFound("Transaction not found"))
}

/// Sets the resolution of the row, and clears its review flag.
async fn resolve_row(
    connection: &mut PgConnection,
    row: &ReconRow,
    status: &str,
    matched_transaction_id: Option<i32>,
    now: NaiveDateTime,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE plaid_transaction_reconciliation
         SET resolution_status = $3, matched_transaction_id = $4, review_reason = NULL,
             review_metadata_json = NULL, resolved_at = $5, updated_at = $5
         WHERE id = $1 AND book_id = $2",
    )
    .bind(row.id)
    .bind(row.book_id)
    .bind(status)
    .bind(matched_transaction_id)
    .bind(now)
    .execute(&mut *connection)
    .await?;
    Ok(())
}

/// Another staged row on this link is already matched to the transaction.
async fn linked_elsewhere(
    connection: &mut PgConnection,
    link: Link,
    transaction_id: i32,
    row: &ReconRow,
) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM plaid_transaction_reconciliation
                        WHERE plaid_account_link_id = $1 AND matched_transaction_id = $2
                          AND id <> $3)",
    )
    .bind(link.link_id)
    .bind(transaction_id)
    .bind(row.id)
    .fetch_one(&mut *connection)
    .await
}

const NOT_ON_LINKED_ACCOUNT: &str = "Selected transaction does not include the linked account";
const LINKED_ELSEWHERE: &str =
    "This transaction is already linked to a different Plaid transaction for the same account";

/// The decision inside its database transaction. Returns the row ID.
pub(crate) async fn apply(
    connection: &mut PgConnection,
    book_id: i32,
    link: Link,
    input: &ReconcileInput,
    actor: i32,
    now: NaiveDateTime,
) -> Result<i32, ReconcileError> {
    let reconciliation_id = body_id(input.reconciliation_id)?;
    let row = load_row(connection, link.link_id, reconciliation_id, book_id, true)
        .await?
        .ok_or(ReconcileError::NotFound("Reconciliation row not found"))?;
    // A linked bank row cannot be linked again, unless Plaid has changed it
    // since and it is flagged for review.
    if matches!(
        input.action,
        Action::Match | Action::MatchUpdateAmount | Action::Create
    ) && row.review_reason.is_none()
        && let Some(matched) = row.matched_transaction_id
    {
        return Err(ReconcileError::Invalid(format!(
            "This bank transaction is already linked to transaction #{matched} — unlink it first"
        )));
    }
    let amount = i64::from(row.amount_cents);
    match input.action {
        Action::Match => {
            let transaction_id = body_id(input.transaction().map_err(invalid)?)?;
            let on_account: bool = sqlx::query_scalar(
                "SELECT EXISTS (SELECT 1 FROM transaction_splits
                                WHERE transaction_id = $1 AND account_id = $2 AND book_id = $3)",
            )
            .bind(transaction_id)
            .bind(link.account_id)
            .bind(book_id)
            .fetch_one(&mut *connection)
            .await?;
            if !on_account {
                return Err(invalid(NOT_ON_LINKED_ACCOUNT));
            }
            if linked_elsewhere(connection, link, transaction_id, &row).await? {
                return Err(invalid(LINKED_ELSEWHERE));
            }
            mark_matched(connection, book_id, transaction_id, &row, now, actor).await?;
            resolve_row(connection, &row, "matched", Some(transaction_id), now).await?;
        }
        Action::MatchUpdateAmount => {
            let transaction_id = body_id(input.transaction().map_err(invalid)?)?;
            let splits: Vec<(i32, i32)> = sqlx::query_as(
                "SELECT id, account_id FROM transaction_splits
                 WHERE transaction_id = $1 AND book_id = $2 ORDER BY id",
            )
            .bind(transaction_id)
            .bind(book_id)
            .fetch_all(&mut *connection)
            .await?;
            if !splits
                .iter()
                .any(|(_, account)| *account == link.account_id)
            {
                return Err(invalid(NOT_ON_LINKED_ACCOUNT));
            }
            if splits.len() != 2 {
                return Err(invalid(
                    "Amount update is only supported for transactions with exactly 2 splits",
                ));
            }
            let investment: bool = sqlx::query_scalar(
                "SELECT EXISTS (SELECT 1 FROM investment_splits
                                WHERE transaction_id = $1 AND book_id = $2)",
            )
            .bind(transaction_id)
            .bind(book_id)
            .fetch_one(&mut *connection)
            .await?;
            if investment {
                return Err(invalid(
                    "Amount update is not supported for investment transactions",
                ));
            }
            if linked_elsewhere(connection, link, transaction_id, &row).await? {
                return Err(invalid(LINKED_ELSEWHERE));
            }
            let linked = splits
                .iter()
                .find(|(_, account)| *account == link.account_id)
                .expect("checked above");
            let counter = splits
                .iter()
                .find(|(_, account)| *account != link.account_id)
                .ok_or_else(|| {
                    invalid("Transaction has no counterpart split on a different account")
                })?;
            for (split_id, split_amount) in [(linked.0, -amount), (counter.0, amount)] {
                sqlx::query(
                    "UPDATE transaction_splits SET amount = $3 WHERE id = $1 AND book_id = $2",
                )
                .bind(split_id)
                .bind(book_id)
                .bind(split_amount)
                .execute(&mut *connection)
                .await?;
            }
            mark_matched(connection, book_id, transaction_id, &row, now, actor).await?;
            resolve_row(connection, &row, "matched", Some(transaction_id), now).await?;
        }
        Action::Create => {
            let counter_account_id = input.counter_account().map_err(invalid)?;
            if counter_account_id == f64::from(link.account_id) {
                return Err(invalid(
                    "Counter account must be different from linked account",
                ));
            }
            let counter_account_id = body_id(counter_account_id)?;
            let exists: bool = sqlx::query_scalar(
                "SELECT EXISTS (SELECT 1 FROM accounts WHERE id = $1 AND book_id = $2)",
            )
            .bind(counter_account_id)
            .bind(book_id)
            .fetch_one(&mut *connection)
            .await?;
            if !exists {
                return Err(invalid("Counter account not found"));
            }
            let payee_source = match &input.payee_name {
                Some(Value::String(name)) => name.clone(),
                _ => row.merchant().to_owned(),
            };
            let payee_id = resolve_payee(connection, book_id, &payee_source).await?;
            let transaction_id: i32 = sqlx::query_scalar(
                "INSERT INTO transactions (date, description, payee_id, is_reconciled, updated_at,
                                           book_id, created_by, updated_by, created_at)
                 VALUES ($1, $2, $3, true, $4, $5, $6, $6, $7) RETURNING id",
            )
            .bind(row.bank_date())
            .bind(&row.name)
            .bind(payee_id)
            .bind(now)
            .bind(book_id)
            .bind(actor)
            .bind(now_millis())
            .fetch_one(&mut *connection)
            .await?;
            sqlx::query(
                "INSERT INTO transaction_splits (transaction_id, account_id, amount, book_id)
                 VALUES ($1, $2, $3, $5), ($1, $4, $6, $5)",
            )
            .bind(transaction_id)
            .bind(link.account_id)
            .bind(-amount)
            .bind(counter_account_id)
            .bind(book_id)
            .bind(amount)
            .execute(&mut *connection)
            .await?;
            resolve_row(connection, &row, "created", Some(transaction_id), now).await?;
        }
        Action::Ignore => {
            resolve_row(connection, &row, "ignored", None, now).await?;
        }
        Action::KeepLocal => {
            sqlx::query(
                "UPDATE plaid_transaction_reconciliation
                 SET review_reason = NULL, review_metadata_json = NULL, updated_at = $3
                 WHERE id = $1 AND book_id = $2",
            )
            .bind(row.id)
            .bind(book_id)
            .bind(now)
            .execute(&mut *connection)
            .await?;
        }
        Action::Unlink => {
            sqlx::query(
                "UPDATE plaid_transaction_reconciliation
                 SET resolution_status = 'pending', matched_transaction_id = NULL,
                     review_reason = NULL, review_metadata_json = NULL, resolved_at = NULL,
                     updated_at = $3
                 WHERE id = $1 AND book_id = $2",
            )
            .bind(row.id)
            .bind(book_id)
            .bind(now)
            .execute(&mut *connection)
            .await?;
            // A transfer is matched on both of its links. Its reconciled flag
            // is cleared only when no other staged row still matches it.
            if let Some(previous) = row.matched_transaction_id {
                let still_linked: bool = sqlx::query_scalar(
                    "SELECT EXISTS (SELECT 1 FROM plaid_transaction_reconciliation
                                    WHERE matched_transaction_id = $1 AND book_id = $2
                                      AND id <> $3)",
                )
                .bind(previous)
                .bind(book_id)
                .bind(row.id)
                .fetch_one(&mut *connection)
                .await?;
                if !still_linked {
                    sqlx::query(
                        "UPDATE transactions SET is_reconciled = false, updated_at = $3,
                                updated_by = $4
                         WHERE id = $1 AND book_id = $2",
                    )
                    .bind(previous)
                    .bind(book_id)
                    .bind(now)
                    .bind(actor)
                    .execute(&mut *connection)
                    .await?;
                }
            }
        }
    }
    Ok(row.id)
}

/// `resolveReconciliation`: applies one decision and returns the row as it
/// now stands, with its candidates.
pub(crate) async fn resolve(
    pool: &PgPool,
    book_id: i32,
    link: Link,
    input: &ReconcileInput,
    actor: i32,
) -> Result<Value, ReconcileError> {
    let now = now_millis();
    let mut transaction = pool.begin().await?;
    let row_id = match apply(transaction.as_mut(), book_id, link, input, actor, now).await {
        Ok(row_id) => {
            transaction.commit().await?;
            row_id
        }
        Err(cause) => {
            if let Err(rollback) = transaction.rollback().await {
                tracing::error!(error = %rollback, "Reconciliation rollback failed");
            }
            return Err(cause);
        }
    };
    let mut connection = pool.acquire().await?;
    let row = load_row(&mut connection, link.link_id, row_id, book_id, false)
        .await?
        .ok_or(ReconcileError::NotFound("Updated row not found"))?;
    load_item(&mut connection, &row, link.account_id, book_id).await
}

/// POST `sync/accounts/[id]/reconcile`. The link is checked before the body
/// is read. After the decision commits, the TypeSafe observation is saved
/// and the analytics event is sent.
pub(crate) async fn resolve_route(
    State(state): State<AppState>,
    Path((raw_book_id, raw_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult {
    const FAILURE: &str = "Failed to resolve reconciliation";
    let action_started_at = Utc::now().naive_utc();
    let book =
        authenticate_book(&state, &headers, &raw_book_id, AccessLevel::Write, FAILURE).await?;
    let link_id = database_id(finite_path_id(&raw_id, INVALID_LINK_ID)?, FAILURE)?;
    let link = reconcilable_link(&state.pool, book.book_id, link_id)
        .await
        .map_err(|cause| cause.into_api(FAILURE))?;
    let body = parse_json_body(&body, FAILURE)?;
    let input = validate_reconcile(&body)?;
    let item = resolve(&state.pool, book.book_id, link, &input, book.user_id)
        .await
        .map_err(|cause| cause.into_api(FAILURE))?;
    let observation = Observation::parse(body.get("typesafe"));
    record_decision(
        &state.pool,
        book.book_id,
        &input,
        &observation,
        action_started_at,
    )
    .await;
    state.analytics.capture_event(
        book.user_id,
        input.action.event_name(),
        Some(json!({ "bookId": book.book_id })),
    );
    Ok(Json(item))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scores_follow_node() {
        let (value, tags) = score(0, 0, "Blue Bottle", Some("blue  bottle"), None, false);
        assert_eq!(
            (value, tags),
            (155, vec!["exact_amount", "same_day", "name_exact"])
        );
        // An empty description is contained in every name.
        let (value, tags) = score(60, 11, "Cafe", Some("Other"), None, true);
        assert_eq!(
            (value, tags),
            (
                -70,
                vec![
                    "amount_close",
                    "date_close",
                    "name_similar",
                    "already_linked"
                ]
            )
        );
        let (value, _) = score(5, 2, "Cafe", Some("Other"), Some("Else"), false);
        assert_eq!(value, 45 + 24);
    }

    /// The TypeSafe confirm builds its input from a stored evaluation, not
    /// through `validate_reconcile`. A missing ID must be an error, not a
    /// panic.
    #[test]
    fn unvalidated_input_without_its_id_is_an_error() {
        let input = |action, transaction_id, counter_account_id| ReconcileInput {
            reconciliation_id: 1.0,
            action,
            transaction_id,
            counter_account_id,
            payee_name: None,
        };
        assert_eq!(
            input(Action::Match, None, None).transaction(),
            Err("transactionId is required for match")
        );
        assert_eq!(
            input(Action::MatchUpdateAmount, Some(json!("7")), None).transaction(),
            Err("transactionId is required for match_update_amount")
        );
        assert_eq!(
            input(Action::Match, Some(json!(7)), None).transaction(),
            Ok(7.0)
        );
        for missing in [None, Some(json!(null)), Some(json!(0)), Some(json!(-2))] {
            assert_eq!(
                input(Action::Create, None, missing).counter_account(),
                Err("counterAccountId is required for create")
            );
        }
        assert_eq!(
            input(Action::Create, None, Some(json!(4))).counter_account(),
            Ok(4.0)
        );
    }

    #[test]
    fn decisions_report_the_first_zod_issue() {
        let message = |body: Value| match validate_reconcile(&body) {
            Ok(input) => input.action.name().to_owned(),
            Err(error) => format!("{error:?}"),
        };
        for (body, expected) in [
            (json!(null), "reconciliationId is required"),
            (json!({}), "reconciliationId is required"),
            (json!({ "reconciliationId": 1 }), "Invalid action"),
            (
                json!({ "reconciliationId": 1.5, "action": "x" }),
                "reconciliationId is required",
            ),
            (
                json!({ "reconciliationId": 9007199254740992_u64, "action": "ignore" }),
                "reconciliationId is required",
            ),
            (
                json!({ "reconciliationId": 1, "action": "bogus", "transactionId": "x" }),
                "Invalid action",
            ),
            (
                json!({ "reconciliationId": 1, "action": "match" }),
                "transactionId is required for match",
            ),
            (
                json!({ "reconciliationId": 1, "action": "match_update_amount", "transactionId": 1.5 }),
                "transactionId is required for match_update_amount",
            ),
            (
                json!({ "reconciliationId": 1, "action": "create", "counterAccountId": 0 }),
                "counterAccountId is required for create",
            ),
            (
                json!({ "reconciliationId": 1, "action": "create", "counterAccountId": 9007199254740992_u64 }),
                "create",
            ),
            (
                json!({ "reconciliationId": -3, "action": "ignore", "payeeName": 5 }),
                "ignore",
            ),
        ] {
            assert!(message(body.clone()).contains(expected), "{body}");
        }
    }

    #[test]
    fn page_queries_fall_back_as_zod_catch_does() {
        let query = |raw: &str| page_query(&first_query_values(Some(raw)));
        assert_eq!(query(""), (25.0, 0.0));
        assert_eq!(query("limit=0x10&offset=1.5"), (16.0, 0.0));
        assert_eq!(query("limit=abc&offset=-5"), (25.0, 0.0));
        assert_eq!(query("limit=5&offset=-0"), (5.0, 0.0));
        assert_eq!(query("limit=1e400"), (25.0, 0.0));
        assert_eq!(
            add_days("2025-03-01", -7).ok(),
            Some("2025-02-22".to_owned())
        );
        assert!(add_days("2025-13-01", 7).is_err());
    }
}
