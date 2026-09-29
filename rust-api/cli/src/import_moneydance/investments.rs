//! Phase 4: investment transactions.
//!
//! This phase writes the transactions, their ledger splits and their
//! investment splits. It writes no lots and no allocations: those are derived
//! state, and the lot rebuild writes them after the stock splits.

use std::collections::HashMap;

use sqlx::{Connection, PgConnection};

use super::transactions::{payee_of, validation_errors};
use super::values::{
    Item, convert_date, field, int, is_transaction_reconciled, normalize_optional_text,
    price_from_transaction, split_indexes, text,
};
use super::{
    ImportContext, NewInvestmentSplit, NewTransaction, RowError, describe, finish,
    insert_investment_split, insert_splits, insert_transaction, item_id,
};

const TYPES: [&str; 5] = [
    "xfrtp_buysell",
    "xfrtp_buysellxfr",
    "xfrtp_dividend",
    "xfrtp_capgain",
    "xfrtp_miscincexp",
];

fn is_investment(transaction: &Item) -> bool {
    field(transaction, "xfer_type").is_some_and(|kind| TYPES.contains(&&*kind))
}

/// The share precision of each security account: the `dec` of the currency
/// record that its `curr` names, or 5.
fn precisions(items: &[&Item]) -> HashMap<String, f64> {
    let mut currencies: HashMap<String, f64> = HashMap::new();
    for item in items {
        if text(item, "obj_type").as_deref() != Some("curr") {
            continue;
        }
        if let (Some(old_id), Some(dec)) = (field(item, "old_id"), field(item, "dec")) {
            currencies.insert(old_id.into_owned(), int(&dec));
        }
    }
    let mut precisions = HashMap::new();
    for item in items {
        if text(item, "obj_type").as_deref() != Some("acct")
            || text(item, "type").as_deref() != Some("s")
        {
            continue;
        }
        let Some(currency) = field(item, "curr") else {
            continue;
        };
        let Some(id) = text(item, "id") else { continue };
        precisions.insert(
            id.into_owned(),
            or_five(currencies.get(&*currency).copied()),
        );
    }
    precisions
}

/// `value || 5`: a missing, zero or NaN precision is 5.
fn or_five(value: Option<f64>) -> f64 {
    value
        .filter(|value| *value != 0.0 && !value.is_nan())
        .unwrap_or(5.0)
}

/// One numbered split of an investment transaction. `samt` and `pamt` are
/// `None` when the field is falsy, as `undefined` is in the TypeScript.
struct Split {
    kind: String,
    samt: Option<f64>,
    pamt: Option<f64>,
    account: Option<String>,
    security: Option<String>,
}

/// Every numbered split, with its type. An unreadable `pamt` stops the
/// transaction, as `convertAmount` throws.
fn extract_splits(transaction: &Item) -> Result<Vec<Split>, String> {
    split_indexes(transaction)
        .into_iter()
        .map(|index| {
            let get = |name: &str| field(transaction, &format!("{index}.{name}"));
            let pamt = match get("pamt") {
                Some(value) => {
                    let amount = int(&value);
                    if amount.is_nan() {
                        return Err(format!("Invalid amount: {value}"));
                    }
                    Some(amount)
                }
                None => None,
            };
            Ok(Split {
                kind: get("invest.splittype")
                    .map_or_else(|| "unknown".to_owned(), |kind| kind.into_owned()),
                samt: get("samt").map(|value| int(&value)),
                pamt,
                account: get("acctid").map(|value| value.into_owned()),
                security: get("secid").map(|value| value.into_owned()),
            })
        })
        .collect()
}

/// JavaScript truthiness of a parsed amount: `None`, zero and NaN are false.
fn truthy(value: Option<f64>) -> bool {
    value.is_some_and(|value| value != 0.0 && !value.is_nan())
}

