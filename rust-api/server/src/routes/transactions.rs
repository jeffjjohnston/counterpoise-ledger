//! The transaction register and transaction CRUD.

use crate::{
    book_auth::{AccessLevel, authenticate_book},
    book_scope::{
        Account, BalancedSplits, BookAccess, InBook, Payee, ProvedInvestmentSplits, ProvedSplits,
        RecurringRule, Security, SplitAccount, Write, resolve_payee, row_in_book, rows_in_book,
        split_accounts,
    },
    db_scope::write_transaction,
    error::{ApiError, ApiResult, error, internal_error},
    platform,
    state::AppState,
    transaction_input::{
        CreateTransaction, InvestmentSplitInput, ListQuery, UpdateTransaction, expected_updated_at,
        validate_create, validate_list_query, validate_update,
    },
    validation::{
        database_integer, first_query_values, is_js_whitespace, parse_int_auto_radix,
        parse_json_body,
    },
};
use axum::{
    Json,
    body::Bytes,
    extract::{Path, RawQuery, State},
    http::{HeaderMap, StatusCode},
};
use chrono::{DateTime, NaiveDateTime, SecondsFormat};
use ledger_core::accounting::{
    InvestmentAction, InvestmentActionInput, is_valid_date_string, validate_investment_actions,
    validate_investment_split_payload,
};
use ledger_db::Database;
use ledger_db::folds::fold_option;
use ledger_db::locks::FOR_UPDATE;
use ledger_db::lots::{LotPair, collect_affected_pairs, rebuild_lots_for_pairs};
use ledger_db::sql::{in_integers, json_array, json_rows};
use ledger_db::store::{self, Builder, Sql, params};
use serde::{Serialize, Serializer};
use serde_json::{Value, json, to_value};
use std::collections::{HashMap, HashSet};

const INVALID_DATE: &str = "Date must be in YYYY-MM-DD format";
const UNBALANCED: &str = "Transaction splits must sum to zero (debits = credits)";
const FOREIGN_SPLIT_ACCOUNT: &str = "One or more split accounts do not belong to this book";
const CHECK_NUMBER_ACCOUNT: &str =
    "Check number can only be set for transactions involving bank accounts";
const INVESTMENT_SPLITS_REQUIRED: &str = "Investment transactions require investmentSplits";
const INVESTMENT_ACCOUNT_KEPT: &str = "The splits must keep each investment account of the investment splits; send investmentSplits to change it";
const CONFLICT: &str = "Another user changed this transaction. Showing the latest version.";
const NOT_FOUND: &str = "Transaction not found";

/// `effectiveDateSql`: a floating transaction resolves to today in the
/// session time zone.
use ledger_db::sql::EFFECTIVE_DATE;

const DEFAULT_LIMIT: i64 = 100;

fn bad_request(message: &'static str) -> ApiError {
    error(StatusCode::BAD_REQUEST, message)
}

/// `new Date()`: JavaScript timestamps have millisecond precision. The
/// conflict check compares `updated_at` at that precision.
pub(crate) fn now_millis() -> NaiveDateTime {
    DateTime::from_timestamp_millis(platform::now().timestamp_millis())
        .expect("current time is in range")
        .naive_utc()
}

pub(crate) fn serialize_timestamp<S: Serializer>(
    value: &NaiveDateTime,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(&value.and_utc().to_rfc3339_opts(SecondsFormat::Millis, true))
}

// ---------------------------------------------------------------------------
// The full transaction, as `findFirst({ with: { payee, splits: { account },
// investmentSplits: { security, account } } })` returns it.
// ---------------------------------------------------------------------------

const TRANSACTION_COLUMNS: &str = "id, book_id, date, description, check_number, notes, payee_id,
    is_reconciled, is_floating, recurring_rule_id, created_by, updated_by, created_at, updated_at";

#[derive(ledger_db::store::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
struct TransactionRow {
    id: i32,
    book_id: i32,
    date: String,
    description: Option<String>,
    check_number: Option<String>,
    notes: Option<String>,
    payee_id: Option<i32>,
    is_reconciled: bool,
    is_floating: bool,
    recurring_rule_id: Option<i32>,
    created_by: Option<i32>,
    updated_by: Option<i32>,
    #[serde(serialize_with = "serialize_timestamp")]
    created_at: NaiveDateTime,
    #[serde(serialize_with = "serialize_timestamp")]
    updated_at: NaiveDateTime,
}

#[derive(ledger_db::store::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PayeeRow {
    pub(crate) id: i32,
    book_id: i32,
    name: String,
    #[serde(serialize_with = "serialize_timestamp")]
    created_at: NaiveDateTime,
}

#[derive(ledger_db::store::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
struct SplitRow {
    id: i32,
    book_id: i32,
    transaction_id: i32,
    account_id: i32,
    amount: i32,
}

#[derive(ledger_db::store::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
struct InvestmentSplitRow {
    id: i32,
    book_id: i32,
    transaction_id: i32,
    account_id: Option<i32>,
    security_id: i32,
    action: String,
    shares_micros: i64,
    price_micros: i64,
    fees_cents: i32,
    split_numerator: Option<i32>,
    split_denominator: Option<i32>,
}

#[derive(ledger_db::store::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AccountRow {
    pub(crate) id: i32,
    book_id: i32,
    name: String,
    #[serde(rename = "type")]
    account_type: String,
    subtype: Option<String>,
    pub(crate) parent_id: Option<i32>,
    is_active: bool,
    is_favorite: bool,
    is_investment_cash: bool,
    icon: Option<String>,
    #[serde(serialize_with = "serialize_timestamp")]
    created_at: NaiveDateTime,
    #[serde(serialize_with = "serialize_timestamp")]
    updated_at: NaiveDateTime,
}

#[derive(ledger_db::store::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
struct SecurityRow {
    id: i32,
    book_id: i32,
    name: String,
    symbol: String,
    security_type: String,
    fetch_prices: bool,
    fixed_price_micros: Option<i64>,
    #[serde(serialize_with = "serialize_timestamp")]
    created_at: NaiveDateTime,
}

#[derive(Serialize)]
struct SplitJson<'a> {
    #[serde(flatten)]
    split: &'a SplitRow,
    account: Option<&'a AccountRow>,
}

#[derive(Serialize)]
struct InvestmentSplitJson<'a> {
    #[serde(flatten)]
    split: &'a InvestmentSplitRow,
    security: Option<&'a SecurityRow>,
    account: Option<&'a AccountRow>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TransactionJson<'a> {
    #[serde(flatten)]
    transaction: &'a TransactionRow,
    payee: Option<&'a PayeeRow>,
    splits: Vec<SplitJson<'a>>,
    investment_splits: Vec<InvestmentSplitJson<'a>>,
}

