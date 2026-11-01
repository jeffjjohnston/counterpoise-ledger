//! The patterns of a payee in one account, for the manual entry fill
//! (guides/typesafe-experiment.md, "Entry suggestions"). `load` reads the
//! uses; the other functions are pure: they group the uses, and build the
//! snapshot, the state and the question of a TypeSafe request.

use crate::platform;
use crate::typesafe_questions::{LoneSurrogate, TYPESAFE_MODEL, UNTRUSTED, question, redact_text};
use chrono::{Datelike, NaiveDate};
use ledger_db::sql::EFFECTIVE_DATE;
use ledger_db::store::{self, Sql, params};
use serde_json::{Map, Value, json};
use std::collections::HashMap;

pub(crate) const MAX_PATTERNS: usize = 8;
const STABLE_USES: usize = 3;
const RANGE_USES: usize = 12;

/// One transaction of the payee that has a split on the account.
pub(crate) struct Use {
    pub(crate) date: String,
    /// `(account_id, amount)` in cents, every split of the transaction.
    pub(crate) splits: Vec<(i64, i64)>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Pattern {
    pub(crate) key: String,
    /// Every split of the latest use, the splits on the account included.
    pub(crate) splits: Vec<(i64, i64)>,
    pub(crate) count: usize,
    pub(crate) last_date: String,
    pub(crate) stable: bool,
    /// Min and max of the absolute net amount on the account.
    pub(crate) range: (i64, i64),
}

/// The sum of the splits on the account.
pub(crate) fn net_amount(account_id: i64, splits: &[(i64, i64)]) -> i64 {
    splits
        .iter()
        .filter(|(id, _)| *id == account_id)
        .map(|(_, amount)| amount)
        .sum()
}

/// The sorted `(other account, direction)` list, as `"10:in|12:out"`. A
/// transaction with no other split has no pattern.
pub(crate) fn pattern_key(account_id: i64, splits: &[(i64, i64)]) -> Option<String> {
    let mut parts: Vec<(i64, &str)> = splits
        .iter()
        .filter(|(id, _)| *id != account_id)
        .map(|(id, amount)| (*id, if *amount >= 0 { "in" } else { "out" }))
        .collect();
    if parts.is_empty() {
        return None;
    }
    parts.sort();
    parts.dedup();
    Some(
        parts
            .iter()
            .map(|(id, direction)| format!("{id}:{direction}"))
            .collect::<Vec<_>>()
            .join("|"),
    )
}

fn sorted(splits: &[(i64, i64)]) -> Vec<(i64, i64)> {
    let mut splits = splits.to_vec();
    splits.sort();
    splits
}

/// Groups the uses (newest first) into patterns: newest last use first, then
/// key, at most `MAX_PATTERNS`.
pub(crate) fn group(account_id: i64, uses: &[Use]) -> Vec<Pattern> {
    let mut order: Vec<String> = Vec::new();
    let mut members: HashMap<String, Vec<&Use>> = HashMap::new();
    for item in uses {
        let Some(key) = pattern_key(account_id, &item.splits) else {
            continue;
        };
        if !members.contains_key(&key) {
            order.push(key.clone());
        }
        members.entry(key).or_default().push(item);
    }
    let mut patterns: Vec<Pattern> = order
        .into_iter()
        .map(|key| {
            let list = &members[&key];
            let latest = list[0];
            let recent = &list[..list.len().min(STABLE_USES)];
            let stable = list.len() >= 2
                && recent
                    .iter()
                    .all(|item| sorted(&item.splits) == sorted(&latest.splits));
            let amounts: Vec<i64> = list
                .iter()
                .take(RANGE_USES)
                .map(|item| net_amount(account_id, &item.splits).abs())
                .collect();
            Pattern {
                key,
                splits: latest.splits.clone(),
                count: list.len(),
                last_date: latest.date.clone(),
                stable,
                range: (
                    *amounts.iter().min().unwrap_or(&0),
                    *amounts.iter().max().unwrap_or(&0),
                ),
            }
        })
        .collect();
    patterns.sort_by(|a, b| {
        b.last_date
            .cmp(&a.last_date)
            .then_with(|| a.key.cmp(&b.key))
    });
    patterns.truncate(MAX_PATTERNS);
    patterns
}

const MAX_USES: i64 = 200;

/// The uses of the payee in the account, newest first: the latest 200 with an
/// effective date in the 24 months up to today, without investment splits.
pub(crate) fn load(
    sql: &impl Sql,
    book_id: i32,
    payee_id: i64,
    account_id: i64,
) -> Result<Vec<Use>, store::Error> {
    // One date for the whole statement.
    let today = platform::today();
    let effective_date = EFFECTIVE_DATE.on(today);
    let today = ledger_db::sql::date_literal(today);
    let rows: Vec<(i64, String, String)> = sql.query(
        &format!(
            "WITH picked AS (
           SELECT t.id, {effective_date} AS day FROM transactions t
           WHERE t.book_id = ?1 AND t.payee_id = ?2
             AND EXISTS (SELECT 1 FROM transaction_splits s
                         WHERE s.transaction_id = t.id AND s.account_id = ?3)
             AND NOT EXISTS (SELECT 1 FROM investment_splits i WHERE i.transaction_id = t.id)
             AND {effective_date} > date({today}, '-24 months')
             AND {effective_date} <= {today}
           ORDER BY day DESC, t.id DESC LIMIT ?4
         )
         SELECT p.id, p.day, json_group_array(json_array(s.account_id, s.amount)) AS splits
         FROM picked p JOIN transaction_splits s ON s.transaction_id = p.id
         GROUP BY p.id, p.day
         ORDER BY p.day DESC, p.id DESC"
        ),
        &params![book_id, payee_id, account_id, MAX_USES],
    )?;
    Ok(rows
        .into_iter()
        .map(|(_, date, splits)| Use {
            date,
            splits: serde_json::from_str::<Vec<(i64, i64)>>(&splits).unwrap_or_default(),
        })
        .collect())
}

