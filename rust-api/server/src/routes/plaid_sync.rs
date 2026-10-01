//! The Plaid transaction sync and the auto-matcher.
//!
//! A sync holds a session advisory lock on its connection for its whole
//! life, so the scheduled sync and a manual sync cannot fetch the same Plaid
//! pages twice. Every query of the sync runs on that connection.

use crate::validation::{parse_pg_int4, pg_float8_to_int4};
use crate::{
    analytics::PostHogCapture,
    book_auth::{AccessLevel, authenticate_book},
    db_scope::with_transaction,
    error::{ApiResult, error, error_owned},
    plaid::{Plaid, is_configuration_error},
    routes::{
        sync::{finite_path_id, iso_timestamp},
        transactions::now_millis,
    },
    state::AppState,
    validation::{js_number, js_number_string, js_round, js_string, js_stringify},
};
use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
};
use chrono::{Days, Local, NaiveDate, NaiveDateTime};
use ledger_db::engine::{Db, DbArguments, DbConnection};
use ledger_db::locks::{SessionLock, with_session_lock};
use ledger_db::sql;
use serde::Serialize;
use serde_json::{Value, json};
use sqlx::FromRow;
use std::collections::{HashMap, HashSet};

const MAX_SYNC_RETRIES: u32 = 2;
const SYNC_PAGE_SIZE: u32 = 250;
const INITIAL_SYNC_DAYS: u32 = 7;
const MUTATION_DURING_PAGINATION: &str = "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION";

/// Why a sync did not complete.
pub(crate) enum SyncError {
    /// `SyncTokenError`: a refusal with its own status.
    Refused(StatusCode, &'static str),
    /// Any other failure. The route reports the message itself.
    Failed(String),
}

impl SyncError {
    pub(crate) fn message(&self) -> String {
        match self {
            Self::Refused(_, message) => (*message).to_owned(),
            Self::Failed(message) => message.clone(),
        }
    }
}

/// The message of a database error, as the PostgreSQL error carries it. A
/// protocol error carries the message of a check that the Rust code does
/// for the database, as `parse_pg_int4`.
fn database_message(cause: &sqlx::Error) -> String {
    if let sqlx::Error::Protocol(message) = cause {
        return message.clone();
    }
    cause
        .as_database_error()
        .map(|error| error.message().to_owned())
        .unwrap_or_else(|| cause.to_string())
}

fn failed(cause: sqlx::Error) -> SyncError {
    SyncError::Failed(database_message(&cause))
}

/// `SyncTokenResult`.
pub(crate) struct SyncResult {
    added: usize,
    modified: usize,
    removed: usize,
    auto_matched: usize,
    last_synced_at: NaiveDateTime,
    pending_count: i32,
    review_count: i32,
}

impl SyncResult {
    pub(crate) fn to_json(&self) -> Value {
        json!({
            "synced": { "added": self.added, "modified": self.modified, "removed": self.removed },
            "autoMatched": self.auto_matched,
            "lastSyncedAt": iso_timestamp(self.last_synced_at),
            "pendingCount": self.pending_count,
            "reviewCount": self.review_count,
        })
    }
}

/// `syncToken`: fetches the new Plaid transactions of one connection and
/// stages them for review. A caller that finds a sync of the connection
/// already running is refused with 409 and does not wait.
pub(crate) async fn sync_token(
    state: &AppState,
    book_id: i32,
    token_id: i32,
) -> Result<SyncResult, SyncError> {
    let plaid = state.plaid.clone();
    let analytics = state.analytics.clone();
    let outcome = with_session_lock(
        &state.pool,
        SessionLock::plaid_sync(token_id),
        move |connection| {
            Box::pin(async move {
                Ok(sync_locked(connection, &plaid, &analytics, book_id, token_id).await)
            })
        },
    )
    .await;
    match outcome {
        Err(cause) => Err(failed(cause)),
        Ok(None) => Err(SyncError::Refused(
            StatusCode::CONFLICT,
            "A sync is already running for this connection",
        )),
        Ok(Some(result)) => result,
    }
}

/// The sync inside the lock. A demo connection is refused before the step
/// that records `last_error`: it is not a failed connection.
async fn sync_locked(
    connection: &mut DbConnection,
    plaid: &Plaid,
    analytics: &PostHogCapture,
    book_id: i32,
    token_id: i32,
) -> Result<SyncResult, SyncError> {
    let token: Option<(bool, String, Option<String>)> = sqlx::query_as(
        "SELECT is_demo, access_token, sync_cursor FROM plaid_tokens
         WHERE id = $1 AND book_id = $2 LIMIT 1",
    )
    .bind(token_id)
    .bind(book_id)
    .fetch_optional(&mut *connection)
    .await
    .map_err(failed)?;
    let Some((is_demo, access_token, cursor)) = token else {
        return Err(SyncError::Refused(StatusCode::NOT_FOUND, "Token not found"));
    };
    if is_demo {
        return Err(SyncError::Refused(
            StatusCode::BAD_REQUEST,
            "This is a demo connection and cannot sync with Plaid",
        ));
    }
    let result = sync_steps(
        connection,
        plaid,
        analytics,
        book_id,
        token_id,
        &access_token,
        cursor,
    )
    .await;
    if let Err(cause) = &result {
        sqlx::query("UPDATE plaid_tokens SET last_error = $2, updated_at = $3 WHERE id = $1")
            .bind(token_id)
            .bind(cause.message())
            .bind(now_millis())
            .execute(&mut *connection)
            .await
            .map_err(failed)?;
    }
    result
}

/// `fetchAllSyncPages`: every page from the stored cursor. Plaid refuses a
/// page when the Item changes during the pagination; the whole fetch then
/// restarts from the stored cursor, at most twice.
async fn fetch_all_pages(
    plaid: &Plaid,
    access_token: &str,
    base_cursor: Option<&str>,
) -> Result<(Vec<Value>, Vec<Value>, Vec<String>, Option<String>), String> {
    let mut attempt = 0;
    loop {
        match fetch_pages_once(plaid, access_token, base_cursor).await {
            Ok(pages) => return Ok(pages),
            Err(message)
                if message.contains(MUTATION_DURING_PAGINATION) && attempt < MAX_SYNC_RETRIES =>
            {
                attempt += 1;
            }
            Err(message) => return Err(message),
        }
    }
}

async fn fetch_pages_once(
    plaid: &Plaid,
    access_token: &str,
    base_cursor: Option<&str>,
) -> Result<(Vec<Value>, Vec<Value>, Vec<String>, Option<String>), String> {
    let mut cursor = base_cursor.map(str::to_owned);
    // The first request of an initial sync asks for a short history.
    let mut bootstrap = base_cursor.is_none_or(str::is_empty);
    let (mut added, mut modified, mut removed) = (Vec::new(), Vec::new(), Vec::new());
    loop {
        let page = plaid
            .fetch_transactions_sync(
                access_token,
                cursor.as_deref(),
                SYNC_PAGE_SIZE,
                bootstrap.then_some(INITIAL_SYNC_DAYS),
            )
            .await?;
        bootstrap = false;
        added.extend(page.added);
        modified.extend(page.modified);
        removed.extend(page.removed);
        cursor = page.next_cursor;
        if !page.has_more {
            return Ok((added, modified, removed, cursor));
        }
    }
}

/// Groups the items by their account, in the order in which each account
/// first appears, as a JavaScript `Map` keeps them. Items of accounts that
/// are not mapped are dropped.
fn group_by_link<'a>(
    items: &'a [Value],
    links: &HashMap<String, i32>,
) -> Vec<(i32, Vec<&'a Value>)> {
    let mut groups: Vec<(i32, Vec<&Value>)> = Vec::new();
    let mut positions: HashMap<i32, usize> = HashMap::new();
    for item in items {
        let account = item["account_id"].as_str().expect("a checked sync item");
        let Some(&link_id) = links.get(account) else {
            continue;
        };
        let position = *positions.entry(link_id).or_insert_with(|| {
            groups.push((link_id, Vec::new()));
            groups.len() - 1
        });
        groups[position].1.push(item);
    }
    groups
}

