//! The sample dataset. It began as a port of the former TypeScript seed, and
//! it writes the same rows in the same order.
//!
//! Mulberry32 with seed 42 drives every variable amount and date, so two runs
//! write the same rows. `tests/http/seed.test.ts` checks the counts, that
//! every transaction balances, and that two runs write the same rows.
//!
//! JavaScript does its arithmetic in doubles. This port does each calculation
//! in `f64` in the same order and rounds with [`js_round`], so each amount is
//! the same to the cent.

use std::collections::{BTreeMap, HashMap};
use std::fmt;
use std::time::Instant;

use chrono::{Datelike, Days, Months, NaiveDate, NaiveDateTime, Utc};
use sqlx::PgConnection;

use crate::lots::{find_all_lot_pairs, rebuild_lots};

/// A failure that stops the seed. The caller's transaction rolls back.
#[derive(Debug)]
pub enum SeedError {
    Database(sqlx::Error),
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

impl From<sqlx::Error> for SeedError {
    fn from(cause: sqlx::Error) -> Self {
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

fn date(year: i32, month: u32, day: u32) -> NaiveDate {
    NaiveDate::from_ymd_opt(year, month, day).expect("seed dates are valid")
}

fn last_day_of_month(year: i32, month: u32) -> u32 {
    let first = date(year, month, 1);
    (first + Months::new(1) - Days::new(1)).day()
}

fn format_date(value: NaiveDate) -> String {
    value.format("%Y-%m-%d").to_string()
}

/// The next `day_of_month` strictly after `today`. The day must be 28 or less.
pub fn next_monthly_date(today: NaiveDate, day_of_month: u32) -> NaiveDate {
    let candidate = date(today.year(), today.month(), day_of_month);
    if candidate <= today {
        candidate + Months::new(1)
    } else {
        candidate
    }
}

/// The next `weekday` strictly after `today`, where 0 is Sunday.
pub fn next_weekday_date(today: NaiveDate, weekday: u32) -> NaiveDate {
    let ahead = (weekday + 7 - today.weekday().num_days_from_sunday()) % 7;
    today + Days::new(u64::from(if ahead == 0 { 7 } else { ahead }))
}

// Month-end prices in cents, one row for each year from 2023 to 2025.
#[rustfmt::skip]
const VTI_PRICES: [i64; 36] = [
    19400, 19650, 19380, 20020, 20210, 20850, 21340, 21060, 20530, 21170, 21890, 22250,
    22510, 22840, 23370, 23690, 24020, 24560, 24930, 25280, 24850, 25540, 26010, 26480,
    26230, 26750, 27080, 27510, 27240, 27890, 28350, 28020, 27680, 28240, 28810, 29250,
];
#[rustfmt::skip]
const VXUS_PRICES: [i64; 36] = [
    5280, 5340, 5190, 5370, 5280, 5420, 5560, 5430, 5290, 5380, 5510, 5580,
    5640, 5720, 5810, 5890, 5970, 6050, 6140, 6080, 5950, 6090, 6210, 6300,
    6250, 6380, 6450, 6530, 6410, 6570, 6680, 6620, 6500, 6640, 6780, 6850,
];
#[rustfmt::skip]
const BND_PRICES: [i64; 36] = [
    7320, 7280, 7350, 7390, 7310, 7260, 7190, 7150, 7080, 7140, 7280, 7350,
    7380, 7420, 7460, 7430, 7390, 7450, 7510, 7560, 7520, 7580, 7630, 7680,
    7710, 7750, 7790, 7830, 7800, 7860, 7910, 7950, 7920, 7980, 8030, 8080,
];
#[rustfmt::skip]
const AGG_PRICES: [i64; 36] = [
    9840, 9780, 9860, 9910, 9830, 9770, 9690, 9640, 9570, 9650, 9790, 9860,
    9900, 9950, 10000, 9970, 9920, 9980, 10050, 10110, 10070, 10130, 10190, 10250,
    10280, 10330, 10380, 10420, 10390, 10450, 10510, 10560, 10520, 10580, 10640, 10700,
];

const PAYEE_NAMES: [&str; 46] = [
    // Employers
    "Meridian Health Systems",
    "NovaTech Solutions",
    // Utilities and housing
    "Greenwood Apartments",
    "PSE&G",
    "New Jersey American Water",
    "Optimum Internet",
    "T-Mobile",
    // Auto
    "Honda Financial Services",
    "Geico",
    "Shell",
    "Exxon",
    "Mavis Discount Tire",
    "Jiffy Lube",
    // Groceries
    "ShopRite",
    "Trader Joe's",
    "Whole Foods",
    "Costco",
    "Aldi",
    // Dining
    "Panera Bread",
    "Chipotle",
    "Cheesecake Factory",
    "Olive Garden",
    "Sakura Sushi",
    "Tony's Pizza",
    // Coffee
    "Starbucks",
    "Dunkin'",
    // Entertainment
    "AMC Theatres",
    "Netflix",
    "Spotify",
    "Hulu",
    // Shopping
    "Amazon",
    "Target",
    "TJ Maxx",
    "Home Depot",
    "Best Buy",
    // Medical
    "Summit Medical Group",
    "CVS Pharmacy",
    "Dr. Patel DDS",
    // Personal
    "Equinox Gym",
    "Supercuts",
    // Travel
    "Delta Airlines",
    "Marriott Hotels",
    "Airbnb",
    // Gifts
    "Hallmark",
    // Miscellaneous
    "Venmo",
    "Zelle",
];

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

/// One seed run: the target book, the clock, and the connection. The
/// connection must be inside a transaction, because the lot rebuild takes an
/// advisory lock that lasts until commit.
struct Seeder<'a> {
    connection: &'a mut PgConnection,
    book_id: i32,
    now: NaiveDateTime,
    rand: Mulberry32,
    log: &'a mut (dyn FnMut(&str) + Send),
}

impl Seeder<'_> {
    async fn account(
        &mut self,
        name: &str,
        account_type: &str,
        subtype: Option<&str>,
        parent_id: Option<i32>,
        is_favorite: bool,
        icon: Option<&str>,
    ) -> SeedResult<i32> {
        let is_investment_cash = subtype == Some("cash");
        Ok(sqlx::query_scalar(
            "INSERT INTO accounts
               (book_id, name, type, subtype, parent_id, is_favorite, is_investment_cash, icon,
                created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
             RETURNING id",
        )
        .bind(self.book_id)
        .bind(name)
        .bind(account_type)
        .bind(subtype)
        .bind(parent_id)
        .bind(is_favorite)
        .bind(is_investment_cash)
        .bind(icon)
        .bind(self.now)
        .fetch_one(&mut *self.connection)
        .await?)
    }

    async fn security(&mut self, name: &str, symbol: &str) -> SeedResult<i32> {
        Ok(sqlx::query_scalar(
            "INSERT INTO securities (book_id, name, symbol, security_type, created_at)
             VALUES ($1, $2, $3, 'etf', $4)
             RETURNING id",
        )
        .bind(self.book_id)
        .bind(name)
        .bind(symbol)
        .bind(self.now)
        .fetch_one(&mut *self.connection)
        .await?)
    }

    async fn transaction(
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
        let transaction_id: i32 = sqlx::query_scalar(
            "INSERT INTO transactions
               (book_id, date, description, payee_id, is_reconciled, created_at, updated_at)
             VALUES ($1, $2, $3, $4, false, $5, $5)
             RETURNING id",
        )
        .bind(self.book_id)
        .bind(date)
        .bind(description)
        .bind(payee_id)
        .bind(self.now)
        .fetch_one(&mut *self.connection)
        .await?;
        let accounts: Vec<i32> = splits.iter().map(|split| split.account_id).collect();
        let amounts: Vec<i32> = splits
            .iter()
            .map(|split| i32::try_from(split.amount))
            .collect::<Result<_, _>>()
            .map_err(|_| {
                SeedError::Invalid(format!("Split amount too large: \"{description}\""))
            })?;
        // WITH ORDINALITY keeps the splits in the order given, so their serial
        // IDs match a multi-row VALUES insert.
        sqlx::query(
            "INSERT INTO transaction_splits (book_id, transaction_id, account_id, amount)
             SELECT $1, $2, split.account_id, split.amount
             FROM unnest($3::integer[], $4::integer[]) WITH ORDINALITY
               AS split(account_id, amount, position)
             ORDER BY split.position",
        )
        .bind(self.book_id)
        .bind(transaction_id)
        .bind(accounts)
        .bind(amounts)
        .execute(&mut *self.connection)
        .await?;
        Ok(transaction_id)
    }

    #[allow(clippy::too_many_arguments)]
    async fn investment_split(
        &mut self,
        transaction_id: i32,
        account_id: i32,
        security_id: i32,
        action: &str,
        shares_micros: i64,
        price_micros: i64,
    ) -> SeedResult<()> {
        sqlx::query(
            "INSERT INTO investment_splits
               (book_id, transaction_id, account_id, security_id, action, shares_micros,
                price_micros, fees_cents, split_numerator, split_denominator)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 0, NULL, NULL)",
        )
        .bind(self.book_id)
        .bind(transaction_id)
        .bind(account_id)
        .bind(security_id)
        .bind(action)
        .bind(shares_micros)
        .bind(price_micros)
        .execute(&mut *self.connection)
        .await?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    async fn buy(
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
        let transaction_id = self
            .transaction(
                date,
                description,
                None,
                &[
                    split(investment_account_id, gross),
                    split(cash_account_id, -gross),
                ],
            )
            .await?;
        self.investment_split(
            transaction_id,
            investment_account_id,
            security_id,
            "buy",
            shares_micros,
            price_micros,
        )
        .await
    }

    /// The ledger records the sale at proceeds, as `buildSellSplits` does
    /// when no cost basis is given. The realized gains report takes the gain
    /// from the lots that the rebuild at the end computes.
    #[allow(clippy::too_many_arguments)]
    async fn sell(
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
        let transaction_id = self
            .transaction(
                date,
                description,
                None,
                &[
                    split(cash_account_id, gross),
                    split(investment_account_id, -gross),
                ],
            )
            .await?;
        self.investment_split(
            transaction_id,
            investment_account_id,
            security_id,
            "sell",
            shares_micros,
            price_micros,
        )
        .await
    }

    /// A dividend has 0 shares and a 0 price, as the importer writes it.
    #[allow(clippy::too_many_arguments)]
    async fn dividend(
        &mut self,
        date: &str,
        investment_account_id: i32,
        cash_account_id: i32,
        income_account_id: i32,
        security_id: i32,
        amount_cents: i64,
        description: &str,
    ) -> SeedResult<()> {
        let transaction_id = self
            .transaction(
                date,
                description,
                None,
                &[
                    split(cash_account_id, amount_cents),
                    split(income_account_id, -amount_cents),
                ],
            )
            .await?;
        self.investment_split(
            transaction_id,
            investment_account_id,
            security_id,
            "dividend",
            0,
            0,
        )
        .await
    }
}

/// The accounts that the transaction generator refers to.
struct Accounts {
    checking: i32,
    brokerage: i32,
    brokerage_cash: i32,
    sarah_401k: i32,
    sarah_401k_cash: i32,
    michael_401k: i32,
    michael_401k_cash: i32,
    sarah_ira: i32,
    sarah_ira_cash: i32,
    michael_ira: i32,
    michael_ira_cash: i32,
    chase_sapphire: i32,
    amex_blue: i32,
    citi_double: i32,
    auto_loan: i32,
    sarah_salary: i32,
    michael_salary: i32,
    dividend_income: i32,
    tax_federal: i32,
    tax_nj: i32,
    tax_ss: i32,
    tax_medicare: i32,
    ins_health: i32,
    ins_dental: i32,
    ins_car: i32,
    housing_rent: i32,
    housing_electric: i32,
    housing_gas: i32,
    housing_water: i32,
    housing_internet: i32,
    housing_phone: i32,
    auto_fuel: i32,
    auto_maintenance: i32,
    food_groceries: i32,
    food_dining: i32,
    food_coffee: i32,
    entertainment: i32,
    shop_clothing: i32,
    shop_household: i32,
    shop_electronics: i32,
    medical: i32,
    personal_gym: i32,
    personal_haircuts: i32,
    travel: i32,
    gifts: i32,
    misc_expense: i32,
    interest_car_loan: i32,
    streaming: i32,
    opening_balances: i32,
}

async fn create_accounts(seeder: &mut Seeder<'_>) -> SeedResult<Accounts> {
    let asset = "asset";
    let checking = seeder
        .account("Joint Checking", asset, Some("bank"), None, true, None)
        .await?;
    let brokerage = seeder
        .account(
            "Joint Brokerage",
            asset,
            Some("investment"),
            None,
            true,
            None,
        )
        .await?;
    let brokerage_cash = seeder
        .account(
            "Joint Brokerage Cash",
            asset,
            Some("cash"),
            Some(brokerage),
            false,
            None,
        )
        .await?;
    let sarah_401k = seeder
        .account("Sarah 401(k)", asset, Some("investment"), None, false, None)
        .await?;
    let sarah_401k_cash = seeder
        .account(
            "Sarah 401(k) Cash",
            asset,
            Some("cash"),
            Some(sarah_401k),
            false,
            None,
        )
        .await?;
    let michael_401k = seeder
        .account(
            "Michael 401(k)",
            asset,
            Some("investment"),
            None,
            false,
            None,
        )
        .await?;
    let michael_401k_cash = seeder
        .account(
            "Michael 401(k) Cash",
            asset,
            Some("cash"),
            Some(michael_401k),
            false,
            None,
        )
        .await?;
    let sarah_ira = seeder
        .account("Sarah IRA", asset, Some("investment"), None, false, None)
        .await?;
    let sarah_ira_cash = seeder
        .account(
            "Sarah IRA Cash",
            asset,
            Some("cash"),
            Some(sarah_ira),
            false,
            None,
        )
        .await?;
    let michael_ira = seeder
        .account("Michael IRA", asset, Some("investment"), None, false, None)
        .await?;
    let michael_ira_cash = seeder
        .account(
            "Michael IRA Cash",
            asset,
            Some("cash"),
            Some(michael_ira),
            false,
            None,
        )
        .await?;
    (seeder.log)("  Created asset accounts");

    let liability = "liability";
    let chase_sapphire = seeder
        .account(
            "Chase Sapphire",
            liability,
            Some("credit_card"),
            None,
            true,
            None,
        )
        .await?;
    let amex_blue = seeder
        .account(
            "Amex Blue Cash",
            liability,
            Some("credit_card"),
            None,
            false,
            None,
        )
        .await?;
    let citi_double = seeder
        .account(
            "Citi Double Cash",
            liability,
            Some("credit_card"),
            None,
            false,
            None,
        )
        .await?;
    let auto_loan = seeder
        .account(
            "Honda Auto Loan",
            liability,
            Some("loan"),
            None,
            false,
            None,
        )
        .await?;
    (seeder.log)("  Created liability accounts");

    // Icons go on the top-level categories. A child keeps a null icon, which
    // means "use the icon of the parent". A child sets its own icon only when
    // it differs from the parent, as Food:Coffee does. Investment Fees and
    // Miscellaneous have no icon on purpose: they keep the full-path display
    // that an unconfigured category shows. No two top-level categories have
    // the same icon.
    let income = "income";
    let salary = seeder
        .account("Salary", income, None, None, false, Some("\u{1f4b0}"))
        .await?;
    let investment_income = seeder
        .account(
            "Investment Income",
            income,
            None,
            None,
            false,
            Some("\u{1f4c8}"),
        )
        .await?;
    let sarah_salary = seeder
        .account("Salary:Sarah", income, None, Some(salary), false, None)
        .await?;
    let michael_salary = seeder
        .account("Salary:Michael", income, None, Some(salary), false, None)
        .await?;
    let dividend_income = seeder
        .account(
            "Investment Income:Dividends",
            income,
            None,
            Some(investment_income),
            false,
            None,
        )
        .await?;
    seeder
        .account(
            "Investment Income:Capital Gains",
            income,
            None,
            Some(investment_income),
            false,
            None,
        )
        .await?;
    seeder
        .account(
            "Interest Income",
            income,
            None,
            None,
            false,
            Some("\u{1f3e6}"),
        )
        .await?;
    (seeder.log)("  Created income accounts");

    let expense = "expense";
    let taxes = seeder
        .account(
            "Taxes",
            expense,
            None,
            None,
            false,
            Some("\u{1f3db}\u{fe0f}"),
        )
        .await?;
    let insurance = seeder
        .account(
            "Insurance",
            expense,
            None,
            None,
            false,
            Some("\u{1f6e1}\u{fe0f}"),
        )
        .await?;
    let housing = seeder
        .account("Housing", expense, None, None, false, Some("\u{1f3e0}"))
        .await?;
    let auto = seeder
        .account("Auto", expense, None, None, false, Some("\u{1f697}"))
        .await?;
    let food = seeder
        .account("Food", expense, None, None, false, Some("\u{1f354}"))
        .await?;
    let shopping = seeder
        .account(
            "Shopping",
            expense,
            None,
            None,
            false,
            Some("\u{1f6cd}\u{fe0f}"),
        )
        .await?;
    let personal = seeder
        .account("Personal", expense, None, None, false, Some("\u{1f9f4}"))
        .await?;
    let interest = seeder
        .account("Interest", expense, None, None, false, Some("\u{1f4b3}"))
        .await?;
    let child = |parent: i32| Some(parent);
    let tax_federal = seeder
        .account("Taxes:Federal", expense, None, child(taxes), false, None)
        .await?;
    let tax_nj = seeder
        .account("Taxes:NJ State", expense, None, child(taxes), false, None)
        .await?;
    let tax_ss = seeder
        .account(
            "Taxes:Social Security",
            expense,
            None,
            child(taxes),
            false,
            None,
        )
        .await?;
    let tax_medicare = seeder
        .account("Taxes:Medicare", expense, None, child(taxes), false, None)
        .await?;
    let ins_health = seeder
        .account(
            "Insurance:Health",
            expense,
            None,
            child(insurance),
            false,
            None,
        )
        .await?;
    let ins_dental = seeder
        .account(
            "Insurance:Dental",
            expense,
            None,
            child(insurance),
            false,
            None,
        )
        .await?;
    let ins_car = seeder
        .account(
            "Insurance:Car",
            expense,
            None,
            child(insurance),
            false,
            None,
        )
        .await?;
    let housing_rent = seeder
        .account("Housing:Rent", expense, None, child(housing), false, None)
        .await?;
    let housing_electric = seeder
        .account(
            "Housing:Electric",
            expense,
            None,
            child(housing),
            false,
            None,
        )
        .await?;
    let housing_gas = seeder
        .account("Housing:Gas", expense, None, child(housing), false, None)
        .await?;
    let housing_water = seeder
        .account("Housing:Water", expense, None, child(housing), false, None)
        .await?;
    let housing_internet = seeder
        .account(
            "Housing:Internet",
            expense,
            None,
            child(housing),
            false,
            Some("\u{1f310}"),
        )
        .await?;
    let housing_phone = seeder
        .account("Housing:Phone", expense, None, child(housing), false, None)
        .await?;
    let auto_fuel = seeder
        .account("Auto:Fuel", expense, None, child(auto), false, None)
        .await?;
    let auto_maintenance = seeder
        .account("Auto:Maintenance", expense, None, child(auto), false, None)
        .await?;
    let food_groceries = seeder
        .account("Food:Groceries", expense, None, child(food), false, None)
        .await?;
    let food_dining = seeder
        .account("Food:Dining", expense, None, child(food), false, None)
        .await?;
    let food_coffee = seeder
        .account(
            "Food:Coffee",
            expense,
            None,
            child(food),
            false,
            Some("\u{2615}"),
        )
        .await?;
    let entertainment = seeder
        .account(
            "Entertainment",
            expense,
            None,
            None,
            false,
            Some("\u{1f3ac}"),
        )
        .await?;
    let shop_clothing = seeder
        .account(
            "Shopping:Clothing",
            expense,
            None,
            child(shopping),
            false,
            None,
        )
        .await?;
    let shop_household = seeder
        .account(
            "Shopping:Household",
            expense,
            None,
            child(shopping),
            false,
            None,
        )
        .await?;
    let shop_electronics = seeder
        .account(
            "Shopping:Electronics",
            expense,
            None,
            child(shopping),
            false,
            None,
        )
        .await?;
    let medical = seeder
        .account("Medical", expense, None, None, false, Some("\u{1f3e5}"))
        .await?;
    let personal_gym = seeder
        .account(
            "Personal:Gym",
            expense,
            None,
            child(personal),
            false,
            Some("\u{1f3cb}\u{fe0f}"),
        )
        .await?;
    let personal_haircuts = seeder
        .account(
            "Personal:Haircuts",
            expense,
            None,
            child(personal),
            false,
            None,
        )
        .await?;
    let travel = seeder
        .account(
            "Travel",
            expense,
            None,
            None,
            false,
            Some("\u{2708}\u{fe0f}"),
        )
        .await?;
    let gifts = seeder
        .account("Gifts", expense, None, None, false, Some("\u{1f381}"))
        .await?;
    seeder
        .account("Investment Fees", expense, None, None, false, None)
        .await?;
    let misc_expense = seeder
        .account("Miscellaneous", expense, None, None, false, None)
        .await?;
    let interest_car_loan = seeder
        .account(
            "Interest:Car Loan",
            expense,
            None,
            child(interest),
            false,
            None,
        )
        .await?;
    let streaming = seeder
        .account(
            "Entertainment:Streaming",
            expense,
            None,
            child(entertainment),
            false,
            Some("\u{1f4fa}"),
        )
        .await?;
    (seeder.log)("  Created expense accounts");

    let opening_balances = seeder
        .account("Opening Balances", "equity", None, None, false, None)
        .await?;
    (seeder.log)("  Created equity account");

    Ok(Accounts {
        checking,
        brokerage,
        brokerage_cash,
        sarah_401k,
        sarah_401k_cash,
        michael_401k,
        michael_401k_cash,
        sarah_ira,
        sarah_ira_cash,
        michael_ira,
        michael_ira_cash,
        chase_sapphire,
        amex_blue,
        citi_double,
        auto_loan,
        sarah_salary,
        michael_salary,
        dividend_income,
        tax_federal,
        tax_nj,
        tax_ss,
        tax_medicare,
        ins_health,
        ins_dental,
        ins_car,
        housing_rent,
        housing_electric,
        housing_gas,
        housing_water,
        housing_internet,
        housing_phone,
        auto_fuel,
        auto_maintenance,
        food_groceries,
        food_dining,
        food_coffee,
        entertainment,
        shop_clothing,
        shop_household,
        shop_electronics,
        medical,
        personal_gym,
        personal_haircuts,
        travel,
        gifts,
        misc_expense,
        interest_car_loan,
        streaming,
        opening_balances,
    })
}

#[derive(Clone, Copy)]
struct Security {
    id: i32,
    symbol: &'static str,
    prices: &'static [i64; 36],
}

impl Security {
    /// The month-end price, in micros, of the month that holds `date`.
    fn price_micros(&self, date: NaiveDate) -> SeedResult<i64> {
        let index = (date.year() - 2023) * 12 + date.month0() as i32;
        usize::try_from(index)
            .ok()
            .and_then(|index| self.prices.get(index))
            .map(|cents| cents * 10_000)
            .ok_or_else(|| {
                SeedError::Invalid(format!(
                    "No price for security {} at month index {index}",
                    self.id
                ))
            })
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
async fn buy_allocation(
    seeder: &mut Seeder<'_>,
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
            seeder
                .buy(
                    date,
                    investment_account_id,
                    cash_account_id,
                    security.id,
                    shares,
                    price,
                    &description,
                )
                .await?;
            positions.add(investment_account_id, security.id, shares);
        }
    }
    Ok(())
}

struct Paycheck {
    gross: i64,
    federal: i64,
    nj_state: i64,
    social_security: i64,
    medicare: i64,
    contribution: i64,
}

const HEALTH_INSURANCE: i64 = 18_500;
const DENTAL_INSURANCE: i64 = 3_500;

/// Creates the rows of one book. The book must exist. The seed deletes the
/// rows that the book holds first, so its contract is "reset this book", not
/// "add to this book". Run it inside a transaction.
///
/// `today` schedules the recurring rules. Every other date is fixed in
/// 2022 to 2025.
pub async fn seed_book(
    connection: &mut PgConnection,
    book_id: i32,
    today: NaiveDate,
    log: &mut (dyn FnMut(&str) + Send),
) -> Result<SeedSummary, SeedError> {
    log(&format!(
        "Seeding book {book_id} with realistic 3-year dataset..."
    ));
    let started = Instant::now();

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
        sqlx::query(&format!("DELETE FROM {table} WHERE book_id = $1"))
            .bind(book_id)
            .execute(&mut *connection)
            .await?;
    }
    log("  Cleared existing book data");

