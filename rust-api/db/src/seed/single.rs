//! One homeowner in Denver, Colorado: a semimonthly paycheck, a mortgage, a
//! car lease, one credit card, a 401(k), a Roth IRA and a brokerage account.
//! The amounts are integer cents.

use std::collections::{BTreeMap, HashMap};

use chrono::{Datelike, Days, NaiveDate};
use ledger_core::recurring::occurrence_date;

use super::plaid::{PlaidDemo, Unmatched, seed_plaid};
use super::prices::{
    BND_PRICES, Security, VTI_PRICES, VXUS_PRICES, limit_401k, limit_ira, seed_prices,
};
use super::recurring::{RuleSeed, Schedule, write_rules};
use super::window::{Window, date, format_date, last_day_of_month};
use super::{
    Positions, SeedError, SeedResult, Seeder, Split, buy_allocation, gross_cents, insert_payees,
    split,
};

const PAYEES: [&str; 26] = [
    "Summit Software",
    "Front Range Mortgage",
    "Xcel Energy",
    "Comcast Xfinity",
    "Verizon Wireless",
    "Toyota Financial Services",
    "Progressive",
    "King Soopers",
    "Safeway",
    "Sprouts Farmers Market",
    "Chipotle",
    "Snooze",
    "Illegal Pete's",
    "Starbucks",
    "Conoco",
    "Shell",
    "Amazon",
    "Target",
    "REI",
    "Netflix",
    "Spotify",
    "UCHealth",
    "Walgreens",
    "Capital One",
    "Main Street Bank",
    "Transfer",
];

const GROSS_PAY: i64 = 479_167;
const HEALTH_INSURANCE: i64 = 9_500;
const FEDERAL_TAX: i64 = 52_000;
/// 8% of the gross pay, before the annual cap.
const CONTRIBUTION: i64 = 38_333;
const MORTGAGE_PRINCIPAL_AND_INTEREST: i64 = 209_345;
const PROPERTY_TAX: i64 = 26_000;
const HOMEOWNERS_INSURANCE: i64 = 12_500;
const CAR_LEASE: i64 = 38_900;
const AUTO_INSURANCE: i64 = 14_200;
const INTERNET: i64 = 8_000;
const PHONE: i64 = 6_500;
const SAVINGS_TRANSFER: i64 = 50_000;
const ROTH_CONTRIBUTION: i64 = 58_300;
const BROKERAGE_TRANSFER: i64 = 40_000;
/// The usual card payment, for the recurring rule.
const CARD_PAYMENT_ESTIMATE: i64 = 110_000;

struct Accounts {
    checking: i32,
    savings: i32,
    home: i32,
    k401: i32,
    k401_cash: i32,
    roth: i32,
    roth_cash: i32,
    brokerage: i32,
    brokerage_cash: i32,
    mortgage: i32,
    card: i32,
    salary: i32,
    interest_income: i32,
    dividends: i32,
    tax_federal: i32,
    tax_state: i32,
    tax_ss: i32,
    tax_medicare: i32,
    health: i32,
    mortgage_interest: i32,
    property_tax: i32,
    home_insurance: i32,
    utilities: i32,
    internet: i32,
    car_lease: i32,
    auto_insurance: i32,
    fuel: i32,
    phone: i32,
    groceries: i32,
    dining: i32,
    shopping: i32,
    subscriptions: i32,
    medical: i32,
    opening: i32,
}

