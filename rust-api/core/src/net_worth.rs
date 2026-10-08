//! The net worth of a book at a list of dates, for the dashboard chart.

use std::collections::{HashMap, HashSet};

use chrono::{Datelike, Months, NaiveDate};
use serde::{Deserialize, Serialize};

use crate::accounting::gross_amount_cents;
use crate::investments::{InvestmentSplitRow, PositionReplay, SecurityPriceRow, replay_order};

/// The sum of the splits of one account in one month, "YYYY-MM".
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonthTotal {
    pub account_id: i64,
    pub month: String,
    pub amount_cents: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FixedPrice {
    pub security_id: i64,
    pub price_micros: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetWorthInput {
    /// The dates of the points, ascending. `point_dates` makes them.
    pub dates: Vec<String>,
    /// The split sums by account and month, ascending by month, of the asset
    /// and liability accounts that are not investment accounts. A liability
    /// sum is negative, so the sum of all rows is the net value of the
    /// accounts.
    pub book_months: Vec<MonthTotal>,
    /// Each investment split on or before the last date.
    pub splits: Vec<InvestmentSplitRow>,
    /// Each recorded price of the book.
    pub prices: Vec<SecurityPriceRow>,
    pub fixed_prices: Vec<FixedPrice>,
    /// The accounts whose market value replaces their book balance.
    pub investment_account_ids: Vec<i64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NetWorthPoint {
    pub date: String,
    pub net_worth_cents: i64,
}

/// An account of the book, with its parent, for `net_worth_by_group`.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeAccount {
    pub id: i64,
    pub parent_id: Option<i64>,
    pub name: String,
}

/// A top-level account that holds the value of its descendants.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NetWorthGroup {
    pub account_id: i64,
    pub name: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GroupValue {
    pub account_id: i64,
    pub value_cents: i64,
}

/// A net worth point with the value of each group, in the order of the
/// groups. The group values add up to `net_worth_cents`.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GroupedNetWorthPoint {
    pub date: String,
    pub net_worth_cents: i64,
    pub groups: Vec<GroupValue>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NetWorthByGroup {
    pub groups: Vec<NetWorthGroup>,
    pub points: Vec<GroupedNetWorthPoint>,
}

/// The last day of the month of `date`.
pub fn month_end(date: NaiveDate) -> NaiveDate {
    let first = date.with_day(1).expect("day 1 exists");
    first
        .checked_add_months(Months::new(1))
        .and_then(|next| next.pred_opt())
        .expect("the month end is a valid date")
}

/// Each month end from the month of `start` that is before `end`, then
/// `end`. The caller makes sure that `start` is not after `end`.
pub fn point_dates(start: NaiveDate, end: NaiveDate) -> Vec<String> {
    let mut dates = Vec::new();
    let mut current = month_end(start);
    while current < end {
        dates.push(current.format("%Y-%m-%d").to_string());
        current = month_end(current.succ_opt().expect("the next day exists"));
    }
    dates.push(end.format("%Y-%m-%d").to_string());
    dates
}

/// The prices of each security, ascending by date, and the fixed prices.
struct PriceBook {
    recorded: HashMap<i64, Vec<(String, i64)>>,
    fixed: HashMap<i64, i64>,
}

impl PriceBook {
    fn new(prices: &[SecurityPriceRow], fixed: &[FixedPrice]) -> Self {
        let mut recorded: HashMap<i64, Vec<(String, i64)>> = HashMap::new();
        for row in prices {
            recorded
                .entry(row.security_id)
                .or_default()
                .push((row.price_date.clone(), row.price_micros));
        }
        for rows in recorded.values_mut() {
            rows.sort();
        }
        Self {
            recorded,
            fixed: fixed
                .iter()
                .map(|row| (row.security_id, row.price_micros))
                .collect(),
        }
    }

    /// A fixed price, else the newest price on or before `date`, else the
    /// earliest price after it.
    fn price_on(&self, security_id: i64, date: &str) -> Option<i64> {
        if let Some(price) = self.fixed.get(&security_id) {
            return Some(*price);
        }
        let rows = self.recorded.get(&security_id)?;
        let after = rows.partition_point(|(day, _)| day.as_str() <= date);
        rows.get(after.saturating_sub(1)).map(|(_, price)| *price)
    }

    /// A fixed price, else the newest recorded price with no date limit, as
    /// `latest_prices()` in the server gives for the account values.
    fn newest_price(&self, security_id: i64) -> Option<i64> {
        if let Some(price) = self.fixed.get(&security_id) {
            return Some(*price);
        }
        self.recorded
            .get(&security_id)?
            .last()
            .map(|(_, price)| *price)
    }
}

/// The value of each account at each date: the book balance of an account
/// that is not an investment account, and the market value of an
/// investment account.
///
/// At each date except the last, a position uses the newest price on or
/// before that date. The last date uses the newest recorded price of each
/// security, also when that price is after the date. Thus the last point
/// equals the account values of `GET /investments/account-values` for
/// today. A fixed price wins at each date.
fn account_values(input: &NetWorthInput) -> Vec<HashMap<i64, i64>> {
    let prices = PriceBook::new(&input.prices, &input.fixed_prices);
    let investment: HashSet<i64> = input.investment_account_ids.iter().copied().collect();
    let mut replay = PositionReplay::new(&input.splits);
    let mut splits = replay_order(&input.splits).into_iter().peekable();
    let mut months = input.book_months.iter().peekable();
    let mut balances: HashMap<i64, i64> = HashMap::new();
    let last = input.dates.len().saturating_sub(1);
    input
        .dates
        .iter()
        .enumerate()
        .map(|(index, date)| {
            let month = &date[..7];
            while let Some(row) = months.next_if(|row| row.month.as_str() <= month) {
                *balances.entry(row.account_id).or_default() += row.amount_cents;
            }
            while let Some(split) =
                splits.next_if(|split| split.transaction_date.as_str() <= date.as_str())
            {
                replay.apply(split);
            }
            let mut values = balances.clone();
            for (&(account_id, security_id), &shares) in replay.positions() {
                if shares <= 0 || !investment.contains(&account_id) {
                    continue;
                }
                let price = if index == last {
                    prices.newest_price(security_id)
                } else {
                    prices.price_on(security_id, date)
                };
                if let Some(price) = price {
                    *values.entry(account_id).or_default() += gross_amount_cents(shares, price);
                }
            }
            values
        })
        .collect()
}

/// The net worth at each date: the book balances plus the market value of
/// the investment accounts. `account_values` gives the price rules.
pub fn net_worth_series(input: &NetWorthInput) -> Vec<NetWorthPoint> {
    input
        .dates
        .iter()
        .zip(account_values(input))
        .map(|(date, values)| NetWorthPoint {
            date: date.clone(),
            net_worth_cents: values.values().sum(),
        })
        .collect()
}

/// The top-level ancestor of each account. An account that is not in the
/// list is its own ancestor. The walk stops after one step for each
/// account, so a parent loop cannot make it run forever.
fn top_level_accounts(accounts: &[TreeAccount]) -> HashMap<i64, i64> {
    let parents: HashMap<i64, Option<i64>> = accounts
        .iter()
        .map(|account| (account.id, account.parent_id))
        .collect();
    accounts
        .iter()
        .map(|account| {
            let mut current = account.id;
            for _ in 0..parents.len() {
                match parents.get(&current) {
                    Some(Some(parent)) => current = *parent,
                    _ => break,
                }
            }
            (account.id, current)
        })
        .collect()
}

/// The net worth at each date, split by top-level account. The value of
/// each account, and the market value of each investment account, goes to
/// its top-level ancestor. A liability is negative. The groups are the
/// top-level accounts with a value that is not zero at one or more dates,
/// ordered by name. Each point has a value for each group.
pub fn net_worth_by_group(input: &NetWorthInput, accounts: &[TreeAccount]) -> NetWorthByGroup {
    let top = top_level_accounts(accounts);
    let per_date: Vec<HashMap<i64, i64>> = account_values(input)
        .into_iter()
        .map(|values| {
            let mut groups: HashMap<i64, i64> = HashMap::new();
            for (account_id, value) in values {
                let group = top.get(&account_id).copied().unwrap_or(account_id);
                *groups.entry(group).or_default() += value;
            }
            groups
        })
        .collect();
    let shown: HashSet<i64> = per_date
        .iter()
        .flat_map(|groups| {
            groups
                .iter()
                .filter(|&(_, &value)| value != 0)
                .map(|(&id, _)| id)
        })
        .collect();
    let names: HashMap<i64, &str> = accounts
        .iter()
        .map(|account| (account.id, account.name.as_str()))
        .collect();
    let mut groups: Vec<NetWorthGroup> = shown
        .into_iter()
        .map(|account_id| NetWorthGroup {
            account_id,
            name: names
                .get(&account_id)
                .copied()
                .unwrap_or_default()
                .to_owned(),
        })
        .collect();
    groups.sort_by(|a, b| a.name.cmp(&b.name).then(a.account_id.cmp(&b.account_id)));
    let points = input
        .dates
        .iter()
        .zip(per_date)
        .map(|(date, values)| GroupedNetWorthPoint {
            date: date.clone(),
            net_worth_cents: values.values().sum(),
            groups: groups
                .iter()
                .map(|group| GroupValue {
                    account_id: group.account_id,
                    value_cents: values.get(&group.account_id).copied().unwrap_or(0),
                })
                .collect(),
        })
        .collect();
    NetWorthByGroup { groups, points }
}

#[cfg(test)]
mod tests {
    // The parent module imports NaiveDate, InvestmentSplitRow and
    // SecurityPriceRow.
    use super::*;
    use crate::accounting::InvestmentAction;

    const SHARE: i64 = 1_000_000;
    const DOLLAR: i64 = 1_000_000;

    fn date(text: &str) -> NaiveDate {
        NaiveDate::parse_from_str(text, "%Y-%m-%d").unwrap()
    }

    fn trade(
        action: InvestmentAction,
        account: i64,
        security: i64,
        shares: i64,
        on: &str,
    ) -> InvestmentSplitRow {
        InvestmentSplitRow {
            security_id: security,
            shares_micros: shares * SHARE,
            price_micros: 0,
            fees_cents: 0,
            action,
            split_numerator: None,
            split_denominator: None,
            transaction_date: on.into(),
            account_id: Some(account),
        }
    }

    fn stock_split(
        security: i64,
        numerator: i64,
        denominator: i64,
        on: &str,
    ) -> InvestmentSplitRow {
        InvestmentSplitRow {
            security_id: security,
            shares_micros: 0,
            price_micros: 0,
            fees_cents: 0,
            action: InvestmentAction::Split,
            split_numerator: Some(numerator),
            split_denominator: Some(denominator),
            transaction_date: on.into(),
            account_id: None,
        }
    }

    fn price(security: i64, on: &str, dollars: i64) -> SecurityPriceRow {
        SecurityPriceRow {
            security_id: security,
            price_micros: dollars * DOLLAR,
            price_date: on.into(),
        }
    }

    fn input(dates: &[&str]) -> NetWorthInput {
        NetWorthInput {
            dates: dates.iter().map(|d| (*d).to_owned()).collect(),
            book_months: Vec::new(),
            splits: Vec::new(),
            prices: Vec::new(),
            fixed_prices: Vec::new(),
            investment_account_ids: vec![1],
        }
    }

    fn month_total(account: i64, month: &str, cents: i64) -> MonthTotal {
        MonthTotal {
            account_id: account,
            month: month.into(),
            amount_cents: cents,
        }
    }

    fn account(id: i64, parent: Option<i64>, name: &str) -> TreeAccount {
        TreeAccount {
            id,
            parent_id: parent,
            name: name.into(),
        }
    }

    fn values(input: &NetWorthInput) -> Vec<i64> {
        net_worth_series(input)
            .into_iter()
            .map(|point| point.net_worth_cents)
            .collect()
    }

    #[test]
    fn point_dates_are_month_ends_then_the_end_date() {
        assert_eq!(
            point_dates(date("2026-01-15"), date("2026-04-10")),
            ["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-10"]
        );
        assert_eq!(
            point_dates(date("2026-01-15"), date("2026-03-31")),
            ["2026-01-31", "2026-02-28", "2026-03-31"]
        );
        assert_eq!(
            point_dates(date("2026-03-05"), date("2026-03-20")),
            ["2026-03-20"]
        );
        assert_eq!(month_end(date("2024-02-10")), date("2024-02-29"));
    }

    #[test]
    fn book_months_add_up_to_each_point() {
        let mut input = input(&["2026-01-31", "2026-02-28"]);
        input.book_months = vec![
            month_total(5, "2025-12", 1000),
            month_total(6, "2026-01", 500),
            month_total(5, "2026-02", -200),
        ];
        assert_eq!(values(&input), [1500, 1300]);
    }

    #[test]
    fn a_position_uses_the_newest_price_on_or_before_each_date() {
        let mut input = input(&["2026-01-31", "2026-02-28"]);
        input.splits = vec![trade(InvestmentAction::Buy, 1, 7, 10, "2026-01-10")];
        input.prices = vec![price(7, "2026-01-20", 100), price(7, "2026-02-15", 110)];
        assert_eq!(values(&input), [100_000, 110_000]);
    }

    #[test]
    fn the_last_point_uses_the_newest_price_also_when_it_is_after_the_date() {
        // Today is 2026-02-10. A price is recorded for yesterday and for tomorrow.
        let mut input = input(&["2026-01-31", "2026-02-10"]);
        input.splits = vec![trade(InvestmentAction::Buy, 1, 7, 10, "2026-01-10")];
        input.prices = vec![
            price(7, "2026-01-20", 90),
            price(7, "2026-02-09", 100),
            price(7, "2026-02-11", 120),
        ];
        assert_eq!(values(&input), [90_000, 120_000]);
    }

    #[test]
    fn a_fixed_price_wins_over_a_newer_recorded_price_at_the_last_point() {
        let mut input = input(&["2026-02-10"]);
        input.splits = vec![trade(InvestmentAction::Buy, 1, 7, 10, "2026-01-10")];
        input.prices = vec![price(7, "2026-02-11", 120)];
        input.fixed_prices = vec![FixedPrice {
            security_id: 7,
            price_micros: 50 * DOLLAR,
        }];
        assert_eq!(values(&input), [50_000]);
    }

    #[test]
    fn a_date_before_the_first_price_uses_the_earliest_later_price() {
        // The last point uses the newest price, so an earlier point shows the rule.
        let mut input = input(&["2026-01-31", "2026-03-31"]);
        input.splits = vec![trade(InvestmentAction::Buy, 1, 7, 10, "2026-01-10")];
        input.prices = vec![price(7, "2026-02-15", 110), price(7, "2026-03-15", 120)];
        assert_eq!(values(&input), [110_000, 120_000]);
    }

    #[test]
    fn a_fixed_price_applies_on_every_date() {
        let mut input = input(&["2026-01-31", "2026-02-28"]);
        input.splits = vec![trade(InvestmentAction::Buy, 1, 7, 10, "2026-01-10")];
        input.prices = vec![price(7, "2026-01-20", 100)];
        input.fixed_prices = vec![FixedPrice {
            security_id: 7,
            price_micros: 50 * DOLLAR,
        }];
        assert_eq!(values(&input), [50_000, 50_000]);
    }

    #[test]
    fn a_stock_split_changes_the_shares_from_its_date() {
        let mut input = input(&["2026-01-31", "2026-02-28"]);
        input.splits = vec![
            trade(InvestmentAction::Buy, 1, 7, 10, "2026-01-10"),
            stock_split(7, 2, 1, "2026-02-10"),
        ];
        input.prices = vec![price(7, "2026-01-01", 100)];
        assert_eq!(values(&input), [100_000, 200_000]);
    }

    #[test]
    fn a_position_sold_to_zero_adds_nothing() {
        let mut input = input(&["2026-01-31", "2026-02-28"]);
        input.splits = vec![
            trade(InvestmentAction::Buy, 1, 7, 10, "2026-01-10"),
            trade(InvestmentAction::Sell, 1, 7, 10, "2026-02-05"),
        ];
        input.prices = vec![price(7, "2026-01-01", 100), price(7, "2026-02-20", 130)];
        assert_eq!(values(&input), [100_000, 0]);
    }

    #[test]
    fn only_investment_accounts_and_priced_securities_add_market_value() {
        let mut input = input(&["2026-01-31"]);
        input.splits = vec![
            trade(InvestmentAction::Buy, 2, 7, 10, "2026-01-10"),
            trade(InvestmentAction::Buy, 1, 8, 10, "2026-01-10"),
        ];
        input.prices = vec![price(7, "2026-01-01", 100)];
        assert_eq!(values(&input), [0]);
    }

    /// Brokerage (1, an investment account) has the cash child 2. Bank (10)
    /// has the child 11, and 11 has the child 12. Card (20) is a liability.
    /// Zero (30) has a value of zero at each date.
    fn grouped_input() -> (NetWorthInput, Vec<TreeAccount>) {
        let mut input = input(&["2026-01-31", "2026-02-28"]);
        input.book_months = vec![
            month_total(11, "2025-12", 50_000),
            month_total(12, "2026-01", 10_000),
            month_total(20, "2026-01", -5_000),
            month_total(30, "2026-01", 0),
            month_total(2, "2026-02", 3_000),
            month_total(11, "2026-02", -20_000),
        ];
        input.splits = vec![trade(InvestmentAction::Buy, 1, 7, 10, "2026-01-10")];
        input.prices = vec![price(7, "2026-01-20", 100), price(7, "2026-02-15", 110)];
        let accounts = vec![
            account(1, None, "Brokerage"),
            account(2, Some(1), "Brokerage Cash"),
            account(10, None, "Bank"),
            account(11, Some(10), "Checking"),
            account(12, Some(11), "Joint Savings"),
            account(20, None, "Card"),
            account(30, None, "Zero"),
        ];
        (input, accounts)
    }

    fn group_values(point: &GroupedNetWorthPoint) -> Vec<(i64, i64)> {
        point
            .groups
            .iter()
            .map(|group| (group.account_id, group.value_cents))
            .collect()
    }

    #[test]
    fn each_value_goes_to_its_top_level_account() {
        let (input, accounts) = grouped_input();
        let result = net_worth_by_group(&input, &accounts);
        // Ordered by name. Zero has no value at any date, so it is not a group.
        assert_eq!(
            result
                .groups
                .iter()
                .map(|group| (group.account_id, group.name.as_str()))
                .collect::<Vec<_>>(),
            [(10, "Bank"), (1, "Brokerage"), (20, "Card")]
        );
        assert_eq!(result.points.len(), 2);
        // January: Bank 500.00 + 100.00 from its grandchild, Brokerage 10
        // shares at 100.00, Card -50.00.
        assert_eq!(result.points[0].date, "2026-01-31");
        assert_eq!(
            group_values(&result.points[0]),
            [(10, 60_000), (1, 100_000), (20, -5_000)]
        );
        assert_eq!(result.points[0].net_worth_cents, 155_000);
        // February: Checking -200.00, the shares at 110.00 plus 30.00 cash.
        assert_eq!(
            group_values(&result.points[1]),
            [(10, 40_000), (1, 113_000), (20, -5_000)]
        );
        assert_eq!(result.points[1].net_worth_cents, 148_000);
    }

    #[test]
    fn the_groups_add_up_to_the_net_worth_series() {
        let (input, accounts) = grouped_input();
        let result = net_worth_by_group(&input, &accounts);
        let series = net_worth_series(&input);
        assert_eq!(result.points.len(), series.len());
        for (point, plain) in result.points.iter().zip(&series) {
            assert_eq!(point.date, plain.date);
            assert_eq!(point.net_worth_cents, plain.net_worth_cents);
            let sum: i64 = point.groups.iter().map(|group| group.value_cents).sum();
            assert_eq!(sum, point.net_worth_cents);
        }
    }

    #[test]
    fn a_group_with_a_value_at_one_date_has_a_value_at_every_date() {
        let mut input = input(&["2026-01-31", "2026-02-28"]);
        input.book_months = vec![
            month_total(10, "2026-01", 700),
            month_total(10, "2026-02", -700),
        ];
        let result = net_worth_by_group(&input, &[account(10, None, "Bank")]);
        assert_eq!(group_values(&result.points[0]), [(10, 700)]);
        assert_eq!(group_values(&result.points[1]), [(10, 0)]);
    }
}