    let mut seeder = Seeder {
        connection,
        book_id,
        now: Utc::now().naive_utc(),
        rand: Mulberry32::new(42),
        log,
    };
    let accounts = create_accounts(&mut seeder).await?;

    let vti = Security {
        id: seeder
            .security("Vanguard Total Stock Market ETF", "VTI")
            .await?,
        symbol: "VTI",
        prices: &VTI_PRICES,
    };
    let vxus = Security {
        id: seeder
            .security("Vanguard Total International Stock ETF", "VXUS")
            .await?,
        symbol: "VXUS",
        prices: &VXUS_PRICES,
    };
    let bnd = Security {
        id: seeder
            .security("Vanguard Total Bond Market ETF", "BND")
            .await?,
        symbol: "BND",
        prices: &BND_PRICES,
    };
    let agg = Security {
        id: seeder
            .security("iShares Core US Aggregate Bond ETF", "AGG")
            .await?,
        symbol: "AGG",
        prices: &AGG_PRICES,
    };
    (seeder.log)("  Created securities");

    seed_prices(&mut seeder, &[vti, vxus, bnd, agg]).await?;
    (seeder.log)("  Created security price history");

    let mut payees = HashMap::new();
    for name in PAYEE_NAMES {
        let id: i32 = sqlx::query_scalar(
            "INSERT INTO payees (book_id, name, created_at) VALUES ($1, $2, $3) RETURNING id",
        )
        .bind(book_id)
        .bind(name)
        .bind(seeder.now)
        .fetch_one(&mut *seeder.connection)
        .await?;
        payees.insert(name, id);
    }
    (seeder.log)("  Created payees");
    let payee = |name: &str| payees.get(name).copied();