async fn create_accounts(seeder: &mut Seeder<'_>) -> SeedResult<Accounts> {
    let (asset, liability, income, expense) = ("asset", "liability", "income", "expense");
    let checking = seeder
        .account("Checking", asset, Some("bank"), None, true, None)
        .await?;
    let savings = seeder
        .account("Savings", asset, Some("bank"), None, true, None)
        .await?;
    let home = seeder
        .account("Home", asset, Some("other"), None, false, None)
        .await?;
    let k401 = seeder
        .account("401(k)", asset, Some("investment"), None, false, None)
        .await?;
    let k401_cash = seeder
        .account("401(k) Cash", asset, Some("cash"), Some(k401), false, None)
        .await?;
    let roth = seeder
        .account("Roth IRA", asset, Some("investment"), None, false, None)
        .await?;
    let roth_cash = seeder
        .account(
            "Roth IRA Cash",
            asset,
            Some("cash"),
            Some(roth),
            false,
            None,
        )
        .await?;
    let brokerage = seeder
        .account("Brokerage", asset, Some("investment"), None, true, None)
        .await?;
    let brokerage_cash = seeder
        .account(
            "Brokerage Cash",
            asset,
            Some("cash"),
            Some(brokerage),
            false,
            None,
        )
        .await?;
    (seeder.log)("  Created asset accounts");

    let mortgage = seeder
        .account("Mortgage", liability, Some("loan"), None, false, None)
        .await?;
    let card = seeder
        .account(
            "Capital One Quicksilver",
            liability,
            Some("credit_card"),
            None,
            true,
            None,
        )
        .await?;
    (seeder.log)("  Created liability accounts");

    // Each top-level category has its own icon. Miscellaneous has none on
    // purpose, as in the household dataset.
    let salary = seeder
        .account("Salary", income, None, None, false, Some("\u{1f4b0}"))
        .await?;
    let interest_income = seeder
        .account(
            "Interest Income",
            income,
            None,
            None,
            false,
            Some("\u{1f3e6}"),
        )
        .await?;
    let dividends = seeder
        .account("Dividends", income, None, None, false, Some("\u{1f4c8}"))
        .await?;
    (seeder.log)("  Created income accounts");

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
    let tax_federal = seeder
        .account("Taxes:Federal", expense, None, Some(taxes), false, None)
        .await?;
    let tax_state = seeder
        .account("Taxes:Colorado", expense, None, Some(taxes), false, None)
        .await?;
    let tax_ss = seeder
        .account(
            "Taxes:Social Security",
            expense,
            None,
            Some(taxes),
            false,
            None,
        )
        .await?;
    let tax_medicare = seeder
        .account("Taxes:Medicare", expense, None, Some(taxes), false, None)
        .await?;
    let health = seeder
        .account(
            "Health Insurance",
            expense,
            None,
            None,
            false,
            Some("\u{1fa7a}"),
        )
        .await?;
    let housing = seeder
        .account("Housing", expense, None, None, false, Some("\u{1f3e0}"))
        .await?;
    let mortgage_interest = seeder
        .account(
            "Housing:Mortgage Interest",
            expense,
            None,
            Some(housing),
            false,
            None,
        )
        .await?;
    let property_tax = seeder
        .account(
            "Housing:Property Tax",
            expense,
            None,
            Some(housing),
            false,
            None,
        )
        .await?;
    let home_insurance = seeder
        .account(
            "Housing:Homeowners Insurance",
            expense,
            None,
            Some(housing),
            false,
            None,
        )
        .await?;
    let utilities = seeder
        .account(
            "Housing:Electric & Gas",
            expense,
            None,
            Some(housing),
            false,
            None,
        )
        .await?;
    let internet = seeder
        .account(
            "Housing:Internet",
            expense,
            None,
            Some(housing),
            false,
            Some("\u{1f310}"),
        )
        .await?;
    let auto = seeder
        .account("Auto", expense, None, None, false, Some("\u{1f697}"))
        .await?;
    let car_lease = seeder
        .account("Auto:Car Lease", expense, None, Some(auto), false, None)
        .await?;
    let auto_insurance = seeder
        .account("Auto:Insurance", expense, None, Some(auto), false, None)
        .await?;
    let fuel = seeder
        .account("Auto:Fuel", expense, None, Some(auto), false, None)
        .await?;
    let phone = seeder
        .account("Phone", expense, None, None, false, Some("\u{1f4f1}"))
        .await?;
    let groceries = seeder
        .account("Groceries", expense, None, None, false, Some("\u{1f6d2}"))
        .await?;
    let dining = seeder
        .account(
            "Dining",
            expense,
            None,
            None,
            false,
            Some("\u{1f37d}\u{fe0f}"),
        )
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
    let subscriptions = seeder
        .account(
            "Subscriptions",
            expense,
            None,
            None,
            false,
            Some("\u{1f4fa}"),
        )
        .await?;
    let medical = seeder
        .account("Medical", expense, None, None, false, Some("\u{1f3e5}"))
        .await?;
    seeder
        .account("Miscellaneous", expense, None, None, false, None)
        .await?;
    (seeder.log)("  Created expense accounts");

    let opening = seeder
        .account("Opening Balances", "equity", None, None, false, None)
        .await?;
    (seeder.log)("  Created equity account");

    Ok(Accounts {
        checking,
        savings,
        home,
        k401,
        k401_cash,
        roth,
        roth_cash,
        brokerage,
        brokerage_cash,
        mortgage,
        card,
        salary,
        interest_income,
        dividends,
        tax_federal,
        tax_state,
        tax_ss,
        tax_medicare,
        health,
        mortgage_interest,
        property_tax,
        home_insurance,
        utilities,
        internet,
        car_lease,
        auto_insurance,
        fuel,
        phone,
        groceries,
        dining,
        shopping,
        subscriptions,
        medical,
        opening,
    })
}