fn is_pending(item: &Value) -> bool {
    item["pending"].as_bool().expect("a checked sync item")
}

async fn sync_steps(
    connection: &mut DbConnection,
    plaid: &Plaid,
    analytics: &PostHogCapture,
    book_id: i32,
    token_id: i32,
    access_token: &str,
    cursor: Option<String>,
) -> Result<SyncResult, SyncError> {
    let linked: Vec<(i32, String, String)> = sqlx::query_as(
        "SELECT pa.id, pa.plaid_account_id, a.type
         FROM plaid_accounts pa JOIN accounts a ON pa.counterpoise_account_id = a.id
         WHERE pa.token_id = $1 ORDER BY pa.id",
    )
    .bind(token_id)
    .fetch_all(&mut *connection)
    .await
    .map_err(failed)?;
    if linked.is_empty() {
        return Err(SyncError::Refused(
            StatusCode::BAD_REQUEST,
            "No linked accounts found for this token",
        ));
    }
    if linked
        .iter()
        .any(|(_, _, kind)| kind != "asset" && kind != "liability")
    {
        return Err(SyncError::Refused(
            StatusCode::BAD_REQUEST,
            "Only asset or liability Counterpoise accounts can be synchronized with Plaid",
        ));
    }
    let links: HashMap<String, i32> = linked
        .iter()
        .map(|(link_id, plaid_account_id, _)| (plaid_account_id.clone(), *link_id))
        .collect();
    let link_ids: Vec<i32> = linked.iter().map(|(link_id, _, _)| *link_id).collect();

    let is_initial = cursor.as_deref().is_none_or(str::is_empty);
    let (mut added, modified, removed, next_cursor) =
        fetch_all_pages(plaid, access_token, cursor.as_deref())
            .await
            .map_err(SyncError::Failed)?;
    let now = now_millis();
    if is_initial {
        let cutoff = (Local::now().date_naive() - Days::new(INITIAL_SYNC_DAYS.into()))
            .format("%Y-%m-%d")
            .to_string();
        added.retain(|item| item["date"].as_str().expect("a checked sync item") >= cutoff.as_str());
    }

    let added_groups = group_by_link(&added, &links);
    for (link_id, items) in &added_groups {
        for item in items.iter().filter(|item| !is_pending(item)) {
            stage_added(connection, book_id, *link_id, item, now)
                .await
                .map_err(failed)?;
        }
    }
    let modified_groups = group_by_link(&modified, &links);
    for (link_id, items) in &modified_groups {
        for item in items.iter().filter(|item| !is_pending(item)) {
            stage_modified(connection, book_id, *link_id, item, now)
                .await
                .map_err(failed)?;
        }
    }
    if !removed.is_empty() {
        let matches: Vec<(i32, String)> = sqlx::query_as(&format!(
            "SELECT plaid_account_link_id, plaid_transaction_id
             FROM plaid_transaction_reconciliation
             WHERE plaid_account_link_id {in1} AND plaid_transaction_id {in2}
             ORDER BY id",
            in1 = sql::in_integers("$1"),
            in2 = sql::in_texts("$2")
        ))
        .bind(sql::json_array(&link_ids))
        .bind(sql::json_array(&removed))
        .fetch_all(&mut *connection)
        .await
        .map_err(failed)?;
        for (link_id, plaid_transaction_id) in matches {
            stage_removed(connection, link_id, &plaid_transaction_id, now)
                .await
                .map_err(failed)?;
        }
    }

    sqlx::query(
        "UPDATE plaid_tokens SET sync_cursor = $2, last_synced_at = $3, last_error = NULL,
                updated_at = $3
         WHERE id = $1",
    )
    .bind(token_id)
    .bind(&next_cursor)
    .bind(now)
    .execute(&mut *connection)
    .await
    .map_err(failed)?;

    let auto_matched = auto_match(connection, analytics, book_id, &link_ids)
        .await
        .map_err(failed)?;
    let (pending_count, review_count): (i32, i32) = sqlx::query_as(&format!(
        "SELECT
           CAST(COALESCE(SUM(CASE WHEN resolution_status = 'pending' AND review_reason IS NULL
                                  THEN 1 ELSE 0 END), 0) AS integer),
           CAST(COALESCE(SUM(CASE WHEN review_reason IS NOT NULL THEN 1 ELSE 0 END), 0) AS integer)
         FROM plaid_transaction_reconciliation WHERE plaid_account_link_id {in1}",
        in1 = sql::in_integers("$1")
    ))
    .bind(sql::json_array(&link_ids))
    .fetch_one(&mut *connection)
    .await
    .map_err(failed)?;

    let staged = |groups: &[(i32, Vec<&Value>)]| {
        groups
            .iter()
            .map(|(_, items)| items.iter().filter(|item| !is_pending(item)).count())
            .sum()
    };
    Ok(SyncResult {
        added: staged(&added_groups),
        modified: staged(&modified_groups),
        removed: removed.len(),
        auto_matched,
        last_synced_at: now,
        pending_count,
        review_count,
    })
}