    (seeder.log)("  Creating opening balances...");
    let a = &accounts;
    seeder
        .transaction(
            "2022-12-31",
            "Opening Balance - Checking",
            None,
            &[
                split(a.checking, 1_500_000),
                split(a.opening_balances, -1_500_000),
            ],
        )
        .await?;
    seeder
        .transaction(
            "2022-12-31",
            "Opening Balance - Auto Loan",
            None,
            &[
                split(a.auto_loan, -2_500_000),
                split(a.opening_balances, 2_500_000),
            ],
        )
        .await?;

    (seeder.log)("  Generating transactions...");
    let mut positions = Positions::default();
    seed_paychecks(&mut seeder, a, &payee, &mut positions, [vti, vxus, bnd]).await?;
    (seeder.log)("    Paychecks & 401(k) purchases done");
    seed_months(
        &mut seeder,
        a,
        &payee,
        &mut positions,
        [vti, vxus, bnd, agg],
    )
    .await?;

    seed_plaid(&mut seeder, a).await?;
    seed_recurring(&mut seeder, a, &payee, today).await?;

    // Lots are derived state, so the lot engine builds them. The caller's
    // transaction holds each pair's advisory lock until commit.
    for pair in find_all_lot_pairs(seeder.connection, book_id).await? {
        rebuild_lots(
            seeder.connection,
            book_id,
            pair.account_id,
            pair.security_id,
        )
        .await?;
    }