fn action_of(transaction: &Item, security: &Split) -> &'static str {
    match field(transaction, "xfer_type").as_deref() {
        Some("xfrtp_dividend") => "dividend",
        Some("xfrtp_capgain") => "capGain",
        _ if truthy(security.samt) => {
            if security.samt.unwrap_or(0.0) > 0.0 {
                "buy"
            } else {
                "sell"
            }
        }
        _ => "buy",
    }
}

#[derive(Default)]
pub struct InvestmentStats {
    pub imported: usize,
    pub skipped: usize,
    pub buys: usize,
    pub sells: usize,
    pub dividends: usize,
    pub errors: Vec<(String, String)>,
}

impl InvestmentStats {
    fn count(&mut self, action: &str, samt: Option<f64>) {
        match action {
            "buy" if truthy(samt) && samt.unwrap_or(0.0) > 0.0 => self.buys += 1,
            "sell" => self.sells += 1,
            "dividend" => self.dividends += 1,
            _ => {}
        }
    }
}

/// The counts that one written transaction adds. They are applied only after
/// the savepoint is released, so a rolled-back write counts nothing.
#[derive(Default)]
struct Counted {
    buys: usize,
    sells: usize,
    dividends: usize,
    imported: usize,
}

/// What every write needs, resolved before the savepoint opens.
struct Resolved<'a> {
    transaction: &'a Item,
    splits: Vec<Split>,
    security_index: usize,
    security_id: i32,
    account_id: i32,
    cash_id: Option<i32>,
    action: &'static str,
    date: String,
    payee_id: Option<i32>,
    /// `samt` in share micros, from the security's precision.
    shares_micros: f64,
    /// The income account of an `inc` split, when it is imported.
    income_account: Option<i32>,
}

impl Resolved<'_> {
    fn security(&self) -> &Split {
        &self.splits[self.security_index]
    }

    fn find(&self, kind: &str) -> Option<&Split> {
        self.splits.iter().find(|split| split.kind == kind)
    }

    fn new_transaction(&self, description: Option<String>) -> NewTransaction {
        NewTransaction {
            date: self.date.clone(),
            description,
            check_number: normalize_optional_text(text(self.transaction, "chk").as_deref()),
            payee_id: self.payee_id,
            is_reconciled: is_transaction_reconciled(self.transaction),
        }
    }

    /// The price in micros, from the absolute `pamt` and share count.
    fn price_micros(&self) -> f64 {
        let (pamt, shares) = (
            self.security().pamt.unwrap_or(0.0).abs(),
            self.shares_micros.abs(),
        );
        if shares > 0.0 {
            price_from_transaction(pamt, shares)
        } else {
            0.0
        }
    }

    fn fees_cents(&self) -> f64 {
        self.find("fee")
            .and_then(|fee| fee.pamt.filter(|pamt| *pamt != 0.0))
            .map_or(0.0, f64::abs)
    }
}