/// Loads the full transactions of this book with these IDs, in the order of
/// `ids`. A relational query has no ORDER BY for its children. Rust returns
/// them in ID order, which is their insertion order. An ID that is not a
/// transaction of this book gives no value. All the queries run on `sql`,
/// so a caller in a transaction gets one snapshot.
pub(crate) fn load_transactions(
    sql: &impl Sql,
    book_id: i32,
    ids: &[i32],
) -> Result<Vec<Value>, store::Error> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let query = format!(
        "SELECT {TRANSACTION_COLUMNS} FROM transactions WHERE book_id = ?1 AND id {}",
        in_integers("?2")
    );
    let transactions: Vec<TransactionRow> =
        sql.query(&query, &params![book_id, json_array(ids)])?;
    let payee_ids: Vec<i32> = transactions
        .iter()
        .filter_map(|transaction| transaction.payee_id)
        .collect();
    let payees: HashMap<i32, PayeeRow> = sql
        .query::<PayeeRow>(
            &format!(
                "SELECT id, book_id, name, created_at FROM payees WHERE id {in1}",
                in1 = in_integers("?1")
            ),
            &params![json_array(&payee_ids)],
        )?
        .into_iter()
        .map(|payee| (payee.id, payee))
        .collect();
    let splits: Vec<SplitRow> = sql.query(
        &format!(
            "SELECT id, book_id, transaction_id, account_id, amount FROM transaction_splits
         WHERE transaction_id {in1} ORDER BY id",
            in1 = in_integers("?1")
        ),
        &params![json_array(ids)],
    )?;
    let investment_splits: Vec<InvestmentSplitRow> = sql.query(
        &format!(
            "SELECT id, book_id, transaction_id, account_id, security_id, action, shares_micros,
                price_micros, fees_cents, split_numerator, split_denominator
         FROM investment_splits WHERE transaction_id {in1} ORDER BY id",
            in1 = in_integers("?1")
        ),
        &params![json_array(ids)],
    )?;
    let account_ids: Vec<i32> = splits
        .iter()
        .map(|split| split.account_id)
        .chain(
            investment_splits
                .iter()
                .filter_map(|split| split.account_id),
        )
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let accounts: HashMap<i32, AccountRow> = sql
        .query::<AccountRow>(
            &format!(
                "SELECT id, book_id, name, type AS account_type, subtype, parent_id, is_active,
                is_favorite, is_investment_cash, icon, created_at, updated_at
         FROM accounts WHERE id {in1}",
                in1 = in_integers("?1")
            ),
            &params![json_array(&account_ids)],
        )?
        .into_iter()
        .map(|account| (account.id, account))
        .collect();
    let security_ids: Vec<i32> = investment_splits
        .iter()
        .map(|split| split.security_id)
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let securities: HashMap<i32, SecurityRow> = sql
        .query::<SecurityRow>(
            &format!(
                "SELECT id, book_id, name, symbol, security_type, fetch_prices, fixed_price_micros,
                created_at
         FROM securities WHERE id {in1}",
                in1 = in_integers("?1")
            ),
            &params![json_array(&security_ids)],
        )?
        .into_iter()
        .map(|security| (security.id, security))
        .collect();

    let mut splits_by_transaction: HashMap<i32, Vec<SplitJson>> = HashMap::new();
    for split in &splits {
        splits_by_transaction
            .entry(split.transaction_id)
            .or_default()
            .push(SplitJson {
                split,
                account: accounts.get(&split.account_id),
            });
    }
    let mut investment_by_transaction: HashMap<i32, Vec<InvestmentSplitJson>> = HashMap::new();
    for split in &investment_splits {
        investment_by_transaction
            .entry(split.transaction_id)
            .or_default()
            .push(InvestmentSplitJson {
                split,
                security: securities.get(&split.security_id),
                account: split.account_id.and_then(|id| accounts.get(&id)),
            });
    }
    let mut by_id: HashMap<i32, Value> = transactions
        .iter()
        .map(|transaction| {
            let value = to_value(TransactionJson {
                transaction,
                payee: transaction.payee_id.and_then(|id| payees.get(&id)),
                splits: splits_by_transaction
                    .remove(&transaction.id)
                    .unwrap_or_default(),
                investment_splits: investment_by_transaction
                    .remove(&transaction.id)
                    .unwrap_or_default(),
            })
            .expect("transaction serializes");
            (transaction.id, value)
        })
        .collect();
    Ok(ids.iter().filter_map(|id| by_id.remove(id)).collect())
}

fn load_transaction(sql: &impl Sql, book_id: i32, id: i32) -> Result<Option<Value>, store::Error> {
    Ok(load_transactions(sql, book_id, &[id])?.pop())
}

/// `parseInt(id)` with no radix. NaN or a value outside the int4 range makes
/// the Node query fail, and the route returns its 500 message.
fn transaction_path_id(raw: &str, failure: &'static str) -> Result<i32, ApiError> {
    parse_int_auto_radix(raw)
        .and_then(|id| i32::try_from(id).ok())
        .ok_or_else(|| error(StatusCode::INTERNAL_SERVER_ERROR, failure))
}

// ---------------------------------------------------------------------------
// GET /transactions: the register
// ---------------------------------------------------------------------------

/// `TransactionFilters` after every ID has reached an integer column.
struct Filters {
    account_ids: Option<Vec<i32>>,
    payee_id: Option<i32>,
    recurring_rule_id: Option<i32>,
    start_date: Option<String>,
    end_date: Option<String>,
}

fn database_ids(ids: &[i64], failure: &'static str) -> Result<Vec<i32>, ApiError> {
    ids.iter()
        .map(|id| database_integer(*id, failure))
        .collect()
}

impl Filters {
    /// Converts every ID, as one query that binds all of them would.
    fn from_query(
        account_ids: Option<&Vec<i64>>,
        query: &ListQuery,
        failure: &'static str,
    ) -> Result<Self, ApiError> {
        Ok(Self {
            account_ids: account_ids
                .map(|ids| database_ids(ids, failure))
                .transpose()?,
            payee_id: query
                .payee_id
                .map(|id| database_integer(id, failure))
                .transpose()?,
            recurring_rule_id: query
                .recurring_rule_id
                .map(|id| database_integer(id, failure))
                .transpose()?,
            start_date: query.start_date.clone(),
            end_date: query.end_date.clone(),
        })
    }

    /// `buildTransactionFilters`: the FROM clause and the WHERE clause. The
    /// account filter is the only condition on another table.
    fn push_from_where(&self, builder: &mut Builder, book_id: i32) {
        builder.push(" FROM transactions t");
        if self.account_ids.is_some() {
            builder.push(" JOIN transaction_splits s ON s.transaction_id = t.id");
        }
        builder.push(" WHERE t.book_id = ").push_bind(book_id);
        if let Some(ids) = &self.account_ids {
            builder.push(" AND s.account_id ");
            builder.push_in_integers(ids);
        }
        if let Some(start) = &self.start_date {
            builder
                .push(format!(" AND {EFFECTIVE_DATE} >= "))
                .push_bind(start.clone());
        }
        if let Some(end) = &self.end_date {
            builder
                .push(format!(" AND {EFFECTIVE_DATE} <= "))
                .push_bind(end.clone());
        }
        if let Some(payee_id) = self.payee_id {
            builder.push(" AND t.payee_id = ").push_bind(payee_id);
        }
        // Always with the book condition: recurring_rule_id has no composite
        // constraint, so another book's row can point at this rule.
        if let Some(rule_id) = self.recurring_rule_id {
            builder
                .push(" AND t.recurring_rule_id = ")
                .push_bind(rule_id);
        }
    }

