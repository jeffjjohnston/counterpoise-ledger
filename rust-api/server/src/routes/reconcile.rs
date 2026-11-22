//! Plaid reconciliation: the queue of
//! staged bank transactions that need a decision, and the six decisions.
//!
//! The resolver takes no lease. It changes one staged row inside one
//! database transaction, which holds the write lock from its start, so two
//! resolves of the same row run one after the other. Each decision checks
//! the state of the row against the transition table
//! (`Action::allowed_from`), and each write repeats that check.

use crate::{
    book_auth::{AccessLevel, authenticate_book},
    book_scope::{BookAccess, Write, find_payee_by_name},
    error::{ApiError, ApiResult, error, error_owned, internal_error},
    platform,
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
use chrono::{Days, NaiveDate, NaiveDateTime};
use ledger_db::locks::FOR_UPDATE;
use ledger_db::lots::{collect_affected_pairs, rebuild_lots_for_pairs};
use ledger_db::store::{self, Sql, params};
use ledger_db::{
    Database,
    sql::{in_integers, json_array},
};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

const INVALID_LINK_ID: &str = "Invalid linked account id";
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
/// `effectiveDateSql` for the transaction alias `t`.
pub(crate) use ledger_db::sql::EFFECTIVE_DATE;

/// A reconciliation failure. Each route maps these to its own responses.
pub(crate) enum ReconcileError {
    /// `ReconcileNotFoundError`: 404 with the message.
    NotFound(&'static str),
    /// `ReconcileValidationError`: 400 with the message.
    Invalid(String),
    /// Any other error: the route's 500. The cause goes to the log only.
    Failed(String),
    /// An error whose message Node repeats in its 500 response.
    Message(&'static str),
}

impl From<store::Error> for ReconcileError {
    fn from(cause: store::Error) -> Self {
        Self::Failed(cause.to_string())
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

const AMOUNT_OUT_OF_RANGE: &str = "The bank amount is out of range for a transaction split";

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
pub(crate) fn reconcilable_link(
    sql: &impl Sql,
    book_id: i32,
    link_id: i32,
) -> Result<Link, ReconcileError> {
    let row: Option<(i32, i32, String)> = sql.query_optional(
        "SELECT pa.id, pa.counterpoise_account_id, a.type
         FROM plaid_accounts pa JOIN accounts a ON pa.counterpoise_account_id = a.id
         WHERE pa.id = ?1 AND pa.book_id = ?2 AND a.book_id = ?2 LIMIT 1",
        &params![link_id, book_id],
    )?;
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
    r.last_seen_at, r.review_metadata_json, r.linked_account_id";

#[derive(ledger_db::store::FromRow)]
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
    pub(crate) review_metadata_json: Option<String>,
    /// The account that the link was made on. The mapping of the bank
    /// account can change after the link.
    pub(crate) linked_account_id: Option<i32>,
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
pub(crate) fn load_row(
    sql: &impl Sql,
    link_id: i32,
    reconciliation_id: i32,
    book_id: i32,
    for_update: bool,
) -> Result<Option<ReconRow>, store::Error> {
    let lock = if for_update { FOR_UPDATE } else { "" };
    sql.query_optional(
        &format!(
            "SELECT {ROW_COLUMNS} FROM plaid_transaction_reconciliation r
         WHERE r.id = ?1 AND r.plaid_account_link_id = ?2 AND r.book_id = ?3 LIMIT 1{lock}"
        ),
        &params![reconciliation_id, link_id, book_id],
    )
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

#[derive(ledger_db::store::FromRow)]
struct CandidateRow {
    transaction_id: i32,
    date: String,
    description: Option<String>,
    payee_name: Option<String>,
    check_number: Option<String>,
    /// The total of the transaction's splits on the mapped account, the
    /// same amount that the resolver compares with the bank amount.
    linked_split_amount: i64,
}

/// `findMatchCandidates`: the five best transactions on the mapped account
/// within seven days of the bank date.
pub(crate) fn match_candidates(
    sql: &impl Sql,
    row: &ReconRow,
    mapped_account_id: i32,
) -> Result<Vec<Value>, ReconcileError> {
    let expected = -i64::from(row.amount_cents);
    let bank_date = row.bank_date();
    let start = add_days(bank_date, -7)?;
    let end = add_days(bank_date, 7)?;
    // No book filter here, as in Node: the mapped account is in this book.
    // The detail query below filters the book.
    let rows: Vec<CandidateRow> = sql.query(
        &format!(
            "SELECT t.id AS transaction_id, {EFFECTIVE_DATE} AS date, t.description,
                p.name AS payee_name, t.check_number,
                (SELECT SUM(x.amount) FROM transaction_splits x
                 WHERE x.transaction_id = t.id AND x.account_id = ?1) AS linked_split_amount
         FROM transaction_splits s
         JOIN transactions t ON s.transaction_id = t.id
         LEFT JOIN payees p ON t.payee_id = p.id
         WHERE s.account_id = ?1 AND {EFFECTIVE_DATE} >= ?2 AND {EFFECTIVE_DATE} <= ?3
         ORDER BY {EFFECTIVE_DATE} DESC, t.id DESC
         LIMIT 200"
        ),
        &params![mapped_account_id, &start, &end],
    )?;
    let mut seen = HashSet::new();
    let rows: Vec<CandidateRow> = rows
        .into_iter()
        .filter(|candidate| seen.insert(candidate.transaction_id))
        .collect();
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let ids: Vec<i32> = rows.iter().map(|row| row.transaction_id).collect();
    let splits: Vec<(i32, i32, String)> = sql.query(
        &format!(
            "SELECT s.transaction_id, s.account_id, a.name
         FROM transaction_splits s
         JOIN transactions t ON t.id = s.transaction_id
         JOIN accounts a ON a.id = s.account_id
         WHERE t.book_id = ?1 AND t.id {in2}
         ORDER BY s.id",
            in2 = in_integers("?2")
        ),
        &params![row.book_id, json_array(&ids)],
    )?;
    let mut details: HashMap<i32, Vec<(i32, String)>> = HashMap::new();
    for (transaction_id, account_id, name) in splits {
        details
            .entry(transaction_id)
            .or_default()
            .push((account_id, name));
    }
    let linked: HashSet<i32> = sql
        .query::<i32>(
            &format!(
                "SELECT matched_transaction_id FROM plaid_transaction_reconciliation
         WHERE plaid_account_link_id = ?1 AND matched_transaction_id IS NOT NULL
           AND matched_transaction_id {in2} AND id <> ?3",
                in2 = in_integers("?2")
            ),
            &params![row.plaid_account_link_id, json_array(&ids), row.id],
        )?
        .into_iter()
        .collect();
    // `match_update_amount` refuses an investment transaction, so the client
    // must not offer it there.
    let investment: HashSet<i32> = sql
        .query::<i32>(
            &format!(
                "SELECT DISTINCT transaction_id FROM investment_splits
         WHERE book_id = ?1 AND transaction_id {in2}",
                in2 = in_integers("?2")
            ),
            &params![row.book_id, json_array(&ids)],
        )?
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
        let amount_delta = (candidate.linked_split_amount - expected).abs();
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
                "isInvestment": investment.contains(&candidate.transaction_id),
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
pub(crate) fn suggest_counter_account(
    sql: &impl Sql,
    row: &ReconRow,
    mapped_account_id: i32,
    book_id: i32,
) -> Result<Option<i32>, store::Error> {
    let source = normalize_name(row.merchant());
    if source.is_empty() {
        return Ok(None);
    }
    let payee_id = find_payee_by_name(sql, book_id, &source)?;
    let Some(payee_id) = payee_id else {
        return Ok(None);
    };
    let transaction_ids: Vec<i32> = sql.query(
        &format!(
            "SELECT t.id FROM transactions t WHERE t.book_id = ?1 AND t.payee_id = ?2
         ORDER BY {EFFECTIVE_DATE} DESC, t.id DESC LIMIT 25"
        ),
        &params![book_id, payee_id],
    )?;
    if transaction_ids.is_empty() {
        return Ok(None);
    }
    let counterparts: Vec<(i32, i32)> = sql.query(
        &format!(
            "SELECT account_id, amount FROM transaction_splits
         WHERE book_id = ?1 AND transaction_id {in2} AND account_id <> ?3
         ORDER BY transaction_id DESC, id",
            in2 = in_integers("?2")
        ),
        &params![book_id, json_array(&transaction_ids), mapped_account_id],
    )?;
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
pub(crate) fn load_item(
    sql: &impl Sql,
    row: &ReconRow,
    mapped_account_id: i32,
    book_id: i32,
) -> Result<Value, ReconcileError> {
    let candidates = match_candidates(sql, row, mapped_account_id)?;
    let suggested = suggest_counter_account(sql, row, mapped_account_id, book_id)?;
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
        "linkedAccountId": row.linked_account_id,
        "pending": row.pending,
        "firstSeenAt": iso_timestamp(row.first_seen_at),
        "lastSeenAt": iso_timestamp(row.last_seen_at),
        "candidates": candidates,
        "suggestedCounterAccountId": suggested,
        "reviewChanges": review_changes(row.review_metadata_json.as_deref()),
    }))
}

/// The fields that a modification review compares (`plaid_sync.rs`,
/// `ReviewFields`), in the order that the queue shows them.
const REVIEW_FIELDS: [&str; 7] = [
    "date",
    "amountCents",
    "name",
    "merchantName",
    "originalDescription",
    "categoryPrimary",
    "categoryDetailed",
];

/// The fields that the bank changed on a row flagged `plaid_modified`, each
/// as `{field, previous, incoming}`, from the row's review metadata. A field
/// that the incoming values leave out was not sent, and the sync kept it, so
/// it is not a change. Any other row, or metadata that does not parse, gives
/// an empty list.
fn review_changes(metadata: Option<&str>) -> Value {
    let Some(metadata) = metadata.and_then(|text| serde_json::from_str::<Value>(text).ok()) else {
        return json!([]);
    };
    if metadata.get("event").and_then(Value::as_str) != Some("modified") {
        return json!([]);
    }
    let (Some(previous), Some(incoming)) = (
        metadata.get("previous").and_then(Value::as_object),
        metadata.get("incoming").and_then(Value::as_object),
    ) else {
        return json!([]);
    };
    let changes: Vec<Value> = REVIEW_FIELDS
        .iter()
        .filter_map(|field| {
            let new = incoming.get(*field)?;
            let old = previous.get(*field).unwrap_or(&Value::Null);
            (old != new).then(|| json!({ "field": field, "previous": old, "incoming": new }))
        })
        .collect();
    Value::Array(changes)
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
    let result: Result<Value, ReconcileError> = (|| {
        let sql = &*state.database;
        let link = reconcilable_link(sql, book.book_id(), link_id)?;
        let queue = "r.plaid_account_link_id = ?1
                     AND (r.resolution_status = 'pending' OR r.review_reason IS NOT NULL)";
        let rows: Vec<ReconRow> = sql.query(
            &format!(
                "SELECT {ROW_COLUMNS} FROM plaid_transaction_reconciliation r WHERE {queue}
             ORDER BY CASE WHEN r.review_reason IS NOT NULL THEN 1 ELSE 0 END DESC,
                      r.last_seen_at DESC, r.id DESC
             LIMIT COALESCE(?2, -1) OFFSET COALESCE(?3, 0)"
            ),
            &params![link.link_id, limit as i64, offset as i64],
        )?;
        let total: i64 = sql.query_row(
            &format!("SELECT COUNT(*) FROM plaid_transaction_reconciliation r WHERE {queue}"),
            &params![link.link_id],
        )?;
        let mut items = Vec::with_capacity(rows.len());
        for row in &rows {
            items.push(load_item(sql, row, link.account_id, book.book_id())?);
        }
        Ok(page(items, total, offset, limit))
    })();
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
    let result: Result<Value, ReconcileError> =
        (|| {
            let sql = &*state.database;
            if let Some(link_id) = link_id {
                reconcilable_link(sql, book.book_id(), link_id)?;
            }
            let queue = "r.book_id = ?1 AND pa.book_id = ?1 AND a.book_id = ?1
                     AND a.type IN ('asset', 'liability')
                     AND (?2 IS NULL OR pa.id = ?2)
                     AND (r.resolution_status = 'pending' OR r.review_reason IS NOT NULL)";
            let joins = "FROM plaid_transaction_reconciliation r
                     JOIN plaid_accounts pa ON r.plaid_account_link_id = pa.id
                     JOIN accounts a ON pa.counterpoise_account_id = a.id";
            let rows: Vec<(i32, i32)> = sql.query(
                &format!(
                    "SELECT r.id, a.id {joins} WHERE {queue}
             ORDER BY CASE WHEN r.review_reason IS NOT NULL THEN 1 ELSE 0 END DESC,
                      COALESCE(r.authorized_date, r.date) DESC, r.id DESC
             LIMIT COALESCE(?3, -1) OFFSET COALESCE(?4, 0)"
                ),
                &params![book.book_id(), link_id, limit as i64, offset as i64],
            )?;
            let total: i64 = sql.query_row(
                &format!("SELECT COUNT(*) {joins} WHERE {queue}"),
                &params![book.book_id(), link_id],
            )?;
            let mut items = Vec::with_capacity(rows.len());
            for (id, mapped_account_id) in rows {
                let row: ReconRow = sql.query_row(&format!(
                "SELECT {ROW_COLUMNS} FROM plaid_transaction_reconciliation r WHERE r.id = ?1"
            ), &params![id])?;
                items.push(load_item(sql, &row, mapped_account_id, book.book_id())?);
            }
            Ok(page(items, total, offset, limit))
        })();
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

    /// The transition table: the states that this decision can start from, as
    /// an SQL condition on the staged row. `guides/plaid-sync.md` has the
    /// same table. Keep the two the same.
    ///
    /// The check before a decision and the `WHERE` of each write both use
    /// this condition, so no write can leave a state that the table refuses.
    fn allowed_from(self) -> &'static str {
        match self {
            // A pending row, or a linked row that is flagged for review. A
            // linked row with no flag must be unlinked first. An ignored row
            // takes no decision.
            Self::Match | Self::MatchUpdateAmount | Self::Create | Self::Ignore => {
                "(resolution_status = 'pending'
                  OR (resolution_status IN ('matched', 'created') AND review_reason IS NOT NULL))"
            }
            // Only a row that the bank changed has a local side to keep. A
            // row that the bank removed must not go back to the plain
            // pending state, where the auto-matcher takes it.
            Self::KeepLocal => {
                "(resolution_status IN ('pending', 'matched', 'created')
                  AND review_reason = 'plaid_modified')"
            }
            Self::Unlink => "resolution_status IN ('matched', 'created')",
        }
    }

    /// Why the transition table refuses this decision on `row`.
    fn refusal(self, row: &ReconRow) -> String {
        let status = row.resolution_status.as_str();
        if status == "ignored" {
            return "This bank transaction is ignored and cannot be changed".to_owned();
        }
        if !matches!(status, "pending" | "matched" | "created") {
            return "This bank transaction has a status that takes no decision".to_owned();
        }
        match self {
            Self::KeepLocal if row.review_reason.as_deref() == Some("plaid_removed") => {
                "Keep local does not apply: the bank removed this transaction".to_owned()
            }
            Self::KeepLocal => {
                "Keep local applies only to a bank transaction that the bank changed".to_owned()
            }
            Self::Unlink => "This bank transaction is not linked to a transaction".to_owned(),
            Self::Match | Self::MatchUpdateAmount | Self::Create | Self::Ignore => {
                match row.matched_transaction_id {
                    Some(matched) => format!(
                        "This bank transaction is already linked to transaction #{matched} — unlink it first"
                    ),
                    None => {
                        "This bank transaction is already resolved — unlink it first".to_owned()
                    }
                }
            }
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
/// resolver. If the match misses a payee with the same name, the insert fails
/// on the unique index and the decision rolls back.
fn resolve_payee(
    sql: &impl Sql,
    access: &BookAccess<'_, Write>,
    payee_name: &str,
) -> Result<Option<i32>, store::Error> {
    let book_id = access.book_id();
    let name = normalize_name(payee_name);
    if name.is_empty() {
        return Ok(None);
    }
    let existing = find_payee_by_name(sql, book_id, &name)?;
    if existing.is_some() {
        return Ok(existing);
    }
    sql.query_optional(
        "INSERT INTO payees (name, book_id, created_at, name_fold) VALUES (?1, ?2, ?3, ?4)
         RETURNING id",
        &params![&name, book_id, now_millis(), ledger_db::folds::fold(&name)],
    )
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
fn mark_matched(
    sql: &impl Sql,
    access: &BookAccess<'_, Write>,
    transaction_id: i32,
    row: &ReconRow,
    now: NaiveDateTime,
    actor: i32,
) -> Result<(), ReconcileError> {
    let book_id = access.book_id();
    let floating: Option<bool> = sql.query_optional(
        "SELECT is_floating FROM transactions WHERE id = ?1 AND book_id = ?2 LIMIT 1",
        &params![transaction_id, book_id],
    )?;
    let settle = floating == Some(true);
    let updated: Option<i32> = sql.query_optional(
        "UPDATE transactions SET is_reconciled = true, updated_at = ?3, updated_by = ?4,
                is_floating = CASE WHEN ?5 THEN false ELSE is_floating END,
                date = CASE WHEN ?5 THEN ?6 ELSE date END
         WHERE id = ?1 AND book_id = ?2 RETURNING id",
        &params![
            transaction_id,
            book_id,
            now,
            actor,
            settle,
            pick_matched_date(row.authorized_date.as_deref(), &row.date)
        ],
    )?;
    if updated.is_none() {
        return Err(ReconcileError::NotFound("Transaction not found"));
    }
    if settle {
        // Lots are derived from the effective date, which the settlement
        // changed: rebuild every pair of the transaction.
        let pairs = collect_affected_pairs(sql, book_id, transaction_id)?;
        rebuild_lots_for_pairs(sql, book_id, &pairs)?;
    }
    Ok(())
}

/// A write of a decision changed no row: the row is not in a state that the
/// transition table allows. `apply` checks the state first, so this is a
/// fault, and the error rolls the decision back.
fn changed(rows: u64, action: Action) -> Result<(), ReconcileError> {
    if rows == 1 {
        Ok(())
    } else {
        Err(ReconcileError::Failed(format!(
            "the {} decision changed {rows} rows: the row left the state that the decision needs",
            action.name()
        )))
    }
}

/// Sets the resolution of the row, and clears its review flag. The write
/// applies only from a state that the transition table allows for `action`.
fn resolve_row(
    sql: &impl Sql,
    row: &ReconRow,
    action: Action,
    status: &str,
    linked: Option<(i32, i32)>,
    now: NaiveDateTime,
) -> Result<(), ReconcileError> {
    // `linked`: the transaction and the account that the link is made on.
    let (matched_transaction_id, linked_account_id) = linked.unzip();
    let rows = sql.execute(
        &format!(
            "UPDATE plaid_transaction_reconciliation
             SET resolution_status = ?3, matched_transaction_id = ?4, linked_account_id = ?6,
                 review_reason = NULL, review_metadata_json = NULL, resolved_at = ?5,
                 updated_at = ?5
             WHERE id = ?1 AND book_id = ?2 AND {}",
            action.allowed_from()
        ),
        &params![
            row.id,
            row.book_id,
            status,
            matched_transaction_id,
            now,
            linked_account_id
        ],
    )?;
    changed(rows, action)
}

/// The columns that an unlink sets. The row goes back to pending. The flag
/// of a row that the bank changed goes, because the row now has the bank's
/// values and no local side. The flag of a row that the bank removed stays:
/// without it the auto-matcher takes a row that the bank deleted. The
/// transaction unlink route (`sync.rs`) uses the same columns. `?3` is the
/// time.
pub(crate) const UNLINK_SET: &str = "resolution_status = 'pending', matched_transaction_id = NULL,
    linked_account_id = NULL,
    review_metadata_json = CASE WHEN review_reason = 'plaid_removed'
                                THEN review_metadata_json END,
    review_reason = CASE WHEN review_reason = 'plaid_removed' THEN review_reason END,
    resolved_at = NULL, updated_at = ?3";

/// The states that an unlink can start from (`Action::allowed_from`).
pub(crate) fn unlink_allowed_from() -> &'static str {
    Action::Unlink.allowed_from()
}

/// Another staged row on this link is already matched to the transaction.
fn linked_elsewhere(
    sql: &impl Sql,
    link: Link,
    transaction_id: i32,
    row: &ReconRow,
) -> Result<bool, store::Error> {
    sql.query_row(
        "SELECT EXISTS (SELECT 1 FROM plaid_transaction_reconciliation
                        WHERE plaid_account_link_id = ?1 AND matched_transaction_id = ?2
                          AND id <> ?3)",
        &params![link.link_id, transaction_id, row.id],
    )
}

/// The total of the transaction's splits on `account_id`, or `None` when the
/// transaction has no split on that account. A link requires this total to
/// be the negation of the bank amount.
pub(crate) fn linked_amount(
    sql: &impl Sql,
    transaction_id: i32,
    account_id: i32,
    book_id: i32,
) -> Result<Option<i64>, store::Error> {
    sql.query_row(
        "SELECT SUM(amount) FROM transaction_splits
         WHERE transaction_id = ?1 AND account_id = ?2 AND book_id = ?3",
        &params![transaction_id, account_id, book_id],
    )
}

/// One bank row that links a transaction, with the bank amount and the
/// transaction's total on the linked account (`None`: no split there).
#[derive(ledger_db::store::FromRow)]
pub(crate) struct LinkAmounts {
    pub(crate) reconciliation_id: i32,
    pub(crate) matched_transaction_id: i32,
    pub(crate) account_id: i32,
    pub(crate) bank_cents: i32,
    pub(crate) linked_cents: Option<i64>,
}

impl LinkAmounts {
    /// The link joins equal amounts.
    pub(crate) fn agrees(&self) -> bool {
        self.linked_cents == Some(-i64::from(self.bank_cents))
    }
}

// A bank account with no Counterpoise account assigned has no linked
// account to compare, so its rows are left out. The account is the one that
// the link was made on (`linked_account_id`), so a remap of the bank account
// to another account does not break the old links. A row with no stored
// account (a deleted account) uses the current mapping.
const LINK_AMOUNTS: &str = "SELECT r.id AS reconciliation_id, r.matched_transaction_id,
           COALESCE(r.linked_account_id, pa.counterpoise_account_id) AS account_id,
           r.amount_cents AS bank_cents,
           (SELECT SUM(s.amount) FROM transaction_splits s
            WHERE s.transaction_id = r.matched_transaction_id
              AND s.account_id = COALESCE(r.linked_account_id, pa.counterpoise_account_id)
              AND s.book_id = r.book_id)
             AS linked_cents
    FROM plaid_transaction_reconciliation r
    JOIN plaid_accounts pa ON pa.id = r.plaid_account_link_id AND pa.book_id = r.book_id
    WHERE r.book_id = ?1 AND r.resolution_status IN ('matched', 'created')
      AND r.matched_transaction_id IS NOT NULL
      AND pa.counterpoise_account_id IS NOT NULL";

/// The bank rows that link `transaction_id`, with their amounts.
pub(crate) fn link_amounts(
    sql: &impl Sql,
    book_id: i32,
    transaction_id: i32,
) -> Result<Vec<LinkAmounts>, store::Error> {
    sql.query(
        &format!("{LINK_AMOUNTS} AND r.matched_transaction_id = ?2 ORDER BY r.id"),
        &params![book_id, transaction_id],
    )
}

/// Every link in the book whose amounts are different.
pub(crate) fn mismatched_links(
    sql: &impl Sql,
    book_id: i32,
) -> Result<Vec<LinkAmounts>, store::Error> {
    let rows: Vec<LinkAmounts> =
        sql.query(&format!("{LINK_AMOUNTS} ORDER BY r.id"), &params![book_id])?;
    Ok(rows.into_iter().filter(|row| !row.agrees()).collect())
}

/// The refusal when a transaction edit would make a link join different
/// amounts. An edit that removes every split on the linked account cannot be
/// corrected with an amount, so that message tells the user to unlink.
pub(crate) fn broken_link_message(link: &LinkAmounts) -> String {
    let bank = dollars(-i64::from(link.bank_cents));
    if link.linked_cents.is_none() {
        return format!(
            "This transaction is linked to a bank transaction for {bank} on the account that \
             the edit removes. Unlink the bank transaction first, or keep a split on that account"
        );
    }
    format!(
        "This transaction is linked to a bank transaction for {bank}. Change the amount on the \
         linked account to that amount, or unlink the bank transaction first"
    )
}

/// The refusal when the amount cannot be changed to the bank amount.
/// `match_update_amount` keeps its earlier message. `match` tells the user
/// what to do.
fn cannot_update(action: Action, update_refusal: &str, reason: &str, bank_cents: i32) -> String {
    match action {
        Action::MatchUpdateAmount => update_refusal.to_owned(),
        _ => format!(
            "The amounts are different, and the amount cannot be changed here because {reason}. \
             Change the amount on this account to the bank amount ({}) first, then match",
            dollars(-i64::from(bank_cents))
        ),
    }
}

/// Cents as a dollar amount for a message, for example `-$4.50`.
fn dollars(cents: i64) -> String {
    let sign = if cents < 0 { "-" } else { "" };
    let abs = cents.unsigned_abs();
    format!("{sign}${}.{:02}", abs / 100, abs % 100)
}

/// The row no longer links `previous`. A transfer is matched on both of its
/// links, so its reconciled flag is cleared only when no other staged row
/// still matches it.
fn release_previous(
    sql: &impl Sql,
    access: &BookAccess<'_, Write>,
    previous: i32,
    row: &ReconRow,
    now: NaiveDateTime,
    actor: i32,
) -> Result<(), store::Error> {
    let book_id = access.book_id();
    let still_linked: bool = sql.query_row(
        "SELECT EXISTS (SELECT 1 FROM plaid_transaction_reconciliation
                        WHERE matched_transaction_id = ?1 AND book_id = ?2
                          AND id <> ?3)",
        &params![previous, book_id, row.id],
    )?;
    if !still_linked {
        sql.execute(
            "UPDATE transactions SET is_reconciled = false, updated_at = ?3,
                    updated_by = ?4
             WHERE id = ?1 AND book_id = ?2",
            &params![previous, book_id, now, actor],
        )?;
    }
    Ok(())
}

/// A row flagged for review can be linked again. When the new link is to a
/// different transaction, the old one is released as by `unlink`.
fn relink(
    sql: &impl Sql,
    access: &BookAccess<'_, Write>,
    row: &ReconRow,
    transaction_id: i32,
    now: NaiveDateTime,
    actor: i32,
) -> Result<(), store::Error> {
    match row.matched_transaction_id {
        Some(previous) if previous != transaction_id => {
            release_previous(sql, access, previous, row, now, actor)
        }
        _ => Ok(()),
    }
}

const NOT_ON_LINKED_ACCOUNT: &str = "Selected transaction does not include the linked account";
const LINKED_ELSEWHERE: &str =
    "This transaction is already linked to a different Plaid transaction for the same account";

/// The decision inside its database transaction. Returns the row ID.
pub(crate) fn apply(
    sql: &impl Sql,
    access: &BookAccess<'_, Write>,
    link: Link,
    input: &ReconcileInput,
    actor: i32,
    now: NaiveDateTime,
) -> Result<i32, ReconcileError> {
    let book_id = access.book_id();
    let reconciliation_id = body_id(input.reconciliation_id)?;
    let row = load_row(sql, link.link_id, reconciliation_id, book_id, true)?
        .ok_or(ReconcileError::NotFound("Reconciliation row not found"))?;
    // The transition table, before any write. A linked bank row cannot be
    // linked again, unless Plaid has changed it since and it is flagged for
    // review.
    let allowed: bool = sql.query_row(
        &format!(
            "SELECT EXISTS (SELECT 1 FROM plaid_transaction_reconciliation
                            WHERE id = ?1 AND book_id = ?2 AND {})",
            input.action.allowed_from()
        ),
        &params![row.id, book_id],
    )?;
    if !allowed {
        return Err(ReconcileError::Invalid(input.action.refusal(&row)));
    }
    // The two split amounts are the bank amount and its negation. SQLite
    // stores any 64-bit value, and every reader decodes a split amount as a
    // 32-bit integer. The negation of i32::MIN does not fit, so refuse it
    // before any write, as PostgreSQL refused it at the insert.
    if matches!(
        input.action,
        Action::Match | Action::MatchUpdateAmount | Action::Create
    ) && row.amount_cents.checked_neg().is_none()
    {
        return Err(invalid(AMOUNT_OUT_OF_RANGE));
    }
    let amount = i64::from(row.amount_cents);
    match input.action {
        // A link always joins equal amounts. `match` therefore changes the
        // amount to the bank amount when the two are different, as
        // `match_update_amount` does. It refuses when it cannot change the
        // amount (more than 2 splits, or an investment transaction).
        Action::Match | Action::MatchUpdateAmount => {
            let transaction_id = body_id(input.transaction().map_err(invalid)?)?;
            let current = linked_amount(sql, transaction_id, link.account_id, book_id)?
                .ok_or_else(|| invalid(NOT_ON_LINKED_ACCOUNT))?;
            let update = input.action == Action::MatchUpdateAmount || current != -amount;
            let splits: Vec<(i32, i32)> = sql.query(
                "SELECT id, account_id FROM transaction_splits
                 WHERE transaction_id = ?1 AND book_id = ?2 ORDER BY id",
                &params![transaction_id, book_id],
            )?;
            if update && splits.len() != 2 {
                return Err(invalid(&cannot_update(
                    input.action,
                    "Amount update is only supported for transactions with exactly 2 splits",
                    "the transaction has more than 2 splits",
                    row.amount_cents,
                )));
            }
            if update {
                let investment: bool = sql.query_row(
                    "SELECT EXISTS (SELECT 1 FROM investment_splits
                                    WHERE transaction_id = ?1 AND book_id = ?2)",
                    &params![transaction_id, book_id],
                )?;
                if investment {
                    return Err(invalid(&cannot_update(
                        input.action,
                        "Amount update is not supported for investment transactions",
                        "it is an investment transaction",
                        row.amount_cents,
                    )));
                }
            }
            if linked_elsewhere(sql, link, transaction_id, &row)? {
                return Err(invalid(LINKED_ELSEWHERE));
            }
            if update {
                let linked = splits
                    .iter()
                    .find(|(_, account)| *account == link.account_id)
                    .expect("linked_amount found a split on the account");
                let counter = splits
                    .iter()
                    .find(|(_, account)| *account != link.account_id)
                    .ok_or_else(|| {
                        invalid("Transaction has no counterpart split on a different account")
                    })?;
                // A transfer can also be linked on its other account. The
                // rewrite changes both splits, so it must not break that
                // link.
                let before = link_amounts(sql, book_id, transaction_id)?;
                for (split_id, split_amount) in [(linked.0, -amount), (counter.0, amount)] {
                    sql.execute(
                        "UPDATE transaction_splits SET amount = ?3 WHERE id = ?1 AND book_id = ?2",
                        &params![split_id, book_id, split_amount],
                    )?;
                }
                let after = link_amounts(sql, book_id, transaction_id)?;
                if let Some(broken) = after.iter().find(|other| {
                    other.reconciliation_id != row.id
                        && !other.agrees()
                        && before.iter().any(|old| {
                            old.reconciliation_id == other.reconciliation_id && old.agrees()
                        })
                }) {
                    return Err(invalid(&format!(
                        "The amounts are different, and this transaction is also linked to a bank \
                         transaction for {} on its other account. Changing the amount would break \
                         that link. Unlink it first, or match another transaction",
                        dollars(-i64::from(broken.bank_cents))
                    )));
                }
            }
            mark_matched(sql, access, transaction_id, &row, now, actor)?;
            relink(sql, access, &row, transaction_id, now, actor)?;
            resolve_row(
                sql,
                &row,
                input.action,
                "matched",
                Some((transaction_id, link.account_id)),
                now,
            )?;
        }
        Action::Create => {
            let counter_account_id = input.counter_account().map_err(invalid)?;
            if counter_account_id == f64::from(link.account_id) {
                return Err(invalid(
                    "Counter account must be different from linked account",
                ));
            }
            let counter_account_id = body_id(counter_account_id)?;
            let exists: bool = sql.query_row(
                "SELECT EXISTS (SELECT 1 FROM accounts WHERE id = ?1 AND book_id = ?2)",
                &params![counter_account_id, book_id],
            )?;
            if !exists {
                return Err(invalid("Counter account not found"));
            }
            let payee_source = match &input.payee_name {
                Some(Value::String(name)) => name.clone(),
                _ => row.merchant().to_owned(),
            };
            let payee_id = resolve_payee(sql, access, &payee_source)?;
            let transaction_id: i32 = sql.query_row(
                "INSERT INTO transactions (date, description, payee_id, is_reconciled, updated_at,
                                           book_id, created_by, updated_by, created_at,
                                           description_fold)
                 VALUES (?1, ?2, ?3, true, ?4, ?5, ?6, ?6, ?7, ?8) RETURNING id",
                &params![
                    row.bank_date(),
                    &row.name,
                    payee_id,
                    now,
                    book_id,
                    actor,
                    now_millis(),
                    ledger_db::folds::fold(&row.name)
                ],
            )?;
            sql.execute(
                "INSERT INTO transaction_splits (transaction_id, account_id, amount, book_id)
                 VALUES (?1, ?2, ?3, ?5), (?1, ?4, ?6, ?5)",
                &params![
                    transaction_id,
                    link.account_id,
                    -amount,
                    counter_account_id,
                    book_id,
                    amount
                ],
            )?;
            relink(sql, access, &row, transaction_id, now, actor)?;
            resolve_row(
                sql,
                &row,
                input.action,
                "created",
                Some((transaction_id, link.account_id)),
                now,
            )?;
        }
        Action::Ignore => {
            resolve_row(sql, &row, input.action, "ignored", None, now)?;
            // Ignore removes the link, as Unlink does. A row flagged for
            // review can still link a transaction, so release it.
            if let Some(previous) = row.matched_transaction_id {
                release_previous(sql, access, previous, &row, now, actor)?;
            }
        }
        Action::KeepLocal => {
            // Keep leaves the transaction as it is. It cannot keep a link
            // whose amounts are now different. The amount is on the account
            // that the link was made on.
            let linked = matches!(row.resolution_status.as_str(), "matched" | "created");
            if let (true, Some(transaction_id)) = (linked, row.matched_transaction_id) {
                let account_id = row.linked_account_id.unwrap_or(link.account_id);
                let current = linked_amount(sql, transaction_id, account_id, book_id)?;
                if current != Some(-amount) {
                    return Err(invalid(&format!(
                        "The bank amount is now {}, and Keep cannot keep a link with a different \
                         amount. Update the amount to the bank amount, or unlink",
                        dollars(-amount)
                    )));
                }
            }
            let rows = sql.execute(
                &format!(
                    "UPDATE plaid_transaction_reconciliation
                     SET review_reason = NULL, review_metadata_json = NULL, updated_at = ?3
                     WHERE id = ?1 AND book_id = ?2 AND {}",
                    input.action.allowed_from()
                ),
                &params![row.id, book_id, now],
            )?;
            changed(rows, input.action)?;
        }
        Action::Unlink => {
            let rows = sql.execute(
                &format!(
                    "UPDATE plaid_transaction_reconciliation SET {UNLINK_SET}
                     WHERE id = ?1 AND book_id = ?2 AND {}",
                    input.action.allowed_from()
                ),
                &params![row.id, book_id, now],
            )?;
            changed(rows, input.action)?;
            if let Some(previous) = row.matched_transaction_id {
                release_previous(sql, access, previous, &row, now, actor)?;
            }
        }
    }
    Ok(row.id)
}

/// `resolveReconciliation`: applies one decision and returns the row as it
/// now stands, with its candidates.
pub(crate) fn resolve(
    database: &Database,
    access: &BookAccess<'_, Write>,
    link: Link,
    input: &ReconcileInput,
    actor: i32,
) -> Result<Value, ReconcileError> {
    let book_id = access.book_id();
    let now = now_millis();
    let row_id = database.transaction(|tx| apply(tx, access, link, input, actor, now))?;
    let row = load_row(database, link.link_id, row_id, book_id, false)?
        .ok_or(ReconcileError::NotFound("Updated row not found"))?;
    load_item(database, &row, link.account_id, book_id)
}

/// POST `sync/accounts/[id]/reconcile`. The link is checked before the body
/// is read. After the decision commits, the TypeSafe observation is saved.
pub(crate) async fn resolve_route(
    State(state): State<AppState>,
    Path((raw_book_id, raw_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult {
    const FAILURE: &str = "Failed to resolve reconciliation";
    let action_started_at = platform::timestamp();
    let book =
        authenticate_book(&state, &headers, &raw_book_id, AccessLevel::Write, FAILURE).await?;
    let access = book.write()?;
    let link_id = database_id(finite_path_id(&raw_id, INVALID_LINK_ID)?, FAILURE)?;
    let link = reconcilable_link(&state.database, book.book_id(), link_id)
        .map_err(|cause| cause.into_api(FAILURE))?;
    let body = parse_json_body(&body, FAILURE)?;
    let input = validate_reconcile(&body)?;
    let item = resolve(&state.database, &access, link, &input, book.user_id())
        .map_err(|cause| cause.into_api(FAILURE))?;
    let observation = Observation::parse(body.get("typesafe"));
    record_decision(
        &state.database,
        &access,
        &input,
        &observation,
        action_started_at,
    );
    Ok(Json(item))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn review_changes_lists_the_fields_that_the_bank_changed() {
        let metadata = json!({
            "event": "modified",
            "previous": {
                "date": "2026-11-04", "amountCents": 880.0, "name": "WSJ",
                "merchantName": null, "categoryPrimary": "A", "categoryDetailed": null,
            },
            "incoming": {
                "date": "2026-11-04", "amountCents": 880.0, "name": "D J*WSJ",
                "merchantName": "D J", "categoryPrimary": "A", "categoryDetailed": null,
            },
        })
        .to_string();
        assert_eq!(
            review_changes(Some(&metadata)),
            json!([
                { "field": "name", "previous": "WSJ", "incoming": "D J*WSJ" },
                { "field": "merchantName", "previous": null, "incoming": "D J" },
            ])
        );
    }

    #[test]
    fn review_changes_is_empty_without_a_modification() {
        assert_eq!(review_changes(None), json!([]));
        assert_eq!(review_changes(Some("not json")), json!([]));
        let removed = json!({ "event": "removed", "previous": {}, "incoming": {} }).to_string();
        assert_eq!(review_changes(Some(&removed)), json!([]));
        // A field that the incoming values leave out was kept, not changed.
        let kept = json!({
            "event": "modified",
            "previous": { "originalDescription": "OLD" },
            "incoming": {},
        })
        .to_string();
        assert_eq!(review_changes(Some(&kept)), json!([]));
    }

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