// ---------------------------------------------------------------------------
// Staging
// ---------------------------------------------------------------------------

/// A value as Node binds it to a text column: null or a missing value is
/// NULL, a string is kept, and another value is `String(value)`.
fn text(value: Option<&Value>) -> Option<String> {
    match value {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) => Some(text.clone()),
        Some(other) => Some(js_string(other)),
    }
}

/// `value?.[key]` for a parsed JSON value. A string is indexed by position.
fn property(value: Option<&Value>, key: &str) -> Option<Value> {
    match value? {
        Value::Object(object) => object.get(key).cloned(),
        Value::Array(items) => key
            .parse::<usize>()
            .ok()
            .and_then(|index| items.get(index).cloned()),
        Value::String(text) => key
            .parse::<usize>()
            .ok()
            .and_then(|index| text.chars().nth(index))
            .map(|character| Value::String(character.into())),
        _ => None,
    }
}

/// `a ?? b`: null and a missing value give way.
fn either(first: Option<Value>, second: impl FnOnce() -> Option<Value>) -> Option<Value> {
    first.filter(|value| !value.is_null()).or_else(second)
}

/// A field that Plaid may leave out. `None` is a missing field, which Node
/// holds as `undefined`: an insert stores NULL, an update leaves the column
/// alone, and `JSON.stringify` leaves the key out. `Some(None)` is null.
type Optional = Option<Option<String>>;

fn optional(value: Option<&Value>) -> Optional {
    value.map(|value| text(Some(value)))
}

