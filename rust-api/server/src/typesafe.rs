//! The TypeSafe experiment records. These records are evidence only: they never change the
//! ledger, and a failure to save one never fails the request.

use crate::validation::js_number_string;
use crate::{
    routes::{
        payees::normalize_name,
        reconcile::{Action, ReconcileInput},
        transactions::now_millis,
    },
    validation::{is_js_whitespace, js_number, js_truthy},
};
use chrono::{DateTime, NaiveDateTime, TimeDelta};
use ledger_db::engine::{Db, DbPool};
use ledger_db::locks::FOR_UPDATE;
use ledger_db::sql;
use serde_json::{Value, json};
use sqlx::FromRow;
use std::collections::HashSet;

/// `recordTypeSafeUnlink`: after an unlink from the transaction banner, an
/// `unlink` decision for each evaluation that an earlier `match` decision on
/// this transaction came from. The book row is locked, as for every
/// TypeSafe record, so a settings change cannot interleave.
pub(crate) async fn record_unlink(pool: &DbPool, book_id: i32, transaction_id: i32) {
    // The MCP tools record no TypeSafe decision, so a route that runs for a
    // tool records none.
    if crate::mcp::in_tool_call() {
        return;
    }
    let result: Result<(), sqlx::Error> = async {
        let mut transaction = ledger_db::locks::begin_pool(pool).await?;
        let enabled: bool = sqlx::query_scalar(&format!(
            "SELECT typesafe_reconciliation_enabled FROM books WHERE id = $1{FOR_UPDATE}"
        ))
        .bind(book_id)
        .fetch_one(transaction.as_mut())
        .await?;
        if enabled {
            let prior: Vec<(i32, Option<i32>)> = sqlx::query_as(
                "SELECT reconciliation_id, evaluation_id FROM typesafe_decisions
                 WHERE book_id = $1 AND transaction_id = $2 AND action = 'match'
                 ORDER BY id",
            )
            .bind(book_id)
            .bind(transaction_id)
            .fetch_all(transaction.as_mut())
            .await?;
            let mut seen = HashSet::new();
            for (reconciliation_id, evaluation_id) in prior {
                let Some(evaluation_id) = evaluation_id.filter(|id| seen.insert(*id)) else {
                    continue;
                };
                sqlx::query(
                    "INSERT INTO typesafe_decisions
                       (book_id, reconciliation_id, evaluation_id, action, transaction_id,
                        decided_at)
                     VALUES ($1, $2, $3, 'unlink', $4, $5)",
                )
                .bind(book_id)
                .bind(reconciliation_id)
                .bind(evaluation_id)
                .bind(transaction_id)
                .bind(chrono::Utc::now().naive_utc())
                .execute(transaction.as_mut())
                .await?;
            }
        }
        transaction.commit().await
    }
    .await;
    if let Err(cause) = result {
        tracing::error!(error = %cause, "TypeSafe unlink observation could not be saved");
    }
}

/// `isTypeSafeConfigured`, read on each call as Node reads it.
pub(crate) fn is_configured() -> bool {
    std::env::var("TYPESAFE_ENABLED").is_ok_and(|value| value == "true")
        && std::env::var("TYPESAFE_API_KEY")
            .is_ok_and(|key| !key.trim_matches(is_js_whitespace).is_empty())
}

/// `typesafeObservationSchema`: what the browser saw before the decision.
/// A body that fails the schema counts as no observation at all.
#[derive(Default)]
pub(crate) struct Observation {
    evaluation_id: Option<f64>,
    suggestion_visible: Option<bool>,
    active_review_ms: Option<f64>,
    accepted_suggestion: Option<bool>,
}

impl Observation {
    /// A click on a suggestion button: the suggestion was visible and the
    /// user accepted it.
    pub(crate) fn accepted(evaluation_id: f64, active_review_ms: Option<f64>) -> Self {
        Self {
            evaluation_id: Some(evaluation_id),
            suggestion_visible: Some(true),
            active_review_ms,
            accepted_suggestion: Some(true),
        }
    }