    verify_and_summarize(seeder, started).await
}

async fn seed_prices(seeder: &mut Seeder<'_>, securities: &[Security]) -> SeedResult<()> {
    let mut rows: Vec<(i32, String, i64)> = Vec::with_capacity(securities.len() * 36);
    for security in securities {
        for (index, cents) in security.prices.iter().enumerate() {
            let year = 2023 + (index / 12) as i32;
            let month = (index % 12) as u32 + 1;
            let price_date = format_date(date(year, month, last_day_of_month(year, month)));
            // Noise of plus or minus 0.5 percent from the generator.
            let noise = 1.0 + (seeder.rand.next() - 0.5) * 0.01;
            let price_cents = js_round(*cents as f64 * noise) as i64;
            rows.push((security.id, price_date, price_cents * 10_000));
        }
    }
    sqlx::query(
        "INSERT INTO security_prices (book_id, security_id, price_date, price_micros, source)
         SELECT $1, price.security_id, price.price_date, price.price_micros, 'seed'
         FROM unnest($2::integer[], $3::text[], $4::bigint[]) WITH ORDINALITY
           AS price(security_id, price_date, price_micros, position)
         ORDER BY price.position",
    )
    .bind(seeder.book_id)
    .bind(rows.iter().map(|row| row.0).collect::<Vec<_>>())
    .bind(rows.iter().map(|row| row.1.clone()).collect::<Vec<_>>())
    .bind(rows.iter().map(|row| row.2).collect::<Vec<_>>())
    .execute(&mut *seeder.connection)
    .await?;
    Ok(())
}

/// Biweekly paychecks for both earners from 2023-01-06, and each 401(k)
/// purchase on the day after.
async fn seed_paychecks(
    seeder: &mut Seeder<'_>,
    a: &Accounts,
    payee: &(dyn Fn(&str) -> Option<i32> + Sync),
    positions: &mut Positions,
    funds: [Security; 3],
) -> SeedResult<()> {
    let annual_limit = |year: i32| match year {
        2023 => 2_250_000,
        2024 => 2_300_000,
        _ => 2_350_000,
    };
    let mut contributed: BTreeMap<(i32, i32), i64> = BTreeMap::new();
    let [vti, vxus, bnd] = funds;
    let allocation = [(vti, 0.4), (vxus, 0.2), (bnd, 0.0)];
    let end = date(2025, 12, 31);
    let mut pay_date = date(2023, 1, 6);

    while pay_date <= end {
        let year = pay_date.year();
        let date_text = format_date(pay_date);
        let buy_date = format_date(pay_date + Days::new(1));

        let earners = [
            (
                Paycheck {
                    gross: 384_600,
                    federal: 67_000,
                    nj_state: 21_500,
                    social_security: 23_800,
                    medicare: 5_600,
                    contribution: 86_500,
                },
                a.sarah_401k,
                a.sarah_401k_cash,
                a.sarah_salary,
                "Paycheck - Meridian Health",
                "Meridian Health Systems",
                "Sarah 401(k)",
            ),
            (
                Paycheck {
                    gross: 500_000,
                    federal: 92_000,
                    nj_state: 30_000,
                    social_security: 31_000,
                    medicare: 7_300,
                    contribution: 88_500,
                },
                a.michael_401k,
                a.michael_401k_cash,
                a.michael_salary,
                "Paycheck - NovaTech Solutions",
                "NovaTech Solutions",
                "Michael 401(k)",
            ),
        ];

        for (pay, plan, plan_cash, salary, description, payee_name, label) in earners {
            // Cap the contribution at the annual limit.
            let so_far = contributed.get(&(year, plan)).copied().unwrap_or(0);
            let remaining = annual_limit(year) - so_far;
            let contribution = if remaining <= 0 {
                0
            } else {
                pay.contribution.min(remaining)
            };
            contributed.insert((year, plan), so_far + contribution);

            let net = pay.gross
                - pay.federal
                - pay.nj_state
                - pay.social_security
                - pay.medicare
                - HEALTH_INSURANCE
                - DENTAL_INSURANCE
                - contribution;
            let mut splits = vec![
                split(a.checking, net),
                split(a.tax_federal, pay.federal),
                split(a.tax_nj, pay.nj_state),
                split(a.tax_ss, pay.social_security),
                split(a.tax_medicare, pay.medicare),
                split(a.ins_health, HEALTH_INSURANCE),
                split(a.ins_dental, DENTAL_INSURANCE),
                split(salary, -pay.gross),
            ];
            // The gross already holds the pre-tax contribution.
            if contribution > 0 {
                splits.push(split(plan_cash, contribution));
            }
            seeder
                .transaction(&date_text, description, payee(payee_name), &splits)
                .await?;

            if contribution > 0 {
                buy_allocation(
                    seeder,
                    positions,
                    &buy_date,
                    pay_date,
                    plan,
                    plan_cash,
                    contribution,
                    &allocation,
                    label,
                )
                .await?;
            }
        }

        pay_date = pay_date + Days::new(14);
    }
    Ok(())
}

struct ChargeTemplate {
    payees: &'static [&'static str],
    account: i32,
    card: i32,
    min: i64,
    max: i64,
}