/// `toReconciliationValues`: the columns of one staged row.
struct Staged {
    plaid_transaction_id: String,
    date: String,
    authorized_date: Optional,
    amount_cents: f64,
    name: String,
    merchant_name: Optional,
    original_description: Optional,
    pending: bool,
    pending_transaction_id: Optional,
    iso_currency_code: Optional,
    unofficial_currency_code: Optional,
    category_primary: Option<String>,
    category_detailed: Option<String>,
    raw_json: String,
}

impl Staged {
    fn from_item(item: &Value) -> Self {
        let field = |key: &str| item.get(key);
        let checked = |key: &str| {
            field(key)
                .and_then(Value::as_str)
                .expect("a checked sync item")
                .to_owned()
        };
        let finance = field("personal_finance_category");
        let category = field("category");
        Self {
            plaid_transaction_id: checked("transaction_id"),
            date: checked("date"),
            authorized_date: optional(field("authorized_date")),
            amount_cents: js_round(
                js_number(
                    field("amount")
                        .and_then(|amount| amount.as_number())
                        .expect("a checked sync item"),
                ) * 100.0,
            ),
            name: checked("name"),
            merchant_name: optional(field("merchant_name")),
            original_description: optional(field("original_description")),
            pending: is_pending(item),
            pending_transaction_id: optional(field("pending_transaction_id")),
            iso_currency_code: optional(field("iso_currency_code")),
            unofficial_currency_code: optional(field("unofficial_currency_code")),
            category_primary: text(
                either(property(finance, "primary"), || property(category, "0")).as_ref(),
            ),
            category_detailed: text(
                either(property(finance, "detailed"), || property(category, "1")).as_ref(),
            ),
            raw_json: js_stringify(item),
        }
    }

    /// Whether each optional field was sent, in the order of
    /// `KEPT_WHEN_MISSING`.
    fn present(&self) -> [bool; 6] {
        [
            &self.authorized_date,
            &self.merchant_name,
            &self.original_description,
            &self.pending_transaction_id,
            &self.iso_currency_code,
            &self.unofficial_currency_code,
        ]
        .map(Option::is_some)
    }
}

/// The columns of the optional fields. An update of a staged row sets each
/// one only when Plaid sent its field, as Drizzle skips an undefined value.
const KEPT_WHEN_MISSING: [&str; 6] = [
    "authorized_date",
    "merchant_name",
    "original_description",
    "pending_transaction_id",
    "iso_currency_code",
    "unofficial_currency_code",
];

/// `column = CASE WHEN <sent> THEN <value> ELSE column END` for each
/// optional column. `first` is the parameter number of the first flag, and
/// `value` gives the new value of a column.
fn kept_when_missing(first: usize, table: &str, value: impl Fn(&str) -> String) -> String {
    KEPT_WHEN_MISSING
        .iter()
        .enumerate()
        .map(|(index, column)| {
            format!(
                "{column} = CASE WHEN ${} THEN {} ELSE {table}{column} END",
                first + index,
                value(column)
            )
        })
        .collect::<Vec<_>>()
        .join(", ")
}

const STAGED_COLUMNS: &str = "book_id, plaid_account_link_id, plaid_transaction_id, date,
    authorized_date, amount_cents, name, merchant_name, original_description, pending,
    pending_transaction_id, iso_currency_code, unofficial_currency_code, category_primary,
    category_detailed, raw_json, resolution_status, first_seen_at, last_seen_at, created_at,
    updated_at";
const STAGED_VALUES: &str = "$1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
    $14, $15, $16, 'pending', $17, $17, $17, $17";

/// The amount as the `integer` column stores it. Node sent a float for
/// PostgreSQL to cast.
fn amount_column(staged: &Staged) -> Result<i32, sqlx::Error> {
    pg_float8_to_int4(staged.amount_cents).map_err(sqlx::Error::Protocol)
}

fn bind_staged<'q>(
    query: sqlx::query::Query<'q, Db, DbArguments<'q>>,
    book_id: i32,
    link_id: i32,
    staged: &'q Staged,
    now: NaiveDateTime,
) -> Result<sqlx::query::Query<'q, Db, DbArguments<'q>>, sqlx::Error> {
    Ok(query
        .bind(book_id)
        .bind(link_id)
        .bind(&staged.plaid_transaction_id)
        .bind(&staged.date)
        .bind(staged.authorized_date.clone().flatten())
        .bind(amount_column(staged)?)
        .bind(&staged.name)
        .bind(staged.merchant_name.clone().flatten())
        .bind(staged.original_description.clone().flatten())
        .bind(staged.pending)
        .bind(staged.pending_transaction_id.clone().flatten())
        .bind(staged.iso_currency_code.clone().flatten())
        .bind(staged.unofficial_currency_code.clone().flatten())
        .bind(&staged.category_primary)
        .bind(&staged.category_detailed)
        .bind(&staged.raw_json)
        .bind(now))
}