    fn count_expression(&self) -> &'static str {
        if self.account_ids.is_some() {
            "SELECT cast(count(DISTINCT t.id) as integer)"
        } else {
            "SELECT cast(count(*) as integer)"
        }
    }
}

#[derive(ledger_db::store::FromRow)]
struct PageRow {
    id: i32,
    date: String,
    is_floating: bool,
}

/// `REGISTER_ORDER` read as a strict "sorts ahead of" (`>`) or "sorts below"
/// (`<`) the anchor: a later or earlier effective date, then the floating
/// flag, then the ID.
fn push_position(builder: &mut Builder, operator: &str, anchor: &PageRow) {
    builder
        .push(format!(" AND ({EFFECTIVE_DATE} {operator} "))
        .push_bind(anchor.date.clone())
        .push(format!(" OR ({EFFECTIVE_DATE} = "))
        .push_bind(anchor.date.clone())
        .push(format!(" AND t.is_floating {operator} "))
        .push_bind(anchor.is_floating)
        .push(format!(") OR ({EFFECTIVE_DATE} = "))
        .push_bind(anchor.date.clone())
        .push(" AND t.is_floating = ")
        .push_bind(anchor.is_floating)
        .push(format!(" AND t.id {operator} "))
        .push_bind(anchor.id)
        .push("))");
}

pub(crate) async fn list_transactions(
    State(state): State<AppState>,
    Path(raw_book_id): Path<String>,
    RawQuery(raw_query): RawQuery,
    headers: HeaderMap,
) -> ApiResult {
    const FAILURE: &str = "Failed to fetch transactions";
    let book =
        authenticate_book(&state, &headers, &raw_book_id, AccessLevel::Read, FAILURE).await?;
    let access = book.read();
    let query = validate_list_query(&first_query_values(raw_query.as_deref()))?;
    let sql = &*state.database;
    fn db_error(cause: impl std::fmt::Display) -> ApiError {
        internal_error(cause, FAILURE)
    }

    // The route refuses an out-of-book balance account outright, rather than
    // answering about nothing.
    let balance_account: Option<InBook<Account>> = match query.balance_account_id {
        None => None,
        Some(id) => {
            let id = database_integer(id, FAILURE)?;
            Some(
                row_in_book(sql, &access, id)
                    .map_err(db_error)?
                    .ok_or_else(|| bad_request("Invalid balanceAccountId"))?,
            )
        }
    };
    let filtered_account_ids = query
        .account_ids
        .clone()
        .or_else(|| query.account_id.map(|id| vec![id]));

    let mut limit = query.limit.unwrap_or(DEFAULT_LIMIT);
    let offset = query.offset.unwrap_or(0);
    // "0" is the route's sentinel for every row. Only that spelling counts.
    let every_row = query.limit_param.as_deref() == Some("0");

    // Widen the page so that the ensured transaction is on it. This runs
    // before the ownership checks of the page select, so an ID outside the
    // int4 range fails here first.
    if let Some(ensure_id) = query.ensure_id
        && offset == 0
        && !every_row
    {
        let ensure_id = database_integer(ensure_id, FAILURE)?;
        let target: Option<PageRow> = sql
            .query_optional(
                &format!(
                    "SELECT t.id, {EFFECTIVE_DATE} AS date, t.is_floating FROM transactions t
             WHERE t.id = ?1 AND t.book_id = ?2"
                ),
                &params![ensure_id, book.book_id()],
            )
            .map_err(db_error)?;
        if let Some(target) = target {
            let filters = Filters::from_query(filtered_account_ids.as_ref(), &query, FAILURE)?;
            let mut count = Builder::new(filters.count_expression());
            filters.push_from_where(&mut count, book.book_id());
            push_position(&mut count, ">", &target);
            let position: i32 = count.query_row(sql).map_err(db_error)?;
            limit = limit.max(i64::from(position) + 1);
        }
    }

    // selectTransactionPage: the ownership checks, in its order. The SQL
    // below also binds the book, so a proof here gives the 400 answer; it
    // does not guard the read.
    if let Some(payee_id) = query.payee_id {
        let payee_id = database_integer(payee_id, FAILURE)?;
        row_in_book::<Payee, _>(sql, &access, payee_id)
            .map_err(db_error)?
            .ok_or_else(|| bad_request("Invalid payeeId"))?;
    }
    if let Some(rule_id) = query.recurring_rule_id {
        let rule_id = database_integer(rule_id, FAILURE)?;
        row_in_book::<RecurringRule, _>(sql, &access, rule_id)
            .map_err(db_error)?
            .ok_or_else(|| bad_request("Invalid recurringRuleId"))?;
    }
    if let Some(ids) = &filtered_account_ids {
        rows_in_book::<Account, _>(sql, &access, &database_ids(ids, FAILURE)?)
            .map_err(db_error)?
            .ok_or_else(|| bad_request("One or more accounts do not belong to this book"))?;
    }
    let filters = Filters::from_query(filtered_account_ids.as_ref(), &query, FAILURE)?;

    let mut page = Builder::new(format!(
        "SELECT t.id, {EFFECTIVE_DATE} AS date, t.is_floating"
    ));
    filters.push_from_where(&mut page, book.book_id());
    if filters.account_ids.is_some() {
        // A transaction with splits on two filtered accounts appears once.
        page.push(" GROUP BY t.id, t.date, t.is_floating");
    }
    page.push(format!(
        " ORDER BY {EFFECTIVE_DATE} DESC, t.is_floating DESC, t.id DESC"
    ));
    // A null limit also skips the offset, as in selectTransactionPage.
    if !every_row {
        // SQLite refuses LIMIT NULL; -1 is no limit.
        page.push(" LIMIT COALESCE(")
            .push_bind(limit)
            .push(", -1) OFFSET COALESCE(")
            .push_bind(offset)
            .push(", 0)");
    }
    let rows: Vec<PageRow> = page.query(sql).map_err(db_error)?;

    let total_count = if query.include_meta {
        let mut count = Builder::new(filters.count_expression());
        filters.push_from_where(&mut count, book.book_id());
        count.query_row::<i32>(sql).map_err(db_error)?
    } else {
        0
    };

    let ids: Vec<i32> = rows.iter().map(|row| row.id).collect();
    let transactions = load_transactions(sql, book.book_id(), &ids).map_err(db_error)?;

    if !query.include_meta {
        return Ok(Json(Value::Array(transactions)));
    }

    let mut starting_balance = 0;
    if let (Some(account_ids), Some(oldest)) = (&filters.account_ids, rows.last()) {
        // Everything the register prints below the page: the inverse of
        // REGISTER_ORDER. The date filters do not apply.
        let account_id = balance_account.map_or(account_ids[0], |account| account.id());
        let mut balance = Builder::new(
            "SELECT cast(coalesce(sum(s.amount), 0) as integer) FROM transaction_splits s
             JOIN transactions t ON t.id = s.transaction_id WHERE t.book_id = ",
        );
        balance
            .push_bind(book.book_id())
            .push(" AND s.account_id = ")
            .push_bind(account_id);
        push_position(&mut balance, "<", oldest);
        if let Some(payee_id) = filters.payee_id {
            balance.push(" AND t.payee_id = ").push_bind(payee_id);
        }
        starting_balance = balance.query_row::<i32>(sql).map_err(db_error)?;
    }

    Ok(Json(json!({
        "transactions": transactions,
        "startingBalance": starting_balance,
        "totalCount": total_count,
    })))
}