pub async fn import_investment_transactions(
    connection: &mut PgConnection,
    context: &mut ImportContext,
    transactions: &[&Item],
    all_items: &[&Item],
) -> Result<InvestmentStats, sqlx::Error> {
    context.heading("📈 Phase 4: Importing Investment Transactions");
    let mut stats = InvestmentStats::default();
    let precisions = precisions(all_items);
    let mut investments: Vec<&Item> = transactions
        .iter()
        .copied()
        .filter(|item| is_investment(item))
        .collect();
    println!("Found {} investment transactions", investments.len());
    if investments.is_empty() {
        println!("No investment transactions to import");
        return Ok(stats);
    }
    // A stable sort by date string, so the rows go in chronological order.
    let date_of = |item: &Item| {
        text(item, "dt")
            .map(|dt| dt.into_owned())
            .unwrap_or_default()
    };
    investments.sort_by_cached_key(|item| date_of(item));

    if context.options.dry_run {
        println!("  [DRY RUN] Would import investment transactions:");
        for (index, transaction) in investments.iter().enumerate() {
            let splits = extract_splits(transaction).unwrap_or_default();
            let security = splits.iter().find(|split| split.kind == "sec");
            let action = security.map_or("unknown", |security| action_of(transaction, security));
            if index < 5 {
                println!(
                    "    {} - {} {}",
                    date_of(transaction),
                    action.to_uppercase(),
                    describe(transaction)
                );
            }
            stats.count(action, security.and_then(|security| security.samt));
        }
        if investments.len() > 5 {
            println!("    ... and {} more", investments.len() - 5);
        }
        stats.imported = investments.len();
    } else {
        println!("\nCreating transactions...");
        let total = investments.len();
        for (count, transaction) in investments.iter().enumerate() {
            let resolved = match resolve(context, transaction, &precisions) {
                Ok(resolved) => resolved,
                Err(Skip::Skipped(message)) => {
                    context.verbose(format!("  ⊗ Skipped {}: {message}", item_id(transaction)));
                    stats.errors.push((item_id(transaction), message));
                    stats.skipped += 1;
                    continue;
                }
                Err(Skip::Failed(message)) => {
                    if context.options.verbose {
                        eprintln!(
                            "  ✗ Error importing transaction {}: {message}",
                            item_id(transaction)
                        );
                    }
                    stats.errors.push((item_id(transaction), message));
                    continue;
                }
            };
            let reinvestment = resolved.action == "dividend" && truthy(resolved.security().samt);
            let mut savepoint = connection.begin().await?;
            let outcome = if reinvestment {
                write_reinvestment(&mut savepoint, context.book_id, context.now, &resolved).await
            } else {
                write_investment(&mut savepoint, context, &resolved).await
            };
            match finish(savepoint, outcome).await? {
                Ok(counted) => {
                    stats.buys += counted.buys;
                    stats.sells += counted.sells;
                    stats.dividends += counted.dividends;
                    if reinvestment {
                        stats.imported += counted.imported;
                        context.verbose(format!(
                            "  ✓ {} - DIVIDEND REINVESTMENT {} (split into 2 txns)",
                            resolved.date,
                            describe(transaction)
                        ));
                        continue;
                    }
                    stats.imported += 1;
                    if context.options.verbose {
                        println!(
                            "  ✓ {} - {} {}",
                            resolved.date,
                            resolved.action.to_uppercase(),
                            describe(transaction)
                        );
                    } else if (count + 1) % 200 == 0 {
                        println!(
                            "  Progress: {}/{total} ({:.1}%)...",
                            count + 1,
                            (count + 1) as f64 / total as f64 * 100.0
                        );
                    }
                }
                Err(message) => {
                    if context.options.verbose {
                        eprintln!(
                            "  ✗ Error importing transaction {}: {message}",
                            item_id(transaction)
                        );
                    }
                    stats.errors.push((item_id(transaction), message));
                }
            }
        }
    }

    println!("\n📊 Investment Transactions Import Summary:");
    println!("  Total transactions: {total}", total = investments.len());
    println!("  Imported: {}", stats.imported);
    println!("  Buys: {}", stats.buys);
    println!("  Sells: {}", stats.sells);
    println!("  Dividends: {}", stats.dividends);
    println!("  Skipped: {}", stats.skipped);
    println!("  Errors: {}", stats.errors.len());
    if !stats.errors.is_empty() {
        println!("\n  Sample errors:");
        let mut groups: Vec<(&str, usize)> = Vec::new();
        for (_, message) in &stats.errors {
            let key = message.split(':').next().unwrap_or_default();
            match groups.iter_mut().find(|(group, _)| *group == key) {
                Some((_, count)) => *count += 1,
                None => groups.push((key, 1)),
            }
        }
        for (group, count) in groups {
            println!("    {group}: {count} occurrences");
        }
        println!("\n  First few errors:");
        for (id, message) in stats.errors.iter().take(5) {
            println!("    {id}: {message}");
        }
    }
    Ok(stats)
}

/// Why a transaction is not written. A skip counts as skipped and as an
/// error; a failure counts only as an error, as in the TypeScript.
enum Skip {
    Skipped(String),
    Failed(String),
}