fn charge_templates(a: &Accounts) -> Vec<ChargeTemplate> {
    let template = |payees, account, card, min, max| ChargeTemplate {
        payees,
        account,
        card,
        min,
        max,
    };
    vec![
        // Amex: groceries and fuel
        template(
            &["ShopRite", "Trader Joe's", "Whole Foods", "Costco", "Aldi"],
            a.food_groceries,
            a.amex_blue,
            3_500,
            18_000,
        ),
        template(
            &["ShopRite", "Trader Joe's", "Whole Foods"],
            a.food_groceries,
            a.amex_blue,
            4_000,
            15_000,
        ),
        template(&["Shell", "Exxon"], a.auto_fuel, a.amex_blue, 3_500, 6_500),
        // Chase: dining, coffee, entertainment, and travel
        template(
            &[
                "Panera Bread",
                "Chipotle",
                "Cheesecake Factory",
                "Olive Garden",
                "Sakura Sushi",
                "Tony's Pizza",
            ],
            a.food_dining,
            a.chase_sapphire,
            1_500,
            8_500,
        ),
        template(
            &["Panera Bread", "Chipotle", "Sakura Sushi", "Tony's Pizza"],
            a.food_dining,
            a.chase_sapphire,
            2_000,
            6_500,
        ),
        template(
            &["Starbucks", "Dunkin'"],
            a.food_coffee,
            a.chase_sapphire,
            450,
            750,
        ),
        template(
            &["Starbucks", "Dunkin'"],
            a.food_coffee,
            a.chase_sapphire,
            400,
            800,
        ),
        template(
            &["AMC Theatres"],
            a.entertainment,
            a.chase_sapphire,
            1_500,
            4_000,
        ),
        // Citi: clothing, household, medical, and personal
        template(
            &["Amazon", "Target"],
            a.shop_household,
            a.citi_double,
            1_500,
            8_000,
        ),
        template(&["TJ Maxx"], a.shop_clothing, a.citi_double, 2_000, 12_000),
        template(
            &["Home Depot"],
            a.shop_household,
            a.citi_double,
            2_000,
            10_000,
        ),
        template(
            &["Amazon"],
            a.shop_electronics,
            a.citi_double,
            2_000,
            15_000,
        ),
        template(&["CVS Pharmacy"], a.medical, a.citi_double, 800, 5_000),
        template(
            &["Supercuts"],
            a.personal_haircuts,
            a.citi_double,
            2_500,
            4_500,
        ),
    ]
}