/// `stageAddedTransactions` for one item. A row already resolved keeps its
/// resolution; any review flag is cleared.
async fn stage_added(
    connection: &mut DbConnection,
    book_id: i32,
    link_id: i32,
    item: &Value,
    now: NaiveDateTime,
) -> Result<(), sqlx::Error> {
    let staged = Staged::from_item(item);
    let optional_columns = kept_when_missing(18, "r.", |column| format!("excluded.{column}"));
    let sql = format!(
        "INSERT INTO plaid_transaction_reconciliation AS r ({STAGED_COLUMNS})
         VALUES ({STAGED_VALUES})
         ON CONFLICT (plaid_account_link_id, plaid_transaction_id) DO UPDATE SET
           date = excluded.date, amount_cents = excluded.amount_cents, name = excluded.name,
           pending = excluded.pending, {optional_columns},
           category_primary = excluded.category_primary,
           category_detailed = excluded.category_detailed, raw_json = excluded.raw_json,
           review_reason = NULL, review_metadata_json = NULL,
           resolution_status = CASE WHEN r.resolution_status IN ('matched', 'created', 'ignored')
                                    THEN r.resolution_status ELSE 'pending' END,
           resolved_at = CASE WHEN r.resolution_status IN ('matched', 'created', 'ignored')
                              THEN r.resolved_at ELSE NULL END,
           last_seen_at = $17, updated_at = $17"
    );
    let mut query = bind_staged(sqlx::query(&sql), book_id, link_id, &staged, now)?;
    for present in staged.present() {
        query = query.bind(present);
    }
    query.execute(&mut *connection).await?;
    Ok(())
}

#[derive(FromRow)]
struct ExistingRow {
    id: i32,
    resolution_status: String,
    review_reason: Option<String>,
    review_metadata_json: Option<String>,
    date: String,
    amount_cents: i32,
    name: String,
    merchant_name: Option<String>,
    original_description: Option<String>,
    category_primary: Option<String>,
    category_detailed: Option<String>,
}

/// The fields that a modification review compares, in the key order of the
/// Node metadata object.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReviewFields<'a> {
    date: &'a str,
    amount_cents: f64,
    name: &'a str,
    // `None` leaves the key out, as `JSON.stringify` leaves out undefined.
    #[serde(skip_serializing_if = "Option::is_none")]
    merchant_name: Option<Option<&'a str>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    original_description: Option<Option<&'a str>>,
    category_primary: Option<&'a str>,
    category_detailed: Option<&'a str>,
}

/// `stageModifiedTransactions` for one item. A modification of a row that is
/// already matched or created is flagged for review with the values before
/// and after it.
async fn stage_modified(
    connection: &mut DbConnection,
    book_id: i32,
    link_id: i32,
    item: &Value,
    now: NaiveDateTime,
) -> Result<(), sqlx::Error> {
    let staged = Staged::from_item(item);
    let existing: Option<ExistingRow> = sqlx::query_as(
        "SELECT id, resolution_status, review_reason, review_metadata_json, date, amount_cents,
                name, merchant_name, original_description, category_primary, category_detailed
         FROM plaid_transaction_reconciliation
         WHERE plaid_account_link_id = $1 AND plaid_transaction_id = $2 LIMIT 1",
    )
    .bind(link_id)
    .bind(&staged.plaid_transaction_id)
    .fetch_optional(&mut *connection)
    .await?;
    let Some(existing) = existing else {
        let sql = format!(
            "INSERT INTO plaid_transaction_reconciliation ({STAGED_COLUMNS})
             VALUES ({STAGED_VALUES})"
        );
        bind_staged(sqlx::query(&sql), book_id, link_id, &staged, now)?
            .execute(&mut *connection)
            .await?;
        return Ok(());
    };
    let flag = matches!(existing.resolution_status.as_str(), "matched" | "created");
    let (review_reason, review_metadata) = if flag {
        let metadata = json!({
            "event": "modified",
            "previous": ReviewFields {
                date: &existing.date,
                amount_cents: f64::from(existing.amount_cents),
                name: &existing.name,
                merchant_name: Some(existing.merchant_name.as_deref()),
                original_description: Some(existing.original_description.as_deref()),
                category_primary: existing.category_primary.as_deref(),
                category_detailed: existing.category_detailed.as_deref(),
            },
            "incoming": ReviewFields {
                date: &staged.date,
                amount_cents: staged.amount_cents,
                name: &staged.name,
                merchant_name: staged.merchant_name.as_ref().map(Option::as_deref),
                original_description: staged.original_description.as_ref().map(Option::as_deref),
                category_primary: staged.category_primary.as_deref(),
                category_detailed: staged.category_detailed.as_deref(),
            },
        });
        (
            Some("plaid_modified".to_owned()),
            Some(js_stringify(&metadata)),
        )
    } else if existing.resolution_status == "pending" {
        (None, existing.review_metadata_json)
    } else {
        (existing.review_reason, existing.review_metadata_json)
    };
    // Parameters 12 to 17 hold the optional values, 18 to 23 whether each
    // was sent.
    let optional_columns = kept_when_missing(18, "", |column| {
        let index = KEPT_WHEN_MISSING
            .iter()
            .position(|name| name == &column)
            .expect("a listed column");
        format!("${}", 12 + index)
    });
    let sql = format!(
        "UPDATE plaid_transaction_reconciliation SET
           date = $2, amount_cents = $3, name = $4, pending = $5,
           category_primary = $6, category_detailed = $7, raw_json = $8, review_reason = $9,
           review_metadata_json = $10, last_seen_at = $11, updated_at = $11, {optional_columns}
         WHERE id = $1"
    );
    let mut query = sqlx::query(&sql)
        .bind(existing.id)
        .bind(&staged.date)
        .bind(amount_column(&staged)?)
        .bind(&staged.name)
        .bind(staged.pending)
        .bind(&staged.category_primary)
        .bind(&staged.category_detailed)
        .bind(&staged.raw_json)
        .bind(review_reason)
        .bind(review_metadata)
        .bind(now);
    for value in [
        &staged.authorized_date,
        &staged.merchant_name,
        &staged.original_description,
        &staged.pending_transaction_id,
        &staged.iso_currency_code,
        &staged.unofficial_currency_code,
    ] {
        query = query.bind(value.clone().flatten());
    }
    for present in staged.present() {
        query = query.bind(present);
    }
    query.execute(&mut *connection).await?;
    Ok(())
}