fn resolve<'a>(
    context: &ImportContext,
    transaction: &'a Item,
    precisions: &HashMap<String, f64>,
) -> Result<Resolved<'a>, Skip> {
    let errors = validation_errors(transaction);
    if !errors.is_empty() {
        return Err(Skip::Skipped(errors.join(", ")));
    }
    let splits = extract_splits(transaction).map_err(Skip::Failed)?;
    if splits.is_empty() {
        return Err(Skip::Skipped("No valid splits found".to_owned()));
    }
    let Some(security_index) = splits.iter().position(|split| split.kind == "sec") else {
        let kinds: Vec<&str> = splits.iter().map(|split| split.kind.as_str()).collect();
        return Err(Skip::Skipped(format!(
            "No security split found (splits: {}, types: {})",
            splits.len(),
            kinds.join(", ")
        )));
    };
    let security = &splits[security_index];
    let Some(security_md_id) = security
        .security
        .clone()
        .or_else(|| security.account.clone())
    else {
        return Err(Skip::Skipped(
            "Security split has no account/security ID".to_owned(),
        ));
    };
    let Some(&security_id) = context.ids.securities.get(&security_md_id) else {
        return Err(Skip::Skipped(format!(
            "Security not found: {security_md_id}"
        )));
    };
    let account_md_id = text(transaction, "acctid")
        .map(|id| id.into_owned())
        .unwrap_or_else(|| "undefined".to_owned());
    let Some(&account_id) = context.ids.accounts.get(&account_md_id) else {
        return Err(Skip::Skipped(format!("Account not found: {account_md_id}")));
    };
    let action = action_of(transaction, security);
    let date = convert_date(field(transaction, "dt").as_deref()).map_err(Skip::Failed)?;
    let precision = or_five(precisions.get(&security_md_id).copied());
    let factor = 10_f64.powf(6.0 - precision);
    // `samt || 0`: a NaN is falsy, so it becomes zero shares.
    let samt = security
        .samt
        .filter(|samt| truthy(Some(*samt)))
        .unwrap_or(0.0);
    let shares_micros = ledger_core::js::round(samt * factor);
    let income_account = splits
        .iter()
        .find(|split| split.kind == "inc")
        .and_then(|income| income.account.as_ref())
        .and_then(|account| context.ids.accounts.get(account))
        .copied();
    let cash_id = context
        .ids
        .accounts
        .get(&format!("{account_md_id}_CASH"))
        .copied();
    Ok(Resolved {
        transaction,
        payee_id: payee_of(context, transaction),
        security_index,
        security_id,
        account_id,
        cash_id,
        action,
        date,
        shares_micros,
        income_account,
        splits,
    })
}

fn js_trim(text: &str) -> String {
    text.trim_matches(ledger_core::js::is_js_whitespace)
        .to_owned()
}