    /// `rawBody?.typesafe ?? {}`, parsed; a failure is the empty observation.
    pub(crate) fn parse(value: Option<&Value>) -> Self {
        let Some(value) = value.filter(|value| !value.is_null()) else {
            return Self::default();
        };
        let Some(object) = value.as_object() else {
            return Self::default();
        };
        // `z.number().int()` with its bounds; a missing key is absent.
        let integer = |key: &str, accept: fn(f64) -> bool| -> Result<Option<f64>, ()> {
            match object.get(key) {
                None => Ok(None),
                Some(Value::Number(number)) => {
                    let value = js_number(number);
                    (value.is_finite()
                        && value.fract() == 0.0
                        && value.abs() <= 9_007_199_254_740_991.0
                        && accept(value))
                    .then_some(Some(value))
                    .ok_or(())
                }
                Some(_) => Err(()),
            }
        };
        let parsed = (|| {
            Ok::<_, ()>(Self {
                evaluation_id: integer("evaluationId", |value| value > 0.0)?,
                suggestion_visible: match object.get("suggestionVisible") {
                    None => None,
                    Some(Value::Bool(visible)) => Some(*visible),
                    Some(_) => return Err(()),
                },
                active_review_ms: integer("activeReviewMs", |value| {
                    (0.0..=3_600_000.0).contains(&value)
                })?,
                accepted_suggestion: None,
            })
        })();
        parsed.unwrap_or_default()
    }
}

/// `value?.[key]` on a parsed JSON value. `None` is undefined.
pub(crate) fn property<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value?.as_object()?.get(key)
}

/// JavaScript `===` for two parsed JSON values, where `None` is undefined.
/// Two objects are never the same object.
pub(crate) fn strict_equal(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(Value::Number(a)), Some(Value::Number(b))) => js_number(a) == js_number(b),
        (Some(Value::Object(_) | Value::Array(_)), _)
        | (_, Some(Value::Object(_) | Value::Array(_))) => false,
        (Some(a), Some(b)) => a == b,
        _ => false,
    }
}

/// Marks a TypeError in Node: the observation is not saved.
pub(crate) struct TypeError;

/// `options?.find((o) => o.label === choice)`.
fn find_option<'a>(
    options: Option<&'a Value>,
    choice: Option<&Value>,
) -> Result<Option<&'a Value>, TypeError> {
    match options {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Array(items)) => {
            for item in items {
                if item.is_null() {
                    return Err(TypeError);
                }
                if strict_equal(property(Some(item), "label"), choice) {
                    return Ok(Some(item));
                }
            }
            Ok(None)
        }
        Some(_) => Err(TypeError),
    }
}

/// `proposalFor`: the payee and category of a proposed new transaction.
pub(crate) fn proposal<'a>(
    snapshot: &'a Value,
    answers: Option<&'a Value>,
) -> Result<Option<(&'a Value, &'a Value)>, TypeError> {
    let payee_answer = property(answers, "payee").filter(|value| js_truthy(value));
    let category_answer = property(answers, "category").filter(|value| js_truthy(value));
    let (Some(payee_answer), Some(category_answer)) = (payee_answer, category_answer) else {
        return Ok(None);
    };
    if let Some(answer) = property(answers, "match").filter(|value| js_truthy(value))
        && !strict_equal(property(Some(answer), "choice"), Some(&json!("none")))
    {
        return Ok(None);
    }
    let payee = find_option(
        property(Some(snapshot), "payeeOptions"),
        property(Some(payee_answer), "choice"),
    )?;
    let category = find_option(
        property(Some(snapshot), "categoryOptions"),
        property(Some(category_answer), "choice"),
    )?;
    Ok(payee.zip(category))
}

#[derive(FromRow)]
struct EvaluationRow {
    id: i32,
    started_at: NaiveDateTime,
    status: String,
    completed_at: Option<NaiveDateTime>,
    displayed_at: Option<NaiveDateTime>,
    snapshot: String,
    answers: Option<String>,
}

/// A database timestamp as a JavaScript Date reads it: whole milliseconds.
fn millis(value: NaiveDateTime) -> NaiveDateTime {
    DateTime::from_timestamp_millis(value.and_utc().timestamp_millis())
        .map(|value| value.naive_utc())
        .unwrap_or(value)
}

/// `recordTypeSafeDecision`: after a committed decision, the evidence of what
/// the suggestion showed. It never changes the response; a failure is
/// logged.
pub(crate) async fn record_decision(
    pool: &DbPool,
    book_id: i32,
    input: &ReconcileInput,
    observation: &Observation,
    action_started_at: NaiveDateTime,
) {
    // As in `record_unlink`: a route that runs for an MCP tool records none.
    if crate::mcp::in_tool_call() {
        return;
    }
    let result: Result<(), String> = async {
        let failed = |cause: sqlx::Error| cause.to_string();
        let mut transaction = ledger_db::locks::begin_pool(pool).await.map_err(failed)?;
        let (enabled, revision): (bool, i32) = sqlx::query_as(&format!(
            "SELECT typesafe_reconciliation_enabled, typesafe_revision FROM books
             WHERE id = $1{FOR_UPDATE}"
        ))
        .bind(book_id)
        .fetch_one(transaction.as_mut())
        .await
        .map_err(failed)?;
        if enabled && is_configured() {
            record_in(
                &mut transaction,
                book_id,
                revision,
                input,
                observation,
                action_started_at,
            )
            .await?;
        }
        transaction.commit().await.map_err(failed)
    }
    .await;
    if let Err(cause) = result {
        tracing::error!(error = %cause, "TypeSafe decision observation could not be saved");
    }
}

