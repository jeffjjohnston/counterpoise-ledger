//! The demo datasets. Each dataset is one module that writes its rows
//! through a `Seeder`.
//!
//! Mulberry32 with seed 42 drives every variable amount and date, so a run
//! with the same `today` writes the same rows. The household arithmetic is
//! in `f64` with [`js_round`], because it began as a port of a TypeScript
//! seed. A new dataset can use integer arithmetic.

use crate::sql;
use crate::store::{Sql, params};
use std::collections::HashMap;
use std::fmt;

use chrono::{DateTime, NaiveDate, NaiveDateTime, Utc};

use crate::lots::{find_all_lot_pairs, rebuild_lots};

mod household;
mod plaid;
mod prices;
mod recurring;
mod single;
#[cfg(test)]
mod tests;
mod window;

use prices::Security;

/// A failure that stops the seed. The caller's transaction rolls back.
#[derive(Debug)]
pub enum SeedError {
    Database(crate::store::Error),
    Invalid(String),
}

impl fmt::Display for SeedError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Database(cause) => write!(formatter, "{cause}"),
            Self::Invalid(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for SeedError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Database(cause) => Some(cause),
            Self::Invalid(_) => None,
        }
    }
}

impl From<crate::store::Error> for SeedError {
    fn from(cause: crate::store::Error) -> Self {
        Self::Database(cause)
    }
}

type SeedResult<T> = Result<T, SeedError>;

/// The Mulberry32 generator, bit for bit as JavaScript computes it.
struct Mulberry32 {
    state: u32,
}

impl Mulberry32 {
    fn new(seed: u32) -> Self {
        Self { state: seed }
    }

    /// A value in [0, 1). JavaScript keeps each step in 32 bits with `| 0`,
    /// `Math.imul`, and `>>> 0`, so wrapping `u32` arithmetic gives the same bits.
    fn next(&mut self) -> f64 {
        self.state = self.state.wrapping_add(0x6d2b_79f5);
        let state = self.state;
        let mut t = (state ^ (state >> 15)).wrapping_mul(1 | state);
        t = t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t)) ^ t;
        f64::from(t ^ (t >> 14)) / 4_294_967_296.0
    }

    /// An integer in [min, max].
    fn int(&mut self, min: i64, max: i64) -> i64 {
        (self.next() * (max - min + 1) as f64).floor() as i64 + min
    }

    fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[(self.next() * items.len() as f64).floor() as usize]
    }
}

/// `Math.round`: a half rounds toward positive infinity, not away from zero
/// as `f64::round` does.
fn js_round(value: f64) -> f64 {
    let floor = value.floor();
    if value - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    }
}

fn gross_cents(shares_micros: i64, price_micros: i64) -> i64 {
    js_round((shares_micros as f64 * price_micros as f64) / 10_000_000_000.0) as i64
}

/// The shares that `amount_cents` buys at `price_micros`, to the nearest 100
/// micros.
fn shares_for(amount_cents: i64, price_micros: i64) -> i64 {
    js_round((amount_cents as f64 * 10_000_000_000.0) / price_micros as f64 / 100.0) as i64 * 100
}

fn round_share(amount_cents: i64, fraction: f64) -> i64 {
    js_round(amount_cents as f64 * fraction) as i64
}

#[derive(Clone, Copy)]
struct Split {
    account_id: i32,
    amount: i64,
}

const fn split(account_id: i32, amount: i64) -> Split {
    Split { account_id, amount }
}

/// The row counts that the seed reports when it completes.
#[derive(Debug, Default)]
pub struct SeedSummary {
    pub accounts: i64,
    pub payees: i64,
    pub transactions: i64,
    pub transaction_splits: i64,
    pub investment_splits: i64,
    pub investment_lots: i64,
}

/// One seed run: the target book, the clock, and the statements, which run
/// inside the caller's write transaction.
struct Seeder<'a, S: Sql> {
    sql: &'a S,
    book_id: i32,
    now: NaiveDateTime,
    rand: Mulberry32,
    log: &'a mut (dyn FnMut(&str) + Send),
}

