//! The recurring rule routes and the processing of due rules.
//!
//! The recurrence math is `ledger_core::recurring`. A scheduled date becomes
//! a transaction date through `occurrence_date`, and the rule advances from
//! the scheduled date, never from the observed one.

use crate::validation::parse_pg_int4;
use crate::{
    book_auth::{AccessLevel, authenticate_book},
    book_scope::{
        Account, BalancedSplits, BookAccess, InBook, Payee, ProvedSplits, RecurringRule, Write,
        resolve_payee, row_in_book, rows_in_book,
    },
    db_scope::write_transaction,
    error::{ApiError, ApiResult, error},
    recurring_input::{
        CreateRule, TemplateSplit, UpdateRule, validate_create, validate_process, validate_update,
    },
    routes::transactions::{
        AccountRow, PayeeRow, database_error, now_millis, same_book, serialize_timestamp,
    },
    state::AppState,
    transaction_input::SplitInput,
    validation::{
        database_integer, first_query_values, js_number, js_string, js_stringify, js_truthy,
        local_today, parse_int_auto_radix, parse_js_number, parse_json_body, query_date_param,
    },
};
use axum::{
    Json,
    body::Bytes,
    extract::{Path, RawQuery, State},
    http::{HeaderMap, StatusCode},
};
use chrono::NaiveDateTime;
use ledger_core::{
    accounting::{is_valid_date_string, validate_splits},
    recurring::{
        RecurrenceConfig, add_days_to_date_string, advance_next_date_to_future, initial_next_date,
        next_date, occurrence_date, schedule_key,
    },
};
use ledger_db::folds::{fold, fold_option};
use ledger_db::sql::{EFFECTIVE_DATE, in_integers, json_array, json_rows};
use ledger_db::store::{self, Builder, params};
use ledger_db::{Database, Sql};
use serde::Serialize;
use serde_json::{Value, json, to_value};
use std::collections::{HashMap, HashSet};

const NOT_FOUND: &str = "Recurring rule not found";
const END_BEFORE_START: &str = "endDate cannot be earlier than startDate";
const UNBALANCED: &str = "Template splits must sum to zero (debits = credits)";
const FOREIGN_ACCOUNT: &str = "One or more template split accounts do not belong to this book";
const NULL_NEXT_DATE: &str = "nextDate cannot be null";
const FEWER_THAN_TWO: &str = "fewer than 2 template splits";
const DOES_NOT_ADVANCE: &str = "schedule does not advance";
/// `createdAt` and `updatedAt` of a projected transaction: `new Date(0)`.
const EPOCH: &str = "1970-01-01T00:00:00.000Z";
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

fn bad_request(message: &'static str) -> ApiError {
    error(StatusCode::BAD_REQUEST, message)
}

fn failed(message: &'static str) -> ApiError {
    error(StatusCode::INTERNAL_SERVER_ERROR, message)
}

/// A schedule error from the core crate: an invalid stored date or a date
/// out of range. Node gets its 500 from a query that fails later.
fn schedule_error(failure: &'static str) -> impl Fn(String) -> ApiError {
    move |cause| {
        tracing::error!(error = %cause, "Rust API recurrence failed");
        failed(failure)
    }
}

// ---------------------------------------------------------------------------
// A rule with its payee and template splits, as
// `findFirst({ with: { payee, templateSplits: { with: { account } } } })`
// returns it.
// ---------------------------------------------------------------------------

const RULE_COLUMNS: &str = "id, book_id, name, frequency, interval, days_of_week, week_of_month,
    days_of_month, start_date, end_date, next_date, business_days_only, auto_create_days_before,
    template_description, payee_id, is_active, created_at";

#[derive(ledger_db::store::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuleRow {
    id: i32,
    book_id: i32,
    name: String,
    frequency: String,
    interval: i32,
    days_of_week: Option<String>,
    week_of_month: Option<String>,
    days_of_month: Option<String>,
    start_date: String,
    end_date: Option<String>,
    next_date: String,
    business_days_only: bool,
    auto_create_days_before: i32,
    template_description: Option<String>,
    payee_id: Option<i32>,
    is_active: bool,
    #[serde(serialize_with = "serialize_timestamp")]
    created_at: NaiveDateTime,
}

#[derive(ledger_db::store::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
struct TemplateSplitRow {
    id: i32,
    book_id: i32,
    recurring_rule_id: i32,
    account_id: i32,
    amount: i32,
}

struct LoadedSplit {
    row: TemplateSplitRow,
    account: Value,
    account_parent_id: Option<i32>,
}

struct LoadedRule {
    rule: RuleRow,
    payee: Value,
    splits: Vec<LoadedSplit>,
}

/// Loads the payee and the template splits of each rule, in the order of
/// `rules`. A relational query has no ORDER BY for its children. Rust
/// returns them in ID order, which is their insertion order.
fn attach(database: &impl Sql, rules: Vec<RuleRow>) -> Result<Vec<LoadedRule>, store::Error> {
    if rules.is_empty() {
        return Ok(Vec::new());
    }
    let rule_ids: Vec<i32> = rules.iter().map(|rule| rule.id).collect();
    let payee_ids: Vec<i32> = rules.iter().filter_map(|rule| rule.payee_id).collect();
    let payees: HashMap<i32, Value> = database
        .query::<PayeeRow>(
            &format!(
                "SELECT id, book_id, name, created_at FROM payees WHERE id {in1}",
                in1 = in_integers("?1")
            ),
            &params![json_array(&payee_ids)],
        )?
        .into_iter()
        .map(|payee| (payee.id, to_value(&payee).expect("payee serializes")))
        .collect();
    let splits: Vec<TemplateSplitRow> = database.query(
        &format!(
        "SELECT id, book_id, recurring_rule_id, account_id, amount FROM recurring_template_splits
         WHERE recurring_rule_id {in1} ORDER BY id",
        in1 = in_integers("?1")
    ),
        &params![json_array(&rule_ids)],
    )?;
    let account_ids: Vec<i32> = splits
        .iter()
        .map(|split| split.account_id)
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let accounts: HashMap<i32, AccountRow> = database
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
    let mut splits_by_rule: HashMap<i32, Vec<LoadedSplit>> = HashMap::new();
    for row in splits {
        let account = accounts.get(&row.account_id);
        splits_by_rule
            .entry(row.recurring_rule_id)
            .or_default()
            .push(LoadedSplit {
                account: account.map_or(Value::Null, |account| {
                    to_value(account).expect("account serializes")
                }),
                account_parent_id: account.and_then(|account| account.parent_id),
                row,
            });
    }
    Ok(rules
        .into_iter()
        .map(|rule| LoadedRule {
            payee: rule
                .payee_id
                .and_then(|id| payees.get(&id).cloned())
                .unwrap_or(Value::Null),
            splits: splits_by_rule.remove(&rule.id).unwrap_or_default(),
            rule,
        })
        .collect())
}