/// A pattern as the route answers it.
pub(crate) fn pattern_json(pattern: &Pattern) -> Value {
    json!({
        "key": pattern.key,
        "splits": pattern
            .splits
            .iter()
            .map(|(account_id, amount)| json!({ "accountId": account_id, "amount": amount }))
            .collect::<Vec<_>>(),
        "count": pattern.count,
        "lastDate": pattern.last_date,
        "stable": pattern.stable,
        "range": { "min": pattern.range.0, "max": pattern.range.1 },
    })
}

pub(crate) const ENTRY_PROMPT_VERSION: &str = "entry-pattern-v1";
const HISTORY_USES: usize = 12;

#[derive(Clone)]
pub(crate) struct AccountInfo {
    pub(crate) name: String,
    pub(crate) kind: String,
    pub(crate) subtype: Option<String>,
}

pub(crate) struct Entry {
    pub(crate) payee: String,
    pub(crate) date: NaiveDate,
    /// The typed amount in cents, negative when money leaves the account.
    pub(crate) amount: Option<i64>,
    pub(crate) account: AccountInfo,
}

/// Income and expense accounts by name; asset and liability accounts by kind
/// only (the reconciliation rule).
fn shown_name(account: &AccountInfo) -> Value {
    match account.kind.as_str() {
        "income" | "expense" => json!(account.name),
        _ => Value::Null,
    }
}