/// The splits of one paycheck with `contribution` to the 401(k).
fn paycheck_splits(a: &Accounts, contribution: i64) -> Vec<Split> {
    let taxable = GROSS_PAY - contribution - HEALTH_INSURANCE;
    // Colorado: a flat 4.4%. Social Security 6.2% and Medicare 1.45% of the
    // gross pay. Each rounds to the nearest cent.
    let state = (taxable * 44 + 500) / 1_000;
    let social_security = (GROSS_PAY * 62 + 500) / 1_000;
    let medicare = (GROSS_PAY * 145 + 5_000) / 10_000;
    let net = GROSS_PAY
        - contribution
        - HEALTH_INSURANCE
        - FEDERAL_TAX
        - state
        - social_security
        - medicare;
    let mut splits = vec![
        split(a.checking, net),
        split(a.tax_federal, FEDERAL_TAX),
        split(a.tax_state, state),
        split(a.tax_ss, social_security),
        split(a.tax_medicare, medicare),
        split(a.health, HEALTH_INSURANCE),
        split(a.salary, -GROSS_PAY),
    ];
    if contribution > 0 {
        splits.push(split(a.k401_cash, contribution));
    }
    splits
}

/// The interest and the principal of the next mortgage payment, at 6.25%.
fn mortgage_parts(balance: i64) -> (i64, i64) {
    let interest = (balance * 625 + 60_000) / 120_000;
    (
        interest,
        (MORTGAGE_PRINCIPAL_AND_INTEREST - interest).min(balance),
    )
}

/// What the generator leaves for the recurring rules.
struct End {
    mortgage_balance: i64,
}

/// Writes the single-homeowner rows into the book of `seeder`.
pub(super) async fn seed(seeder: &mut Seeder<'_>, window: Window) -> SeedResult<()> {
    let a = create_accounts(seeder).await?;
    let vti = Security::new(
        seeder
            .security("Vanguard Total Stock Market ETF", "VTI")
            .await?,
        "VTI",
        &VTI_PRICES,
        window,
    );
    let vxus = Security::new(
        seeder
            .security("Vanguard Total International Stock ETF", "VXUS")
            .await?,
        "VXUS",
        &VXUS_PRICES,
        window,
    );
    let bnd = Security::new(
        seeder
            .security("Vanguard Total Bond Market ETF", "BND")
            .await?,
        "BND",
        &BND_PRICES,
        window,
    );
    (seeder.log)("  Created securities");
    seed_prices(seeder, &[vti, vxus, bnd], window).await?;
    (seeder.log)("  Created security price history");
    let payees = insert_payees(seeder, &PAYEES).await?;
    (seeder.log)("  Created payees");

    let mut positions = Positions::default();
    seed_opening(seeder, &a, window, &mut positions, [vti, vxus, bnd]).await?;
    (seeder.log)("  Generating transactions...");
    let end = seed_months(
        seeder,
        &a,
        &payees,
        window,
        &mut positions,
        [vti, vxus, bnd],
    )
    .await?;
    seed_plaid(seeder, &plaid_demo(&a), window.today).await?;
    write_rules(seeder, rules(&a, &end), &payees, window.today).await?;
    Ok(())
}