/// An ID as Node binds it to an integer column, or an error where
/// PostgreSQL would refuse it.
fn integer_column(value: f64) -> Result<i32, String> {
    (value.fract() == 0.0 && (f64::from(i32::MIN)..=f64::from(i32::MAX)).contains(&value))
        .then_some(value as i32)
        .ok_or_else(|| format!("{value} is not an integer column value"))
}

async fn record_in(
    transaction: &mut sqlx::Transaction<'_, Db>,
    book_id: i32,
    revision: i32,
    input: &ReconcileInput,
    observation: &Observation,
    action_started_at: NaiveDateTime,
) -> Result<(), String> {
    let failed = |cause: sqlx::Error| cause.to_string();
    let reconciliation_id = integer_column(input.reconciliation_id)?;
    let evaluation_filter = observation.evaluation_id.map(integer_column).transpose()?;
    let record: Option<EvaluationRow> = sqlx::query_as(
        "SELECT id, started_at, status, completed_at, displayed_at,
                CAST(snapshot AS TEXT) AS snapshot, CAST(answers AS TEXT) AS answers
         FROM typesafe_evaluations
         WHERE book_id = $1 AND reconciliation_id = $2 AND revision = $3
           AND ($4 IS NULL OR id = $4)
         ORDER BY started_at DESC LIMIT 1",
    )
    .bind(book_id)
    .bind(reconciliation_id)
    .bind(revision)
    .bind(evaluation_filter)
    .fetch_optional(transaction.as_mut())
    .await
    .map_err(failed)?;
    let Some(record) = record else {
        return Ok(());
    };
    if millis(record.started_at) > action_started_at {
        return Ok(());
    }
    let shown_before =
        |time: Option<NaiveDateTime>| time.is_some_and(|time| millis(time) <= action_started_at);
    let visible = observation.suggestion_visible == Some(true)
        && observation.evaluation_id == Some(f64::from(record.id))
        && record.status == "ready"
        && shown_before(record.completed_at)
        && shown_before(record.displayed_at);
    let snapshot: Value = read_json_column(&record.snapshot).map_err(|cause| cause.to_string())?;
    let answers: Option<Value> = record
        .answers
        .as_deref()
        .map(read_json_column)
        .transpose()
        .map_err(|cause| cause.to_string())?;
    let proposal = if visible {
        proposal(
            &snapshot,
            answers.as_ref().filter(|answers| !answers.is_null()),
        )
        .map_err(|TypeError| "TypeError in proposalFor".to_owned())?
    } else {
        None
    };
    let creating = input.action == Action::Create && proposal.is_some();
    let payee_kept = match (&input.payee_name, proposal) {
        (Some(Value::String(name)), Some((payee, _))) => {
            let proposed = property(Some(payee), "name")
                .and_then(Value::as_str)
                .ok_or_else(|| "TypeError in normalizePayeeName".to_owned())?;
            normalize_name(name).to_lowercase() == normalize_name(proposed).to_lowercase()
        }
        _ => false,
    };
    let category_kept = proposal.is_some_and(|(_, category)| {
        strict_equal(
            input.counter_account_id.as_ref(),
            property(Some(category), "accountId"),
        )
    });
    let transaction_id = match &input.transaction_id {
        Some(Value::Number(number)) => Some(integer_column(js_number(number))?),
        _ => None,
    };
    let active_review_ms = observation
        .active_review_ms
        .map(integer_column)
        .transpose()?;
    sqlx::query(
        "INSERT INTO typesafe_decisions
           (book_id, reconciliation_id, evaluation_id, action, transaction_id, suggestion_visible,
            accepted_suggestion, proposal_payee_kept, proposal_category_kept, active_review_ms,
            decided_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
    )
    .bind(book_id)
    .bind(reconciliation_id)
    .bind(record.id)
    .bind(input.action.name())
    .bind(transaction_id)
    .bind(visible)
    .bind(visible && observation.accepted_suggestion == Some(true))
    .bind(creating.then_some(payee_kept))
    .bind(creating.then_some(category_kept))
    .bind(active_review_ms)
    .bind(now_millis())
    .execute(transaction.as_mut())
    .await
    .map_err(failed)?;
    Ok(())
}

/// Counts in the order a JavaScript object first saw each key, as
/// `summarizeTypeSafe` builds them. The database stores them as jsonb.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct Counts(Vec<(String, Option<f64>)>);

impl Counts {
    fn add(&mut self, key: &str, n: f64) {
        match self.0.iter_mut().find(|(seen, _)| seen == key) {
            // `(a[key] ?? 0) + n`: a stored null counts as 0.
            Some((_, value)) => *value = Some(value.unwrap_or(0.0) + n),
            None => self.0.push((key.to_owned(), Some(n))),
        }
    }

    /// `merge(a, b)`: `a[key] = (a[key] ?? 0) + value`.
    fn merge(&mut self, other: &Self) {
        for (key, value) in &other.0 {
            self.add(key, value.unwrap_or(f64::NAN));
        }
    }

    /// Archived counts as stored. A null stays null until a new count is
    /// added to it. `JSON.stringify` writes a NaN count as null.
    fn parse(text: &str) -> Result<Self, String> {
        let value: Value = serde_json::from_str(text).map_err(|cause| cause.to_string())?;
        let Value::Object(object) = value else {
            return Ok(Self::default());
        };
        Ok(Self(
            object
                .iter()
                .map(|(key, value)| {
                    let number = match value {
                        Value::Number(number) => Some(crate::validation::js_number(number)),
                        _ => None,
                    };
                    (key.clone(), number)
                })
                .collect(),
        ))
    }

    /// `JSON.stringify(counts)`.
    fn to_json(&self) -> String {
        let fields: Vec<String> = self
            .0
            .iter()
            .map(|(key, value)| {
                let number = match value {
                    Some(value) if value.is_finite() => js_number_string(*value),
                    _ => "null".to_owned(),
                };
                format!("{}:{number}", Value::String(key.clone()))
            })
            .collect();
        format!("{{{}}}", fields.join(","))
    }

    #[cfg(test)]
    pub(crate) fn get(&self, key: &str) -> Option<f64> {
        self.0
            .iter()
            .find(|(seen, _)| seen == key)
            .and_then(|(_, value)| *value)
    }
}

pub(crate) struct SummaryEvaluation {
    pub(crate) id: i32,
    pub(crate) status: String,
    pub(crate) snapshot: Value,
    pub(crate) choice: Option<String>,
    pub(crate) usage: Option<Value>,
    pub(crate) answers: Option<Value>,
    pub(crate) displayed_at: Option<NaiveDateTime>,
    pub(crate) latency_ms: Option<i32>,
}

/// An evaluation row with its jsonb columns as text.
#[derive(FromRow)]
struct StoredEvaluation {
    id: i32,
    status: String,
    snapshot: String,
    choice: Option<String>,
    usage: Option<String>,
    answers: Option<String>,
    displayed_at: Option<NaiveDateTime>,
    latency_ms: Option<i32>,
}

/// Reads a JSON column as PostgreSQL `jsonb` gave it back: each object's keys
/// sorted by length, then by bytes. The TypeSafe request body and its
/// fingerprint are built from stored snapshots, so this order keeps them the
/// same as before the move to SQLite, which keeps the text as written.
pub(crate) fn read_json_column(text: &str) -> serde_json::Result<Value> {
    fn order(value: Value) -> Value {
        match value {
            Value::Object(object) => {
                let mut entries: Vec<(String, Value)> = object.into_iter().collect();
                entries.sort_by(|(left, _), (right, _)| {
                    left.len().cmp(&right.len()).then_with(|| left.cmp(right))
                });
                Value::Object(
                    entries
                        .into_iter()
                        .map(|(key, value)| (key, order(value)))
                        .collect(),
                )
            }
            Value::Array(items) => Value::Array(items.into_iter().map(order).collect()),
            other => other,
        }
    }
    serde_json::from_str(text).map(order)
}

impl StoredEvaluation {
    fn parse(self) -> Result<SummaryEvaluation, String> {
        let json = |text: &str| read_json_column(text).map_err(|cause| cause.to_string());
        Ok(SummaryEvaluation {
            id: self.id,
            status: self.status,
            snapshot: json(&self.snapshot)?,
            choice: self.choice,
            usage: self.usage.as_deref().map(json).transpose()?,
            answers: self.answers.as_deref().map(json).transpose()?,
            displayed_at: self.displayed_at,
            latency_ms: self.latency_ms,
        })
    }
}

#[derive(FromRow)]
pub(crate) struct SummaryDecision {
    pub(crate) evaluation_id: Option<i32>,
    pub(crate) action: String,
    pub(crate) transaction_id: Option<i32>,
    pub(crate) suggestion_visible: bool,
    pub(crate) accepted_suggestion: bool,
    pub(crate) proposal_payee_kept: Option<bool>,
    pub(crate) proposal_category_kept: Option<bool>,
    pub(crate) active_review_ms: Option<i32>,
    pub(crate) decided_at: NaiveDateTime,
}

/// `array.find((c) => c[key] === expected)`, where `None` is undefined.
fn find_by<'a>(
    array: Option<&'a Value>,
    key: &str,
    expected: Option<&Value>,
) -> Result<Option<&'a Value>, TypeError> {
    match array {
        Some(Value::Array(items)) => {
            for item in items {
                if item.is_null() {
                    return Err(TypeError);
                }
                if strict_equal(property(Some(item), key), expected) {
                    return Ok(Some(item));
                }
            }
            Ok(None)
        }
        _ => Err(TypeError),
    }
}