/// The bills, card charges, dividends, and contributions of each month from
/// January 2023 to December 2025. Each draw from the generator happens in a
/// fixed order, because each later amount depends on it.
async fn seed_months(
    seeder: &mut Seeder<'_>,
    a: &Accounts,
    payee: &(dyn Fn(&str) -> Option<i32> + Sync),
    positions: &mut Positions,
    funds: [Security; 4],
) -> SeedResult<()> {
    let [vti, vxus, bnd, agg] = funds;
    let templates = charge_templates(a);
    // A card is paid in full on the 25th. The map iterates in ID order, as
    // a JavaScript object with integer keys does.
    let mut card_balances: BTreeMap<i32, i64> =
        [(a.chase_sapphire, 0), (a.amex_blue, 0), (a.citi_double, 0)].into();
    let mut car_loan_remaining: i64 = 2_500_000;
    let car_loan_rate = 0.049;
    let car_loan_payment: i64 = 45_000;

    for year in 2023..=2025 {
        for month in 0..12_u32 {
            let month_date = date(year, month + 1, 1);
            let month_text = format!("{year}-{:02}", month + 1);
            let on = |day: i64| format!("{month_text}-{day:02}");

            seeder
                .transaction(
                    &on(1),
                    "Rent Payment",
                    payee("Greenwood Apartments"),
                    &[split(a.housing_rent, 250_000), split(a.checking, -250_000)],
                )
                .await?;

            // Electric: higher in summer and winter.
            let season = if (5..=8).contains(&month) {
                1.6
            } else if month >= 11 || month <= 1 {
                1.4
            } else {
                1.0
            };
            let noise = seeder.rand.int(-1500, 1500) as f64;
            let electric = js_round(12_000.0 * season + noise) as i64;
            seeder
                .transaction(
                    &on(5),
                    "Electric Bill",
                    payee("PSE&G"),
                    &[
                        split(a.housing_electric, electric),
                        split(a.checking, -electric),
                    ],
                )
                .await?;

            // Gas: winter heating, and only the water heater in summer.
            let season = if month >= 11 || month <= 2 {
                2.0
            } else if (5..=8).contains(&month) {
                0.6
            } else {
                1.0
            };
            let noise = seeder.rand.int(-1000, 1000) as f64;
            let gas = js_round(7_500.0 * season + noise) as i64;
            seeder
                .transaction(
                    &on(7),
                    "Gas Bill",
                    payee("PSE&G"),
                    &[split(a.housing_gas, gas), split(a.checking, -gas)],
                )
                .await?;

            let water = 6_500 + seeder.rand.int(-500, 500);
            seeder
                .transaction(
                    &on(10),
                    "Water Bill",
                    payee("New Jersey American Water"),
                    &[split(a.housing_water, water), split(a.checking, -water)],
                )
                .await?;

            seeder
                .transaction(
                    &on(12),
                    "Internet",
                    payee("Optimum Internet"),
                    &[split(a.housing_internet, 9_000), split(a.checking, -9_000)],
                )
                .await?;
            seeder
                .transaction(
                    &on(12),
                    "Phone Bill",
                    payee("T-Mobile"),
                    &[split(a.housing_phone, 14_000), split(a.checking, -14_000)],
                )
                .await?;
            seeder
                .transaction(
                    &on(15),
                    "Car Insurance",
                    payee("Geico"),
                    &[split(a.ins_car, 18_500), split(a.checking, -18_500)],
                )
                .await?;

            if car_loan_remaining > 0 {
                let interest = js_round(car_loan_remaining as f64 * (car_loan_rate / 12.0)) as i64;
                let principal = (car_loan_payment - interest).min(car_loan_remaining);
                car_loan_remaining -= principal;
                seeder
                    .transaction(
                        &on(18),
                        "Auto Loan Payment",
                        payee("Honda Financial Services"),
                        &[
                            split(a.auto_loan, principal),
                            split(a.interest_car_loan, interest),
                            split(a.checking, -(principal + interest)),
                        ],
                    )
                    .await?;
            }

            for (name, amount) in [("Netflix", 1_599), ("Spotify", 999), ("Hulu", 799)] {
                seeder
                    .transaction(
                        &on(20),
                        name,
                        payee(name),
                        &[split(a.streaming, amount), split(a.amex_blue, -amount)],
                    )
                    .await?;
                *card_balances.entry(a.amex_blue).or_default() += amount;
            }

            seeder
                .transaction(
                    &on(1),
                    "Equinox Membership",
                    payee("Equinox Gym"),
                    &[split(a.personal_gym, 18_000), split(a.checking, -18_000)],
                )
                .await?;

            let charges = seeder.rand.int(15, 25);
            for _ in 0..charges {
                let template = seeder.rand.pick(&templates);
                let payee_name = *seeder.rand.pick(template.payees);
                let amount = seeder.rand.int(template.min, template.max);
                let day = seeder.rand.int(2, 28);
                seeder
                    .transaction(
                        &on(day),
                        payee_name,
                        payee(payee_name),
                        &[
                            split(template.account, amount),
                            split(template.card, -amount),
                        ],
                    )
                    .await?;
                *card_balances.entry(template.card).or_default() += amount;
            }

            if seeder.rand.next() < 0.4 {
                let amount = seeder.rand.int(5_000, 25_000);
                let day = seeder.rand.int(5, 25);
                seeder
                    .transaction(
                        &on(day),
                        "Doctor Visit",
                        payee("Summit Medical Group"),
                        &[split(a.medical, amount), split(a.citi_double, -amount)],
                    )
                    .await?;
                *card_balances.entry(a.citi_double).or_default() += amount;
            }

            if seeder.rand.next() < 0.15 {
                let amount = seeder.rand.int(5_000, 45_000);
                let shop = *seeder.rand.pick(&["Mavis Discount Tire", "Jiffy Lube"]);
                let day = seeder.rand.int(5, 25);
                seeder
                    .transaction(
                        &on(day),
                        shop,
                        payee(shop),
                        &[
                            split(a.auto_maintenance, amount),
                            split(a.checking, -amount),
                        ],
                    )
                    .await?;
            }

            if seeder.rand.next() < 0.1 {
                let amount = seeder.rand.int(10_000, 80_000);
                let day = seeder.rand.int(5, 25);
                seeder
                    .transaction(
                        &on(day),
                        "Best Buy",
                        payee("Best Buy"),
                        &[
                            split(a.shop_electronics, amount),
                            split(a.chase_sapphire, -amount),
                        ],
                    )
                    .await?;
                *card_balances.entry(a.chase_sapphire).or_default() += amount;
            }

            // About two trips each year. The draw happens only in April and
            // September.
            if (month == 3 || month == 8) && seeder.rand.next() < 0.7 {
                let airfare = seeder.rand.int(30_000, 60_000);
                let hotel = seeder.rand.int(40_000, 120_000);
                let day = seeder.rand.int(5, 15);
                seeder
                    .transaction(
                        &on(day),
                        "Flights",
                        payee("Delta Airlines"),
                        &[split(a.travel, airfare), split(a.chase_sapphire, -airfare)],
                    )
                    .await?;
                *card_balances.entry(a.chase_sapphire).or_default() += airfare;

                let lodging = *seeder.rand.pick(&["Marriott Hotels", "Airbnb"]);
                let day = seeder.rand.int(16, 25);
                seeder
                    .transaction(
                        &on(day),
                        lodging,
                        payee(lodging),
                        &[split(a.travel, hotel), split(a.chase_sapphire, -hotel)],
                    )
                    .await?;
                *card_balances.entry(a.chase_sapphire).or_default() += hotel;
            }

            if month == 10 || month == 11 {
                let amount = seeder.rand.int(5_000, 30_000);
                let day = seeder.rand.int(5, 25);
                seeder
                    .transaction(
                        &on(day),
                        "Gift Purchase",
                        payee("Amazon"),
                        &[split(a.gifts, amount), split(a.chase_sapphire, -amount)],
                    )
                    .await?;
                *card_balances.entry(a.chase_sapphire).or_default() += amount;
            }

            for (card, balance) in card_balances.iter_mut() {
                if *balance > 0 {
                    seeder
                        .transaction(
                            &on(25),
                            "Credit Card Payment",
                            None,
                            &[split(*card, *balance), split(a.checking, -*balance)],
                        )
                        .await?;
                    *balance = 0;
                }
            }

            let quarter_end = (month + 1) % 3 == 0;
            if quarter_end {
                // Annual yields: VTI 1.5%, VXUS 3%, BND 3.5%, AGG 3.8%.
                let dividend_date = date(year, month + 1, 28);
                let date_text = format_date(dividend_date);
                let yields = [
                    (vti, 0.015 / 4.0),
                    (vxus, 0.03 / 4.0),
                    (bnd, 0.035 / 4.0),
                    (agg, 0.038 / 4.0),
                ];
                let holders = [
                    (a.sarah_401k, a.sarah_401k_cash, "Sarah 401(k)"),
                    (a.michael_401k, a.michael_401k_cash, "Michael 401(k)"),
                    (a.sarah_ira, a.sarah_ira_cash, "Sarah IRA"),
                    (a.michael_ira, a.michael_ira_cash, "Michael IRA"),
                    (a.brokerage, a.brokerage_cash, "Joint Brokerage"),
                ];
                for (account, cash, label) in holders {
                    for (security, quarterly_yield) in yields {
                        let held = positions.get(account, security.id);
                        if held <= 0 {
                            continue;
                        }
                        let value = gross_cents(held, security.price_micros(dividend_date)?);
                        let amount = js_round(value as f64 * quarterly_yield) as i64;
                        if amount > 0 {
                            let description = format!("{} Dividend - {label}", security.symbol);
                            seeder
                                .dividend(
                                    &date_text,
                                    account,
                                    cash,
                                    a.dividend_income,
                                    security.id,
                                    amount,
                                    &description,
                                )
                                .await?;
                        }
                    }
                }
            }

            // IRA contributions in January: $6,500 in 2023, $7,000 after.
            if month == 0 {
                let limit = if year == 2023 { 650_000 } else { 700_000 };
                for (ira, ira_cash, person, label) in [
                    (a.sarah_ira, a.sarah_ira_cash, "Sarah", "Sarah IRA"),
                    (a.michael_ira, a.michael_ira_cash, "Michael", "Michael IRA"),
                ] {
                    seeder
                        .transaction(
                            &on(15),
                            &format!("IRA Contribution - {person}"),
                            None,
                            &[split(ira_cash, limit), split(a.checking, -limit)],
                        )
                        .await?;
                    buy_allocation(
                        seeder,
                        positions,
                        &on(16),
                        month_date,
                        ira,
                        ira_cash,
                        limit,
                        &[(vti, 0.4), (vxus, 0.2), (bnd, 0.0)],
                        label,
                    )
                    .await?;
                }
            }

            if quarter_end {
                let amount = seeder.rand.int(200_000, 500_000);
                seeder
                    .transaction(
                        &on(10),
                        "Transfer to Brokerage",
                        None,
                        &[split(a.brokerage_cash, amount), split(a.checking, -amount)],
                    )
                    .await?;
                buy_allocation(
                    seeder,
                    positions,
                    &on(11),
                    month_date,
                    a.brokerage,
                    a.brokerage_cash,
                    amount,
                    &[(vti, 0.4), (vxus, 0.15), (bnd, 0.25), (agg, 0.0)],
                    "Brokerage",
                )
                .await?;

                // The year-end rebalance sells about a fifth of the VTI in
                // the taxable brokerage. The brokerage buys each quarter, so
                // the sale takes shares from several lots. The seeded book
                // then has FIFO allocations, and the realized gains report
                // has rows.
                if month == 11 {
                    let held = positions.get(a.brokerage, vti.id);
                    let trim = js_round((held as f64 * 0.2) / 100.0) as i64 * 100;
                    if trim > 0 && trim <= held {
                        let price = vti.price_micros(month_date)?;
                        seeder
                            .sell(
                                &on(18),
                                a.brokerage,
                                a.brokerage_cash,
                                vti.id,
                                trim,
                                price,
                                "Sell VTI - Rebalance",
                            )
                            .await?;
                        positions.add(a.brokerage, vti.id, -trim);
                    }
                }
            }

            if seeder.rand.next() < 0.3 {
                let app = *seeder.rand.pick(&["Venmo", "Zelle"]);
                let amount = seeder.rand.int(1_500, 10_000);
                let day = seeder.rand.int(5, 25);
                seeder
                    .transaction(
                        &on(day),
                        app,
                        payee(app),
                        &[split(a.misc_expense, amount), split(a.checking, -amount)],
                    )
                    .await?;
            }

            if month == 2 || month == 8 {
                let amount = seeder.rand.int(15_000, 25_000);
                let day = seeder.rand.int(10, 20);
                seeder
                    .transaction(
                        &on(day),
                        "Dental Cleaning",
                        payee("Dr. Patel DDS"),
                        &[split(a.medical, amount), split(a.checking, -amount)],
                    )
                    .await?;
            }

            if month % 2 == 1 {
                let day = seeder.rand.int(10, 25);
                seeder
                    .transaction(
                        &on(day),
                        "Haircut",
                        payee("Supercuts"),
                        &[split(a.personal_haircuts, 3_500), split(a.checking, -3_500)],
                    )
                    .await?;
            }
        }
    }
    Ok(())
}