impl<S: Sql> Seeder<'_, S> {
    fn account(
        &mut self,
        name: &str,
        account_type: &str,
        subtype: Option<&str>,
        parent_id: Option<i32>,
        is_favorite: bool,
        icon: Option<&str>,
    ) -> SeedResult<i32> {
        let is_investment_cash = subtype == Some("cash");
        Ok(self.sql.query_row(
            "INSERT INTO accounts
               (book_id, name, type, subtype, parent_id, is_favorite, is_investment_cash, icon,
                created_at, updated_at, name_fold)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, ?10)
             RETURNING id",
            &params![
                self.book_id,
                name,
                account_type,
                subtype,
                parent_id,
                is_favorite,
                is_investment_cash,
                icon,
                self.now,
                crate::folds::fold(name)
            ],
        )?)
    }

    fn security(&mut self, name: &str, symbol: &str) -> SeedResult<i32> {
        Ok(self.sql.query_row(
            "INSERT INTO securities (book_id, name, symbol, security_type, created_at, symbol_fold)
             VALUES (?1, ?2, ?3, 'etf', ?4, ?5)
             RETURNING id",
            &params![
                self.book_id,
                name,
                symbol,
                self.now,
                crate::folds::fold(symbol)
            ],
        )?)
    }

    fn transaction(
        &mut self,
        date: &str,
        description: &str,
        payee_id: Option<i32>,
        splits: &[Split],
    ) -> SeedResult<i32> {
        let total: i64 = splits.iter().map(|split| split.amount).sum();
        if total.abs() > 1 {
            return Err(SeedError::Invalid(format!(
                "Splits don't balance! Total={total}, desc=\"{description}\", date={date}"
            )));
        }
        let transaction_id: i32 = self.sql.query_row(
            "INSERT INTO transactions
               (book_id, date, description, payee_id, is_reconciled, created_at, updated_at,
                description_fold)
             VALUES (?1, ?2, ?3, ?4, false, ?5, ?5, ?6)
             RETURNING id",
            &params![
                self.book_id,
                date,
                description,
                payee_id,
                self.now,
                crate::folds::fold(description)
            ],
        )?;
        let accounts: Vec<i32> = splits.iter().map(|split| split.account_id).collect();
        let amounts: Vec<i32> = splits
            .iter()
            .map(|split| i32::try_from(split.amount))
            .collect::<Result<_, _>>()
            .map_err(|_| {
                SeedError::Invalid(format!("Split amount too large: \"{description}\""))
            })?;
        // One insert keeps the splits in the order given, so their IDs follow
        // that order.
        let rows: Vec<(i32, i32)> = accounts.into_iter().zip(amounts).collect();
        self.sql.execute(
            &format!(
                "INSERT INTO transaction_splits (book_id, transaction_id, account_id, amount) {}",
                sql::json_rows(&["?1", "?2", "#0", "#1"], "?3")
            ),
            &params![self.book_id, transaction_id, sql::json_array(&rows)],
        )?;
        Ok(transaction_id)
    }

    #[allow(clippy::too_many_arguments)]
    fn investment_split(
        &mut self,
        transaction_id: i32,
        account_id: i32,
        security_id: i32,
        action: &str,
        shares_micros: i64,
        price_micros: i64,
    ) -> SeedResult<()> {
        self.sql.execute(
            "INSERT INTO investment_splits
               (book_id, transaction_id, account_id, security_id, action, shares_micros,
                price_micros, fees_cents, split_numerator, split_denominator)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, NULL, NULL)",
            &params![
                self.book_id,
                transaction_id,
                account_id,
                security_id,
                action,
                shares_micros,
                price_micros
            ],
        )?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn buy(
        &mut self,
        date: &str,
        investment_account_id: i32,
        cash_account_id: i32,
        security_id: i32,
        shares_micros: i64,
        price_micros: i64,
        description: &str,
    ) -> SeedResult<()> {
        let gross = gross_cents(shares_micros, price_micros);
        let transaction_id = self.transaction(
            date,
            description,
            None,
            &[
                split(investment_account_id, gross),
                split(cash_account_id, -gross),
            ],
        )?;
        self.investment_split(
            transaction_id,
            investment_account_id,
            security_id,
            "buy",
            shares_micros,
            price_micros,
        )
    }

    /// The ledger records the sale at proceeds, as `buildSellSplits` does
    /// when no cost basis is given. The realized gains report takes the gain
    /// from the lots that the rebuild at the end computes.
    #[allow(clippy::too_many_arguments)]
    fn sell(
        &mut self,
        date: &str,
        investment_account_id: i32,
        cash_account_id: i32,
        security_id: i32,
        shares_micros: i64,
        price_micros: i64,
        description: &str,
    ) -> SeedResult<()> {
        let gross = gross_cents(shares_micros, price_micros);
        let transaction_id = self.transaction(
            date,
            description,
            None,
            &[
                split(cash_account_id, gross),
                split(investment_account_id, -gross),
            ],
        )?;
        self.investment_split(
            transaction_id,
            investment_account_id,
            security_id,
            "sell",
            shares_micros,
            price_micros,
        )
    }

    /// A dividend has 0 shares and a 0 price, as the importer writes it.
    #[allow(clippy::too_many_arguments)]
    fn dividend(
        &mut self,
        date: &str,
        investment_account_id: i32,
        cash_account_id: i32,
        income_account_id: i32,
        security_id: i32,
        amount_cents: i64,
        description: &str,
    ) -> SeedResult<()> {
        let transaction_id = self.transaction(
            date,
            description,
            None,
            &[
                split(cash_account_id, amount_cents),
                split(income_account_id, -amount_cents),
            ],
        )?;
        self.investment_split(
            transaction_id,
            investment_account_id,
            security_id,
            "dividend",
            0,
            0,
        )
    }
}