/// `array[0]`: an error where JavaScript reads a property of undefined.
fn first_item(array: Option<&Value>) -> Result<Option<&Value>, TypeError> {
    match array {
        None | Some(Value::Null) => Err(TypeError),
        Some(Value::Array(items)) => Ok(items.first()),
        Some(_) => Ok(None),
    }
}

/// A JSON number for a SQL integer, so that `strict_equal` compares it with
/// a value read from a snapshot.
fn number(value: i32) -> Value {
    Value::from(value)
}

/// `summarizeTypeSafe`: the counts of a set of evaluations and of the
/// decisions that refer to them. A snapshot that JavaScript cannot read (a
/// TypeError in Node) fails the summary.
pub(crate) fn summarize(
    evaluations: &[SummaryEvaluation],
    decisions: &[SummaryDecision],
) -> Result<Counts, String> {
    let type_error = |TypeError| "TypeError in summarizeTypeSafe".to_owned();
    let mut counts = Counts::default();
    for row in evaluations {
        let mut add = |key: &str, n: f64| counts.add(key, n);
        let snapshot = &row.snapshot;
        add("evaluations", 1.0);
        add(&format!("status_{}", row.status), 1.0);
        add(
            if property(Some(snapshot), "merchantSeenBefore").is_some_and(js_truthy_value) {
                "familiar_merchant_evaluations"
            } else {
                "unseen_merchant_evaluations"
            },
            1.0,
        );
        if let Some(latency) = row.latency_ms {
            add("latency_samples", 1.0);
            add("latency_total_ms", f64::from(latency));
        }
        if let Some(usage) = row.usage.as_ref().filter(|usage| js_truthy_value(usage)) {
            add("usage_samples", 1.0);
            add(
                "input_tokens",
                json_number(property(Some(usage), "input_tokens")),
            );
            add(
                "output_tokens",
                json_number(property(Some(usage), "output_tokens")),
            );
        }
        if row.choice.as_deref() == Some("none") {
            add("none_predictions", 1.0);
        }
        let choice = row.choice.clone().map(Value::String).unwrap_or(Value::Null);
        let chosen = find_by(
            property(Some(snapshot), "candidates"),
            "label",
            Some(&choice),
        )
        .map_err(type_error)?
        .and_then(|candidate| property(Some(candidate), "transactionId"));
        let baseline_first =
            first_item(property(Some(snapshot), "baselineIds")).map_err(type_error)?;
        if let Some(chosen) = chosen.filter(|chosen| js_truthy_value(chosen)) {
            add(
                if strict_equal(Some(chosen), baseline_first) {
                    "agrees_with_baseline"
                } else {
                    "differs_from_baseline"
                },
                1.0,
            );
        }
        let proposal = proposal(
            snapshot,
            row.answers.as_ref().filter(|answers| !answers.is_null()),
        )
        .map_err(type_error)?;
        if let Some((_, category)) = proposal {
            add("proposals", 1.0);
            if row.displayed_at.is_some() {
                add("proposals_displayed", 1.0);
            }
            if let Some(baseline) =
                property(Some(snapshot), "baselineCategoryId").filter(|value| !value.is_null())
            {
                add(
                    if strict_equal(property(Some(category), "accountId"), Some(baseline)) {
                        "proposal_category_agrees_with_baseline"
                    } else {
                        "proposal_category_differs_from_baseline"
                    },
                    1.0,
                );
            }
        }
        let mut outcomes: Vec<&SummaryDecision> = decisions
            .iter()
            .filter(|decision| decision.evaluation_id == Some(row.id))
            .collect();
        outcomes.sort_by_key(|decision| millis(decision.decided_at));
        let Some(first) = outcomes.iter().find(|decision| decision.action != "unlink") else {
            add("outcome_unknown", 1.0);
            continue;
        };
        add("ui_decisions", 1.0);
        add(&format!("ui_action_{}", first.action), 1.0);
        if first.suggestion_visible {
            add("suggestion_visible_decisions", 1.0);
        }
        if first.accepted_suggestion {
            add("suggestion_button_acceptances", 1.0);
        }
        if let Some(review) = first.active_review_ms {
            add("review_time_samples", 1.0);
            add("review_time_total_ms", f64::from(review));
        }
        if proposal.is_some() && first.suggestion_visible {
            if first.action != "create" {
                add(&format!("proposal_shown_then_{}", first.action), 1.0);
            } else if first.accepted_suggestion {
                add("proposal_one_click_creates", 1.0);
            } else if first.proposal_payee_kept == Some(true)
                && first.proposal_category_kept == Some(true)
            {
                add("proposal_edits_unchanged", 1.0);
            } else {
                add("proposal_edits_changed", 1.0);
                if first.proposal_payee_kept == Some(false) {
                    add("proposal_edits_changed_payee", 1.0);
                }
                if first.proposal_category_kept == Some(false) {
                    add("proposal_edits_changed_category", 1.0);
                }
            }
        }
        if first.action == "match"
            && let Some(transaction_id) = first.transaction_id
        {
            let transaction_id = number(transaction_id);
            add("manual_matches", 1.0);
            let in_candidates = find_by(
                property(Some(snapshot), "candidates"),
                "transactionId",
                Some(&transaction_id),
            )
            .map_err(type_error)?
            .is_some();
            add(
                if in_candidates {
                    "manual_match_in_candidates"
                } else {
                    "manual_match_outside_candidates"
                },
                1.0,
            );
            if strict_equal(baseline_first, Some(&transaction_id)) {
                add("baseline_agrees_with_user", 1.0);
            }
            if strict_equal(chosen, Some(&transaction_id)) {
                add("jev_agrees_with_user", 1.0);
                add(
                    if property(Some(snapshot), "merchantSeenBefore").is_some_and(js_truthy_value) {
                        "familiar_merchant_agrees_with_user"
                    } else {
                        "unseen_merchant_agrees_with_user"
                    },
                    1.0,
                );
            }
            if row.choice.as_deref() == Some("none") {
                add("none_followed_by_manual_match", 1.0);
            }
        }
        let first_decided = millis(first.decided_at);
        if outcomes.iter().any(|decision| {
            decision.action == "unlink" && millis(decision.decided_at) >= first_decided
        }) {
            add("subsequently_unlinked", 1.0);
        }
    }
    Ok(counts)
}