struct ChaseCharge {
    date: String,
    description: Option<String>,
    amount: i32,
}

impl ChaseCharge {
    fn upper(&self) -> String {
        self.description
            .as_deref()
            .map_or_else(|| "PURCHASE".to_owned(), str::to_uppercase)
    }
}

struct Reconciliation {
    transaction_id: &'static str,
    date: String,
    authorized_date: Option<String>,
    amount_cents: i64,
    name: String,
    merchant_name: Option<String>,
    original_description: String,
    review_reason: Option<&'static str>,
}

/// A demo Plaid connection on Chase Sapphire, with reconciliation rows that
/// the Sync page shows: two strong matches, a weak match, two rows with no
/// match, and one row to review.
async fn seed_plaid(seeder: &mut Seeder<'_>, a: &Accounts) -> SeedResult<()> {
    (seeder.log)("  Seeding Plaid sync demo data...");
    let book_id = seeder.book_id;

    // The transaction ID breaks a tie between two charges on one date.
    let recent: Vec<ChaseCharge> = sqlx::query_as::<_, (String, Option<String>, i32)>(
        "SELECT t.date, t.description, s.amount
         FROM transactions t
         JOIN transaction_splits s ON s.transaction_id = t.id
         WHERE s.account_id = $1 AND t.book_id = $2 AND s.amount < 0
         ORDER BY t.date DESC, t.id DESC
         LIMIT 5",
    )
    .bind(a.chase_sapphire)
    .bind(book_id)
    .fetch_all(&mut *seeder.connection)
    .await?
    .into_iter()
    .map(|(date, description, amount)| ChaseCharge {
        date,
        description,
        amount,
    })
    .collect();

    // plaid_tokens.item_id and plaid_accounts.plaid_account_id are unique in
    // the whole table, as real Plaid IDs are. The book ID in each value lets
    // one database hold more than one seeded book.
    let token_id: i32 = sqlx::query_scalar(
        "INSERT INTO plaid_tokens
           (book_id, financial_institution, item_id, access_token, is_demo, created_at, updated_at)
         VALUES ($1, 'Chase Bank', $2, $3, true, $4, $4)
         RETURNING id",
    )
    .bind(book_id)
    .bind(format!("demo_item_chase_{book_id}"))
    .bind(format!("demo_access_token_chase_{book_id}"))
    .bind(seeder.now)
    .fetch_one(&mut *seeder.connection)
    .await?;
    // is_demo keeps the scheduled sync away from this connection. Plaid can
    // only refuse its token.

    let link_id: i32 = sqlx::query_scalar(
        "INSERT INTO plaid_accounts
           (book_id, token_id, plaid_account_id, name, official_name, mask, type, subtype,
            counterpoise_account_id, created_at, updated_at)
         VALUES ($1, $2, $3, 'Chase Sapphire', 'Chase Sapphire Preferred', '4567', 'credit',
                 'credit card', $4, $5, $5)
         RETURNING id",
    )
    .bind(book_id)
    .bind(token_id)
    .bind(format!("demo_acct_chase_sapphire_{book_id}"))
    .bind(a.chase_sapphire)
    .bind(seeder.now)
    .fetch_one(&mut *seeder.connection)
    .await?;

    // Plaid gives a charge as a positive amount.
    let mut items = Vec::new();
    if let [first, second, third, ..] = recent.as_slice() {
        items.push(Reconciliation {
            transaction_id: "demo_txn_001",
            date: first.date.clone(),
            authorized_date: Some(first.date.clone()),
            amount_cents: -i64::from(first.amount),
            name: format!("{} #1234", first.upper()),
            merchant_name: first.description.clone(),
            original_description: format!("{} STORE 1234", first.upper()),
            review_reason: None,
        });
        let day_before = NaiveDate::parse_from_str(&second.date, "%Y-%m-%d")
            .map_err(|cause| SeedError::Invalid(format!("Bad date {}: {cause}", second.date)))?
            - Days::new(1);
        let day_before = format_date(day_before);
        items.push(Reconciliation {
            transaction_id: "demo_txn_002",
            date: day_before.clone(),
            authorized_date: Some(day_before),
            amount_cents: -i64::from(second.amount),
            name: format!("{} #567", second.upper()),
            merchant_name: second.description.clone(),
            original_description: format!("{} 567", second.upper()),
            review_reason: None,
        });
        // A weak match: the amount is 29 cents off.
        items.push(Reconciliation {
            transaction_id: "demo_txn_003",
            date: third.date.clone(),
            authorized_date: Some(third.date.clone()),
            amount_cents: -i64::from(third.amount) + 29,
            name: format!("{} MODIFIED", third.upper()),
            merchant_name: third.description.clone(),
            original_description: format!("{} MODIFIED", third.upper()),
            review_reason: None,
        });
    }
    items.push(Reconciliation {
        transaction_id: "demo_txn_004",
        date: "2025-12-28".to_owned(),
        authorized_date: None,
        amount_cents: 4250,
        name: "TRADER JOES #789".to_owned(),
        merchant_name: Some("Trader Joe's".to_owned()),
        original_description: "TRADER JOES 789 JERSEY CITY NJ".to_owned(),
        review_reason: None,
    });
    items.push(Reconciliation {
        transaction_id: "demo_txn_005",
        date: "2025-12-29".to_owned(),
        authorized_date: None,
        amount_cents: 28999,
        name: "BEST BUY #0042".to_owned(),
        merchant_name: Some("Best Buy".to_owned()),
        original_description: "BEST BUY 00042 SECAUCUS NJ".to_owned(),
        review_reason: None,
    });
    if let Some(fourth) = recent.get(3) {
        items.push(Reconciliation {
            transaction_id: "demo_txn_006",
            date: fourth.date.clone(),
            authorized_date: Some(fourth.date.clone()),
            amount_cents: -i64::from(fourth.amount),
            name: format!("{} REVISED", fourth.upper()),
            merchant_name: fourth.description.clone(),
            original_description: format!("{} REVISED", fourth.upper()),
            review_reason: Some("plaid_modified"),
        });
    }

    for item in &items {
        sqlx::query(
            "INSERT INTO plaid_transaction_reconciliation
               (book_id, plaid_account_link_id, plaid_transaction_id, date, authorized_date,
                amount_cents, name, merchant_name, original_description, pending, raw_json,
                resolution_status, review_reason, first_seen_at, last_seen_at, created_at,
                updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, false, '{}', 'pending', $10,
                     $11, $11, $11, $11)",
        )
        .bind(book_id)
        .bind(link_id)
        .bind(item.transaction_id)
        .bind(&item.date)
        .bind(&item.authorized_date)
        .bind(i32::try_from(item.amount_cents).map_err(|_| {
            SeedError::Invalid(format!("Plaid amount too large: {}", item.amount_cents))
        })?)
        .bind(&item.name)
        .bind(&item.merchant_name)
        .bind(&item.original_description)
        .bind(item.review_reason)
        .bind(seeder.now)
        .execute(&mut *seeder.connection)
        .await?;
    }
    (seeder.log)(&format!("  Plaid reconciliation items: {}", items.len()));
    Ok(())
}