// ---------------------------------------------------------------------------
// GET /transactions/[id]
// ---------------------------------------------------------------------------

pub(crate) async fn get_transaction(
    State(state): State<AppState>,
    Path((raw_book_id, raw_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> ApiResult {
    const FAILURE: &str = "Failed to fetch transaction";
    let book =
        authenticate_book(&state, &headers, &raw_book_id, AccessLevel::Read, FAILURE).await?;
    let id = transaction_path_id(&raw_id, FAILURE)?;
    load_transaction(&*state.database, book.book_id(), id)
        .map_err(|cause| internal_error(cause, FAILURE))?
        .map(Json)
        .ok_or_else(|| error(StatusCode::NOT_FOUND, NOT_FOUND))
}

// ---------------------------------------------------------------------------
// Shared write rules
// ---------------------------------------------------------------------------

fn has_subtype(accounts: &[SplitAccount], subtype: &str) -> bool {
    accounts
        .iter()
        .any(|account| account.subtype.as_deref() == Some(subtype))
}

/// `deriveInvestmentAccountId`: the brokerage account for a buy or a sell,
/// or the parent of the investment-cash leg for a dividend, capital gain, or
/// fee. `None` for a dividend paid into a plain bank account.
fn derive_investment_account(accounts: &[SplitAccount]) -> Option<InBook<Account>> {
    if let Some(direct) = accounts
        .iter()
        .find(|account| account.subtype.as_deref() == Some("investment"))
    {
        return Some(direct.account);
    }
    accounts
        .iter()
        .find(|account| account.is_investment_cash)
        .and_then(|account| account.investment_parent)
}

/// First-seen order without repeats, as `[...new Set(ids)]`.
fn unique_in_order(ids: impl IntoIterator<Item = i32>) -> Vec<i32> {
    let mut seen = HashSet::new();
    ids.into_iter().filter(|id| seen.insert(*id)).collect()
}

const FOREIGN_SECURITY: &str = "One or more investment split securities do not belong to this book";

/// The investment-split checks that follow the account checks in both
/// createTransaction and updateTransaction. An empty list passes.
fn prove_investment_splits<'a>(
    sql: &impl Sql,
    access: &BookAccess<'_, Write>,
    splits: &'a [InvestmentSplitInput],
    accounts: &[SplitAccount],
    failure: &'static str,
) -> Result<ProvedInvestmentSplits<'a>, ApiError> {
    let account = derive_investment_account(accounts);
    if splits.is_empty() {
        return ProvedInvestmentSplits::new(access, splits, &[], account)
            .ok_or_else(|| bad_request(FOREIGN_SECURITY));
    }
    if !splits
        .iter()
        .all(|split| validate_investment_split_payload(&split.raw))
    {
        return Err(bad_request("Invalid investment split values"));
    }
    let actions: Vec<InvestmentActionInput> = splits
        .iter()
        .map(|split| InvestmentActionInput {
            action: split.action,
            shares_micros: split.shares_micros,
            price_micros: split.price_micros,
            fees_cents: split.fees_cents.unwrap_or(0),
            split_numerator: split.split_numerator,
            split_denominator: split.split_denominator,
        })
        .collect();
    if !validate_investment_actions(&actions) {
        return Err(bad_request("Invalid investment actions"));
    }
    let security_ids = database_ids(
        &splits
            .iter()
            .map(|split| split.security_id)
            .collect::<Vec<_>>(),
        failure,
    )?;
    let securities = rows_in_book::<Security, _>(sql, access, &security_ids)
        .map_err(|cause| internal_error(cause, failure))?
        .ok_or_else(|| bad_request(FOREIGN_SECURITY))?;
    let trades = splits
        .iter()
        .any(|split| matches!(split.action, InvestmentAction::Buy | InvestmentAction::Sell));
    if trades && !has_subtype(accounts, "investment") {
        return Err(bad_request(
            "Investment splits require a transaction split on an investment account",
        ));
    }
    ProvedInvestmentSplits::new(access, splits, &securities, account)
        .ok_or_else(|| bad_request(FOREIGN_SECURITY))
}

pub(crate) fn database_error<E: std::fmt::Display>(
    failure: &'static str,
) -> impl Fn(E) -> ApiError {
    move |cause| internal_error(cause, failure)
}

/// The proofs and the access must be of one book. One request has one book,
/// so a mismatch is a defect: answer 500 and write nothing.
pub(crate) fn same_book(
    access: &BookAccess<'_, Write>,
    proof_book_id: i32,
    failure: &'static str,
) -> Result<i32, ApiError> {
    if proof_book_id == access.book_id() {
        Ok(proof_book_id)
    } else {
        tracing::error!(
            access_book_id = access.book_id(),
            proof_book_id,
            "Split proof of another book"
        );
        Err(error(StatusCode::INTERNAL_SERVER_ERROR, failure))
    }
}

/// Inserts the double-entry splits. `ProvedSplits` holds only balanced
/// splits on accounts of this book.
fn insert_splits(
    sql: &impl Sql,
    access: &BookAccess<'_, Write>,
    transaction_id: i32,
    splits: &ProvedSplits,
    failure: &'static str,
) -> Result<(), ApiError> {
    let book_id = same_book(access, splits.book_id(), failure)?;
    sql.execute(
        &format!(
            "INSERT INTO transaction_splits (transaction_id, account_id, amount, book_id) {}",
            json_rows(&["?1", "#0", "#1", "?2"], "?3")
        ),
        &params![transaction_id, book_id, splits.json_rows()],
    )
    .map_err(database_error(failure))?;
    Ok(())
}

/// Inserts the investment splits. A stock split has no account. PostgreSQL
/// rejects a fee or a ratio outside the int4 range, and so does this.
fn insert_investment_splits(
    sql: &impl Sql,
    access: &BookAccess<'_, Write>,
    transaction_id: i32,
    splits: &ProvedInvestmentSplits<'_>,
    failure: &'static str,
) -> Result<(), ApiError> {
    let book_id = same_book(access, splits.book_id(), failure)?;
    let optional = |value: Option<i64>| {
        value
            .map(|value| database_integer(value, failure))
            .transpose()
    };
    let investment_account_id = splits.account().map(|account| account.id());
    let rows = splits
        .splits()
        .iter()
        .map(|(split, security)| {
            Ok((
                (split.action != InvestmentAction::Split)
                    .then_some(investment_account_id)
                    .flatten(),
                security.id(),
                to_value(split.action).expect("action serializes"),
                split.shares_micros,
                split.price_micros,
                database_integer(split.fees_cents.unwrap_or(0), failure)?,
                optional(split.split_numerator)?,
                optional(split.split_denominator)?,
            ))
        })
        .collect::<Result<Vec<_>, ApiError>>()?;
    sql.execute(
        &format!(
            "INSERT INTO investment_splits (transaction_id, account_id, security_id, action,
           shares_micros, price_micros, fees_cents, split_numerator, split_denominator, book_id)
         {}",
            json_rows(
                &["?1", "#0", "#1", "#2", "#3", "#4", "#5", "#6", "#7", "?2"],
                "?3"
            )
        ),
        &params![transaction_id, book_id, json_array(&rows)],
    )
    .map_err(database_error(failure))?;
    Ok(())
}