/// `stageRemovedTransactions` for one staged row that Plaid removed. A row
/// that is pending, matched, or created is flagged for review; an ignored
/// row is left alone.
async fn stage_removed(
    connection: &mut DbConnection,
    link_id: i32,
    plaid_transaction_id: &str,
    now: NaiveDateTime,
) -> Result<(), sqlx::Error> {
    let metadata = js_stringify(&json!({
        "event": "removed",
        "removedTransactionId": plaid_transaction_id,
    }));
    sqlx::query(
        "UPDATE plaid_transaction_reconciliation
         SET review_reason = 'plaid_removed', review_metadata_json = $3, last_seen_at = $4,
             updated_at = $4
         WHERE id = (SELECT id FROM plaid_transaction_reconciliation
                     WHERE plaid_account_link_id = $1 AND plaid_transaction_id = $2 LIMIT 1)
           AND resolution_status IN ('pending', 'matched', 'created')",
    )
    .bind(link_id)
    .bind(plaid_transaction_id)
    .bind(metadata)
    .bind(now)
    .execute(&mut *connection)
    .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Auto-match
// ---------------------------------------------------------------------------

/// The calendar days from one date to another. `None` is NaN: a date that is
/// not a calendar date.
pub(crate) fn day_delta(from: &str, to: &str) -> Option<i64> {
    let parse = |value: &str| NaiveDate::parse_from_str(value, "%Y-%m-%d").ok();
    Some((parse(to)? - parse(from)?).num_days())
}

/// `pickMatchedDate`: the authorization date, unless the posted date is
/// seven or more days after it or there is no authorization date.
pub(crate) fn pick_matched_date<'a>(
    authorized_date: Option<&'a str>,
    posted_date: &'a str,
) -> &'a str {
    match authorized_date {
        Some(authorized)
            if !authorized.is_empty()
                && day_delta(authorized, posted_date).is_some_and(|days| days < 7) =>
        {
            authorized
        }
        _ => posted_date,
    }
}

/// `normalizePayeeName(merchant ?? name).toLowerCase()`: the key of the
/// learned payee map.
pub(crate) use ledger_core::names::merchant_key;

#[derive(FromRow)]
struct PendingRow {
    id: i32,
    plaid_account_link_id: i32,
    date: String,
    authorized_date: Option<String>,
    amount_cents: i32,
    name: String,
    merchant_name: Option<String>,
}

