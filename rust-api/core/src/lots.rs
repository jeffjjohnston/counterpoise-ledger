//! Pure FIFO replay. Persisting the result remains the server's responsibility.

use serde::{Deserialize, Serialize};

use crate::accounting::{InvestmentAction, gross_amount_cents, round_js};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaySplit {
    pub investment_split_id: i64,
    pub transaction_id: i64,
    pub action: InvestmentAction,
    pub shares_micros: i64,
    pub price_micros: i64,
    pub fees_cents: i64,
    pub split_numerator: Option<i64>,
    pub split_denominator: Option<i64>,
    pub transaction_date: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReplayLot {
    pub lot_key: usize,
    pub opened_split_id: i64,
    pub opened_transaction_id: i64,
    pub acquired_date: String,
    pub original_shares_micros: i64,
    pub original_basis_cents: i64,
    pub remaining_shares_micros: i64,
    pub remaining_basis_cents: i64,
    pub closed_transaction_id: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReplayAllocation {
    pub lot_key: usize,
    pub sell_split_id: i64,
    pub transaction_id: i64,
    pub shares_micros: i64,
    pub basis_cents: i64,
    pub proceeds_cents: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UnallocatedShares {
    pub sell_split_id: i64,
    pub shares_micros: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReplayResult {
    pub lots: Vec<ReplayLot>,
    pub allocations: Vec<ReplayAllocation>,
    pub unallocated: Vec<UnallocatedShares>,
}

pub fn replay_lots(splits: &[ReplaySplit]) -> ReplayResult {
    let mut ordered: Vec<_> = splits.iter().collect();
    ordered.sort_by(|a, b| {
        a.transaction_date
            .cmp(&b.transaction_date)
            .then(a.transaction_id.cmp(&b.transaction_id))
            .then(a.investment_split_id.cmp(&b.investment_split_id))
    });
    let mut result = ReplayResult {
        lots: Vec::new(),
        allocations: Vec::new(),
        unallocated: Vec::new(),
    };
    for split in ordered {
        match split.action {
            InvestmentAction::Buy => {
                if split.shares_micros <= 0 {
                    continue;
                }
                let basis =
                    gross_amount_cents(split.shares_micros, split.price_micros) + split.fees_cents;
                result.lots.push(ReplayLot {
                    lot_key: result.lots.len(),
                    opened_split_id: split.investment_split_id,
                    opened_transaction_id: split.transaction_id,
                    acquired_date: split.transaction_date.clone(),
                    original_shares_micros: split.shares_micros,
                    original_basis_cents: basis,
                    remaining_shares_micros: split.shares_micros,
                    remaining_basis_cents: basis,
                    closed_transaction_id: None,
                });
            }
            InvestmentAction::Split => {
                let (Some(numerator), Some(denominator)) =
                    (split.split_numerator, split.split_denominator)
                else {
                    continue;
                };
                if numerator == 0 || denominator == 0 {
                    continue;
                }
                let ratio = numerator as f64 / denominator as f64;
                for lot in &mut result.lots {
                    if lot.remaining_shares_micros <= 0 {
                        continue;
                    }
                    lot.original_shares_micros =
                        round_js(lot.original_shares_micros as f64 * ratio);
                    lot.remaining_shares_micros =
                        round_js(lot.remaining_shares_micros as f64 * ratio);
                }
            }
            InvestmentAction::Sell => {
                if split.shares_micros <= 0 {
                    continue;
                }
                let net_proceeds =
                    gross_amount_cents(split.shares_micros, split.price_micros) - split.fees_cents;
                let mut needed = split.shares_micros;
                let mut allocated_shares = 0;
                let mut allocated_proceeds = 0;
                for lot in &mut result.lots {
                    if needed <= 0 {
                        break;
                    }
                    if lot.remaining_shares_micros <= 0 {
                        continue;
                    }
                    let taken = lot.remaining_shares_micros.min(needed);
                    let basis = if taken == lot.remaining_shares_micros {
                        lot.remaining_basis_cents
                    } else {
                        round_js(
                            lot.remaining_basis_cents as f64 * taken as f64
                                / lot.remaining_shares_micros as f64,
                        )
                    };
                    allocated_shares += taken;
                    let proceeds_so_far = round_js(
                        net_proceeds as f64 * allocated_shares as f64 / split.shares_micros as f64,
                    );
                    let proceeds = proceeds_so_far - allocated_proceeds;
                    allocated_proceeds = proceeds_so_far;
                    result.allocations.push(ReplayAllocation {
                        lot_key: lot.lot_key,
                        sell_split_id: split.investment_split_id,
                        transaction_id: split.transaction_id,
                        shares_micros: taken,
                        basis_cents: basis,
                        proceeds_cents: proceeds,
                    });
                    lot.remaining_shares_micros -= taken;
                    lot.remaining_basis_cents -= basis;
                    needed -= taken;
                    if lot.remaining_shares_micros == 0 {
                        lot.closed_transaction_id = Some(split.transaction_id);
                    }
                }
                if needed > 0 {
                    result.unallocated.push(UnallocatedShares {
                        sell_split_id: split.investment_split_id,
                        shares_micros: needed,
                    });
                }
            }
            _ => {}
        }
    }
    result
}
