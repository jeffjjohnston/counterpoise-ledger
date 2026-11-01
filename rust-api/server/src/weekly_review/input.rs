//! What a weekly review sends to Claude. `load` reads it from the book in
//! one read transaction. `document` makes the JSON document. Every name and
//! memo passes `redact_text`, as the text that goes to TypeSafe does.

use crate::typesafe_questions::redact_text;
use chrono::Datelike;
use ledger_db::{
    Database, Sql,
    sql::EFFECTIVE_DATE,
    store::{self, params},
};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashSet};

/// A larger week is cut, and the document says so (`truncated`).
pub(crate) const MAX_TRANSACTIONS: i64 = 1000;

#[derive(Debug, Clone, ledger_db::store::FromRow)]
pub(crate) struct AccountRow {
    pub(crate) id: i64,
    pub(crate) name: String,
    #[row(rename = "type")]
    pub(crate) kind: String,
    pub(crate) parent: Option<String>,
}

#[derive(Debug, Clone, ledger_db::store::FromRow)]
pub(crate) struct TransactionRow {
    pub(crate) id: i64,
    /// The effective date.
    pub(crate) day: String,
    pub(crate) payee: Option<String>,
    pub(crate) description: Option<String>,
    pub(crate) notes: Option<String>,
    pub(crate) is_floating: bool,
    pub(crate) is_reconciled: bool,
    pub(crate) recurring_rule_id: Option<i64>,
}

#[derive(Debug, Clone, ledger_db::store::FromRow)]
pub(crate) struct SplitRow {
    pub(crate) transaction_id: i64,
    pub(crate) account_id: i64,
    pub(crate) amount: i64,
}

#[derive(Debug, Clone, ledger_db::store::FromRow)]
pub(crate) struct InvestmentRow {
    pub(crate) transaction_id: i64,
    pub(crate) action: String,
    pub(crate) symbol: String,
    pub(crate) shares_micros: i64,
}

/// One month of one payee or one account: the sum of the income and
/// expense splits, in cents, and the number of transactions.
#[derive(Debug, Clone, ledger_db::store::FromRow)]
pub(crate) struct HistoryRow {
    pub(crate) month: String,
    pub(crate) name: String,
    pub(crate) total: i64,
    pub(crate) count: i64,
}

#[derive(Debug, Clone, ledger_db::store::FromRow)]
pub(crate) struct RuleRow {
    pub(crate) id: i64,
    pub(crate) name: String,
    pub(crate) payee: Option<String>,
    pub(crate) frequency: String,
    pub(crate) interval: i64,
    pub(crate) next_date: String,
}