fn js_truthy_value(value: &Value) -> bool {
    crate::validation::js_truthy(value)
}

/// A number read from stored JSON; anything else is NaN, as `0 + undefined`.
fn json_number(value: Option<&Value>) -> f64 {
    match value {
        Some(Value::Number(number)) => crate::validation::js_number(number),
        _ => f64::NAN,
    }
}

const RETENTION_DAYS: i64 = 30;
pub(crate) const CLEANUP_BATCH: i64 = 1000;

/// `cleanupTypeSafe`: one bounded batch. Evaluations older than 30 days are
/// added to the book's archived counts and deleted with their decisions,
/// book by book under the book-row lock. Quotas of earlier days are deleted.
/// Returns the number of evaluations deleted.
pub(crate) async fn cleanup(pool: &DbPool, now: NaiveDateTime) -> Result<i64, String> {
    let failed = |cause: sqlx::Error| cause.to_string();
    let cutoff = now - TimeDelta::days(RETENTION_DAYS);
    let batch: Vec<(i32, i32)> = sqlx::query_as(
        "SELECT id, book_id FROM typesafe_evaluations WHERE started_at < $1
         ORDER BY id LIMIT COALESCE($2, -1)",
    )
    .bind(cutoff)
    .bind(CLEANUP_BATCH)
    .fetch_all(pool)
    .await
    .map_err(failed)?;
    let mut books: Vec<i32> = Vec::new();
    for (_, book_id) in &batch {
        if !books.contains(book_id) {
            books.push(*book_id);
        }
    }
    let mut deleted = 0;
    for book_id in books {
        let ids: Vec<i32> = batch
            .iter()
            .filter(|(_, book)| *book == book_id)
            .map(|(id, _)| *id)
            .collect();
        deleted += archive_book(pool, book_id, &ids, cutoff).await?;
    }
    // Quotas carry no transaction data. Today's quota stays across clear-data.
    let cutoff_day = cutoff.format("%Y-%m-%d").to_string();
    sqlx::query("DELETE FROM typesafe_quotas WHERE day < $1")
        .bind(cutoff_day)
        .execute(pool)
        .await
        .map_err(failed)?;
    Ok(deleted)
}