fn rule_json(loaded: &LoadedRule) -> Value {
    let mut value = to_value(&loaded.rule).expect("rule serializes");
    value["payee"] = loaded.payee.clone();
    value["templateSplits"] = loaded
        .splits
        .iter()
        .map(|split| {
            let mut value = to_value(&split.row).expect("template split serializes");
            value["account"] = split.account.clone();
            value
        })
        .collect();
    value
}

fn load_rule(
    database: &impl Sql,
    book_id: i32,
    rule_id: i32,
) -> Result<Option<LoadedRule>, store::Error> {
    let rule: Option<RuleRow> = database.query_optional(
        &format!("SELECT {RULE_COLUMNS} FROM recurring_rules WHERE id = ?1 AND book_id = ?2"),
        &params![rule_id, book_id],
    )?;
    Ok(attach(database, rule.into_iter().collect())?.pop())
}

/// The active rules of a book. Node reads them without an ORDER BY, which
/// gives heap order. Rust uses ID order.
fn load_active_rules(database: &impl Sql, book_id: i32) -> Result<Vec<LoadedRule>, store::Error> {
    let rules = database.query(&format!(
        "SELECT {RULE_COLUMNS} FROM recurring_rules WHERE book_id = ?1 AND is_active ORDER BY id"
    ), &params![book_id])?;
    attach(database, rules)
}

/// `parseInt(id)` with no radix. The caller turns `None` (NaN, or a value
/// outside the int4 range) into the route's 500 message at the first query
/// that Node runs with the ID, because that query is the one that fails.
fn rule_path_id(raw: &str) -> Option<i32> {
    parse_int_auto_radix(raw).and_then(|id| i32::try_from(id).ok())
}

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

/// A day list as the recurrence math reads it. A value that is not an array
/// of integers matches no day in Node; Rust treats it as absent.
fn loose_days(value: &Value) -> Option<Vec<i64>> {
    let Value::Array(items) = value else {
        return None;
    };
    items
        .iter()
        .map(|item| {
            item.as_number()
                .map(js_number)
                .filter(|day| day.is_finite() && day.fract() == 0.0)
                .map(|day| day as i64)
        })
        .collect()
}

/// `weekOfMonth || undefined`. Node reads a number such as 2 with `parseInt`.
fn loose_week_of_month(value: &Value) -> Option<String> {
    js_truthy(value).then(|| js_string(value))
}

/// The interval as the recurrence math reads it. PostgreSQL decides what the
/// column stores: a value that it refuses makes the write fail, so the date
/// computed here is never used.
fn loose_interval(value: &Value) -> i64 {
    match value {
        Value::Number(number) => {
            let number = js_number(number);
            if number.is_finite() && number.fract() == 0.0 {
                number as i64
            } else {
                1
            }
        }
        Value::String(text) => text.trim().parse().unwrap_or(1),
        _ => 1,
    }
}

/// `JSON.parse` of a stored day list. Text that is not JSON makes Node throw.
fn stored_days(text: Option<&str>) -> Result<Option<Vec<i64>>, String> {
    match text.filter(|text| !text.is_empty()) {
        None => Ok(None),
        Some(text) => serde_json::from_str::<Value>(text)
            .map(|value| loose_days(&value))
            .map_err(|cause| format!("Stored day list is not JSON: {cause}")),
    }
}

/// `buildConfig`: the stored columns as the recurrence math reads them. The
/// interval is not clamped, as in Node.
fn stored_config(rule: &RuleRow) -> Result<RecurrenceConfig, String> {
    Ok(RecurrenceConfig {
        frequency: rule.frequency.clone(),
        interval: rule.interval.into(),
        days_of_week: stored_days(rule.days_of_week.as_deref())?,
        week_of_month: rule.week_of_month.clone().filter(|value| !value.is_empty()),
        days_of_month: stored_days(rule.days_of_month.as_deref())?,
    })
}

/// A value for a text column from a `z.any()` field. Drizzle writes
/// `String(value)`.
fn text_value(value: &Value) -> Option<String> {
    (!value.is_null()).then(|| js_string(value))
}

// ---------------------------------------------------------------------------
// Shared write checks
// ---------------------------------------------------------------------------

/// `validateSplits`: each amount an integer in the int4 range, and a zero sum.
fn balanced_amounts(splits: &[TemplateSplit]) -> Option<Vec<i32>> {
    let amounts = splits
        .iter()
        .map(|split| {
            (split.amount.fract() == 0.0
                && (f64::from(i32::MIN)..=f64::from(i32::MAX)).contains(&split.amount))
            .then_some(split.amount as i32)
        })
        .collect::<Option<Vec<_>>>()?;
    validate_splits(
        &amounts
            .iter()
            .map(|amount| i64::from(*amount))
            .collect::<Vec<_>>(),
    )
    .then_some(amounts)
}

/// The template splits as the split proofs take them. `amounts` comes from
/// `balanced_amounts`, in the order of `splits`.
fn template_inputs(splits: &[TemplateSplit], amounts: &[i32]) -> Vec<SplitInput> {
    splits
        .iter()
        .zip(amounts)
        .map(|(split, amount)| SplitInput {
            account_id: split.account_id,
            amount: i64::from(*amount),
        })
        .collect()
}

