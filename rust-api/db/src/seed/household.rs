//! A married couple in New Jersey: two paychecks, three cards, a car loan,
//! two 401(k)s, two IRAs and a joint brokerage account.

use std::collections::BTreeMap;

use chrono::{Datelike, Days, NaiveDate};

use super::plaid::{PlaidDemo, Unmatched, seed_plaid};
use super::prices::{
    AGG_PRICES, BND_PRICES, Security, VTI_PRICES, VXUS_PRICES, limit_401k, limit_ira, seed_prices,
};
use super::recurring::{RuleSeed, Schedule, write_rules};
use super::window::{Window, date, format_date};
use super::{
    Positions, SeedResult, Seeder, buy_allocation, gross_cents, insert_payees, js_round, split,
};

/// Writes the household rows into the book of `seeder`.
pub(super) async fn seed(seeder: &mut Seeder<'_>, window: Window) -> SeedResult<()> {
    let accounts = create_accounts(seeder).await?;

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
    let agg = Security::new(
        seeder
            .security("iShares Core US Aggregate Bond ETF", "AGG")
            .await?,
        "AGG",
        &AGG_PRICES,
        window,
    );
    (seeder.log)("  Created securities");

    seed_prices(seeder, &[vti, vxus, bnd, agg], window).await?;
    (seeder.log)("  Created security price history");

    let payees = insert_payees(seeder, &PAYEES).await?;
    (seeder.log)("  Created payees");
    let payee = |name: &str| payees.get(name).copied();

    (seeder.log)("  Creating opening balances...");
    let a = &accounts;
    let opening_date = format_date(window.opening_date());
    seeder
        .transaction(
            &opening_date,
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
            &opening_date,
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
    let next_paycheck =
        seed_paychecks(seeder, a, &payee, &mut positions, [vti, vxus, bnd], window).await?;
    (seeder.log)("    Paychecks & 401(k) purchases done");
    seed_months(
        seeder,
        a,
        &payee,
        &mut positions,
        [vti, vxus, bnd, agg],
        window,
    )
    .await?;

    seed_plaid(seeder, &plaid_demo(&accounts), window.today).await?;
    write_rules(
        seeder,
        rules(&accounts, next_paycheck),
        &payees,
        window.today,
    )
    .await?;
    Ok(())
}

fn plaid_demo(a: &Accounts) -> PlaidDemo {
    PlaidDemo {
        card: a.chase_sapphire,
        slug: "chase",
        account_slug: "chase_sapphire",
        institution: "Chase Bank",
        account_name: "Chase Sapphire",
        official_name: "Chase Sapphire Preferred",
        mask: "4567",
        unmatched: [
            Unmatched {
                name: "TRADER JOES #789",
                merchant: "Trader Joe's",
                original_description: "TRADER JOES 789 JERSEY CITY NJ",
                amount_cents: 4250,
            },
            Unmatched {
                name: "BEST BUY #0042",
                merchant: "Best Buy",
                original_description: "BEST BUY 00042 SECAUCUS NJ",
                amount_cents: 28999,
            },
        ],
    }
}

/// Rules for the bills that the monthly loop posts, so that the Recurring
/// page shows the same household as the rest of the book. The dates come
/// from `today`.
fn rules(a: &Accounts, next_paycheck: NaiveDate) -> Vec<RuleSeed> {
    let rule =
        |name, schedule, payee, template_description, auto_create_days_before, splits| RuleSeed {
            name,
            schedule,
            payee,
            template_description,
            auto_create_days_before,
            business_days_only: false,
            splits,
        };
    vec![
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
            Schedule::Biweekly {
                next: next_paycheck,
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
    ]
}

const PAYEES: [&str; 50] = [
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
    // Credit card issuers
    "Chase Bank",
    "American Express",
    "Citi",
    // Checking bank
    "Main Street Bank",
];

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

/// Biweekly paychecks for both earners from the first Friday of the window,
/// and each 401(k) purchase on the day after. Returns the next pay date after
/// `today`, for the paycheck rule.
async fn seed_paychecks(
    seeder: &mut Seeder<'_>,
    a: &Accounts,
    payee: &(dyn Fn(&str) -> Option<i32> + Sync),
    positions: &mut Positions,
    funds: [Security; 3],
    window: Window,
) -> SeedResult<NaiveDate> {
    let mut contributed: BTreeMap<(i32, i32), i64> = BTreeMap::new();
    let [vti, vxus, bnd] = funds;
    let allocation = [(vti, 0.4), (vxus, 0.2), (bnd, 0.0)];
    let mut pay_date = window.start;
    while pay_date.weekday() != chrono::Weekday::Fri {
        pay_date = pay_date + Days::new(1);
    }

    while pay_date <= window.today {
        let year = pay_date.year();
        let date_text = format_date(pay_date);
        let buy_on = pay_date + Days::new(1);
        let buy_date = format_date(buy_on);

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
            let remaining = limit_401k(year) - so_far;
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

            if contribution > 0 && buy_on <= window.today {
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
    Ok(pay_date)
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

/// The bills, card charges, dividends and contributions of each month of the
/// window. Each draw from the generator happens in a fixed order, because
/// each later amount depends on it. A draw happens whether or not its row is
/// written, so a row after `today` does not move the draws of the rows
/// before it.
async fn seed_months(
    seeder: &mut Seeder<'_>,
    a: &Accounts,
    payee: &(dyn Fn(&str) -> Option<i32> + Sync),
    positions: &mut Positions,
    funds: [Security; 4],
    window: Window,
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

    for (_, year, month1) in window.months() {
        let month = month1 - 1;
        let month_date = date(year, month1, 1);
        let on = |day: i64| window.on(year, month1, day as u32).map(format_date);

        if let Some(day) = on(1) {
            seeder
                .transaction(
                    &day,
                    "Rent Payment",
                    payee("Greenwood Apartments"),
                    &[split(a.housing_rent, 250_000), split(a.checking, -250_000)],
                )
                .await?;
        }

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
        if let Some(day) = on(5) {
            seeder
                .transaction(
                    &day,
                    "Electric Bill",
                    payee("PSE&G"),
                    &[
                        split(a.housing_electric, electric),
                        split(a.checking, -electric),
                    ],
                )
                .await?;
        }

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
        if let Some(day) = on(7) {
            seeder
                .transaction(
                    &day,
                    "Gas Bill",
                    payee("PSE&G"),
                    &[split(a.housing_gas, gas), split(a.checking, -gas)],
                )
                .await?;
        }

        let water = 6_500 + seeder.rand.int(-500, 500);
        if let Some(day) = on(10) {
            seeder
                .transaction(
                    &day,
                    "Water Bill",
                    payee("New Jersey American Water"),
                    &[split(a.housing_water, water), split(a.checking, -water)],
                )
                .await?;
        }

        if let Some(day) = on(12) {
            seeder
                .transaction(
                    &day,
                    "Internet",
                    payee("Optimum Internet"),
                    &[split(a.housing_internet, 9_000), split(a.checking, -9_000)],
                )
                .await?;
            seeder
                .transaction(
                    &day,
                    "Phone Bill",
                    payee("T-Mobile"),
                    &[split(a.housing_phone, 14_000), split(a.checking, -14_000)],
                )
                .await?;
        }
        if let Some(day) = on(15) {
            seeder
                .transaction(
                    &day,
                    "Car Insurance",
                    payee("Geico"),
                    &[split(a.ins_car, 18_500), split(a.checking, -18_500)],
                )
                .await?;
        }

        if car_loan_remaining > 0 {
            let interest = js_round(car_loan_remaining as f64 * (car_loan_rate / 12.0)) as i64;
            let principal = (car_loan_payment - interest).min(car_loan_remaining);
            if let Some(day) = on(18) {
                car_loan_remaining -= principal;
                seeder
                    .transaction(
                        &day,
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
        }

        if let Some(day) = on(20) {
            for (name, amount) in [("Netflix", 1_599), ("Spotify", 999), ("Hulu", 799)] {
                seeder
                    .transaction(
                        &day,
                        name,
                        payee(name),
                        &[split(a.streaming, amount), split(a.amex_blue, -amount)],
                    )
                    .await?;
                *card_balances.entry(a.amex_blue).or_default() += amount;
            }
        }

        if let Some(day) = on(1) {
            seeder
                .transaction(
                    &day,
                    "Equinox Membership",
                    payee("Equinox Gym"),
                    &[split(a.personal_gym, 18_000), split(a.checking, -18_000)],
                )
                .await?;
        }

        let charges = seeder.rand.int(15, 25);
        for _ in 0..charges {
            let template = seeder.rand.pick(&templates);
            let payee_name = *seeder.rand.pick(template.payees);
            let amount = seeder.rand.int(template.min, template.max);
            let day = seeder.rand.int(2, 28);
            if let Some(day) = on(day) {
                seeder
                    .transaction(
                        &day,
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
        }

        if seeder.rand.next() < 0.4 {
            let amount = seeder.rand.int(5_000, 25_000);
            let day = seeder.rand.int(5, 25);
            if let Some(day) = on(day) {
                seeder
                    .transaction(
                        &day,
                        "Doctor Visit",
                        payee("Summit Medical Group"),
                        &[split(a.medical, amount), split(a.citi_double, -amount)],
                    )
                    .await?;
                *card_balances.entry(a.citi_double).or_default() += amount;
            }
        }

        if seeder.rand.next() < 0.15 {
            let amount = seeder.rand.int(5_000, 45_000);
            let shop = *seeder.rand.pick(&["Mavis Discount Tire", "Jiffy Lube"]);
            let day = seeder.rand.int(5, 25);
            if let Some(day) = on(day) {
                seeder
                    .transaction(
                        &day,
                        shop,
                        payee(shop),
                        &[
                            split(a.auto_maintenance, amount),
                            split(a.checking, -amount),
                        ],
                    )
                    .await?;
            }
        }

        if seeder.rand.next() < 0.1 {
            let amount = seeder.rand.int(10_000, 80_000);
            let day = seeder.rand.int(5, 25);
            if let Some(day) = on(day) {
                seeder
                    .transaction(
                        &day,
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
        }

        // About two trips each year. The draw happens only in April and
        // September.
        if (month == 3 || month == 8) && seeder.rand.next() < 0.7 {
            let airfare = seeder.rand.int(30_000, 60_000);
            let hotel = seeder.rand.int(40_000, 120_000);
            let day = seeder.rand.int(5, 15);
            if let Some(day) = on(day) {
                seeder
                    .transaction(
                        &day,
                        "Flights",
                        payee("Delta Airlines"),
                        &[split(a.travel, airfare), split(a.chase_sapphire, -airfare)],
                    )
                    .await?;
                *card_balances.entry(a.chase_sapphire).or_default() += airfare;
            }

            let lodging = *seeder.rand.pick(&["Marriott Hotels", "Airbnb"]);
            let day = seeder.rand.int(16, 25);
            if let Some(day) = on(day) {
                seeder
                    .transaction(
                        &day,
                        lodging,
                        payee(lodging),
                        &[split(a.travel, hotel), split(a.chase_sapphire, -hotel)],
                    )
                    .await?;
                *card_balances.entry(a.chase_sapphire).or_default() += hotel;
            }
        }

        if month == 10 || month == 11 {
            let amount = seeder.rand.int(5_000, 30_000);
            let day = seeder.rand.int(5, 25);
            if let Some(day) = on(day) {
                seeder
                    .transaction(
                        &day,
                        "Gift Purchase",
                        payee("Amazon"),
                        &[split(a.gifts, amount), split(a.chase_sapphire, -amount)],
                    )
                    .await?;
                *card_balances.entry(a.chase_sapphire).or_default() += amount;
            }
        }

        for (card, balance) in card_balances.iter_mut() {
            if *balance > 0
                && let Some(day) = on(25)
            {
                let bank = if *card == a.chase_sapphire {
                    "Chase Bank"
                } else if *card == a.amex_blue {
                    "American Express"
                } else {
                    "Citi"
                };
                seeder
                    .transaction(
                        &day,
                        "Credit Card Payment",
                        payee(bank),
                        &[split(*card, *balance), split(a.checking, -*balance)],
                    )
                    .await?;
                *balance = 0;
            }
        }

        let quarter_end = month1 % 3 == 0;
        if quarter_end {
            // Annual yields: VTI 1.5%, VXUS 3%, BND 3.5%, AGG 3.8%.
            if let Some(dividend_date) = window.on(year, month1, 28) {
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
        }

        // IRA contributions in January, at the limit of the year.
        if month == 0
            && let Some(day) = on(15)
        {
            let limit = limit_ira(year);
            for (ira, ira_cash, person, label) in [
                (a.sarah_ira, a.sarah_ira_cash, "Sarah", "Sarah IRA"),
                (a.michael_ira, a.michael_ira_cash, "Michael", "Michael IRA"),
            ] {
                seeder
                    .transaction(
                        &day,
                        &format!("IRA Contribution - {person}"),
                        payee("Main Street Bank"),
                        &[split(ira_cash, limit), split(a.checking, -limit)],
                    )
                    .await?;
                if let Some(buy_day) = on(16) {
                    buy_allocation(
                        seeder,
                        positions,
                        &buy_day,
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
        }

        if quarter_end {
            let amount = seeder.rand.int(200_000, 500_000);
            if let Some(day) = on(10) {
                seeder
                    .transaction(
                        &day,
                        "Transfer to Brokerage",
                        payee("Main Street Bank"),
                        &[split(a.brokerage_cash, amount), split(a.checking, -amount)],
                    )
                    .await?;
                if let Some(buy_day) = on(11) {
                    buy_allocation(
                        seeder,
                        positions,
                        &buy_day,
                        month_date,
                        a.brokerage,
                        a.brokerage_cash,
                        amount,
                        &[(vti, 0.4), (vxus, 0.15), (bnd, 0.25), (agg, 0.0)],
                        "Brokerage",
                    )
                    .await?;
                }

                // The year-end rebalance sells about a fifth of the VTI in
                // the taxable brokerage. The brokerage buys each quarter, so
                // the sale takes shares from several lots. The seeded book
                // then has FIFO allocations, and the realized gains report
                // has rows.
                if month == 11 {
                    let held = positions.get(a.brokerage, vti.id);
                    let trim = js_round((held as f64 * 0.2) / 100.0) as i64 * 100;
                    if trim > 0
                        && trim <= held
                        && let Some(sale_day) = on(18)
                    {
                        let price = vti.price_micros(month_date)?;
                        seeder
                            .sell(
                                &sale_day,
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
        }

        if seeder.rand.next() < 0.3 {
            let app = *seeder.rand.pick(&["Venmo", "Zelle"]);
            let amount = seeder.rand.int(1_500, 10_000);
            let day = seeder.rand.int(5, 25);
            if let Some(day) = on(day) {
                seeder
                    .transaction(
                        &day,
                        app,
                        payee(app),
                        &[split(a.misc_expense, amount), split(a.checking, -amount)],
                    )
                    .await?;
            }
        }

        if month == 2 || month == 8 {
            let amount = seeder.rand.int(15_000, 25_000);
            let day = seeder.rand.int(10, 20);
            if let Some(day) = on(day) {
                seeder
                    .transaction(
                        &day,
                        "Dental Cleaning",
                        payee("Dr. Patel DDS"),
                        &[split(a.medical, amount), split(a.checking, -amount)],
                    )
                    .await?;
            }
        }

        if month % 2 == 1 {
            let day = seeder.rand.int(10, 25);
            if let Some(day) = on(day) {
                seeder
                    .transaction(
                        &day,
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