/// Share positions in micros, per (account, security).
#[derive(Default)]
struct Positions(HashMap<(i32, i32), i64>);

impl Positions {
    fn add(&mut self, account_id: i32, security_id: i32, shares_micros: i64) {
        *self.0.entry((account_id, security_id)).or_default() += shares_micros;
    }

    fn get(&self, account_id: i32, security_id: i32) -> i64 {
        self.0.get(&(account_id, security_id)).copied().unwrap_or(0)
    }
}

/// Buys `securities` with `amount_cents` split by `weights`. The last
/// security takes the remainder, so the amounts sum to `amount_cents`.
#[allow(clippy::too_many_arguments)]
fn buy_allocation(
    seeder: &mut Seeder<'_, impl Sql>,
    positions: &mut Positions,
    date: &str,
    price_date: NaiveDate,
    investment_account_id: i32,
    cash_account_id: i32,
    amount_cents: i64,
    allocation: &[(Security, f64)],
    label: &str,
) -> SeedResult<()> {
    let mut remainder = amount_cents;
    let mut orders = Vec::with_capacity(allocation.len());
    for (index, (security, weight)) in allocation.iter().enumerate() {
        let amount = if index + 1 == allocation.len() {
            remainder
        } else {
            round_share(amount_cents, *weight)
        };
        remainder -= amount;
        let price = security.price_micros(price_date)?;
        orders.push((*security, shares_for(amount, price), price));
    }
    for (security, shares, price) in orders {
        if shares > 0 {
            let description = format!("Buy {} - {label}", security.symbol);
            seeder.buy(
                date,
                investment_account_id,
                cash_account_id,
                security.id,
                shares,
                price,
                &description,
            )?;
            positions.add(investment_account_id, security.id, shares);
        }
    }
    Ok(())
}
fn verify_and_summarize(
    seeder: Seeder<'_, impl Sql>,
    started: DateTime<Utc>,
) -> SeedResult<SeedSummary> {
    let Seeder {
        sql, book_id, log, ..
    } = seeder;
    let unbalanced: Vec<(i32, String, Option<String>, i64)> = sql.query(
        "SELECT t.id, t.date, t.description, CAST(SUM(s.amount) AS bigint)
         FROM transactions t
         JOIN transaction_splits s ON s.transaction_id = t.id
         WHERE t.book_id = ?1
         GROUP BY t.id, t.date, t.description
         HAVING ABS(SUM(s.amount)) > 1",
        &params![book_id],
    )?;
    if !unbalanced.is_empty() {
        let mut message = format!("{} unbalanced transactions found!", unbalanced.len());
        for (id, date, description, total) in &unbalanced {
            message.push_str(&format!(
                "\n  ID={id} date={date} \"{}\" total={total}",
                description.as_deref().unwrap_or("")
            ));
        }
        return Err(SeedError::Invalid(message));
    }

    // The counts cover every book, as the TypeScript seed reports them.
    let (accounts, payees, transactions, transaction_splits, investment_splits, investment_lots): (
        i64,
        i64,
        i64,
        i64,
        i64,
        i64,
    ) = sql.query_row(
        "SELECT (SELECT COUNT(*) FROM accounts), (SELECT COUNT(*) FROM payees),
                (SELECT COUNT(*) FROM transactions), (SELECT COUNT(*) FROM transaction_splits),
                (SELECT COUNT(*) FROM investment_splits), (SELECT COUNT(*) FROM investment_lots)",
        &[],
    )?;
    let summary = SeedSummary {
        accounts,
        payees,
        transactions,
        transaction_splits,
        investment_splits,
        investment_lots,
    };

    log("\n  Seed complete!");
    log(&format!(
        "  Time: {:.1}s",
        (Utc::now() - started).num_milliseconds() as f64 / 1000.0
    ));
    log(&format!("  Accounts: {}", summary.accounts));
    log(&format!("  Payees: {}", summary.payees));
    log(&format!("  Transactions: {}", summary.transactions));
    log(&format!(
        "  Transaction Splits: {}",
        summary.transaction_splits
    ));
    log(&format!(
        "  Investment Splits: {}",
        summary.investment_splits
    ));
    log(&format!("  Investment Lots: {}", summary.investment_lots));
    log("  All transactions balance: \u{2713}");
    Ok(summary)
}