/// The stored input of an evaluation, unredacted. `entry_state` and
/// `entry_question` redact what they send.
pub(crate) fn snapshot(
    revision: i32,
    account_id: i64,
    payee_id: i64,
    entry: &Entry,
    patterns: &[Pattern],
    uses: &[Use],
    accounts: &HashMap<i64, AccountInfo>,
) -> Value {
    let label = |key: &str| {
        patterns
            .iter()
            .position(|p| p.key == key)
            .map(|i| format!("P{}", i + 1))
            .unwrap_or_else(|| "other".into())
    };
    let options: Vec<Value> = patterns
        .iter()
        .enumerate()
        .map(|(i, pattern)| {
            let others: Vec<Value> = pattern
                .splits
                .iter()
                .filter(|(id, _)| *id != account_id)
                .map(|(id, amount)| {
                    let account = accounts.get(id);
                    json!({
                        "name": account.map_or(Value::Null, shown_name),
                        "kind": account.map(|a| a.kind.clone()),
                        "subtype": account.and_then(|a| a.subtype.clone()),
                        "direction": if *amount >= 0 { "in" } else { "out" },
                    })
                })
                .collect();
            json!({
                "label": format!("P{}", i + 1),
                "key": pattern.key,
                "accounts": others,
                "count": pattern.count,
                "lastDate": pattern.last_date,
                "amount": pattern.stable.then(|| net_amount(account_id, &pattern.splits).abs()),
                "range": { "min": pattern.range.0, "max": pattern.range.1 },
                "stable": pattern.stable,
            })
        })
        .collect();
    let history: Vec<Value> = uses
        .iter()
        .take(HISTORY_USES)
        .rev()
        .filter_map(|item| {
            let key = pattern_key(account_id, &item.splits)?;
            Some(json!({ "date": item.date, "option": label(&key), "amount": net_amount(account_id, &item.splits) }))
        })
        .collect();
    json!({
        "prompt": ENTRY_PROMPT_VERSION,
        "model": TYPESAFE_MODEL,
        "revision": revision,
        "accountId": account_id,
        "payeeId": payee_id,
        "entry": {
            "payee": entry.payee,
            "date": entry.date.format("%Y-%m-%d").to_string(),
            "weekday": entry.date.format("%A").to_string(),
            "dayOfMonth": entry.date.day(),
            "account": { "kind": entry.account.kind, "subtype": entry.account.subtype },
            "amount": entry.amount.map(|cents| json!({
                "cents": cents.abs(),
                "direction": if cents < 0 { "out" } else { "in" },
            })),
        },
        "options": options,
        "history": history,
        "baselineKey": patterns.first().map(|p| p.key.clone()),
    })
}

fn redact_value(value: &Value) -> Result<Value, LoneSurrogate> {
    Ok(match value {
        Value::String(text) => Value::String(redact_text(text)?),
        other => other.clone(),
    })
}

/// The state sent to TypeSafe: the entry and the history, redacted.
pub(crate) fn entry_state(snapshot: &Value) -> Result<Value, LoneSurrogate> {
    let mut entry = snapshot["entry"].clone();
    entry["payee"] = redact_value(&entry["payee"])?;
    Ok(json!({ "entry": entry, "history": snapshot["history"] }))
}