/// `validateTemplateSplitAccounts`, as a proof: the template splits, each
/// on an account of this book. An ID outside the int4 range makes the Node
/// query fail.
fn prove_template_splits(
    database: &impl Sql,
    access: &BookAccess<'_, Write>,
    splits: &[SplitInput],
    failure: &'static str,
) -> Result<ProvedSplits, ApiError> {
    // `balanced_amounts` passed, so this refusal does not occur.
    let balanced = BalancedSplits::new(splits).ok_or_else(|| bad_request(UNBALANCED))?;
    let ids = splits
        .iter()
        .map(|split| database_integer(split.account_id, failure))
        .collect::<Result<Vec<_>, _>>()?;
    let accounts = rows_in_book::<Account, _>(database, access, &ids)
        .map_err(database_error(failure))?
        .ok_or_else(|| bad_request(FOREIGN_ACCOUNT))?;
    ProvedSplits::on_accounts(access, balanced, &accounts)
        .ok_or_else(|| bad_request(FOREIGN_ACCOUNT))
}

/// `resolvePayeeId`. A finite numeric `payeeId` must name a payee in this
/// book, or it resolves to null. A `payeeName` string that normalizes to a
/// name wins over it. Node binds the ID as text, so a fraction or a value
/// outside the int4 range makes the query fail.
///
/// `recurring_rules.payee_id` has a single-column foreign key, so the proof
/// is what keeps a payee of another book out of a rule.
fn resolve_rule_payee(
    sql: &impl Sql,
    access: &BookAccess<'_, Write>,
    payee_id: Option<&Value>,
    payee_name: Option<&Value>,
) -> Result<Option<InBook<Payee>>, store::Error> {
    let mut fallback = None;
    if let Some(value @ Value::Number(number)) = payee_id
        && js_number(number).is_finite()
    {
        let id = parse_pg_int4(&js_string(value)).map_err(store::Error::Invalid)?;
        fallback = row_in_book::<Payee, _>(sql, access, id)?;
    }
    match payee_name {
        Some(Value::String(name)) => Ok(resolve_payee(sql, access, name)?.or(fallback)),
        _ => Ok(fallback),
    }
}