#[derive(Debug, Clone, ledger_db::store::FromRow)]
pub(crate) struct TemplateRow {
    pub(crate) recurring_rule_id: i64,
    pub(crate) account_id: i64,
    pub(crate) amount: i64,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct ReviewInput {
    pub(crate) period_start: String,
    pub(crate) period_end: String,
    pub(crate) truncated: bool,
    pub(crate) accounts: Vec<AccountRow>,
    pub(crate) transactions: Vec<TransactionRow>,
    pub(crate) splits: Vec<SplitRow>,
    pub(crate) investments: Vec<InvestmentRow>,
    pub(crate) payee_history: Vec<HistoryRow>,
    pub(crate) account_history: Vec<HistoryRow>,
    pub(crate) rules: Vec<RuleRow>,
    pub(crate) templates: Vec<TemplateRow>,
}

/// Reads the data of one review. The history covers the 13 calendar months
/// before the month of `period_start`, up to the day before `period_start`.
pub(crate) fn load(
    database: &Database,
    book_id: i32,
    period_start: &str,
    period_end: &str,
) -> Result<ReviewInput, store::Error> {
    database.read_transaction(|tx| load_in(tx, book_id, period_start, period_end))
}

fn load_in(
    tx: &impl Sql,
    book_id: i32,
    period_start: &str,
    period_end: &str,
) -> Result<ReviewInput, store::Error> {
    let accounts: Vec<AccountRow> = tx.query(
        "SELECT a.id, a.name, a.type, p.name AS parent
         FROM accounts a LEFT JOIN accounts p ON p.id = a.parent_id AND p.book_id = a.book_id
         WHERE a.book_id = ?1 ORDER BY a.id",
        &params![book_id],
    )?;

    let period = params![book_id, period_start, period_end];
    let in_period = format!("t.book_id = ?1 AND {EFFECTIVE_DATE} BETWEEN ?2 AND ?3");
    let mut transactions: Vec<TransactionRow> = tx.query(
        &format!(
            "SELECT t.id, {EFFECTIVE_DATE} AS day, p.name AS payee, t.description, t.notes,
                    t.is_floating, t.is_reconciled, t.recurring_rule_id
             FROM transactions t LEFT JOIN payees p ON p.id = t.payee_id
             WHERE {in_period}
             ORDER BY day, t.id LIMIT {}",
            MAX_TRANSACTIONS + 1
        ),
        &period,
    )?;
    let truncated = transactions.len() as i64 > MAX_TRANSACTIONS;
    transactions.truncate(MAX_TRANSACTIONS as usize);

    let splits: Vec<SplitRow> = tx.query(
        &format!(
            "SELECT s.transaction_id, s.account_id, s.amount
             FROM transaction_splits s
             JOIN transactions t ON t.id = s.transaction_id AND t.book_id = s.book_id
             WHERE {in_period} ORDER BY s.id"
        ),
        &period,
    )?;

    let investments: Vec<InvestmentRow> = tx.query(
        &format!(
            "SELECT i.transaction_id, i.action, sec.symbol, i.shares_micros
             FROM investment_splits i
             JOIN securities sec ON sec.id = i.security_id AND sec.book_id = i.book_id
             JOIN transactions t ON t.id = i.transaction_id AND t.book_id = i.book_id
             WHERE {in_period} ORDER BY i.id"
        ),
        &period,
    )?;

    let history = |group: &str, name: &str| {
        format!(
            "SELECT strftime('%Y-%m', {EFFECTIVE_DATE}) AS month, {name} AS name,
                    CAST(SUM(s.amount) AS INTEGER) AS total, COUNT(DISTINCT t.id) AS count
             FROM transactions t
             JOIN transaction_splits s ON s.transaction_id = t.id AND s.book_id = t.book_id
             JOIN accounts a ON a.id = s.account_id AND a.book_id = s.book_id
             {group}
             WHERE t.book_id = ?1 AND a.type IN ('income', 'expense')
               AND {EFFECTIVE_DATE} >= ?2 AND {EFFECTIVE_DATE} < ?3
             GROUP BY month, {name} ORDER BY month, {name}"
        )
    };
    let (history_start, history_end) = history_window(period_start);
    let window = params![book_id, &history_start, &history_end];
    let payee_history: Vec<HistoryRow> = tx.query(
        &history("JOIN payees p ON p.id = t.payee_id", "p.name"),
        &window,
    )?;
    let account_history: Vec<HistoryRow> = tx.query(&history("", "a.name"), &window)?;

    let rules: Vec<RuleRow> = tx.query(
        "SELECT r.id, r.name, p.name AS payee, r.frequency, r.\"interval\" AS interval, r.next_date
         FROM recurring_rules r LEFT JOIN payees p ON p.id = r.payee_id
         WHERE r.book_id = ?1 AND r.is_active = 1 ORDER BY r.id",
        &params![book_id],
    )?;
    let templates: Vec<TemplateRow> = tx.query(
        "SELECT s.recurring_rule_id, s.account_id, s.amount
         FROM recurring_template_splits s
         JOIN recurring_rules r ON r.id = s.recurring_rule_id AND r.book_id = s.book_id
         WHERE s.book_id = ?1 AND r.is_active = 1 ORDER BY s.id",
        &params![book_id],
    )?;

    let (splits, investments) = kept_rows(&transactions, splits, investments);
    Ok(ReviewInput {
        period_start: period_start.to_owned(),
        period_end: period_end.to_owned(),
        truncated,
        accounts,
        splits,
        investments,
        transactions,
        payee_history,
        account_history,
        rules,
        templates,
    })
}

/// The history bounds, `[start, end)`: the 13 whole calendar months before
/// the month of `period_start`. A part of a month would look low next to the
/// whole months, and the model would report a false drop.
fn history_window(period_start: &str) -> (String, String) {
    let first = chrono::NaiveDate::parse_from_str(period_start, "%Y-%m-%d")
        .ok()
        .and_then(|day| day.with_day(1));
    let start = first.and_then(|day| day.checked_sub_months(chrono::Months::new(13)));
    let text = |day: Option<chrono::NaiveDate>| day.map(|day| day.to_string()).unwrap_or_default();
    (text(start), text(first))
}

/// The splits and investment rows of the transactions that the document
/// sends. A cut week sends only the first `MAX_TRANSACTIONS` rows.
fn kept_rows(
    transactions: &[TransactionRow],
    splits: Vec<SplitRow>,
    investments: Vec<InvestmentRow>,
) -> (Vec<SplitRow>, Vec<InvestmentRow>) {
    let sent: HashSet<i64> = transactions.iter().map(|row| row.id).collect();
    (
        splits
            .into_iter()
            .filter(|row| sent.contains(&row.transaction_id))
            .collect(),
        investments
            .into_iter()
            .filter(|row| sent.contains(&row.transaction_id))
            .collect(),
    )
}

/// Text that goes to Claude: redacted, and `None` when empty.
fn text(value: Option<&str>) -> Option<String> {
    let redacted = redact_text(value?).ok()?;
    let trimmed = redacted.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

/// A name that goes to Claude: redacted; empty when nothing is left.
fn name(value: &str) -> String {
    text(Some(value)).unwrap_or_default()
}

/// The user content of the request.
pub(crate) fn document(input: &ReviewInput) -> Value {
    let mut splits: BTreeMap<i64, Vec<Value>> = BTreeMap::new();
    for row in &input.splits {
        splits.entry(row.transaction_id).or_default().push(json!({
            "accountId": row.account_id,
            "amountCents": row.amount,
        }));
    }
    let mut investments: BTreeMap<i64, Vec<Value>> = BTreeMap::new();
    for row in &input.investments {
        investments
            .entry(row.transaction_id)
            .or_default()
            .push(json!({
                "action": row.action,
                "symbol": row.symbol,
                "shares": row.shares_micros as f64 / 1_000_000.0,
            }));
    }
    let mut amounts: BTreeMap<i64, Vec<Value>> = BTreeMap::new();
    for row in &input.templates {
        amounts
            .entry(row.recurring_rule_id)
            .or_default()
            .push(json!({
                "accountId": row.account_id,
                "amountCents": row.amount,
            }));
    }
    let transactions: Vec<Value> = input
        .transactions
        .iter()
        .map(|row| {
            let mut value = json!({
                "id": row.id,
                "date": row.day,
                "payee": row.payee.as_deref().map(name),
                "description": text(row.description.as_deref()),
                "memo": text(row.notes.as_deref()),
                "isFloating": row.is_floating,
                "isReconciled": row.is_reconciled,
                "recurringRuleId": row.recurring_rule_id,
                "splits": splits.remove(&row.id).unwrap_or_default(),
            });
            if let Some(investment) = investments.remove(&row.id) {
                value["investment"] = Value::Array(investment);
            }
            value
        })
        .collect();
    json!({
        "period": { "start": input.period_start, "end": input.period_end },
        "truncated": input.truncated,
        "accounts": input.accounts.iter().map(|row| json!({
            "id": row.id,
            "name": name(&row.name),
            "type": row.kind,
            "parent": row.parent.as_deref().map(name),
        })).collect::<Vec<_>>(),
        "transactions": transactions,
        "history": {
            "byPayee": input.payee_history.iter().map(|row| json!({
                "month": row.month, "payee": name(&row.name), "totalCents": row.total, "count": row.count,
            })).collect::<Vec<_>>(),
            "byAccount": input.account_history.iter().map(|row| json!({
                "month": row.month, "account": name(&row.name), "totalCents": row.total, "count": row.count,
            })).collect::<Vec<_>>(),
        },
        "recurringRules": input.rules.iter().map(|row| json!({
            "id": row.id,
            "name": name(&row.name),
            "payee": row.payee.as_deref().map(name),
            "frequency": row.frequency,
            "interval": row.interval,
            "nextDate": row.next_date,
            "amounts": amounts.remove(&row.id).unwrap_or_default(),
        })).collect::<Vec<_>>(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample() -> ReviewInput {
        ReviewInput {
            period_start: "2026-10-05".into(),
            period_end: "2026-10-11".into(),
            truncated: false,
            accounts: vec![
                AccountRow {
                    id: 1,
                    name: "Checking 12345678".into(),
                    kind: "asset".into(),
                    parent: None,
                },
                AccountRow {
                    id: 2,
                    name: "Groceries".into(),
                    kind: "expense".into(),
                    parent: Some("Food".into()),
                },
            ],
            transactions: vec![TransactionRow {
                id: 10,
                day: "2026-10-06".into(),
                payee: Some("Costco".into()),
                description: None,
                notes: Some("mail me at a@b.com".into()),
                is_floating: false,
                is_reconciled: true,
                recurring_rule_id: None,
            }],
            splits: vec![
                SplitRow {
                    transaction_id: 10,
                    account_id: 2,
                    amount: 14210,
                },
                SplitRow {
                    transaction_id: 10,
                    account_id: 1,
                    amount: -14210,
                },
            ],
            investments: vec![],
            payee_history: vec![HistoryRow {
                month: "2026-09".into(),
                name: "Costco".into(),
                total: 30000,
                count: 2,
            }],
            account_history: vec![HistoryRow {
                month: "2026-09".into(),
                name: "Groceries".into(),
                total: 52000,
                count: 9,
            }],
            rules: vec![RuleRow {
                id: 4,
                name: "Rent".into(),
                payee: None,
                frequency: "monthly".into(),
                interval: 1,
                next_date: "2026-11-01".into(),
            }],
            templates: vec![TemplateRow {
                recurring_rule_id: 4,
                account_id: 1,
                amount: -150000,
            }],
        }
    }

    #[test]
    fn the_document_has_the_period_the_accounts_and_the_transactions_with_their_splits() {
        let document = document(&sample());
        assert_eq!(
            document["period"],
            json!({ "start": "2026-10-05", "end": "2026-10-11" })
        );
        assert_eq!(
            document["accounts"][1],
            json!({ "id": 2, "name": "Groceries", "type": "expense", "parent": "Food" })
        );
        assert_eq!(document["transactions"][0]["payee"], json!("Costco"));
        assert_eq!(
            document["transactions"][0]["splits"],
            json!([
                { "accountId": 2, "amountCents": 14210 },
                { "accountId": 1, "amountCents": -14210 },
            ])
        );
        assert_eq!(
            document["recurringRules"][0]["amounts"],
            json!([{ "accountId": 1, "amountCents": -150000 }])
        );
        assert_eq!(
            document["history"]["byPayee"][0],
            json!({ "month": "2026-09", "payee": "Costco", "totalCents": 30000, "count": 2 })
        );
        assert_eq!(
            document["history"]["byAccount"][0]["account"],
            json!("Groceries")
        );
    }

    #[test]
    fn the_document_redacts_emails_and_long_digit_runs() {
        let document = document(&sample());
        assert_eq!(
            document["transactions"][0]["memo"],
            json!("mail me at [email]")
        );
        assert_eq!(
            document["accounts"][0]["name"],
            json!("Checking [reference]")
        );
        assert!(!document.to_string().contains("12345678"));
    }

    #[test]
    fn the_document_sends_shares_as_a_number_of_shares() {
        let mut input = sample();
        input.investments = vec![InvestmentRow {
            transaction_id: 10,
            action: "buy".into(),
            symbol: "VTI".into(),
            shares_micros: 1_500_000,
        }];
        assert_eq!(
            document(&input)["transactions"][0]["investment"],
            json!([{ "action": "buy", "symbol": "VTI", "shares": 1.5 }])
        );
    }

    fn row(id: i64, day: &str) -> TransactionRow {
        TransactionRow {
            id,
            day: day.into(),
            payee: None,
            description: None,
            notes: None,
            is_floating: false,
            is_reconciled: false,
            recurring_rule_id: None,
        }
    }

    #[test]
    fn a_cut_week_keeps_the_splits_of_each_sent_transaction() {
        // Ordered by day, then ID: an early day can hold a high ID.
        let sent = vec![row(50, "2026-10-05"), row(7, "2026-10-06")];
        let split = |transaction_id| SplitRow {
            transaction_id,
            account_id: 1,
            amount: 1,
        };
        let (splits, _) = kept_rows(&sent, vec![split(50), split(7), split(8)], vec![]);
        let ids: Vec<i64> = splits.iter().map(|row| row.transaction_id).collect();
        assert_eq!(ids, vec![50, 7]);
    }

    #[test]
    fn the_history_is_the_13_whole_months_before_the_month_of_the_period() {
        assert_eq!(
            history_window("2026-10-05"),
            ("2025-09-01".to_owned(), "2026-10-01".to_owned())
        );
        assert_eq!(
            history_window("2026-03-30"),
            ("2025-02-01".to_owned(), "2026-03-01".to_owned())
        );
    }
}