async fn archive_book(
    pool: &DbPool,
    book_id: i32,
    ids: &[i32],
    cutoff: NaiveDateTime,
) -> Result<i64, String> {
    let failed = |cause: sqlx::Error| cause.to_string();
    let mut transaction = ledger_db::locks::begin_pool(pool).await.map_err(failed)?;
    let locked: Option<i32> =
        sqlx::query_scalar(&format!("SELECT id FROM books WHERE id = $1{FOR_UPDATE}"))
            .bind(book_id)
            .fetch_optional(transaction.as_mut())
            .await
            .map_err(failed)?;
    if locked.is_none() {
        return Err("Book not found".to_owned());
    }
    let rows: Vec<StoredEvaluation> = sqlx::query_as(&format!(
        "SELECT id, status, CAST(snapshot AS TEXT) AS snapshot, choice,
                CAST(usage AS TEXT) AS usage, CAST(answers AS TEXT) AS answers, displayed_at,
                latency_ms
         FROM typesafe_evaluations
         WHERE book_id = $1 AND id {} AND started_at < $3
         ORDER BY id",
        sql::in_integers("$2")
    ))
    .bind(book_id)
    .bind(sql::json_array(ids))
    .bind(cutoff)
    .fetch_all(transaction.as_mut())
    .await
    .map_err(failed)?;
    if rows.is_empty() {
        return Ok(0);
    }
    let rows = rows
        .into_iter()
        .map(StoredEvaluation::parse)
        .collect::<Result<Vec<_>, _>>()?;
    let ids: Vec<i32> = rows.iter().map(|row| row.id).collect();
    let decisions: Vec<SummaryDecision> = sqlx::query_as(&format!(
        "SELECT evaluation_id, action, transaction_id, suggestion_visible, accepted_suggestion,
                proposal_payee_kept, proposal_category_kept, active_review_ms, decided_at
         FROM typesafe_decisions WHERE evaluation_id {} ORDER BY id",
        sql::in_integers("$1")
    ))
    .bind(sql::json_array(&ids))
    .fetch_all(transaction.as_mut())
    .await
    .map_err(failed)?;
    let archived: Option<String> = sqlx::query_scalar(
        "SELECT CAST(counts AS TEXT) FROM typesafe_aggregates WHERE book_id = $1",
    )
    .bind(book_id)
    .fetch_optional(transaction.as_mut())
    .await
    .map_err(failed)?;
    let mut counts = match archived {
        // In the order that jsonb gave, as the stored counts were read before.
        Some(text) => Counts::parse(
            &read_json_column(&text)
                .map_err(|cause| cause.to_string())?
                .to_string(),
        )?,
        None => Counts::default(),
    };
    counts.merge(&summarize(&rows, &decisions)?);
    sqlx::query(&format!(
        "INSERT INTO typesafe_aggregates (book_id, counts) VALUES ($1, {})
         ON CONFLICT (book_id) DO UPDATE SET counts = excluded.counts",
        sql::json("$2")
    ))
    .bind(book_id)
    .bind(counts.to_json())
    .execute(transaction.as_mut())
    .await
    .map_err(failed)?;
    sqlx::query(&format!(
        "DELETE FROM typesafe_evaluations WHERE id {}",
        sql::in_integers("$1")
    ))
    .bind(sql::json_array(&ids))
    .execute(transaction.as_mut())
    .await
    .map_err(failed)?;
    transaction.commit().await.map_err(failed)?;
    Ok(ids.len() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(text: &str) -> NaiveDateTime {
        NaiveDateTime::parse_from_str(text, "%Y-%m-%d %H:%M:%S").unwrap()
    }

    fn pick(choice: &str) -> Value {
        json!({ "choice": choice, "probabilities": { choice: 1 }, "confidence": 1 })
    }

    fn evaluation(id: i32) -> SummaryEvaluation {
        SummaryEvaluation {
            id,
            status: "ready".into(),
            snapshot: json!({
                "merchantSeenBefore": false,
                "baselineIds": [],
                "candidates": [],
                "payeeOptions": [{ "label": "payee_1", "payeeId": 3, "name": "X", "source": "existing" }],
                "categoryOptions": [{ "label": "category_1", "accountId": 7, "name": "Food", "kind": "expense" }],
                "baselineCategoryId": 7,
            }),
            choice: None,
            usage: None,
            answers: Some(json!({ "payee": pick("payee_1"), "category": pick("category_1") })),
            displayed_at: Some(at("2026-09-22 10:00:02")),
            latency_ms: Some(1000),
        }
    }

    fn decision(evaluation_id: i32, action: &str) -> SummaryDecision {
        SummaryDecision {
            evaluation_id: Some(evaluation_id),
            action: action.into(),
            transaction_id: None,
            suggestion_visible: true,
            accepted_suggestion: false,
            proposal_payee_kept: None,
            proposal_category_kept: None,
            active_review_ms: None,
            decided_at: at("2026-09-22 10:01:00"),
        }
    }

    #[test]
    fn proposals_count_one_click_creates_edits_and_other_outcomes() {
        let evaluations: Vec<_> = (1..=4).map(evaluation).collect();
        let decisions = vec![
            SummaryDecision {
                accepted_suggestion: true,
                proposal_payee_kept: Some(true),
                proposal_category_kept: Some(true),
                ..decision(1, "create")
            },
            SummaryDecision {
                proposal_payee_kept: Some(true),
                proposal_category_kept: Some(true),
                ..decision(2, "create")
            },
            SummaryDecision {
                proposal_payee_kept: Some(false),
                proposal_category_kept: Some(true),
                ..decision(3, "create")
            },
            decision(4, "ignore"),
        ];
        let counts = summarize(&evaluations, &decisions).unwrap();
        for (key, value) in [
            ("proposals", 4.0),
            ("proposals_displayed", 4.0),
            ("proposal_category_agrees_with_baseline", 4.0),
            ("proposal_one_click_creates", 1.0),
            ("proposal_edits_unchanged", 1.0),
            ("proposal_edits_changed", 1.0),
            ("proposal_edits_changed_payee", 1.0),
            ("proposal_shown_then_ignore", 1.0),
            ("latency_total_ms", 4000.0),
        ] {
            assert_eq!(counts.get(key), Some(value), "{key}");
        }
        assert_eq!(counts.get("proposal_edits_changed_category"), None);
    }

    #[test]
    fn a_v1_evaluation_without_answers_has_no_proposal() {
        let mut v1 = evaluation(5);
        v1.answers = None;
        let counts = summarize(&[v1], &[]).unwrap();
        assert_eq!(counts.get("evaluations"), Some(1.0));
        assert_eq!(counts.get("outcome_unknown"), Some(1.0));
        assert_eq!(counts.get("proposals"), None);
    }

    #[test]
    fn manual_matches_compare_with_the_baseline_and_the_choice() {
        let mut row = evaluation(6);
        row.answers = None;
        row.choice = Some("candidate_1".into());
        row.snapshot["baselineIds"] = json!([41, 42]);
        row.snapshot["candidates"] = json!([{ "label": "candidate_1", "transactionId": 42 }]);
        let decisions = vec![
            SummaryDecision {
                transaction_id: Some(42),
                ..decision(6, "match")
            },
            SummaryDecision {
                decided_at: at("2026-09-22 10:02:00"),
                ..decision(6, "unlink")
            },
        ];
        let counts = summarize(&[row], &decisions).unwrap();
        for key in [
            "differs_from_baseline",
            "manual_matches",
            "manual_match_in_candidates",
            "jev_agrees_with_user",
            "unseen_merchant_agrees_with_user",
            "subsequently_unlinked",
        ] {
            assert_eq!(counts.get(key), Some(1.0), "{key}");
        }
        assert_eq!(counts.get("baseline_agrees_with_user"), None);
    }

    #[test]
    fn counts_merge_into_archived_counts_and_serialize_as_javascript() {
        let mut archived = Counts::parse(r#"{"evaluations": 2, "odd": null}"#).unwrap();
        let mut added = Counts::default();
        added.add("evaluations", 1.0);
        added.add("latency_total_ms", 1.5);
        archived.merge(&added);
        assert_eq!(
            archived.to_json(),
            r#"{"evaluations":3,"odd":null,"latency_total_ms":1.5}"#
        );
    }
}