/// The opening balances on the day before the window, and the first buys of
/// the investment accounts on its first day.
async fn seed_opening(
    seeder: &mut Seeder<'_>,
    a: &Accounts,
    window: Window,
    positions: &mut Positions,
    [vti, vxus, bnd]: [Security; 3],
) -> SeedResult<()> {
    (seeder.log)("  Creating opening balances...");
    let opening = format_date(window.opening_date());
    for (description, account, amount) in [
        ("Opening Balance - Checking", a.checking, 600_000),
        ("Opening Balance - Savings", a.savings, 1_800_000),
        ("Opening Balance - Home", a.home, 45_000_000),
        ("Opening Balance - Mortgage", a.mortgage, -31_200_000),
        ("Opening Balance - 401(k)", a.k401_cash, 4_200_000),
        ("Opening Balance - Roth IRA", a.roth_cash, 1_500_000),
        ("Opening Balance - Brokerage", a.brokerage_cash, 1_000_000),
    ] {
        seeder
            .transaction(
                &opening,
                description,
                None,
                &[split(account, amount), split(a.opening, -amount)],
            )
            .await?;
    }
    let start = format_date(window.start);
    for (account, cash, amount, allocation, label) in [
        (
            a.k401,
            a.k401_cash,
            4_200_000,
            vec![(vti, 0.6), (vxus, 0.3), (bnd, 0.0)],
            "401(k)",
        ),
        (
            a.roth,
            a.roth_cash,
            1_500_000,
            vec![(vti, 0.7), (vxus, 0.0)],
            "Roth IRA",
        ),
        (
            a.brokerage,
            a.brokerage_cash,
            1_000_000,
            vec![(vti, 0.8), (bnd, 0.0)],
            "Brokerage",
        ),
    ] {
        buy_allocation(
            seeder,
            positions,
            &start,
            window.start,
            account,
            cash,
            amount,
            &allocation,
            label,
        )
        .await?;
    }
    Ok(())
}