/// Inserts the template splits of a rule. `ProvedSplits` holds only
/// balanced splits on accounts of this book.
fn insert_template_splits(
    sql: &impl Sql,
    access: &BookAccess<'_, Write>,
    rule_id: i32,
    splits: &ProvedSplits,
    failure: &'static str,
) -> Result<(), ApiError> {
    let book_id = same_book(access, splits.book_id(), failure)?;
    sql.execute(&format!(
        "INSERT INTO recurring_template_splits (recurring_rule_id, account_id, amount, book_id) {}",
        json_rows(&["?1", "#0", "#1", "?2"], "?3")
    ), &params![rule_id, book_id, splits.json_rows()])
    .map_err(database_error(failure))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// GET /recurring and GET /recurring/[id]
// ---------------------------------------------------------------------------

pub(crate) async fn list_rules(
    State(state): State<AppState>,
    Path(raw_book_id): Path<String>,
    headers: HeaderMap,
) -> ApiResult {
    const FAILURE: &str = "Failed to fetch recurring rules";
    let book =
        authenticate_book(&state, &headers, &raw_book_id, AccessLevel::Read, FAILURE).await?;
    // The name breaks a tie between rules that share a nextDate. Node stops
    // there; Rust adds the ID so that the order is stable.
    let rules = state
        .database
        .query(
            &format!(
                "SELECT {RULE_COLUMNS} FROM recurring_rules WHERE book_id = ?1
         ORDER BY is_active DESC, next_date, name, id"
            ),
            &params![book.book_id()],
        )
        .map_err(database_error(FAILURE))?;
    let rules = attach(&state.database, rules).map_err(database_error(FAILURE))?;
    Ok(Json(rules.iter().map(rule_json).collect()))
}

pub(crate) async fn get_rule(
    State(state): State<AppState>,
    Path((raw_book_id, raw_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> ApiResult {
    const FAILURE: &str = "Failed to fetch recurring rule";
    let book =
        authenticate_book(&state, &headers, &raw_book_id, AccessLevel::Read, FAILURE).await?;
    let id = rule_path_id(&raw_id).ok_or_else(|| failed(FAILURE))?;
    load_rule(&state.database, book.book_id(), id)
        .map_err(database_error(FAILURE))?
        .map(|rule| Json(rule_json(&rule)))
        .ok_or_else(|| error(StatusCode::NOT_FOUND, NOT_FOUND))
}

// ---------------------------------------------------------------------------
// POST /recurring
// ---------------------------------------------------------------------------

/// `createRecurringRule`. The checks run in the Node order, so a request
/// with several problems gets the message that Node gives.
fn create(
    database: &Database,
    access: &BookAccess<'_, Write>,
    input: &CreateRule,
    failure: &'static str,
) -> Result<i32, ApiError> {
    if input
        .end_date
        .as_ref()
        .is_some_and(|end_date| *end_date < input.start_date)
    {
        return Err(bad_request(END_BEFORE_START));
    }
    let amounts =
        balanced_amounts(&input.template_splits).ok_or_else(|| bad_request(UNBALANCED))?;
    let splits = prove_template_splits(
        database,
        access,
        &template_inputs(&input.template_splits, &amounts),
        failure,
    )?;

    let loose = &input.loose;
    // `interval || 1`.
    let interval = loose.interval.as_ref().filter(|value| js_truthy(value));
    let config = RecurrenceConfig {
        frequency: input.frequency.clone(),
        interval: interval.map_or(1, loose_interval),
        days_of_week: loose.days_of_week.as_ref().and_then(loose_days),
        week_of_month: loose.week_of_month.as_ref().and_then(loose_week_of_month),
        days_of_month: loose.days_of_month.as_ref().and_then(loose_days),
    };
    let business_days_only = input.business_days_only.unwrap_or(false);
    // Compare the date each occurrence is observed on: a business-day rule's
    // Saturday occurrence is still to come on that Sunday or Monday.
    let next = advance_next_date_to_future(
        &initial_next_date(&input.start_date, &config).map_err(schedule_error(failure))?,
        &config,
        &local_today(),
        business_days_only,
    )
    .map_err(schedule_error(failure))?;

    write_transaction(database, failure, |tx| {
        // Resolved in the transaction, so a payee that `payeeName` creates rolls
        // back with a failed write.
        let payee = resolve_rule_payee(
            tx,
            access,
            loose.payee_id.as_ref(),
            loose.payee_name.as_ref(),
        )
        .map_err(database_error(failure))?;
        let truthy =
            |value: &Option<Value>| value.as_ref().filter(|value| js_truthy(value)).cloned();
        // Node sent the interval as text for PostgreSQL to cast, so the same
        // values are accepted and refused here.
        let interval = parse_pg_int4(&interval.map_or_else(|| "1".to_owned(), js_string))
            .map_err(|message| database_error(failure)(store::Error::Invalid(message)))?;
        let template_description =
            truthy(&loose.template_description).map(|value| js_string(&value));
        let rule_id: i32 = tx.query_row("INSERT INTO recurring_rules (name, frequency, interval, days_of_week, week_of_month,
           days_of_month, start_date, end_date, next_date, business_days_only,
           auto_create_days_before, template_description, payee_id, is_active, book_id,
           created_at, name_fold, template_description_fold)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, true,
           ?14, ?15, ?16, ?17)
         RETURNING id", &params![&input.name, &input.frequency, interval, truthy(&loose.days_of_week).map(|value| js_stringify(&value)), truthy(&loose.week_of_month).map(|value| js_string(&value)), truthy(&loose.days_of_month).map(|value| js_stringify(&value)), &input.start_date, &input.end_date, &next, business_days_only, input.auto_create_days_before.unwrap_or(0) as i32, &template_description, payee.map(|payee| payee.id()), access.book_id(), now_millis(), fold(&input.name), fold_option(template_description.as_deref())])
    .map_err(database_error(failure))?;
        insert_template_splits(tx, access, rule_id, &splits, failure)?;
        Ok(rule_id)
    })
}

pub(crate) async fn create_rule(
    State(state): State<AppState>,
    Path(raw_book_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult {
    const FAILURE: &str = "Failed to create recurring rule";
    let book =
        authenticate_book(&state, &headers, &raw_book_id, AccessLevel::Write, FAILURE).await?;
    let access = book.write()?;
    let input = validate_create(&parse_json_body(&body, FAILURE)?)?;
    let id = create(&state.database, &access, &input, FAILURE)?;
    let created = load_rule(&state.database, book.book_id(), id)
        .map_err(database_error(FAILURE))?
        .ok_or_else(|| failed(FAILURE))?;
    state.analytics.capture_event(
        book.user_id(),
        "recurring_rule_created",
        Some(json!({ "bookId": book.book_id() })),
    );
    Ok(Json(rule_json(&created)))
}

// ---------------------------------------------------------------------------
// PUT /recurring/[id]
// ---------------------------------------------------------------------------

/// The schedule after the update, as `updateRecurringRule` builds it: a
/// field in the request replaces the stored one, and `interval` falls back
/// to the stored value when it is null.
fn updated_config(
    input: &UpdateRule,
    existing: &RuleRow,
    stored: &RecurrenceConfig,
) -> RecurrenceConfig {
    let loose = &input.loose;
    RecurrenceConfig {
        frequency: input
            .frequency
            .clone()
            .unwrap_or_else(|| existing.frequency.clone()),
        interval: loose
            .interval
            .as_ref()
            .filter(|value| !value.is_null())
            .map_or(existing.interval.into(), loose_interval),
        days_of_week: match &loose.days_of_week {
            Some(value) => loose_days(value),
            None => stored.days_of_week.clone(),
        },
        week_of_month: match &loose.week_of_month {
            Some(value) => loose_week_of_month(value),
            None => stored.week_of_month.clone(),
        },
        days_of_month: match &loose.days_of_month {
            Some(value) => loose_days(value),
            None => stored.days_of_month.clone(),
        },
    }
}

/// Adds each field that the request names to the SET list.
fn push_updates(
    set: &mut Builder,
    input: &UpdateRule,
    interval: Option<Option<i32>>,
    next: Option<String>,
    payee: Option<Option<InBook<Payee>>>,
) -> bool {
    let loose = &input.loose;
    let mut any = false;
    let mut column = |set: &mut Builder, name: &str| {
        if any {
            set.push(", ");
        }
        any = true;
        set.push(name).push(" = ");
    };
    if let Some(name) = &input.name {
        column(set, "name");
        set.push_bind(name.clone());
        column(set, "name_fold");
        set.push_bind(fold(name));
    }
    if let Some(frequency) = &input.frequency {
        column(set, "frequency");
        set.push_bind(frequency.clone());
    }
    if let Some(interval) = interval {
        column(set, "interval");
        set.push_bind(interval);
    }
    for (name, value) in [
        ("days_of_week", &loose.days_of_week),
        ("days_of_month", &loose.days_of_month),
    ] {
        if let Some(value) = value {
            column(set, name);
            set.push_bind(js_truthy(value).then(|| js_stringify(value)));
        }
    }
    if let Some(value) = &loose.week_of_month {
        column(set, "week_of_month");
        set.push_bind(js_truthy(value).then(|| js_string(value)));
    }
    if let Some(start_date) = &input.start_date {
        column(set, "start_date");
        set.push_bind(start_date.clone());
    }
    if let Some(end_date) = &input.end_date {
        column(set, "end_date");
        set.push_bind(end_date.clone());
    }
    if let Some(next) = next {
        column(set, "next_date");
        set.push_bind(next);
    }
    if let Some(value) = &loose.template_description {
        let description = text_value(value);
        column(set, "template_description_fold");
        set.push_bind(fold_option(description.as_deref()));
        column(set, "template_description");
        set.push_bind(description);
    }
    if let Some(payee) = payee {
        column(set, "payee_id");
        set.push_bind(payee.map(|payee| payee.id()));
    }
    if let Some(is_active) = input.is_active {
        column(set, "is_active");
        set.push_bind(is_active);
    }
    if let Some(days) = input.auto_create_days_before {
        column(set, "auto_create_days_before");
        set.push_bind(days as i32);
    }
    if let Some(business_days_only) = input.business_days_only {
        column(set, "business_days_only");
        set.push_bind(business_days_only);
    }
    any
}

/// `updateRecurringRule`. It applies only the fields it is given, and it
/// reads the stored rule only when the write needs it.
fn update(
    database: &Database,
    access: &BookAccess<'_, Write>,
    rule_id: Option<i32>,
    input: &UpdateRule,
    failure: &'static str,
) -> Result<(), ApiError> {
    let id = || rule_id.ok_or_else(|| failed(failure));
    let amounts = input
        .template_splits
        .as_deref()
        .map(|splits| balanced_amounts(splits).ok_or_else(|| bad_request(UNBALANCED)))
        .transpose()?;

    // A schedule field in the request is not a change to the schedule: the
    // edit form posts all six on every save. The key comparison below
    // decides.
    let loose = &input.loose;
    let schedule_fields = input.frequency.is_some()
        || loose.interval.is_some()
        || loose.days_of_week.is_some()
        || loose.week_of_month.is_some()
        || loose.days_of_month.is_some()
        || input.start_date.is_some();
    let end_date = input.end_date.as_ref().and_then(Option::as_ref);
    let recompute = schedule_fields && input.next_date.is_none();
    let existing: Option<RuleRow> = if end_date.is_some() || recompute {
        database
            .query_optional(
                &format!(
                    "SELECT {RULE_COLUMNS} FROM recurring_rules WHERE id = ?1 AND book_id = ?2"
                ),
                &params![id()?, access.book_id()],
            )
            .map_err(database_error(failure))?
    } else {
        None
    };

    if let Some(end_date) = end_date {
        let start_date = input
            .start_date
            .as_ref()
            .or(existing.as_ref().map(|rule| &rule.start_date));
        if start_date.is_some_and(|start_date| end_date < start_date) {
            return Err(bad_request(END_BEFORE_START));
        }
    }
    let splits = match (&input.template_splits, &amounts) {
        (Some(splits), Some(amounts)) => Some(prove_template_splits(
            database,
            access,
            &template_inputs(splits, amounts),
            failure,
        )?),
        _ => None,
    };

    let mut computed = None;
    if let Some(existing) = existing.as_ref().filter(|_| recompute) {
        let stored = stored_config(existing).map_err(schedule_error(failure))?;
        let config = updated_config(input, existing, &stored);
        let start_date = input.start_date.as_ref().unwrap_or(&existing.start_date);
        let changed =
            start_date != &existing.start_date || schedule_key(&config) != schedule_key(&stored);
        if changed {
            let business_days_only = input
                .business_days_only
                .unwrap_or(existing.business_days_only);
            let mut next = advance_next_date_to_future(
                &initial_next_date(start_date, &config).map_err(schedule_error(failure))?,
                &config,
                &local_today(),
                business_days_only,
            )
            .map_err(schedule_error(failure))?;
            // Resume after the last transaction that this rule created, so
            // the recompute does not go back before it.
            let last_created: Option<String> = database.query_row("SELECT max(date) FROM transactions WHERE recurring_rule_id = ?1 AND book_id = ?2", &params![id()?, access.book_id()])
            .map_err(database_error(failure))?;
            if let Some(last_created) = last_created {
                next = advance_next_date_to_future(
                    &next,
                    &config,
                    &add_days_to_date_string(&last_created, 1).map_err(schedule_error(failure))?,
                    business_days_only,
                )
                .map_err(schedule_error(failure))?;
            }
            computed = Some(next);
        }
    }

    // The schema accepts a null nextDate, but the column is NOT NULL.
    let next = match &input.next_date {
        Some(None) => return Err(bad_request(NULL_NEXT_DATE)),
        Some(Some(next)) => Some(next.clone()),
        None => computed,
    };

    write_transaction(database, failure, |tx| {
        // Prove the rule is in this book before anything names its ID. Nothing
        // is written before this check, so a payee is not created for a rule
        // that is not the caller's.
        let rule: InBook<RecurringRule> = row_in_book(tx, access, id()?)
            .map_err(database_error(failure))?
            .ok_or_else(|| error(StatusCode::NOT_FOUND, NOT_FOUND))?;
        let rule_id = rule.id();
        // An absent key leaves the payee alone; a resolved null clears it.
        let payee = if loose.payee_id.is_some() || loose.payee_name.is_some() {
            Some(
                resolve_rule_payee(
                    tx,
                    access,
                    loose.payee_id.as_ref(),
                    loose.payee_name.as_ref(),
                )
                .map_err(database_error(failure))?,
            )
        } else {
            None
        };
        // Node sent the interval as text for PostgreSQL to cast.
        let interval = input
            .loose
            .interval
            .as_ref()
            .map(|value| text_value(value).as_deref().map(parse_pg_int4).transpose())
            .transpose()
            .map_err(|message| database_error(failure)(store::Error::Invalid(message)))?;
        let mut set = Builder::new("UPDATE recurring_rules SET ");
        if push_updates(&mut set, input, interval, next, payee) {
            set.push(" WHERE id = ")
                .push_bind(rule_id)
                .push(" AND book_id = ")
                .push_bind(access.book_id());
            set.execute(tx).map_err(database_error(failure))?;
        }
        if let Some(splits) = &splits {
            tx.execute("DELETE FROM recurring_template_splits WHERE recurring_rule_id = ?1 AND book_id = ?2", &params![rule_id, access.book_id()])
        .map_err(database_error(failure))?;
            insert_template_splits(tx, access, rule_id, splits, failure)?;
        }
        Ok(())
    })
}

pub(crate) async fn update_rule(
    State(state): State<AppState>,
    Path((raw_book_id, raw_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult {
    const FAILURE: &str = "Failed to update recurring rule";
    let book =
        authenticate_book(&state, &headers, &raw_book_id, AccessLevel::Write, FAILURE).await?;
    let access = book.write()?;
    let rule_id = rule_path_id(&raw_id);
    let input = validate_update(&parse_json_body(&body, FAILURE)?)?;
    update(&state.database, &access, rule_id, &input, FAILURE)?;
    let id = rule_id.ok_or_else(|| failed(FAILURE))?;
    load_rule(&state.database, book.book_id(), id)
        .map_err(database_error(FAILURE))?
        .map(|rule| Json(rule_json(&rule)))
        .ok_or_else(|| error(StatusCode::NOT_FOUND, NOT_FOUND))
}

// ---------------------------------------------------------------------------
// DELETE /recurring/[id]
// ---------------------------------------------------------------------------

/// Template splits go by ON DELETE CASCADE. Transactions that the rule made
/// keep their rows, and their `recurring_rule_id` becomes NULL.
pub(crate) async fn delete_rule(
    State(state): State<AppState>,
    Path((raw_book_id, raw_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> ApiResult {
    const FAILURE: &str = "Failed to delete recurring rule";
    let book =
        authenticate_book(&state, &headers, &raw_book_id, AccessLevel::Write, FAILURE).await?;
    let id = rule_path_id(&raw_id).ok_or_else(|| failed(FAILURE))?;
    let deleted: Option<i32> = state
        .database
        .query_optional(
            "DELETE FROM recurring_rules WHERE id = ?1 AND book_id = ?2 RETURNING id",
            &params![id, book.book_id()],
        )
        .map_err(database_error(FAILURE))?;
    deleted.ok_or_else(|| error(StatusCode::NOT_FOUND, NOT_FOUND))?;
    Ok(Json(json!({ "success": true })))
}

// ---------------------------------------------------------------------------
// POST /recurring/process
// ---------------------------------------------------------------------------

#[derive(Default)]
pub(crate) struct Processed {
    pub(crate) transaction_ids: Vec<i32>,
    skipped: Vec<(i32, &'static str)>,
}

/// `createTransactionFromRule`: one transaction from the template, dated
/// `date`. It does not use the transaction service: a rule makes an ordinary
/// transaction with no investment splits, check number, or notes.
fn create_transaction_from_rule(
    sql: &impl Sql,
    access: &BookAccess<'_, Write>,
    rule: &LoadedRule,
    date: &str,
    failure: &'static str,
) -> Result<Option<i32>, ApiError> {
    if rule.splits.len() < 2 {
        return Ok(None);
    }
    if !is_valid_date_string(date) {
        tracing::error!(
            date,
            "Recurring transaction date must be in YYYY-MM-DD format"
        );
        return Err(failed(failure));
    }
    let inputs: Vec<SplitInput> = rule
        .splits
        .iter()
        .map(|split| SplitInput {
            account_id: i64::from(split.row.account_id),
            amount: i64::from(split.row.amount),
        })
        .collect();
    let Some(balanced) = BalancedSplits::new(&inputs) else {
        tracing::error!(
            rule = rule.rule.id,
            "Recurring rule template splits must sum to zero"
        );
        return Err(failed(failure));
    };
    let account_ids: Vec<i32> = rule
        .splits
        .iter()
        .map(|split| split.row.account_id)
        .collect();
    let accounts =
        rows_in_book::<Account, _>(sql, access, &account_ids).map_err(database_error(failure))?;
    let Some(splits) =
        accounts.and_then(|accounts| ProvedSplits::on_accounts(access, balanced, &accounts))
    else {
        tracing::error!(
            rule = rule.rule.id,
            "Recurring rule template contains accounts outside this book"
        );
        return Err(failed(failure));
    };
    let book_id = same_book(access, splits.book_id(), failure)?;
    let now = now_millis();
    let transaction_id: i32 = sql
        .query_row(
            "INSERT INTO transactions (book_id, date, description, payee_id, recurring_rule_id,
           created_at, updated_at, description_fold)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7) RETURNING id",
            &params![
                book_id,
                date,
                &rule.rule.template_description,
                rule.rule.payee_id,
                rule.rule.id,
                now,
                fold_option(rule.rule.template_description.as_deref())
            ],
        )
        .map_err(database_error(failure))?;
    sql.execute(
        &format!(
            "INSERT INTO transaction_splits (book_id, transaction_id, account_id, amount) {}",
            json_rows(&["?1", "?2", "#0", "#1"], "?3")
        ),
        &params![book_id, transaction_id, splits.json_rows()],
    )
    .map_err(database_error(failure))?;
    Ok(Some(transaction_id))
}

/// Advances `next_date` only if it still holds `due`, as the first statement
/// of the transaction. A concurrent processor blocks on the row, then
/// matches no row once this one commits, so a due date never makes two
/// transactions.
fn claim(
    sql: &impl Sql,
    access: &BookAccess<'_, Write>,
    rule_id: i32,
    due: &str,
    next: &str,
    deactivate: bool,
    failure: &'static str,
) -> Result<bool, ApiError> {
    let claimed: Option<i32> = sql
        .query_optional(
            "UPDATE recurring_rules
         SET next_date = ?1, is_active = CASE WHEN ?2 THEN false ELSE is_active END
         WHERE id = ?3 AND book_id = ?4 AND next_date = ?5
         RETURNING id",
            &params![next, deactivate, rule_id, access.book_id(), due],
        )
        .map_err(database_error(failure))?;
    Ok(claimed.is_some())
}

/// `processRecurringRuleById`: create the rule's next occurrence whether or
/// not it is due, active, or past its end date, and advance the rule.
fn process_rule(
    database: &Database,
    access: &BookAccess<'_, Write>,
    rule_id: i32,
    failure: &'static str,
) -> Result<Option<Processed>, ApiError> {
    let Some(rule) =
        load_rule(database, access.book_id(), rule_id).map_err(database_error(failure))?
    else {
        return Ok(None);
    };
    // Checked before the claim, which would otherwise advance the rule past
    // a date that made nothing.
    if rule.splits.len() < 2 {
        return Ok(Some(Processed {
            skipped: vec![(rule.rule.id, FEWER_THAN_TWO)],
            ..Processed::default()
        }));
    }
    let due = &rule.rule.next_date;
    let schedule = schedule_error(failure);
    let occurrence = occurrence_date(due, rule.rule.business_days_only).map_err(&schedule)?;
    let next = next_date(due, &stored_config(&rule.rule).map_err(&schedule)?).map_err(&schedule)?;
    write_transaction(database, failure, |tx| {
        let mut processed = Processed::default();
        if claim(tx, access, rule_id, due, &next, false, failure)? {
            processed
                .transaction_ids
                .extend(create_transaction_from_rule(
                    tx,
                    access,
                    &rule,
                    &occurrence,
                    failure,
                )?);
        }
        Ok(Some(processed))
    })
}

/// `processAllRecurringRules`: each active rule whose observed next date is
/// within its lead window creates every occurrence due up to that horizon.
/// A rule whose schedule passes its end date is deactivated. The end date
/// bounds the scheduled date, not the observed one.
pub(crate) fn process_all(
    database: &Database,
    access: &BookAccess<'_, Write>,
    failure: &'static str,
) -> Result<Processed, ApiError> {
    let schedule = schedule_error(failure);
    let today = local_today();
    let rules = load_active_rules(database, access.book_id()).map_err(database_error(failure))?;
    let mut processed = Processed::default();
    for rule in &rules {
        let row = &rule.rule;
        let horizon = add_days_to_date_string(&today, row.auto_create_days_before.into())
            .map_err(&schedule)?;
        let observe = |date: &str| occurrence_date(date, row.business_days_only).map_err(&schedule);
        if observe(&row.next_date)? > horizon {
            continue;
        }
        if rule.splits.len() < 2 {
            processed.skipped.push((row.id, FEWER_THAN_TWO));
            continue;
        }
        let mut occurrences = Vec::new();
        let mut current = row.next_date.clone();
        let mut deactivate = false;
        let mut advances = true;
        while observe(&current)? <= horizon {
            if row.end_date.as_ref().is_some_and(|end| current > *end) {
                deactivate = true;
                break;
            }
            occurrences.push(observe(&current)?);
            // Node parses the stored day lists here, after the end-date
            // check, so a rule past its end date never parses them.
            let config = stored_config(row).map_err(&schedule)?;
            let next = next_date(&current, &config).map_err(&schedule)?;
            // An interval below 1 never advances the schedule. Node loops
            // without end on such a rule. A claim of it would keep its due
            // date, so each run would create the same occurrence again: Rust
            // leaves the rule unchanged and reports it.
            if next <= current {
                advances = false;
                break;
            }
            current = next;
        }
        if !advances {
            processed.skipped.push((row.id, DOES_NOT_ADVANCE));
            continue;
        }
        write_transaction(database, failure, |tx| {
            if claim(
                tx,
                access,
                row.id,
                &row.next_date,
                &current,
                deactivate,
                failure,
            )? {
                for occurrence in &occurrences {
                    processed
                        .transaction_ids
                        .extend(create_transaction_from_rule(
                            tx, access, rule, occurrence, failure,
                        )?);
                }
            }
            Ok(())
        })?;
    }
    Ok(processed)
}

pub(crate) async fn process_rules(
    State(state): State<AppState>,
    Path(raw_book_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult {
    const FAILURE: &str = "Failed to process recurring rules";
    let book =
        authenticate_book(&state, &headers, &raw_book_id, AccessLevel::Write, FAILURE).await?;
    let access = book.write()?;
    let input = validate_process(&parse_json_body(&body, FAILURE)?)?;
    // `if (ruleId)`: a ruleId of 0 counts as absent.
    let processed = match input.rule_id.filter(|id| *id != 0) {
        Some(rule_id) => {
            let rule_id = i32::try_from(rule_id).map_err(|_| failed(FAILURE))?;
            process_rule(&state.database, &access, rule_id, FAILURE)?
                .ok_or_else(|| error(StatusCode::NOT_FOUND, NOT_FOUND))?
        }
        None if input.process_all == Some(true) => process_all(&state.database, &access, FAILURE)?,
        None => Processed::default(),
    };
    Ok(Json(json!({
        "success": true,
        "transactionsCreated": processed.transaction_ids.len(),
        "transactionIds": processed.transaction_ids,
        "skipped": processed.skipped.iter().map(|(rule_id, reason)| json!({
            "ruleId": rule_id,
            "reason": reason,
        })).collect::<Vec<_>>(),
    })))
}

// ---------------------------------------------------------------------------
// GET /recurring/projected
// ---------------------------------------------------------------------------

/// `idParam("Invalid accountId")`: `Number()` of the text, then a positive
/// safe integer.
fn projected_account_id(raw: Option<&String>) -> Result<Option<i64>, ApiError> {
    let Some(raw) = raw.filter(|raw| !raw.is_empty()) else {
        return Ok(None);
    };
    parse_js_number(raw)
        .filter(|id| id.fract() == 0.0 && *id > 0.0 && *id <= MAX_SAFE_INTEGER)
        .map(|id| Some(id as i64))
        .ok_or_else(|| bad_request("Invalid accountId"))
}

/// One occurrence of a rule as a transaction with splits. The IDs are
/// negative and derive from the rule, so they never clash with a stored row.
fn projected_transaction(book_id: i32, rule: &LoadedRule, date: &str, index: i64) -> Value {
    let row = &rule.rule;
    let transaction_id = -(i64::from(row.id) * 10_000 + index);
    json!({
        "id": transaction_id,
        "bookId": book_id,
        "date": date,
        "description": row.template_description,
        "checkNumber": null,
        "notes": null,
        "payeeId": row.payee_id,
        "isReconciled": false,
        "isFloating": false,
        "recurringRuleId": row.id,
        "createdBy": null,
        "updatedBy": null,
        "createdAt": EPOCH,
        "updatedAt": EPOCH,
        "payee": rule.payee,
        "splits": rule.splits.iter().enumerate().map(|(position, split)| json!({
            "id": -(transaction_id * 100 + position as i64),
            "bookId": book_id,
            "transactionId": transaction_id,
            "accountId": split.row.account_id,
            "amount": split.row.amount,
            "account": split.account,
        })).collect::<Vec<_>>(),
        "investmentSplits": [],
        "isProjected": true,
    })
}

pub(crate) async fn projected(
    State(state): State<AppState>,
    Path(raw_book_id): Path<String>,
    RawQuery(raw_query): RawQuery,
    headers: HeaderMap,
) -> ApiResult {
    const FAILURE: &str = "Failed to fetch projected recurring transactions";
    let book =
        authenticate_book(&state, &headers, &raw_book_id, AccessLevel::Read, FAILURE).await?;
    let params = first_query_values(raw_query.as_deref());
    let start_date = query_date_param(&params, "startDate")?;
    let end_date = query_date_param(&params, "endDate")?;
    let account_id = projected_account_id(params.get("accountId"))?;

    let schedule = schedule_error(FAILURE);
    let today = local_today();
    let upcoming_days: i32 = state
        .database
        .query_row(
            "SELECT upcoming_days FROM books WHERE id = ?1",
            &params![book.book_id()],
        )
        .map_err(database_error(FAILURE))?;
    let start_date = match start_date {
        Some(date) => date,
        None => add_days_to_date_string(&today, 1).map_err(&schedule)?,
    };
    let end_date = match end_date {
        Some(date) => date,
        None => add_days_to_date_string(&today, upcoming_days.into()).map_err(&schedule)?,
    };
    let rules =
        load_active_rules(&state.database, book.book_id()).map_err(database_error(FAILURE))?;

    let mut projected: Vec<(String, Value)> = Vec::new();
    for rule in &rules {
        if let Some(account_id) = account_id
            && !rule.splits.iter().any(|split| {
                i64::from(split.row.account_id) == account_id
                    || split
                        .account_parent_id
                        .is_some_and(|parent| i64::from(parent) == account_id)
            })
        {
            continue;
        }
        let row = &rule.rule;
        let config = stored_config(row).map_err(&schedule)?;
        // The loop walks the scheduled dates. The window and the projected
        // transaction use the observed date. The shift only moves a date
        // forward, so a bound on the scheduled date is safe.
        let mut current = row.next_date.clone();
        let mut index = 0;
        while current <= end_date {
            let occurrence =
                occurrence_date(&current, row.business_days_only).map_err(&schedule)?;
            if occurrence >= start_date && occurrence <= end_date {
                projected.push((
                    occurrence.clone(),
                    projected_transaction(book.book_id(), rule, &occurrence, index),
                ));
                index += 1;
            }
            let next = next_date(&current, &config).map_err(&schedule)?;
            if next <= current {
                break;
            }
            current = next;
            if row.end_date.as_ref().is_some_and(|end| current > *end) {
                break;
            }
        }
    }
    // A stable sort, as Array.prototype.sort is.
    projected.sort_by(|left, right| left.0.cmp(&right.0));
    Ok(Json(
        projected.into_iter().map(|(_, value)| value).collect(),
    ))
}

// ---------------------------------------------------------------------------
// GET /recurring/transactions
// ---------------------------------------------------------------------------

#[derive(ledger_db::store::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecurringTransactionRow {
    transaction_id: i32,
    date: String,
    recurring_rule_id: Option<i32>,
    rule_name: String,
}

/// The transactions that rules created, by effective date. The query is
/// checked before authentication, as in Node. The dates are compared as
/// text and are not validated.
pub(crate) async fn rule_transactions(
    State(state): State<AppState>,
    Path(raw_book_id): Path<String>,
    RawQuery(raw_query): RawQuery,
    headers: HeaderMap,
) -> ApiResult {
    const FAILURE: &str = "Failed to fetch recurring transactions";
    let params = first_query_values(raw_query.as_deref());
    let required = |name: &str| {
        params
            .get(name)
            .filter(|value| !value.is_empty())
            .cloned()
            .ok_or_else(|| bad_request("startDate and endDate are required"))
    };
    let (start_date, end_date) = (required("startDate")?, required("endDate")?);
    let book =
        authenticate_book(&state, &headers, &raw_book_id, AccessLevel::Read, FAILURE).await?;
    // Node gives no ORDER BY. Rust uses the transaction ID.
    let rows: Vec<RecurringTransactionRow> = state
        .database
        .query(
            &format!(
                "SELECT t.id AS transaction_id, {EFFECTIVE_DATE} AS date,
                t.recurring_rule_id, r.name AS rule_name
         FROM transactions t
         JOIN recurring_rules r ON t.recurring_rule_id = r.id
         WHERE t.book_id = ?1 AND t.recurring_rule_id IS NOT NULL
           AND {EFFECTIVE_DATE} >= ?2 AND {EFFECTIVE_DATE} <= ?3
         ORDER BY t.id"
            ),
            &params![book.book_id(), start_date, end_date],
        )
        .map_err(database_error(FAILURE))?;
    Ok(Json(to_value(rows).expect("rows serialize")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loose_values_read_as_the_recurrence_math_reads_them() {
        assert_eq!(loose_days(&json!([3, 1.0])), Some(vec![3, 1]));
        assert_eq!(loose_days(&json!([1.5])), None);
        assert_eq!(loose_days(&json!("1,2")), None);
        assert_eq!(loose_days(&json!([])), Some(vec![]));
        assert_eq!(loose_week_of_month(&json!(2)), Some("2".into()));
        assert_eq!(loose_week_of_month(&json!("")), None);
        assert_eq!(loose_interval(&json!(-1)), -1);
        assert_eq!(loose_interval(&json!(" 3 ")), 3);
        assert_eq!(loose_interval(&json!(1.5)), 1);
        assert_eq!(stored_days(Some("[5,1]")), Ok(Some(vec![5, 1])));
        assert_eq!(stored_days(Some("")), Ok(None));
        assert!(stored_days(Some("[5,")).is_err());
    }

    #[test]
    fn a_template_balances_only_with_int4_integers() {
        let split = |amount| TemplateSplit {
            account_id: 1,
            amount,
        };
        assert_eq!(
            balanced_amounts(&[split(5.0), split(-5.0)]),
            Some(vec![5, -5])
        );
        assert_eq!(balanced_amounts(&[split(1.5), split(-1.5)]), None);
        assert_eq!(balanced_amounts(&[split(3e9), split(-3e9)]), None);
        assert_eq!(balanced_amounts(&[split(5.0), split(-4.0)]), None);
    }

    #[test]
    fn account_filter_is_a_positive_safe_integer() {
        let raw = |value: &str| projected_account_id(Some(&value.to_owned())).ok().flatten();
        assert_eq!(raw(" 5 "), Some(5));
        assert_eq!(raw("0x10"), Some(16));
        assert_eq!(raw("3000000000"), Some(3_000_000_000));
        for bad in ["abc", "0", "-1", "1.5", "Infinity", "9007199254740993"] {
            assert!(
                projected_account_id(Some(&bad.to_owned())).is_err(),
                "{bad}"
            );
        }
        assert_eq!(
            projected_account_id(Some(&String::new())).ok().flatten(),
            None
        );
    }
}