/// `assertUnchanged`: lock the row and compare its `updated_at` with the
/// value the caller loaded, at millisecond precision.
fn assert_unchanged(
    sql: &impl Sql,
    book_id: i32,
    transaction_id: i32,
    expected: Option<i64>,
    failure: &'static str,
) -> Result<(), ApiError> {
    let Some(expected) = expected else {
        return Ok(());
    };
    let current: Option<NaiveDateTime> = sql
        .query_optional(
            &format!(
                "SELECT updated_at FROM transactions WHERE id = ?1 AND book_id = ?2{FOR_UPDATE}"
            ),
            &params![transaction_id, book_id],
        )
        .map_err(database_error(failure))?;
    let current = current.ok_or_else(|| error(StatusCode::NOT_FOUND, NOT_FOUND))?;
    if current.and_utc().timestamp_millis() != expected {
        return Err(error(StatusCode::CONFLICT, CONFLICT));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// POST /transactions
// ---------------------------------------------------------------------------

fn create(
    database: &Database,
    access: &BookAccess<'_, Write>,
    input: &CreateTransaction,
    failure: &'static str,
) -> Result<i32, ApiError> {
    if !is_valid_date_string(&input.date) {
        return Err(bad_request(INVALID_DATE));
    }
    let check_number = input
        .check_number
        .as_deref()
        .map(|value| value.trim_matches(is_js_whitespace))
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    let balanced = BalancedSplits::new(&input.splits).ok_or_else(|| bad_request(UNBALANCED))?;
    let account_ids = database_ids(
        &input
            .splits
            .iter()
            .map(|split| split.account_id)
            .collect::<Vec<_>>(),
        failure,
    )?;
    let accounts = split_accounts(database, access, &account_ids)
        .map_err(database_error(failure))?
        .ok_or_else(|| bad_request(FOREIGN_SPLIT_ACCOUNT))?;
    if check_number.is_some() && !has_subtype(&accounts, "bank") {
        return Err(bad_request(CHECK_NUMBER_ACCOUNT));
    }
    let investment_splits = input.investment_splits.as_deref().unwrap_or_default();
    if has_subtype(&accounts, "investment") && investment_splits.is_empty() {
        return Err(bad_request(INVESTMENT_SPLITS_REQUIRED));
    }
    let investment_splits =
        prove_investment_splits(database, access, investment_splits, &accounts, failure)?;
    let splits = ProvedSplits::new(access, balanced, &accounts)
        .ok_or_else(|| bad_request(FOREIGN_SPLIT_ACCOUNT))?;

    write_transaction(database, failure, |tx| {
        let payee = match &input.payee_name {
            Some(name) => resolve_payee(tx, access, name).map_err(database_error(failure))?,
            None => None,
        };
        let now = now_millis();
        let description = input
            .description
            .as_deref()
            .filter(|value| !value.is_empty());
        let transaction_id: i32 = tx
            .query_row(
                "INSERT INTO transactions (date, description, notes, check_number, is_floating,
           is_reconciled, payee_id, book_id, created_by, updated_by, created_at, updated_at,
           description_fold, notes_fold, check_number_fold)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, ?10, ?10, ?11, ?12, ?13) RETURNING id",
                // `description || null`, but `notes ?? null`: an empty description
                // is stored as NULL and an empty note is kept.
                &params![
                    &input.date,
                    description,
                    input.notes.as_deref(),
                    &check_number,
                    input.is_floating.unwrap_or(false),
                    input.is_reconciled.unwrap_or(false),
                    payee.map(|payee| payee.id()),
                    access.book_id(),
                    access.user_id(),
                    now,
                    fold_option(description),
                    fold_option(input.notes.as_deref()),
                    fold_option(check_number.as_deref()),
                ],
            )
            .map_err(database_error(failure))?;
        insert_splits(tx, access, transaction_id, &splits, failure)?;
        if !investment_splits.is_empty() {
            insert_investment_splits(tx, access, transaction_id, &investment_splits, failure)?;
            // Lots are derived state: rebuild every pair this write can change.
            let book_id = access.book_id();
            let pairs = collect_affected_pairs(tx, book_id, transaction_id)
                .map_err(database_error(failure))?;
            rebuild_lots_for_pairs(tx, book_id, &pairs).map_err(database_error(failure))?;
        }
        Ok(transaction_id)
    })
}