/// The one Choice question: which listed pattern the entry follows.
pub(crate) fn entry_question(snapshot: &Value) -> Result<(&'static str, Value), LoneSurrogate> {
    let mut criteria = Map::new();
    for option in snapshot["options"].as_array().into_iter().flatten() {
        let mut accounts = Vec::new();
        for account in option["accounts"].as_array().into_iter().flatten() {
            let mut account = account.clone();
            account["name"] = redact_value(&account["name"])?;
            accounts.push(account);
        }
        let label = option["label"].as_str().unwrap_or_default().to_owned();
        criteria.insert(
            label,
            json!({
                "accounts": accounts,
                "uses": option["count"],
                "lastDate": option["lastDate"],
                "amount": option["amount"],
                "range": option["range"],
                "stable": option["stable"],
            }),
        );
    }
    criteria.insert(
        "none".into(),
        json!("No listed pattern fits this new transaction better than the others."),
    );
    Ok((
        "pattern",
        question(
            criteria,
            format!(
                "The user is entering a new transaction for `entry.payee` on `entry.date`. Each option is a pattern of accounts that this payee used before in this account. Which pattern will this new transaction follow? Use `history` (oldest first) for alternation and day-of-month rules, and `entry.amount` when it is given. Choose none when the history gives no reason to prefer one option. {UNTRUSTED}"
            ),
        ),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    const CHECKING: i64 = 1;
    const GROCERIES: i64 = 10;
    const HOUSEHOLD: i64 = 11;
    const TAX: i64 = 12;

    fn spend(date: &str, to: i64, amount: i64) -> Use {
        Use {
            date: date.into(),
            splits: vec![(to, amount), (CHECKING, -amount)],
        }
    }

    #[test]
    fn the_key_lists_the_other_accounts_and_their_direction() {
        assert_eq!(
            pattern_key(CHECKING, &[(GROCERIES, 500), (CHECKING, -500)]).as_deref(),
            Some("10:in")
        );
        assert_eq!(
            pattern_key(CHECKING, &[(TAX, 50), (GROCERIES, 450), (CHECKING, -500)]).as_deref(),
            Some("10:in|12:in")
        );
        assert_eq!(
            pattern_key(CHECKING, &[(CHECKING, 500), (CHECKING, -500)]),
            None
        );
    }

    #[test]
    fn net_amount_of_two_splits_on_the_account() {
        assert_eq!(
            net_amount(
                CHECKING,
                &[(CHECKING, -900), (CHECKING, 400), (GROCERIES, 500)]
            ),
            -500
        );
    }

    #[test]
    fn groups_newest_first_and_keeps_the_latest_splits() {
        let uses = [
            spend("2026-10-01", GROCERIES, 4210),
            spend("2026-09-20", HOUSEHOLD, 9000),
            spend("2026-09-10", GROCERIES, 3120),
        ];
        let patterns = group(CHECKING, &uses);
        assert_eq!(
            patterns.iter().map(|p| p.key.as_str()).collect::<Vec<_>>(),
            ["10:in", "11:in"]
        );
        assert_eq!(
            patterns[0].splits,
            vec![(GROCERIES, 4210), (CHECKING, -4210)]
        );
        assert_eq!(patterns[0].count, 2);
        assert_eq!(patterns[0].last_date, "2026-10-01");
        assert_eq!(patterns[0].range, (3120, 4210));
    }

    #[test]
    fn stable_needs_two_uses_with_the_same_amounts() {
        let one = group(CHECKING, &[spend("2026-10-01", GROCERIES, 1599)]);
        assert!(!one[0].stable);
        let two = group(
            CHECKING,
            &[
                spend("2026-10-01", GROCERIES, 1599),
                spend("2026-09-01", GROCERIES, 1599),
            ],
        );
        assert!(two[0].stable);
        let changed = group(
            CHECKING,
            &[
                spend("2026-10-01", GROCERIES, 1599),
                spend("2026-09-01", GROCERIES, 1599),
                spend("2026-08-01", GROCERIES, 1499),
            ],
        );
        assert!(!changed[0].stable);
        let old_change = group(
            CHECKING,
            &[
                spend("2026-10-01", GROCERIES, 1599),
                spend("2026-09-01", GROCERIES, 1599),
                spend("2026-08-01", GROCERIES, 1599),
                spend("2026-07-01", GROCERIES, 1499),
            ],
        );
        assert!(old_change[0].stable, "only the last 3 uses count");
    }

    #[test]
    fn the_range_uses_the_last_12_uses() {
        let mut uses: Vec<Use> = (0..12)
            .map(|i| spend("2026-10-01", GROCERIES, 1000 + i))
            .collect();
        uses.push(spend("2025-01-01", GROCERIES, 99_999));
        assert_eq!(group(CHECKING, &uses)[0].range, (1000, 1011));
    }

    #[test]
    fn keeps_at_most_8_patterns_ordered_by_last_use_then_key() {
        let uses: Vec<Use> = (0..10).map(|i| spend("2026-10-01", 100 + i, 500)).collect();
        let patterns = group(CHECKING, &uses);
        assert_eq!(patterns.len(), MAX_PATTERNS);
        assert_eq!(patterns[0].key, "100:in");
        assert_eq!(patterns[1].key, "101:in");
    }

    #[test]
    fn money_in_has_the_out_direction_on_the_other_account() {
        let refund = Use {
            date: "2026-10-01".into(),
            splits: vec![(CHECKING, 700), (GROCERIES, -700)],
        };
        assert_eq!(group(CHECKING, &[refund])[0].key, "10:out");
    }

    fn info(id: i64, name: &str, kind: &str, subtype: Option<&str>) -> (i64, AccountInfo) {
        let account = AccountInfo {
            name: name.into(),
            kind: kind.into(),
            subtype: subtype.map(Into::into),
        };
        (id, account)
    }

    fn sample() -> Value {
        let accounts: HashMap<i64, AccountInfo> = [
            info(CHECKING, "Checking 12345678", "asset", Some("bank")),
            info(GROCERIES, "Groceries jo@example.com", "expense", None),
            info(HOUSEHOLD, "Household", "expense", None),
        ]
        .into_iter()
        .collect();
        let uses = [
            spend("2026-10-01", GROCERIES, 4210),
            spend("2026-09-20", HOUSEHOLD, 9000),
            spend("2026-09-10", GROCERIES, 4210),
        ];
        let patterns = group(CHECKING, &uses);
        let entry = Entry {
            payee: "Costco 1234567".into(),
            date: chrono::NaiveDate::from_ymd_opt(2026, 10, 12).unwrap(),
            amount: Some(5000),
            account: accounts[&CHECKING].clone(),
        };
        snapshot(4, CHECKING, 7, &entry, &patterns, &uses, &accounts)
    }

    #[test]
    fn the_snapshot_labels_the_patterns_and_hides_asset_names() {
        let value = sample();
        assert_eq!(value["prompt"], json!(ENTRY_PROMPT_VERSION));
        assert_eq!(value["baselineKey"], json!("10:in"));
        assert_eq!(value["entry"]["weekday"], json!("Monday"));
        assert_eq!(value["entry"]["dayOfMonth"], json!(12));
        assert_eq!(
            value["entry"]["account"],
            json!({ "kind": "asset", "subtype": "bank" })
        );
        assert_eq!(value["options"][0]["label"], json!("P1"));
        assert_eq!(
            value["options"][0]["amount"],
            json!(4210),
            "stable: two equal uses"
        );
        assert_eq!(value["options"][1]["amount"], Value::Null);
        assert_eq!(
            value["options"][0]["accounts"],
            json!([{ "name": "Groceries jo@example.com", "kind": "expense", "subtype": null, "direction": "in" }])
        );
        assert_eq!(
            value["history"],
            json!([
                { "date": "2026-09-10", "option": "P1", "amount": -4210 },
                { "date": "2026-09-20", "option": "P2", "amount": -9000 },
                { "date": "2026-10-01", "option": "P1", "amount": -4210 },
            ])
        );
        assert!(!value.to_string().contains("Checking"));
    }

    #[test]
    fn the_state_and_the_question_are_redacted() {
        let value = sample();
        let state = entry_state(&value).unwrap();
        assert_eq!(state["entry"]["payee"], json!("Costco [reference]"));
        let (id, question) = entry_question(&value).unwrap();
        assert_eq!(id, "pattern");
        let criteria = question["criteria"].as_object().unwrap();
        assert_eq!(criteria.keys().collect::<Vec<_>>(), ["P1", "P2", "none"]);
        assert_eq!(
            criteria["P1"]["accounts"][0]["name"],
            json!("Groceries [email]")
        );
        assert!(
            !state.to_string().contains("key"),
            "the internal key is not sent"
        );
    }
}