/// A dividend that bought shares becomes two transactions: the cash
/// dividend, then a buy of the shares with that cash.
async fn write_reinvestment(
    connection: &mut PgConnection,
    book_id: i32,
    now: chrono::NaiveDateTime,
    resolved: &Resolved<'_>,
) -> Result<Counted, RowError> {
    let description = field(resolved.transaction, "desc")
        .map(|text| text.into_owned())
        .unwrap_or_default();
    let pamt = resolved.security().pamt.unwrap_or(0.0).abs();
    let price_micros = resolved.price_micros();
    let income = resolved.find("inc");
    let dividend_cents = match income.and_then(|income| income.samt) {
        Some(samt) if samt != 0.0 && !samt.is_nan() => samt.abs(),
        _ => pamt,
    };

    let dividend_id = insert_transaction(
        connection,
        book_id,
        now,
        &resolved.new_transaction(Some(js_trim(&format!("{description} (Dividend)")))),
    )
    .await?;
    insert_investment_split(
        connection,
        book_id,
        &NewInvestmentSplit {
            transaction_id: dividend_id,
            account_id: Some(resolved.account_id),
            security_id: resolved.security_id,
            action: "dividend",
            shares_micros: 0.0,
            price_micros: 0.0,
            fees_cents: 0.0,
            split_ratio: None,
        },
    )
    .await?;
    if let Some(cash_id) = resolved.cash_id {
        insert_splits(
            connection,
            book_id,
            dividend_id,
            &[(cash_id, dividend_cents)],
        )
        .await?;
    }
    if let Some(account_id) = resolved.income_account {
        insert_splits(
            connection,
            book_id,
            dividend_id,
            &[(account_id, -dividend_cents)],
        )
        .await?;
    }

    let buy_id = insert_transaction(
        connection,
        book_id,
        now,
        &resolved.new_transaction(Some(js_trim(&format!("{description} (Reinvestment)")))),
    )
    .await?;
    let fees_cents = resolved.fees_cents();
    insert_investment_split(
        connection,
        book_id,
        &NewInvestmentSplit {
            transaction_id: buy_id,
            account_id: Some(resolved.account_id),
            security_id: resolved.security_id,
            action: "buy",
            shares_micros: resolved.shares_micros.abs(),
            price_micros,
            fees_cents,
            split_ratio: None,
        },
    )
    .await?;
    let basis_cents = pamt + fees_cents;
    insert_splits(
        connection,
        book_id,
        buy_id,
        &[(resolved.account_id, basis_cents)],
    )
    .await?;
    if let Some(cash_id) = resolved.cash_id {
        insert_splits(connection, book_id, buy_id, &[(cash_id, -basis_cents)]).await?;
    }
    Ok(Counted {
        dividends: 1,
        buys: 1,
        imported: 2,
        ..Counted::default()
    })
}