/// A sample dataset that a demo book can hold.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DemoDataset {
    Household,
    Single,
}

impl DemoDataset {
    /// Every dataset, in menu order.
    pub const ALL: [Self; 2] = [Self::Household, Self::Single];

    pub fn id(self) -> &'static str {
        match self {
            Self::Household => "household",
            Self::Single => "single",
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Household => "Household",
            Self::Single => "Single homeowner",
        }
    }

    pub fn description(self) -> &'static str {
        match self {
            Self::Household => {
                "A married couple in New Jersey: two paychecks, three credit cards, a car loan, \
                 401(k)s, IRAs and a brokerage account. Three years of transactions."
            }
            Self::Single => {
                "One homeowner in Colorado: a paycheck, a mortgage, a car lease, one credit \
                 card, a 401(k), a Roth IRA and a brokerage account. Two years of transactions."
            }
        }
    }

    /// The name of a new demo book of this dataset.
    pub fn book_name(self) -> &'static str {
        match self {
            Self::Household => "Demo Book",
            Self::Single => "Demo Book - Single",
        }
    }

    /// The months of history, the month of `today` included.
    pub fn months(self) -> u32 {
        match self {
            Self::Household => 36,
            Self::Single => 24,
        }
    }

    pub fn from_id(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|dataset| dataset.id() == id)
    }
}

/// Inserts `names` as the payees of the book, in order.
fn insert_payees(
    seeder: &mut Seeder<'_, impl Sql>,
    names: &[&'static str],
) -> SeedResult<HashMap<&'static str, i32>> {
    let mut payees = HashMap::with_capacity(names.len());
    for name in names {
        let id: i32 = seeder.sql.query_row(
            "INSERT INTO payees (book_id, name, created_at, name_fold) VALUES (?1, ?2, ?3, ?4)
             RETURNING id",
            &params![seeder.book_id, name, seeder.now, crate::folds::fold(name)],
        )?;
        payees.insert(*name, id);
    }
    Ok(payees)
}

/// Creates the rows of one book. The book must exist. The seed deletes the
/// rows that the book holds first, so its contract is "reset this book", not
/// "add to this book". Run it inside a write transaction, a
/// `Database::transaction`.
pub fn seed_book(
    sql: &impl Sql,
    book_id: i32,
    dataset: DemoDataset,
    today: NaiveDate,
    log: &mut (dyn FnMut(&str) + Send),
) -> Result<SeedSummary, SeedError> {
    log(&format!(
        "Seeding book {book_id} with the {} dataset...",
        dataset.name()
    ));
    // `Instant` has no clock on wasm32; chrono reads the host's.
    let started = Utc::now();

    // Foreign keys set this order.
    for table in [
        "plaid_transaction_reconciliation",
        "plaid_accounts",
        "plaid_tokens",
        "investment_splits",
        "investment_lots",
        "transaction_splits",
        "recurring_template_splits",
        "transactions",
        "recurring_rules",
        "security_prices",
        "securities",
        "accounts",
        "payees",
    ] {
        sql.execute(
            &format!("DELETE FROM {table} WHERE book_id = ?1"),
            &params![book_id],
        )?;
    }
    log("  Cleared existing book data");

    let mut seeder = Seeder {
        sql,
        book_id,
        now: Utc::now().naive_utc(),
        rand: Mulberry32::new(42),
        log,
    };
    let window = window::Window::new(today, dataset.months());
    match dataset {
        DemoDataset::Household => household::seed(&mut seeder, window)?,
        DemoDataset::Single => single::seed(&mut seeder, window)?,
    }

    // Lots are derived state, so the lot engine builds them, inside the
    // caller's transaction.
    for pair in find_all_lot_pairs(sql, book_id)? {
        rebuild_lots(sql, book_id, pair.account_id, pair.security_id)?;
    }

    verify_and_summarize(seeder, started)
}