/// `autoMatchPendingTransactions`: matches pending rows to existing
/// transactions through the payees of earlier matches. Returns the number
/// of matches.
async fn auto_match(
    connection: &mut DbConnection,
    analytics: &PostHogCapture,
    book_id: i32,
    link_ids: &[i32],
) -> Result<usize, sqlx::Error> {
    if link_ids.is_empty() {
        return Ok(0);
    }
    let history: Vec<(Option<String>, String, i32)> = sqlx::query_as(
        "SELECT r.merchant_name, r.name, t.payee_id
         FROM plaid_transaction_reconciliation r
         JOIN transactions t ON r.matched_transaction_id = t.id
         WHERE r.book_id = $1 AND r.resolution_status = 'matched' AND t.payee_id IS NOT NULL",
    )
    .bind(book_id)
    .fetch_all(&mut *connection)
    .await?;
    let mut payee_map: HashMap<String, HashSet<i32>> = HashMap::new();
    for (merchant_name, name, payee_id) in history {
        let key = merchant_key(merchant_name.as_deref(), &name);
        if !key.is_empty() {
            payee_map.entry(key).or_default().insert(payee_id);
        }
    }
    if payee_map.is_empty() {
        return Ok(0);
    }

    let pending: Vec<PendingRow> = sqlx::query_as(&format!(
        "SELECT id, plaid_account_link_id, date, authorized_date, amount_cents, name, merchant_name
         FROM plaid_transaction_reconciliation
         WHERE book_id = $1 AND plaid_account_link_id {in2}
           AND resolution_status = 'pending' AND review_reason IS NULL
         ORDER BY id",
        in2 = sql::in_integers("$2")
    ))
    .bind(book_id)
    .bind(sql::json_array(link_ids))
    .fetch_all(&mut *connection)
    .await?;
    if pending.is_empty() {
        return Ok(0);
    }
    let accounts: HashMap<i32, i32> = sqlx::query_as::<_, (i32, Option<i32>)>(&format!(
        "SELECT id, counterpoise_account_id FROM plaid_accounts WHERE id {}",
        sql::in_integers("$1")
    ))
    .bind(sql::json_array(link_ids))
    .fetch_all(&mut *connection)
    .await?
    .into_iter()
    .filter_map(|(link_id, account_id)| account_id.map(|account_id| (link_id, account_id)))
    .collect();
    // Uniqueness is per link, so a transfer can match on both of its links.
    let mut linked: HashMap<i32, HashSet<i32>> = HashMap::new();
    for (link_id, transaction_id) in sqlx::query_as::<_, (i32, i32)>(&format!(
        "SELECT plaid_account_link_id, matched_transaction_id
         FROM plaid_transaction_reconciliation
         WHERE plaid_account_link_id {} AND matched_transaction_id IS NOT NULL",
        sql::in_integers("$1")
    ))
    .bind(sql::json_array(link_ids))
    .fetch_all(&mut *connection)
    .await?
    {
        linked.entry(link_id).or_default().insert(transaction_id);
    }

    let now = now_millis();
    let mut matched = 0;
    for row in &pending {
        let Some(&account_id) = accounts.get(&row.plaid_account_link_id) else {
            continue;
        };
        let key = merchant_key(row.merchant_name.as_deref(), &row.name);
        let Some(payee_ids) = payee_map.get(&key).filter(|_| !key.is_empty()) else {
            continue;
        };
        let payee_ids: Vec<i32> = payee_ids.iter().copied().collect();
        // A candidate within one day of the posted date or of the
        // authorization date. Ordered by date and ID.
        let candidates: Vec<(i32, String)> = sqlx::query_as(&format!(
            "SELECT t.id, {} AS date
             FROM transaction_splits s JOIN transactions t ON s.transaction_id = t.id
             WHERE s.account_id = $1 AND s.amount = $2 AND t.book_id = $3 AND t.payee_id {in4}
             ORDER BY 2, t.id",
            sql::EFFECTIVE_DATE,
            in4 = sql::in_integers("$4")
        ))
        .bind(account_id)
        .bind(-i64::from(row.amount_cents))
        .bind(book_id)
        .bind(sql::json_array(&payee_ids))
        .fetch_all(&mut *connection)
        .await?;
        let already = linked.entry(row.plaid_account_link_id).or_default();
        let dates: Vec<&str> = std::iter::once(row.date.as_str())
            .chain(row.authorized_date.as_deref())
            .collect();
        let valid: Vec<&(i32, String)> = candidates
            .iter()
            .filter(|(id, date)| {
                !already.contains(id)
                    && dates
                        .iter()
                        .any(|anchor| day_delta(anchor, date).is_some_and(|days| days.abs() <= 1))
            })
            .collect();
        let Some(first) = valid.first() else {
            continue;
        };
        let matched_date = pick_matched_date(row.authorized_date.as_deref(), &row.date);
        // The candidate nearest the stamped date. The strict comparison keeps
        // the (date, ID) order as the tiebreak.
        let distance = |date: &str| day_delta(matched_date, date).map(i64::abs);
        let chosen = valid.iter().skip(1).fold(*first, |best, candidate| {
            match (distance(&candidate.1), distance(&best.1)) {
                (Some(candidate_days), Some(best_days)) if candidate_days < best_days => candidate,
                _ => best,
            }
        });
        let (transaction_id, matched_date, reconciliation_id) =
            (chosen.0, matched_date.to_owned(), row.id);
        // Claim the row only while it is still pending and not flagged: a
        // person or a concurrent sync may have resolved it since it was read.
        let claimed = with_transaction(connection, |transaction| {
            Box::pin(async move {
                let claimed: Option<i32> = sqlx::query_scalar(
                    "UPDATE plaid_transaction_reconciliation
                     SET resolution_status = 'matched', matched_transaction_id = $2,
                         resolved_at = $3, updated_at = $3
                     WHERE id = $1 AND resolution_status = 'pending' AND review_reason IS NULL
                     RETURNING id",
                )
                .bind(reconciliation_id)
                .bind(transaction_id)
                .bind(now)
                .fetch_optional(&mut *transaction)
                .await?;
                if claimed.is_some() {
                    sqlx::query(
                        "UPDATE transactions SET is_reconciled = true, is_floating = false,
                                date = $2, updated_at = $3
                         WHERE id = $1",
                    )
                    .bind(transaction_id)
                    .bind(matched_date)
                    .bind(now)
                    .execute(&mut *transaction)
                    .await?;
                }
                Ok(claimed.is_some())
            })
        })
        .await?;
        if claimed {
            linked
                .entry(row.plaid_account_link_id)
                .or_default()
                .insert(transaction_id);
            matched += 1;
        }
    }

    if matched > 0 {
        // A sync has no session user, so the events go to the book owner.
        let owner: Option<i32> = sqlx::query_scalar("SELECT user_id FROM books WHERE id = $1")
            .bind(book_id)
            .fetch_optional(&mut *connection)
            .await?;
        if let Some(owner) = owner {
            for _ in 0..matched {
                analytics.capture_event(
                    owner,
                    "sync_transaction_auto_matched",
                    Some(json!({ "bookId": book_id })),
                );
            }
        }
    }
    Ok(matched)
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

pub(crate) async fn sync_now(
    State(state): State<AppState>,
    Path((raw_book_id, raw_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> ApiResult {
    let book = authenticate_book(
        &state,
        &headers,
        &raw_book_id,
        AccessLevel::Write,
        "Failed to sync token",
    )
    .await?;
    let token_id = finite_path_id(&raw_id, "Invalid token id")?;
    // The PostgreSQL release refused an ID outside the int4 range. The route
    // keeps that refusal and its message.
    let token_id = match i32::try_from(token_id as i64) {
        Ok(id) if f64::from(id) == token_id => id,
        _ => {
            let refused = parse_pg_int4(&js_number_string(token_id))
                .err()
                .unwrap_or_else(|| "Failed to sync token".to_owned());
            return Err(error_owned(StatusCode::BAD_GATEWAY, refused));
        }
    };
    match sync_token(&state, book.book_id, token_id).await {
        Ok(result) => Ok(Json(result.to_json())),
        Err(SyncError::Refused(status, message)) => Err(error(status, message)),
        Err(SyncError::Failed(message)) => {
            tracing::error!(error = %message, "Plaid sync failed");
            let status = if is_configuration_error(&message) {
                StatusCode::INTERNAL_SERVER_ERROR
            } else {
                StatusCode::BAD_GATEWAY
            };
            Err(error_owned(status, message))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_and_rounding_follow_javascript() {
        assert_eq!(js_round(-1234.5), -1234.0);
        assert_eq!(js_round(1234.5), 1235.0);
        assert_eq!(js_round(0.49999999999999994), 0.0);
        assert_eq!(js_round(12.34 * 100.0), 1234.0);
        assert_eq!(day_delta("2025-03-08", "2025-03-10"), Some(2));
        assert_eq!(day_delta("2025-03-10", "2025-03-08"), Some(-2));
        assert_eq!(day_delta("not a date", "2025-03-08"), None);
        assert_eq!(
            pick_matched_date(Some("2025-03-01"), "2025-03-07"),
            "2025-03-01"
        );
        assert_eq!(
            pick_matched_date(Some("2025-03-01"), "2025-03-08"),
            "2025-03-08"
        );
        assert_eq!(pick_matched_date(Some(""), "2025-03-08"), "2025-03-08");
        assert_eq!(pick_matched_date(None, "2025-03-08"), "2025-03-08");
        assert_eq!(merchant_key(Some("  Blue’s   CAFE "), "x"), "blue's cafe");
    }

    #[test]
    fn staged_values_follow_to_reconciliation_values() {
        let item: Value = serde_json::from_str(
            r#"{"transaction_id":"t","account_id":"a","amount":-0.5,"date":"2025-01-02",
                "name":"N","pending":false,"personal_finance_category":{"primary":"FOOD"},
                "category":["Shops","Books"],"merchant_name":5,"authorized_date":null}"#,
        )
        .unwrap();
        let staged = Staged::from_item(&item);
        assert_eq!(staged.amount_cents, -50.0);
        assert_eq!(staged.category_primary.as_deref(), Some("FOOD"));
        assert_eq!(staged.category_detailed.as_deref(), Some("Books"));
        assert_eq!(staged.merchant_name, Some(Some("5".to_owned())));
        // Null is sent; a missing field is not.
        assert_eq!(staged.authorized_date, Some(None));
        assert_eq!(staged.original_description, None);
        assert_eq!(staged.present(), [true, true, false, false, false, false]);
        assert!(
            staged
                .raw_json
                .starts_with(r#"{"transaction_id":"t","account_id":"a","amount":-0.5,"#)
        );
        let text_category: Value = serde_json::from_str(
            r#"{"transaction_id":"t","account_id":"a","amount":1,"date":"d","name":"N","pending":false,
                "personal_finance_category":"x","category":"AB"}"#,
        )
        .unwrap();
        let staged = Staged::from_item(&text_category);
        assert_eq!(staged.category_primary.as_deref(), Some("A"));
        assert_eq!(staged.category_detailed.as_deref(), Some("B"));
    }
}