struct RuleSeed {
    name: &'static str,
    schedule: Schedule,
    payee: &'static str,
    template_description: &'static str,
    auto_create_days_before: i32,
    splits: Vec<Split>,
}

enum Schedule {
    Monthly(u32),
    /// Every `interval` weeks on a weekday, where 0 is Sunday.
    Weekly {
        interval: i32,
        weekday: u32,
    },
}

/// Rules for the bills that the monthly loop posts, so that the Recurring
/// page shows the same household as the rest of the book.
///
/// The dates come from `today`, not from 2023 to 2025. A fixed next date
/// would be months overdue in a book created later, and the hourly recurring
/// job would post each rule into each demo book at its next run.
async fn seed_recurring(
    seeder: &mut Seeder<'_>,
    a: &Accounts,
    payee: &(dyn Fn(&str) -> Option<i32> + Sync),
    today: NaiveDate,
) -> SeedResult<()> {
    let rule =
        |name, schedule, payee, template_description, auto_create_days_before, splits| RuleSeed {
            name,
            schedule,
            payee,
            template_description,
            auto_create_days_before,
            splits,
        };
    let rules = [
        rule(
            "Rent",
            Schedule::Monthly(1),
            "Greenwood Apartments",
            "Rent Payment",
            3,
            vec![split(a.housing_rent, 250_000), split(a.checking, -250_000)],
        ),
        rule(
            "Electric Bill",
            Schedule::Monthly(5),
            "PSE&G",
            "Electric Bill",
            0,
            vec![
                split(a.housing_electric, 12_000),
                split(a.checking, -12_000),
            ],
        ),
        rule(
            "Internet",
            Schedule::Monthly(12),
            "Optimum Internet",
            "Internet",
            0,
            vec![split(a.housing_internet, 9_000), split(a.checking, -9_000)],
        ),
        rule(
            "Phone Bill",
            Schedule::Monthly(12),
            "T-Mobile",
            "Phone Bill",
            0,
            vec![split(a.housing_phone, 14_000), split(a.checking, -14_000)],
        ),
        // On the card, not on checking, so that the page shows both.
        rule(
            "Netflix",
            Schedule::Monthly(20),
            "Netflix",
            "Netflix",
            0,
            vec![split(a.streaming, 1_599), split(a.amex_blue, -1_599)],
        ),
        // Biweekly, and the only template with more than two splits. It shows
        // that a rule is a full double-entry transaction, not a reminder.
        rule(
            "Paycheck - Meridian Health",
            Schedule::Weekly {
                interval: 2,
                weekday: 5,
            },
            "Meridian Health Systems",
            "Paycheck - Meridian Health",
            0,
            vec![
                split(a.checking, 268_500),
                split(a.tax_federal, 62_000),
                split(a.tax_nj, 15_500),
                split(a.tax_ss, 26_800),
                split(a.tax_medicare, 6_300),
                split(a.ins_health, 18_000),
                split(a.ins_dental, 2_900),
                split(a.sarah_salary, -400_000),
            ],
        ),
    ];

    let count = rules.len();
    for RuleSeed {
        name,
        schedule,
        payee: payee_name,
        template_description,
        auto_create_days_before,
        splits,
    } in rules
    {
        // Both day columns hold JSON text, as the API writes them.
        let (frequency, interval, days_of_month, days_of_week, next) = match schedule {
            Schedule::Monthly(day) => (
                "monthly",
                1,
                Some(format!("[{day}]")),
                None,
                next_monthly_date(today, day),
            ),
            Schedule::Weekly { interval, weekday } => (
                "weekly",
                interval,
                None,
                Some(format!("[{weekday}]")),
                next_weekday_date(today, weekday),
            ),
        };
        let next = format_date(next);
        let rule_id: i32 = sqlx::query_scalar(
            "INSERT INTO recurring_rules
               (book_id, name, frequency, interval, days_of_month, days_of_week, start_date,
                next_date, auto_create_days_before, template_description, payee_id, is_active,
                created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9, $10, true, $11)
             RETURNING id",
        )
        .bind(seeder.book_id)
        .bind(name)
        .bind(frequency)
        .bind(interval)
        .bind(days_of_month)
        .bind(days_of_week)
        .bind(&next)
        .bind(auto_create_days_before)
        .bind(template_description)
        .bind(payee(payee_name))
        .bind(seeder.now)
        .fetch_one(&mut *seeder.connection)
        .await?;
        for template in splits {
            sqlx::query(
                "INSERT INTO recurring_template_splits (book_id, recurring_rule_id, account_id, amount)
                 VALUES ($1, $2, $3, $4)",
            )
            .bind(seeder.book_id)
            .bind(rule_id)
            .bind(template.account_id)
            .bind(template.amount as i32)
            .execute(&mut *seeder.connection)
            .await?;
        }
    }
    (seeder.log)(&format!("  Recurring rules: {count}"));
    Ok(())
}

async fn verify_and_summarize(seeder: Seeder<'_>, started: Instant) -> SeedResult<SeedSummary> {
    let Seeder {
        connection,
        book_id,
        log,
        ..
    } = seeder;
    let unbalanced: Vec<(i32, String, Option<String>, i64)> = sqlx::query_as(
        "SELECT t.id, t.date, t.description, SUM(s.amount)::bigint
         FROM transactions t
         JOIN transaction_splits s ON s.transaction_id = t.id
         WHERE t.book_id = $1
         GROUP BY t.id, t.date, t.description
         HAVING ABS(SUM(s.amount)) > 1",
    )
    .bind(book_id)
    .fetch_all(&mut *connection)
    .await?;
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
    ) = sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM accounts), (SELECT COUNT(*) FROM payees),
                (SELECT COUNT(*) FROM transactions), (SELECT COUNT(*) FROM transaction_splits),
                (SELECT COUNT(*) FROM investment_splits), (SELECT COUNT(*) FROM investment_lots)",
    )
    .fetch_one(&mut *connection)
    .await?;
    let summary = SeedSummary {
        accounts,
        payees,
        transactions,
        transaction_splits,
        investment_splits,
        investment_lots,
    };

    log("\n  Seed complete!");
    log(&format!("  Time: {:.1}s", started.elapsed().as_secs_f64()));
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mulberry32_matches_javascript() {
        // The first draws of mulberry32(42) in Node.
        let mut rand = Mulberry32::new(42);
        let draws: Vec<f64> = (0..3).map(|_| rand.next()).collect();
        assert_eq!(
            draws,
            [0.6011037519201636, 0.44829055899754167, 0.8524657934904099]
        );
    }

    #[test]
    fn js_round_takes_a_half_up() {
        assert_eq!(js_round(2.5), 3.0);
        assert_eq!(js_round(-2.5), -2.0);
        assert_eq!(js_round(-2.6), -3.0);
        assert_eq!(js_round(0.49999999999999994), 0.0);
    }

    #[test]
    fn monthly_rule_is_strictly_after_today() {
        let month_end = date(2026, 8, 31);
        assert_eq!(next_monthly_date(month_end, 1), date(2026, 9, 1));
        assert_eq!(next_monthly_date(date(2026, 9, 5), 5), date(2026, 10, 5));
        assert_eq!(next_monthly_date(date(2026, 9, 4), 5), date(2026, 9, 5));
        assert_eq!(next_monthly_date(date(2026, 12, 20), 12), date(2027, 1, 12));
    }

    #[test]
    fn weekly_rule_is_strictly_after_today() {
        // 2026-09-25 is a Friday.
        assert_eq!(next_weekday_date(date(2026, 9, 25), 5), date(2026, 10, 2));
        assert_eq!(next_weekday_date(date(2026, 9, 24), 5), date(2026, 9, 25));
        assert_eq!(next_weekday_date(date(2026, 9, 27), 5), date(2026, 10, 2));
    }
}
