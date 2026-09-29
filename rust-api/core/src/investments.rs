//! Pure position and market-value aggregation from `lib/investments.ts`.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::accounting::{InvestmentAction, gross_amount_cents, round_js};
use crate::collation::compare_names;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InvestmentSplitRow {
    pub security_id: i64,
    pub shares_micros: i64,
    pub price_micros: i64,
    pub fees_cents: i64,
    pub action: InvestmentAction,
    pub split_numerator: Option<i64>,
    pub split_denominator: Option<i64>,
    pub transaction_date: String,
    #[serde(default)]
    pub account_id: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecurityRow {
    pub id: i64,
    pub name: String,
    pub symbol: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecurityPriceRow {
    pub security_id: i64,
    pub price_micros: i64,
    pub price_date: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PositionSummary {
    pub security_id: i64,
    pub security_name: String,
    pub security_symbol: String,
    pub shares_micros: i64,
    pub cost_basis_cents: i64,
    pub price_micros: Option<i64>,
    pub price_date: Option<String>,
    pub market_value_cents: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PositionInput {
    pub splits: Vec<InvestmentSplitRow>,
    pub securities: Vec<SecurityRow>,
    pub prices: Vec<SecurityPriceRow>,
}

fn latest_prices(rows: &[SecurityPriceRow]) -> HashMap<i64, &SecurityPriceRow> {
    let mut latest = HashMap::new();
    for row in rows {
        if latest
            .get(&row.security_id)
            .is_none_or(|old: &&SecurityPriceRow| row.price_date > old.price_date)
        {
            latest.insert(row.security_id, row);
        }
    }
    latest
}

fn split_ratio(split: &InvestmentSplitRow) -> Option<f64> {
    let (Some(numerator), Some(denominator)) = (split.split_numerator, split.split_denominator)
    else {
        return None;
    };
    if numerator == 0 || denominator == 0 {
        None
    } else {
        Some(numerator as f64 / denominator as f64)
    }
}

pub fn aggregate_positions(input: &PositionInput) -> Vec<PositionSummary> {
    let securities: HashMap<i64, &SecurityRow> =
        input.securities.iter().map(|row| (row.id, row)).collect();
    let prices = latest_prices(&input.prices);
    let mut ordered: Vec<(usize, &InvestmentSplitRow)> = input.splits.iter().enumerate().collect();
    ordered.sort_by(|a, b| {
        a.1.transaction_date
            .cmp(&b.1.transaction_date)
            .then(a.0.cmp(&b.0))
    });
    let mut first_seen = HashMap::new();
    for (index, (_, split)) in ordered.iter().enumerate() {
        if matches!(
            split.action,
            InvestmentAction::Buy | InvestmentAction::Sell | InvestmentAction::Split
        ) {
            first_seen.entry(split.security_id).or_insert(index);
        }
    }
    let mut positions: HashMap<i64, (i64, i64)> = HashMap::new();
    for (_, split) in ordered {
        let current = positions.get(&split.security_id).copied().unwrap_or((0, 0));
        match split.action {
            InvestmentAction::Split => {
                let shares = split_ratio(split)
                    .map_or(current.0, |ratio| round_js(current.0 as f64 * ratio));
                positions.insert(split.security_id, (shares, current.1));
            }
            InvestmentAction::Buy => {
                let basis =
                    gross_amount_cents(split.shares_micros, split.price_micros) + split.fees_cents;
                positions.insert(
                    split.security_id,
                    (current.0 + split.shares_micros, current.1 + basis),
                );
            }
            InvestmentAction::Sell => {
                let reduction = if current.0 <= 0 || current.1 <= 0 {
                    0
                } else {
                    round_js(current.1 as f64 * split.shares_micros as f64 / current.0 as f64)
                        .min(current.1)
                };
                positions.insert(
                    split.security_id,
                    (current.0 - split.shares_micros, current.1 - reduction),
                );
            }
            _ => {}
        }
    }
    let mut result: Vec<_> = positions
        .into_iter()
        .filter_map(|(security_id, (shares_micros, cost_basis_cents))| {
            if shares_micros <= 0 {
                return None;
            }
            let security = securities.get(&security_id)?;
            let price = prices.get(&security_id);
            Some(PositionSummary {
                security_id,
                security_name: security.name.clone(),
                security_symbol: security.symbol.clone(),
                shares_micros,
                cost_basis_cents,
                price_micros: price.map(|row| row.price_micros),
                price_date: price.map(|row| row.price_date.clone()),
                market_value_cents: price
                    .map(|row| gross_amount_cents(shares_micros, row.price_micros)),
            })
        })
        .collect();
    result.sort_by(|a, b| {
        compare_names(&a.security_name, &b.security_name)
            .then_with(|| first_seen[&a.security_id].cmp(&first_seen[&b.security_id]))
    });
    result
}

pub fn fixed_price_row(security_id: i64, fixed_price_micros: i64, today: &str) -> SecurityPriceRow {
    SecurityPriceRow {
        security_id,
        price_micros: fixed_price_micros,
        price_date: today.to_owned(),
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AccountMarketValue {
    pub account_id: i64,
    pub market_value_cents: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketValueInput {
    pub splits: Vec<InvestmentSplitRow>,
    pub prices: Vec<SecurityPriceRow>,
}

pub fn aggregate_market_values_by_account(input: &MarketValueInput) -> Vec<AccountMarketValue> {
    let prices = latest_prices(&input.prices);
    let mut ordered: Vec<(usize, &InvestmentSplitRow)> = input.splits.iter().enumerate().collect();
    ordered.sort_by(|a, b| {
        a.1.transaction_date
            .cmp(&b.1.transaction_date)
            .then(a.0.cmp(&b.0))
    });
    let mut account_ids = Vec::new();
    for (_, split) in &ordered {
        if let Some(id) = split.account_id
            && !account_ids.contains(&id)
        {
            account_ids.push(id);
        }
    }
    let mut positions: HashMap<(i64, i64), i64> = HashMap::new();
    for (_, split) in ordered {
        let targets: Vec<i64> = split
            .account_id
            .map_or_else(|| account_ids.clone(), |id| vec![id]);
        for account_id in targets {
            let key = (account_id, split.security_id);
            let current = positions.get(&key).copied().unwrap_or(0);
            match split.action {
                InvestmentAction::Split => {
                    if let Some(ratio) = split_ratio(split) {
                        positions.insert(key, round_js(current as f64 * ratio));
                    }
                }
                InvestmentAction::Buy => {
                    positions.insert(key, current + split.shares_micros);
                }
                InvestmentAction::Sell => {
                    positions.insert(key, current - split.shares_micros);
                }
                _ => {}
            }
        }
    }
    let mut totals: HashMap<i64, i64> = HashMap::new();
    for ((account_id, security_id), shares) in positions {
        if shares <= 0 {
            continue;
        }
        if let Some(price) = prices.get(&security_id) {
            *totals.entry(account_id).or_default() +=
                gross_amount_cents(shares, price.price_micros);
        }
    }
    let mut result: Vec<_> = totals
        .into_iter()
        .map(|(account_id, market_value_cents)| AccountMarketValue {
            account_id,
            market_value_cents,
        })
        .collect();
    result.sort_by_key(|row| row.account_id);
    result
}