pub(crate) async fn create_transaction(
    State(state): State<AppState>,
    Path(raw_book_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult {
    const FAILURE: &str = "Failed to create transaction";
    let book =
        authenticate_book(&state, &headers, &raw_book_id, AccessLevel::Write, FAILURE).await?;
    let access = book.write()?;
    let input = validate_create(&parse_json_body(&body, FAILURE)?)?;
    let id = create(&state.database, &access, &input, FAILURE)?;
    let created = load_transaction(&*state.database, book.book_id(), id)
        .map_err(database_error(FAILURE))?
        .ok_or_else(|| error(StatusCode::INTERNAL_SERVER_ERROR, FAILURE))?;
    state.analytics.capture_event(
        book.user_id(),
        "transaction_created",
        Some(json!({
            "bookId": book.book_id(),
            "hasInvestmentSplits": input.investment_splits.as_ref().is_some_and(|splits| !splits.is_empty()),
            "splitCount": input.splits.len(),
        })),
    );
    Ok(Json(created))
}

// ---------------------------------------------------------------------------
// PUT /transactions/[id]
// ---------------------------------------------------------------------------

fn existing_split_account_ids(
    sql: &impl Sql,
    book_id: i32,
    transaction_id: i32,
    failure: &'static str,
) -> Result<Vec<i32>, ApiError> {
    sql.query(
        "SELECT account_id FROM transaction_splits
         WHERE transaction_id = ?1 AND book_id = ?2 ORDER BY id",
        &params![transaction_id, book_id],
    )
    .map_err(database_error(failure))
}

fn update(
    database: &Database,
    access: &BookAccess<'_, Write>,
    transaction_id: i32,
    input: &UpdateTransaction,
    failure: &'static str,
) -> Result<(), ApiError> {
    let book_id = access.book_id();
    if input
        .date
        .as_deref()
        .is_some_and(|date| !is_valid_date_string(date))
    {
        return Err(bad_request(INVALID_DATE));
    }
    // `Some(None)` clears the check number.
    let check_number: Option<Option<String>> = input.check_number.as_deref().map(|value| {
        Some(value.trim_matches(is_js_whitespace))
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    });
    let has_check_number = matches!(check_number, Some(Some(_)));
    let balanced = input
        .splits
        .as_deref()
        .map(|splits| BalancedSplits::new(splits).ok_or_else(|| bad_request(UNBALANCED)))
        .transpose()?;

    let mut account_ids: Option<Vec<i32>> = None;
    let mut existing_split_count: Option<usize> = None;
    match &input.splits {
        Some(splits) if !splits.is_empty() => {
            account_ids = Some(unique_in_order(database_ids(
                &splits
                    .iter()
                    .map(|split| split.account_id)
                    .collect::<Vec<_>>(),
                failure,
            )?));
        }
        _ if input.investment_splits.is_some() => {
            let existing = existing_split_account_ids(database, book_id, transaction_id, failure)?;
            existing_split_count = Some(existing.len());
            account_ids = Some(unique_in_order(existing));
        }
        _ => {}
    }
    if has_check_number && account_ids.is_none() {
        account_ids = Some(unique_in_order(existing_split_account_ids(
            database,
            book_id,
            transaction_id,
            failure,
        )?));
    }
    let investment_splits = input.investment_splits.as_deref();
    if investment_splits.is_some_and(|splits| !splits.is_empty())
        && input.splits.is_none()
        && existing_split_count.is_some_and(|count| count < 2)
    {
        return Err(bad_request(crate::transaction_input::UPDATE_SPLITS));
    }

    let mut accounts = Vec::new();
    match account_ids.as_deref() {
        Some(ids) if !ids.is_empty() => {
            accounts = split_accounts(database, access, ids)
                .map_err(database_error(failure))?
                .ok_or_else(|| bad_request(FOREIGN_SPLIT_ACCOUNT))?;
            if has_check_number && !has_subtype(&accounts, "bank") {
                return Err(bad_request(CHECK_NUMBER_ACCOUNT));
            }
            if has_subtype(&accounts, "investment") && investment_splits.is_none_or(<[_]>::is_empty)
            {
                let existing: bool = database
                    .query_row(
                        "SELECT EXISTS (SELECT 1 FROM investment_splits
                       WHERE transaction_id = ?1 AND book_id = ?2)",
                        &params![transaction_id, book_id],
                    )
                    .map_err(database_error(failure))?;
                if !existing {
                    return Err(bad_request(INVESTMENT_SPLITS_REQUIRED));
                }
            }
        }
        _ if has_check_number => return Err(bad_request(CHECK_NUMBER_ACCOUNT)),
        _ => {}
    }
    // New splits without investmentSplits keep the stored investment splits.
    // Each of them names an investment account, and the new splits must still
    // hold that account, directly or through its investment cash child (a
    // dividend has only the cash leg). Otherwise the ledger moves to another
    // account while the shares and the lots stay in the old one. The stored
    // splits are read after the conflict check, inside the write transaction.
    let retained_accounts: Option<HashSet<i32>> = (investment_splits.is_none()
        && input
            .splits
            .as_ref()
            .is_some_and(|splits| splits.len() >= 2))
    .then(|| {
        accounts
            .iter()
            .flat_map(|account| {
                let parent = account
                    .is_investment_cash
                    .then_some(account.investment_parent)
                    .flatten();
                std::iter::once(account.account.id()).chain(parent.map(|parent| parent.id()))
            })
            .collect()
    });
    let proved_investment_splits = prove_investment_splits(
        database,
        access,
        investment_splits.unwrap_or_default(),
        &accounts,
        failure,
    )?;
    // Fewer than two splits leaves the stored splits as they are. Two or
    // more replace them, and `accounts` holds the accounts of these splits.
    let splits = match balanced {
        Some(balanced)
            if input
                .splits
                .as_ref()
                .is_some_and(|splits| splits.len() >= 2) =>
        {
            Some(
                ProvedSplits::new(access, balanced, &accounts)
                    .ok_or_else(|| bad_request(FOREIGN_SPLIT_ACCOUNT))?,
            )
        }
        _ => None,
    };

    write_transaction(database, failure, |tx| {
        assert_unchanged(
            tx,
            book_id,
            transaction_id,
            input.expected_updated_at,
            failure,
        )?;
        if let Some(retained) = &retained_accounts {
            let kept: Vec<i32> = tx
                .query(
                    "SELECT DISTINCT account_id FROM investment_splits
               WHERE transaction_id = ?1 AND book_id = ?2 AND account_id IS NOT NULL",
                    &params![transaction_id, book_id],
                )
                .map_err(database_error(failure))?;
            if kept.iter().any(|account_id| !retained.contains(account_id)) {
                return Err(bad_request(INVESTMENT_ACCOUNT_KEPT));
            }
        }
        // Collected before the splits change: a replaced account or security
        // still needs a rebuild once its investment splits are gone.
        let prior_pairs =
            collect_affected_pairs(tx, book_id, transaction_id).map_err(database_error(failure))?;
        let payee: Option<Option<InBook<Payee>>> = match &input.payee_name {
            None => None,
            Some(None) => Some(None),
            Some(Some(name)) => {
                Some(resolve_payee(tx, access, name).map_err(database_error(failure))?)
            }
        };

        let mut set = Builder::new("UPDATE transactions SET updated_at = ");
        set.push_bind(now_millis())
            .push(", updated_by = ")
            .push_bind(access.user_id());
        if let Some(date) = &input.date {
            set.push(", date = ").push_bind(date.clone());
        }
        if let Some(description) = &input.description {
            set.push(", description = ").push_bind(description.clone());
            set.push(", description_fold = ")
                .push_bind(ledger_db::folds::fold(description));
        }
        if let Some(notes) = &input.notes {
            set.push(", notes = ").push_bind(notes.clone());
            set.push(", notes_fold = ")
                .push_bind(fold_option(notes.as_deref()));
        }
        if let Some(check_number) = &check_number {
            set.push(", check_number = ")
                .push_bind(check_number.clone());
            set.push(", check_number_fold = ")
                .push_bind(fold_option(check_number.as_deref()));
        }
        if let Some(payee) = payee {
            set.push(", payee_id = ")
                .push_bind(payee.map(|payee| payee.id()));
        }
        if let Some(is_reconciled) = input.is_reconciled {
            set.push(", is_reconciled = ").push_bind(is_reconciled);
        }
        if let Some(is_floating) = input.is_floating {
            set.push(", is_floating = ").push_bind(is_floating);
        }
        set.push(" WHERE id = ")
            .push_bind(transaction_id)
            .push(" AND book_id = ")
            .push_bind(book_id);
        set.execute(tx).map_err(database_error(failure))?;

        if let Some(splits) = &splits {
            tx.execute(
                "DELETE FROM transaction_splits WHERE transaction_id = ?1 AND book_id = ?2",
                &params![transaction_id, book_id],
            )
            .map_err(database_error(failure))?;
            insert_splits(tx, access, transaction_id, splits, failure)?;
        }
        if investment_splits.is_some() {
            tx.execute(
                "DELETE FROM investment_splits WHERE transaction_id = ?1 AND book_id = ?2",
                &params![transaction_id, book_id],
            )
            .map_err(database_error(failure))?;
            if !proved_investment_splits.is_empty() {
                insert_investment_splits(
                    tx,
                    access,
                    transaction_id,
                    &proved_investment_splits,
                    failure,
                )?;
            }
        }
        // A date change alone reorders FIFO, so the rebuild always runs.
        let mut pairs: Vec<LotPair> = prior_pairs;
        pairs.extend(
            collect_affected_pairs(tx, book_id, transaction_id).map_err(database_error(failure))?,
        );
        rebuild_lots_for_pairs(tx, book_id, &pairs).map_err(database_error(failure))?;
        Ok(())
    })
}

/// The transaction as it was before the update, for `diffTransactionFields`.
struct ExistingTransaction {
    date: String,
    description: Option<String>,
    notes: Option<String>,
    check_number: Option<String>,
    is_reconciled: bool,
    payee_name: Option<String>,
    splits: Vec<(i32, i32)>,
}

fn load_existing(
    sql: &impl Sql,
    book_id: i32,
    transaction_id: i32,
) -> Result<Option<ExistingTransaction>, store::Error> {
    type Row = (
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        bool,
        Option<String>,
    );
    let row: Option<Row> = sql.query_optional(
        "SELECT t.date, t.description, t.notes, t.check_number, t.is_reconciled, p.name
         FROM transactions t LEFT JOIN payees p ON p.id = t.payee_id
         WHERE t.id = ?1 AND t.book_id = ?2",
        &params![transaction_id, book_id],
    )?;
    let Some((date, description, notes, check_number, is_reconciled, payee_name)) = row else {
        return Ok(None);
    };
    let splits = sql.query(
        "SELECT account_id, amount FROM transaction_splits WHERE transaction_id = ?1 ORDER BY id",
        &params![transaction_id],
    )?;
    Ok(Some(ExistingTransaction {
        date,
        description,
        notes,
        check_number,
        is_reconciled,
        payee_name,
        splits,
    }))
}

/// `diffTransactionFields`: which fields the body changes. The body values
/// are compared as sent, before any trim.
fn diff_transaction_fields(
    existing: &ExistingTransaction,
    body: &UpdateTransaction,
) -> (Vec<&'static str>, bool) {
    let mut changed = Vec::new();
    if body
        .date
        .as_ref()
        .is_some_and(|date| *date != existing.date)
    {
        changed.push("date");
    }
    if body
        .description
        .as_ref()
        .is_some_and(|description| Some(description) != existing.description.as_ref())
    {
        changed.push("description");
    }
    if body
        .notes
        .as_ref()
        .is_some_and(|notes| notes.as_ref() != existing.notes.as_ref())
    {
        changed.push("notes");
    }
    if body
        .check_number
        .as_ref()
        .is_some_and(|check| Some(check) != existing.check_number.as_ref())
    {
        changed.push("checkNumber");
    }
    if body
        .is_reconciled
        .is_some_and(|reconciled| reconciled != existing.is_reconciled)
    {
        changed.push("isReconciled");
    }
    if let Some(payee_name) = &body.payee_name {
        let old = existing.payee_name.as_deref().unwrap_or("").to_lowercase();
        let new = payee_name.as_deref().unwrap_or("").to_lowercase();
        if old != new {
            changed.push("payeeName");
        }
    }
    let mut splits_accounts_changed = false;
    if let Some(splits) = &body.splits {
        let mut old_accounts: Vec<i64> = existing
            .splits
            .iter()
            .map(|(account, _)| i64::from(*account))
            .collect();
        let mut new_accounts: Vec<i64> = splits.iter().map(|split| split.account_id).collect();
        old_accounts.sort_unstable();
        new_accounts.sort_unstable();
        splits_accounts_changed = old_accounts != new_accounts;
        let key = |pairs: Vec<String>| {
            let mut pairs = pairs;
            pairs.sort();
            pairs.join(",")
        };
        let old_key = key(existing
            .splits
            .iter()
            .map(|(account, amount)| format!("{account}:{amount}"))
            .collect());
        let new_key = key(splits
            .iter()
            .map(|split| format!("{}:{}", split.account_id, split.amount))
            .collect());
        if old_key != new_key {
            changed.push("splits");
        }
    }
    (changed, splits_accounts_changed)
}

pub(crate) async fn update_transaction(
    State(state): State<AppState>,
    Path((raw_book_id, raw_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult {
    const FAILURE: &str = "Failed to update transaction";
    let book =
        authenticate_book(&state, &headers, &raw_book_id, AccessLevel::Write, FAILURE).await?;
    let access = book.write()?;
    let input = validate_update(&parse_json_body(&body, FAILURE)?)?;
    // The route reads the transaction for the analytics diff before it
    // updates, so an unusable ID fails at that read.
    let id = transaction_path_id(&raw_id, FAILURE)?;
    let existing =
        load_existing(&*state.database, book.book_id(), id).map_err(database_error(FAILURE))?;
    update(&state.database, &access, id, &input, FAILURE)?;
    let updated = load_transaction(&*state.database, book.book_id(), id)
        .map_err(database_error(FAILURE))?
        .ok_or_else(|| error(StatusCode::NOT_FOUND, NOT_FOUND))?;
    let (fields_changed, splits_accounts_changed) = existing
        .as_ref()
        .map(|existing| diff_transaction_fields(existing, &input))
        .unwrap_or_default();
    state.analytics.capture_event(
        book.user_id(),
        "transaction_updated",
        Some(json!({
            "bookId": book.book_id(),
            "fieldsChanged": fields_changed,
            "splitsAccountsChanged": splits_accounts_changed,
        })),
    );
    Ok(Json(updated))
}

// ---------------------------------------------------------------------------
// DELETE /transactions/[id]
// ---------------------------------------------------------------------------

/// Deletes a transaction, its splits, and its investment splits. Returns
/// whether a row was deleted. The Plaid sweep commits either way.
///
/// Not a plain row delete. Five things happen inside one transaction:
///
/// 0. When the caller sent `expectedUpdatedAt`, compare it with the row's
///    `updated_at`. A stale value answers 409 before anything below runs
///    (`assert_unchanged`).
/// 1. Collect the affected (account, security) pairs BEFORE the delete.
///    Investment splits cascade away with the transaction, so this is the
///    last point their pairs can be read.
/// 2. Reset the Plaid reconciliation rows that point at this transaction to
///    `pending`. The foreign key is `ON DELETE SET NULL`: it clears the id but
///    leaves `resolution_status` at `matched`, and that combination hides the
///    row from the reconciliation queue forever.
/// 3. Sweep for a row stranded by a race with a concurrent auto-match. If
///    auto-match claims the row after step 2 but before this delete commits,
///    the delete waits on the foreign key until auto-match commits, and
///    `ON DELETE SET NULL` then leaves the row at `matched` with a NULL id.
///    Mutation testing found that removing step 2 or step 3 alone left the
///    row `pending` in every test, each step masking the other's absence.
/// 4. Rebuild the lots of the collected pairs, in the same transaction, so
///    no reader sees the transaction gone and its lots still there.
fn delete(
    database: &Database,
    access: &BookAccess<'_, Write>,
    transaction_id: i32,
    expected: Option<i64>,
    failure: &'static str,
) -> Result<bool, ApiError> {
    let book_id = access.book_id();
    write_transaction(database, failure, |tx| {
        assert_unchanged(tx, book_id, transaction_id, expected, failure)?;
        // Investment splits cascade away with the transaction, so their pairs
        // must be read first.
        let pairs =
            collect_affected_pairs(tx, book_id, transaction_id).map_err(database_error(failure))?;
        let now = now_millis();
        tx.execute(
            "UPDATE plaid_transaction_reconciliation
         SET resolution_status = 'pending', matched_transaction_id = NULL, resolved_at = NULL,
             updated_at = ?1
         WHERE matched_transaction_id = ?2 AND book_id = ?3",
            &params![now, transaction_id, book_id],
        )
        .map_err(database_error(failure))?;
        let deleted: Option<i32> = tx
            .query_optional(
                "DELETE FROM transactions WHERE id = ?1 AND book_id = ?2 RETURNING id",
                &params![transaction_id, book_id],
            )
            .map_err(database_error(failure))?;
        // A row that a concurrent auto-match claimed after the reset above is
        // left at matched with a NULL ID by ON DELETE SET NULL.
        tx.execute(
            "UPDATE plaid_transaction_reconciliation
         SET resolution_status = 'pending', resolved_at = NULL, updated_at = ?1
         WHERE book_id = ?2 AND resolution_status = 'matched' AND matched_transaction_id IS NULL",
            &params![now, book_id],
        )
        .map_err(database_error(failure))?;
        rebuild_lots_for_pairs(tx, book_id, &pairs).map_err(database_error(failure))?;
        Ok(deleted.is_some())
    })
}

pub(crate) async fn delete_transaction(
    State(state): State<AppState>,
    Path((raw_book_id, raw_id)): Path<(String, String)>,
    RawQuery(raw_query): RawQuery,
    headers: HeaderMap,
) -> ApiResult {
    const FAILURE: &str = "Failed to delete transaction";
    let book =
        authenticate_book(&state, &headers, &raw_book_id, AccessLevel::Write, FAILURE).await?;
    let access = book.write()?;
    let expected = first_query_values(raw_query.as_deref())
        .get("expectedUpdatedAt")
        .map(|value| expected_updated_at(Some(value)))
        .transpose()?;
    let id = transaction_path_id(&raw_id, FAILURE)?;
    if !delete(&state.database, &access, id, expected, FAILURE)? {
        return Err(error(StatusCode::NOT_FOUND, NOT_FOUND));
    }
    state.analytics.capture_event(
        book.user_id(),
        "transaction_deleted",
        Some(json!({ "bookId": book.book_id() })),
    );
    Ok(Json(json!({ "success": true })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transaction_input::SplitInput;

    fn existing() -> ExistingTransaction {
        ExistingTransaction {
            date: "2025-01-01".into(),
            description: None,
            notes: Some("n".into()),
            check_number: None,
            is_reconciled: false,
            payee_name: Some("IKEA".into()),
            splits: vec![(10, -500), (2, 500)],
        }
    }

    #[test]
    fn diff_matches_the_node_analytics_fields() {
        let body = UpdateTransaction {
            date: Some("2025-01-01".into()),
            description: Some(String::new()),
            notes: Some(None),
            payee_name: Some(Some("ikea".into())),
            is_reconciled: Some(true),
            splits: Some(vec![
                SplitInput {
                    account_id: 2,
                    amount: 400,
                },
                SplitInput {
                    account_id: 10,
                    amount: -400,
                },
            ]),
            ..UpdateTransaction::default()
        };
        assert_eq!(
            diff_transaction_fields(&existing(), &body),
            (
                vec!["description", "notes", "isReconciled", "splits"],
                false
            )
        );
        let moved = UpdateTransaction {
            splits: Some(vec![
                SplitInput {
                    account_id: 3,
                    amount: 500,
                },
                SplitInput {
                    account_id: 10,
                    amount: -500,
                },
            ]),
            payee_name: Some(None),
            ..UpdateTransaction::default()
        };
        assert_eq!(
            diff_transaction_fields(&existing(), &moved),
            (vec!["payeeName", "splits"], true)
        );
    }

    #[test]
    fn investment_account_prefers_the_brokerage_then_the_cash_parent() {
        let account = |id, subtype: Option<&str>, cash, parent: Option<i32>| SplitAccount {
            account: InBook::unchecked(id, 1),
            subtype: subtype.map(str::to_owned),
            is_investment_cash: cash,
            investment_parent: parent.map(|parent| InBook::unchecked(parent, 1)),
        };
        let derived = |accounts: &[SplitAccount]| {
            derive_investment_account(accounts).map(|account| account.id())
        };
        assert_eq!(
            derived(&[
                account(1, Some("cash"), true, Some(7)),
                account(2, Some("investment"), false, None),
            ]),
            Some(2)
        );
        assert_eq!(derived(&[account(1, Some("cash"), true, Some(7))]), Some(7));
        assert_eq!(derived(&[account(1, Some("bank"), false, None)]), None);
    }

    #[test]
    fn unique_ids_keep_first_seen_order() {
        assert_eq!(unique_in_order([3, 1, 3, 2, 1]), vec![3, 1, 2]);
    }
}