/// The events of each month of the window. Every random value of an event is
/// drawn before its date is checked, so the rows before `today` do not
/// depend on `today`.
async fn seed_months(
    seeder: &mut Seeder<'_>,
    a: &Accounts,
    payees: &HashMap<&'static str, i32>,
    window: Window,
    positions: &mut Positions,
    [vti, vxus, bnd]: [Security; 3],
) -> SeedResult<End> {
    let payee = |name: &str| payees.get(name).copied();
    let mut mortgage_balance: i64 = 31_200_000;
    let mut savings_balance: i64 = 1_800_000;
    let mut k401_by_year: BTreeMap<i32, i64> = BTreeMap::new();
    let mut roth_by_year: BTreeMap<i32, i64> = BTreeMap::new();
    // The card statement closes on the 21st and is paid on the 22nd. A
    // charge on or after the 22nd goes on the next statement.
    let mut carried: i64 = 0;

    for (_, year, month) in window.months() {
        let month_date = date(year, month, 1);
        let on = |day: u32| window.on(year, month, day);

        // Mortgage on the 1st.
        let (interest, principal) = mortgage_parts(mortgage_balance);
        if let Some(day) = on(1) {
            let escrow = PROPERTY_TAX + HOMEOWNERS_INSURANCE;
            seeder
                .transaction(
                    &format_date(day),
                    "Mortgage Payment",
                    payee("Front Range Mortgage"),
                    &[
                        split(a.mortgage, principal),
                        split(a.mortgage_interest, interest),
                        split(a.property_tax, PROPERTY_TAX),
                        split(a.home_insurance, HOMEOWNERS_INSURANCE),
                        split(a.checking, -(principal + interest + escrow)),
                    ],
                )
                .await?;
            mortgage_balance -= principal;
        }

        // Roth IRA on the 3rd, the buy on the 4th.
        let roth_room = limit_ira(year) - roth_by_year.get(&year).copied().unwrap_or(0);
        let roth = ROTH_CONTRIBUTION.min(roth_room.max(0));
        if roth > 0
            && let Some(day) = on(3)
        {
            seeder
                .transaction(
                    &format_date(day),
                    "Roth IRA Contribution",
                    payee("Main Street Bank"),
                    &[split(a.roth_cash, roth), split(a.checking, -roth)],
                )
                .await?;
            *roth_by_year.entry(year).or_default() += roth;
            if let Some(buy_day) = on(4) {
                buy_allocation(
                    seeder,
                    positions,
                    &format_date(buy_day),
                    month_date,
                    a.roth,
                    a.roth_cash,
                    roth,
                    &[(vti, 0.7), (vxus, 0.0)],
                    "Roth IRA",
                )
                .await?;
            }
        }

        // Brokerage on the 5th, the buy on the 6th.
        if let Some(day) = on(5) {
            seeder
                .transaction(
                    &format_date(day),
                    "Transfer to Brokerage",
                    payee("Main Street Bank"),
                    &[
                        split(a.brokerage_cash, BROKERAGE_TRANSFER),
                        split(a.checking, -BROKERAGE_TRANSFER),
                    ],
                )
                .await?;
            if let Some(buy_day) = on(6) {
                buy_allocation(
                    seeder,
                    positions,
                    &format_date(buy_day),
                    month_date,
                    a.brokerage,
                    a.brokerage_cash,
                    BROKERAGE_TRANSFER,
                    &[(vti, 0.8), (bnd, 0.0)],
                    "Brokerage",
                )
                .await?;
            }
        }

        // Electric and gas on the 9th: more in winter and in summer.
        let season = match month {
            12 | 1 | 2 => 18,
            6..=8 => 14,
            _ => 10,
        };
        let utilities = 9_000 * season / 10 + seeder.rand.int(-1_500, 1_500);
        if let Some(day) = on(9) {
            seeder
                .transaction(
                    &format_date(day),
                    "Electric & Gas",
                    payee("Xcel Energy"),
                    &[split(a.utilities, utilities), split(a.checking, -utilities)],
                )
                .await?;
        }

        for (day, description, payee_name, account, amount) in [
            (12, "Internet", "Comcast Xfinity", a.internet, INTERNET),
            (18, "Phone Bill", "Verizon Wireless", a.phone, PHONE),
            (
                20,
                "Car Lease",
                "Toyota Financial Services",
                a.car_lease,
                CAR_LEASE,
            ),
            (
                20,
                "Auto Insurance",
                "Progressive",
                a.auto_insurance,
                AUTO_INSURANCE,
            ),
        ] {
            if let Some(day) = on(day) {
                seeder
                    .transaction(
                        &format_date(day),
                        description,
                        payee(payee_name),
                        &[split(account, amount), split(a.checking, -amount)],
                    )
                    .await?;
            }
        }

        // Savings transfer on the 16th.
        if let Some(day) = on(16) {
            seeder
                .transaction(
                    &format_date(day),
                    "Transfer to Savings",
                    payee("Transfer"),
                    &[
                        split(a.savings, SAVINGS_TRANSFER),
                        split(a.checking, -SAVINGS_TRANSFER),
                    ],
                )
                .await?;
            savings_balance += SAVINGS_TRANSFER;
        }

        // The card charges of the month. Each is drawn in full first.
        let mut charges: Vec<(u32, &'static str, i32, i64)> = Vec::new();
        for week in 0..4_u32 {
            let day = 3 + week * 7 + seeder.rand.int(0, 2) as u32;
            let store = *seeder
                .rand
                .pick(&["King Soopers", "Safeway", "Sprouts Farmers Market"]);
            charges.push((day, store, a.groceries, seeder.rand.int(4_500, 14_000)));
        }
        for _ in 0..seeder.rand.int(4, 8) {
            let day = seeder.rand.int(1, 28) as u32;
            let place = *seeder
                .rand
                .pick(&["Chipotle", "Snooze", "Illegal Pete's", "Starbucks"]);
            charges.push((day, place, a.dining, seeder.rand.int(1_200, 6_500)));
        }
        for _ in 0..3 {
            let day = seeder.rand.int(1, 28) as u32;
            let station = *seeder.rand.pick(&["Conoco", "Shell"]);
            charges.push((day, station, a.fuel, seeder.rand.int(3_500, 6_000)));
        }
        for _ in 0..seeder.rand.int(2, 4) {
            let day = seeder.rand.int(1, 28) as u32;
            let shop = *seeder.rand.pick(&["Amazon", "Target", "REI"]);
            charges.push((day, shop, a.shopping, seeder.rand.int(1_500, 15_000)));
        }
        if seeder.rand.next() < 0.3 {
            let day = seeder.rand.int(1, 28) as u32;
            let provider = *seeder.rand.pick(&["UCHealth", "Walgreens"]);
            charges.push((day, provider, a.medical, seeder.rand.int(2_500, 20_000)));
        }
        charges.push((8, "Netflix", a.subscriptions, 1_549));
        charges.push((14, "Spotify", a.subscriptions, 1_199));

        let mut before_statement: i64 = 0;
        let mut after_statement: i64 = 0;
        for (day, name, account, amount) in charges {
            if let Some(charge_day) = on(day) {
                seeder
                    .transaction(
                        &format_date(charge_day),
                        name,
                        payee(name),
                        &[split(account, amount), split(a.card, -amount)],
                    )
                    .await?;
                if day <= 21 {
                    before_statement += amount;
                } else {
                    after_statement += amount;
                }
            }
        }
        let statement = carried + before_statement;
        if let Some(day) = on(22) {
            if statement > 0 {
                seeder
                    .transaction(
                        &format_date(day),
                        "Credit Card Payment",
                        payee("Capital One"),
                        &[split(a.card, statement), split(a.checking, -statement)],
                    )
                    .await?;
            }
            carried = after_statement;
        } else {
            carried = statement + after_statement;
        }

        // Paychecks on the 15th and the last day. A weekend date moves to the
        // next Monday, as a `businessDaysOnly` rule does. A paycheck whose
        // date moves past today is not written.
        for scheduled_day in [15, last_day_of_month(year, month)] {
            let scheduled = format_date(date(year, month, scheduled_day));
            let paid = occurrence_date(&scheduled, true).map_err(SeedError::Invalid)?;
            let paid = NaiveDate::parse_from_str(&paid, "%Y-%m-%d")
                .map_err(|cause| SeedError::Invalid(cause.to_string()))?;
            if paid > window.today {
                continue;
            }
            let room =
                limit_401k(paid.year()) - k401_by_year.get(&paid.year()).copied().unwrap_or(0);
            let contribution = CONTRIBUTION.min(room.max(0));
            *k401_by_year.entry(paid.year()).or_default() += contribution;
            seeder
                .transaction(
                    &format_date(paid),
                    "Paycheck - Summit Software",
                    payee("Summit Software"),
                    &paycheck_splits(a, contribution),
                )
                .await?;
            let buy_day = paid + Days::new(1);
            if contribution > 0 && buy_day <= window.today {
                buy_allocation(
                    seeder,
                    positions,
                    &format_date(buy_day),
                    paid,
                    a.k401,
                    a.k401_cash,
                    contribution,
                    &[(vti, 0.6), (vxus, 0.3), (bnd, 0.0)],
                    "401(k)",
                )
                .await?;
            }
        }

        // Quarter-end dividends on the 28th. Annual yields: VTI 1.5%, VXUS
        // 3%, BND 3.5%.
        if month % 3 == 0
            && let Some(day) = on(28)
        {
            for (account, cash, label) in [
                (a.k401, a.k401_cash, "401(k)"),
                (a.roth, a.roth_cash, "Roth IRA"),
                (a.brokerage, a.brokerage_cash, "Brokerage"),
            ] {
                for (security, basis_points) in [(vti, 150), (vxus, 300), (bnd, 350)] {
                    let held = positions.get(account, security.id);
                    if held <= 0 {
                        continue;
                    }
                    let value = gross_cents(held, security.price_micros(day)?);
                    let amount = value * basis_points / 40_000;
                    if amount > 0 {
                        seeder
                            .dividend(
                                &format_date(day),
                                account,
                                cash,
                                a.dividends,
                                security.id,
                                amount,
                                &format!("{} Dividend - {label}", security.symbol),
                            )
                            .await?;
                    }
                }
            }
        }

        // The December rebalance sells about 15% of the brokerage VTI, so
        // the book has FIFO allocations and realized gains.
        if month == 12
            && let Some(day) = on(18)
        {
            let held = positions.get(a.brokerage, vti.id);
            let trim = held * 15 / 100 / 100 * 100;
            if trim > 0 {
                seeder
                    .sell(
                        &format_date(day),
                        a.brokerage,
                        a.brokerage_cash,
                        vti.id,
                        trim,
                        vti.price_micros(month_date)?,
                        "Sell VTI - Rebalance",
                    )
                    .await?;
                positions.add(a.brokerage, vti.id, -trim);
            }
        }

        // Savings interest on the last day: 4.0% a year.
        let interest_day = last_day_of_month(year, month);
        if let Some(day) = on(interest_day) {
            let interest = (savings_balance * 400 + 60_000) / 120_000;
            seeder
                .transaction(
                    &format_date(day),
                    "Interest Payment",
                    payee("Main Street Bank"),
                    &[
                        split(a.savings, interest),
                        split(a.interest_income, -interest),
                    ],
                )
                .await?;
            savings_balance += interest;
        }
    }
    Ok(End { mortgage_balance })
}

fn plaid_demo(a: &Accounts) -> PlaidDemo {
    PlaidDemo {
        card: a.card,
        slug: "capital_one",
        account_slug: "capital_one_quicksilver",
        institution: "Capital One",
        account_name: "Capital One Quicksilver",
        official_name: "Capital One Quicksilver Cash Rewards",
        mask: "8812",
        unmatched: [
            Unmatched {
                name: "KING SOOPERS #112",
                merchant: "King Soopers",
                original_description: "KING SOOPERS 112 DENVER CO",
                amount_cents: 6_843,
            },
            Unmatched {
                name: "REI #45",
                merchant: "REI",
                original_description: "REI 45 DENVER CO",
                amount_cents: 12_995,
            },
        ],
    }
}

/// The rules continue the generator's pattern from tomorrow.
fn rules(a: &Accounts, end: &End) -> Vec<RuleSeed> {
    let (interest, principal) = mortgage_parts(end.mortgage_balance);
    let rule = |name, schedule, payee, business_days_only, splits| RuleSeed {
        name,
        schedule,
        payee,
        template_description: name,
        auto_create_days_before: 0,
        business_days_only,
        splits,
    };
    let monthly = |day| Schedule::Monthly(day);
    let pair = |to: i32, from: i32, amount: i64| vec![split(to, amount), split(from, -amount)];
    vec![
        rule(
            "Paycheck - Summit Software",
            Schedule::MonthlyDays(&[15, -1]),
            "Summit Software",
            true,
            paycheck_splits(a, CONTRIBUTION),
        ),
        rule(
            "Mortgage Payment",
            monthly(1),
            "Front Range Mortgage",
            false,
            vec![
                split(a.mortgage, principal),
                split(a.mortgage_interest, interest),
                split(a.property_tax, PROPERTY_TAX),
                split(a.home_insurance, HOMEOWNERS_INSURANCE),
                split(
                    a.checking,
                    -(principal + interest + PROPERTY_TAX + HOMEOWNERS_INSURANCE),
                ),
            ],
        ),
        rule(
            "Car Lease",
            monthly(20),
            "Toyota Financial Services",
            false,
            pair(a.car_lease, a.checking, CAR_LEASE),
        ),
        rule(
            "Internet",
            monthly(12),
            "Comcast Xfinity",
            false,
            pair(a.internet, a.checking, INTERNET),
        ),
        rule(
            "Credit Card Payment",
            monthly(22),
            "Capital One",
            false,
            pair(a.card, a.checking, CARD_PAYMENT_ESTIMATE),
        ),
        rule(
            "Transfer to Savings",
            monthly(16),
            "Transfer",
            false,
            pair(a.savings, a.checking, SAVINGS_TRANSFER),
        ),
        rule(
            "Roth IRA Contribution",
            monthly(3),
            "Main Street Bank",
            false,
            pair(a.roth_cash, a.checking, ROTH_CONTRIBUTION),
        ),
    ]
}