/// A buy, a sell, a dividend, a capital gain or a fee in one transaction.
async fn write_investment(
    connection: &mut PgConnection,
    context: &ImportContext,
    resolved: &Resolved<'_>,
) -> Result<Counted, RowError> {
    let (book_id, action) = (context.book_id, resolved.action);
    let transaction_id = insert_transaction(
        connection,
        book_id,
        context.now,
        &resolved
            .new_transaction(field(resolved.transaction, "desc").map(|text| text.into_owned())),
    )
    .await?;
    // The shares belong to the investment account, not its cash child.
    insert_investment_split(
        connection,
        book_id,
        &NewInvestmentSplit {
            transaction_id,
            account_id: Some(resolved.account_id),
            security_id: resolved.security_id,
            action,
            shares_micros: resolved.shares_micros.abs(),
            price_micros: resolved.price_micros(),
            fees_cents: resolved.fees_cents(),
            split_ratio: None,
        },
    )
    .await?;

    // pamt is from the parent account's side, so their sum is the cash
    // movement of the investment account's cash child.
    let cash_amount: f64 = resolved.splits.iter().filter_map(|split| split.pamt).sum();
    let security = resolved.security();
    let has_shares = truthy(security.samt);
    // The offsetting split of the investment account. The lot rebuild does
    // not read it: basis comes from the investment split. A transfer
    // (BuyXfr, SellXfr) uses the security's pamt without the fee.
    let investment_amount = match action {
        "buy" | "sell" if resolved.find("xfr").is_some() => -security.pamt.unwrap_or(0.0),
        "buy" | "sell" => -cash_amount,
        "dividend" if has_shares => -security.pamt.unwrap_or(0.0),
        _ => 0.0,
    };
    let mut counted = Counted::default();
    match action {
        "buy" if resolved.shares_micros.abs() > 0.0 => counted.buys += 1,
        "sell" => counted.sells += 1,
        "dividend" => counted.dividends += 1,
        _ => {}
    }
    if investment_amount != 0.0 {
        insert_splits(
            connection,
            book_id,
            transaction_id,
            &[(resolved.account_id, investment_amount)],
        )
        .await?;
    }

    // A cash dividend can show a zero cash sum. The security's pamt then
    // carries the cash that came into the account.
    let income = resolved.find("inc");
    let mut actual_cash = cash_amount;
    if action == "dividend"
        && cash_amount == 0.0
        && income.is_some_and(|income| truthy(income.pamt))
        && !has_shares
    {
        actual_cash = -security.pamt.unwrap_or(0.0);
    }
    if let Some(cash_id) = resolved.cash_id
        && actual_cash != 0.0
    {
        insert_splits(
            connection,
            book_id,
            transaction_id,
            &[(cash_id, actual_cash)],
        )
        .await?;
    }

    for split in &resolved.splits {
        if split.kind != "xfr" && split.kind != "inc" {
            continue;
        }
        let (Some(account), Some(samt)) = (&split.account, split.samt) else {
            continue;
        };
        let accounts = &context.ids.accounts;
        let mut target = accounts.get(account).copied();
        if split.kind == "xfr"
            && let Some(&cash_id) = accounts.get(&format!("{account}_CASH"))
        {
            target = Some(cash_id);
        }
        if let Some(target) = target {
            insert_splits(connection, book_id, transaction_id, &[(target, samt)]).await?;
        }
    }

    if action == "buy"
        && income.is_some()
        && text(resolved.transaction, "reinvest").as_deref() == Some("true")
    {
        insert_investment_split(
            connection,
            book_id,
            &NewInvestmentSplit {
                transaction_id,
                account_id: Some(resolved.account_id),
                security_id: resolved.security_id,
                action: "dividend",
                shares_micros: 0.0,
                price_micros: 0.0,
                fees_cents: 0.0,
                split_ratio: None,
            },
        )
        .await?;
        counted.dividends += 1;
    }
    Ok(counted)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn item(value: serde_json::Value) -> Item {
        value.as_object().unwrap().clone()
    }

    #[test]
    fn precision_defaults_to_five() {
        let items = [
            item(json!({"obj_type": "curr", "old_id": "c4", "dec": "4"})),
            item(json!({"obj_type": "curr", "old_id": "c0", "dec": "0"})),
            item(json!({"obj_type": "acct", "type": "s", "id": "s4", "curr": "c4"})),
            item(json!({"obj_type": "acct", "type": "s", "id": "s0", "curr": "c0"})),
            item(json!({"obj_type": "acct", "type": "s", "id": "sx", "curr": "missing"})),
        ];
        let refs: Vec<&Item> = items.iter().collect();
        let map = precisions(&refs);
        assert_eq!(map["s4"], 4.0);
        assert_eq!(map["s0"], 5.0);
        assert_eq!(map["sx"], 5.0);
    }

    #[test]
    fn action_follows_the_type_then_the_share_sign() {
        let split = |samt: Option<f64>| Split {
            kind: "sec".to_owned(),
            samt,
            pamt: None,
            account: None,
            security: None,
        };
        let buysell = item(json!({"xfer_type": "xfrtp_buysell"}));
        assert_eq!(action_of(&buysell, &split(Some(5.0))), "buy");
        assert_eq!(action_of(&buysell, &split(Some(-5.0))), "sell");
        assert_eq!(action_of(&buysell, &split(None)), "buy");
        assert_eq!(action_of(&buysell, &split(Some(f64::NAN))), "buy");
        assert_eq!(
            action_of(
                &item(json!({"xfer_type": "xfrtp_capgain"})),
                &split(Some(-1.0))
            ),
            "capGain"
        );
        assert_eq!(
            action_of(&item(json!({"xfer_type": "xfrtp_dividend"})), &split(None)),
            "dividend"
        );
    }

    #[test]
    fn an_unreadable_pamt_stops_the_transaction() {
        assert!(extract_splits(&item(json!({"0.pamt": "abc"}))).is_err());
        let splits = extract_splits(&item(json!({"0.pamt": "0", "0.samt": "0"}))).unwrap();
        assert_eq!(splits[0].pamt, Some(0.0));
        assert_eq!(splits[0].samt, Some(0.0));
        assert_eq!(splits[0].kind, "unknown");
    }
}
