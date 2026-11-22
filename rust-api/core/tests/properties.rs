//! Property tests of the accounting invariants.
//!
//! Each test makes many random inputs from a fixed seed and checks a rule
//! that must hold for all of them. The corpus in `fixtures/core.json` checks
//! chosen examples; these tests check the rules between the examples.
//!
//! The generator is in this file, so the tests add no dependency. A failure
//! prints the seed of its case. To see one case again, call its check with
//! that seed.

use ledger_core::accounting::{
    self, BuyBuilderInput, IncomeBuilderInput, InvestmentAction, InvestmentSplit, SellBuilderInput,
};
use ledger_core::lots::{ReplayResult, ReplaySplit, replay_lots};
use std::collections::HashMap;

/// The number of random cases of each property.
const CASES: u64 = 2_000;

const INT4_MIN: i64 = i32::MIN as i64;
const INT4_MAX: i64 = i32::MAX as i64;

/// SplitMix64: a small generator with a full 64-bit state.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// A value from `low` to `high`, both included.
    fn range(&mut self, low: i64, high: i64) -> i64 {
        let span = (high - low) as u64 + 1;
        low + (self.next() % span) as i64
    }

    fn chance(&mut self, percent: u64) -> bool {
        self.next() % 100 < percent
    }

    fn shuffle<T>(&mut self, items: &mut [T]) {
        for index in (1..items.len()).rev() {
            let other = self.range(0, index as i64) as usize;
            items.swap(index, other);
        }
    }
}

/// A random trade history of one (account, security) pair. The dates come
/// from a small set, so many trades share a date and the order within a date
/// matters. The IDs are unique, as the database makes them.
fn history(rng: &mut Rng, with_stock_splits: bool) -> Vec<ReplaySplit> {
    const DATES: [&str; 6] = [
        "2024-01-15",
        "2024-01-16",
        "2024-06-30",
        "2024-12-31",
        "2025-01-01",
        "2025-03-09",
    ];
    const RATIOS: [(i64, i64); 4] = [(2, 1), (1, 2), (3, 2), (1, 10)];
    let count = rng.range(1, 40);
    let mut transaction_id = 0;
    (1..=count)
        .map(|investment_split_id| {
            transaction_id += rng.range(1, 3);
            let kind = rng.range(0, 99);
            let (action, ratio) = match kind {
                0..=49 => (InvestmentAction::Buy, None),
                50..=89 => (InvestmentAction::Sell, None),
                90..=94 if with_stock_splits => (
                    InvestmentAction::Split,
                    Some(RATIOS[rng.range(0, 3) as usize]),
                ),
                90..=94 => (InvestmentAction::Buy, None),
                _ => (InvestmentAction::Dividend, None),
            };
            ReplaySplit {
                investment_split_id,
                transaction_id,
                action,
                // A dividend has no shares, and a zero trade must change nothing.
                shares_micros: if rng.chance(5) {
                    0
                } else {
                    rng.range(1, 5_000_000_000)
                },
                price_micros: rng.range(1, 500_000_000),
                fees_cents: rng.range(0, 5_000),
                split_numerator: ratio.map(|(numerator, _)| numerator),
                split_denominator: ratio.map(|(_, denominator)| denominator),
                transaction_date: DATES[rng.range(0, 5) as usize].to_owned(),
            }
        })
        .collect()
}

fn is_trade(split: &ReplaySplit, action: InvestmentAction) -> bool {
    split.action == action && split.shares_micros > 0
}

/// The rules that hold for each replay, with or without stock splits.
fn check_replay(seed: u64, splits: &[ReplaySplit], result: &ReplayResult) {
    let by_id: HashMap<i64, &ReplaySplit> = splits
        .iter()
        .map(|split| (split.investment_split_id, split))
        .collect();

    // One lot for each buy, with the basis of the buy.
    let buys: Vec<&ReplaySplit> = splits
        .iter()
        .filter(|split| is_trade(split, InvestmentAction::Buy))
        .collect();
    assert_eq!(result.lots.len(), buys.len(), "seed {seed}: lots per buy");
    for (key, lot) in result.lots.iter().enumerate() {
        assert_eq!(lot.lot_key, key, "seed {seed}: lot keys are positions");
        let buy = by_id[&lot.opened_split_id];
        assert_eq!(
            lot.original_basis_cents,
            accounting::gross_amount_cents(buy.shares_micros, buy.price_micros) + buy.fees_cents,
            "seed {seed}: lot {key} basis"
        );
        assert_eq!(lot.acquired_date, buy.transaction_date, "seed {seed}");
        assert!(lot.remaining_shares_micros >= 0, "seed {seed}: lot {key}");
        assert!(lot.remaining_basis_cents >= 0, "seed {seed}: lot {key}");
        if lot.closed_transaction_id.is_some() {
            assert_eq!(lot.remaining_shares_micros, 0, "seed {seed}: lot {key}");
            assert_eq!(lot.remaining_basis_cents, 0, "seed {seed}: lot {key}");
        }
    }

    // Basis is conserved: each cent of a lot's basis is in the lot or in
    // exactly one allocation.
    let mut allocated_basis = vec![0_i64; result.lots.len()];
    let mut allocated_shares = vec![0_i64; result.lots.len()];
    for allocation in &result.allocations {
        assert!(
            allocation.shares_micros > 0,
            "seed {seed}: empty allocation"
        );
        assert!(allocation.basis_cents >= 0, "seed {seed}");
        allocated_basis[allocation.lot_key] += allocation.basis_cents;
        allocated_shares[allocation.lot_key] += allocation.shares_micros;
    }
    for (key, lot) in result.lots.iter().enumerate() {
        assert_eq!(
            lot.original_basis_cents,
            lot.remaining_basis_cents + allocated_basis[key],
            "seed {seed}: basis of lot {key}"
        );
    }

    // Each sell is accounted for: its shares are allocated or reported as
    // unallocated, and its allocations carry its net proceeds.
    let unallocated: HashMap<i64, i64> = result
        .unallocated
        .iter()
        .map(|row| (row.sell_split_id, row.shares_micros))
        .collect();
    assert_eq!(unallocated.len(), result.unallocated.len(), "seed {seed}");
    for sell in splits
        .iter()
        .filter(|split| is_trade(split, InvestmentAction::Sell))
    {
        let own: Vec<_> = result
            .allocations
            .iter()
            .filter(|allocation| allocation.sell_split_id == sell.investment_split_id)
            .collect();
        let shares: i64 = own.iter().map(|allocation| allocation.shares_micros).sum();
        let missing = unallocated
            .get(&sell.investment_split_id)
            .copied()
            .unwrap_or(0);
        assert_eq!(
            shares + missing,
            sell.shares_micros,
            "seed {seed}: shares of sell {}",
            sell.investment_split_id
        );
        let net =
            accounting::gross_amount_cents(sell.shares_micros, sell.price_micros) - sell.fees_cents;
        let proceeds: i64 = own.iter().map(|allocation| allocation.proceeds_cents).sum();
        if missing == 0 {
            assert_eq!(proceeds, net, "seed {seed}: proceeds of a whole sell");
        } else {
            let part = accounting::round_js(net as f64 * shares as f64 / sell.shares_micros as f64);
            assert_eq!(proceeds, part, "seed {seed}: proceeds of a part sell");
        }
        // First in, first out: a sell takes its lots in the order they opened.
        assert!(
            own.windows(2).all(|pair| pair[0].lot_key < pair[1].lot_key),
            "seed {seed}: lot order of sell {}",
            sell.investment_split_id
        );
    }
    // No allocation names a split that is not a sell.
    for allocation in &result.allocations {
        assert!(
            is_trade(by_id[&allocation.sell_split_id], InvestmentAction::Sell),
            "seed {seed}"
        );
    }

    // First in, first out between lots: while an older lot has shares, no
    // sell takes from a newer lot.
    for (key, lot) in result.lots.iter().enumerate() {
        if lot.remaining_shares_micros > 0 {
            assert!(
                allocated_shares[key + 1..]
                    .iter()
                    .all(|shares| *shares == 0),
                "seed {seed}: a sell passed over lot {key}"
            );
        }
    }
}

#[test]
fn a_replay_conserves_shares_and_basis() {
    for seed in 0..CASES {
        let mut rng = Rng(seed);
        let splits = history(&mut rng, false);
        let result = replay_lots(&splits);
        check_replay(seed, &splits, &result);

        // Without a stock split, shares are conserved too: each share bought
        // is in a lot or in exactly one allocation.
        let bought: i64 = splits
            .iter()
            .filter(|split| is_trade(split, InvestmentAction::Buy))
            .map(|split| split.shares_micros)
            .sum();
        let held: i64 = result
            .lots
            .iter()
            .map(|lot| lot.remaining_shares_micros)
            .sum();
        let sold: i64 = result
            .allocations
            .iter()
            .map(|allocation| allocation.shares_micros)
            .sum();
        assert_eq!(bought, held + sold, "seed {seed}: shares");
        for lot in &result.lots {
            assert_eq!(
                lot.closed_transaction_id.is_some(),
                lot.remaining_shares_micros == 0,
                "seed {seed}: a lot is closed when it has no shares"
            );
        }
    }
}

#[test]
fn a_replay_with_stock_splits_conserves_basis() {
    for seed in 0..CASES {
        let mut rng = Rng(seed ^ 0x5EED);
        let splits = history(&mut rng, true);
        check_replay(seed, &splits, &replay_lots(&splits));
    }
}

/// The replay sorts its input by date, transaction and split, so the order
/// in which the rows arrive from the database must not change the result.
#[test]
fn a_replay_does_not_depend_on_the_input_order() {
    for seed in 0..CASES {
        let mut rng = Rng(seed ^ 0x0BDE);
        let splits = history(&mut rng, true);
        let expected = replay_lots(&splits);
        let mut shuffled = splits.clone();
        rng.shuffle(&mut shuffled);
        assert_eq!(replay_lots(&shuffled), expected, "seed {seed}");
    }
}

/// The amounts balance: their sum is zero. `validate_splits` then accepts
/// them exactly when each amount fits a split.
fn check_balanced(seed: u64, splits: &[InvestmentSplit]) {
    let amounts: Vec<i64> = splits.iter().map(|split| split.amount).collect();
    let sum: i128 = amounts.iter().map(|amount| i128::from(*amount)).sum();
    assert_eq!(sum, 0, "seed {seed}: {amounts:?}");
    let fits = amounts
        .iter()
        .all(|amount| (INT4_MIN..=INT4_MAX).contains(amount));
    assert_eq!(
        accounting::validate_splits(&amounts),
        fits,
        "seed {seed}: {amounts:?}"
    );
}

/// A random magnitude: most values are small, and some are at the limits.
fn amount(rng: &mut Rng, high: i64) -> i64 {
    match rng.range(0, 9) {
        0 => 0,
        1 => high,
        2 => rng.range(0, 100),
        _ => rng.range(0, high),
    }
}

#[test]
fn a_built_buy_balances() {
    let mut built = 0;
    for seed in 0..CASES {
        let mut rng = Rng(seed ^ 0xB0B);
        let fees_cents = if rng.chance(50) {
            0
        } else {
            amount(&mut rng, 1_000_000)
        };
        let input = BuyBuilderInput {
            security_account_id: 1,
            cash_account_id: 2,
            fee_account_id: rng.chance(80).then_some(3),
            shares_micros: amount(&mut rng, 10_000_000_000),
            price_micros: amount(&mut rng, 1_000_000_000),
            fees_cents,
        };
        if let Ok(splits) = accounting::build_buy_splits(&input) {
            built += 1;
            check_balanced(seed, &splits);
        }
    }
    assert!(built > CASES / 2, "most inputs build: {built}");
}

#[test]
fn a_built_sell_balances() {
    let mut built = 0;
    for seed in 0..CASES {
        let mut rng = Rng(seed ^ 0x5E11);
        let fees_cents = if rng.chance(50) {
            0
        } else {
            amount(&mut rng, 1_000_000)
        };
        let input = SellBuilderInput {
            security_account_id: 1,
            cash_account_id: 2,
            fee_account_id: rng.chance(80).then_some(3),
            gain_loss_account_id: rng.chance(80).then_some(4),
            shares_micros: amount(&mut rng, 10_000_000_000),
            price_micros: amount(&mut rng, 1_000_000_000),
            fees_cents,
            cost_basis_cents: rng.chance(70).then(|| amount(&mut rng, 2_000_000_000)),
        };
        if let Ok(splits) = accounting::build_sell_splits(&input) {
            built += 1;
            check_balanced(seed, &splits);
        }
    }
    assert!(built > CASES / 2, "most inputs build: {built}");
}

#[test]
fn a_built_dividend_balances() {
    for seed in 0..CASES {
        let mut rng = Rng(seed ^ 0xD1F);
        let input = IncomeBuilderInput {
            cash_account_id: 2,
            income_account_id: 5,
            // The negation of INT4_MIN does not fit a split, so the range
            // stops one above it.
            amount_cents: rng.range(INT4_MIN + 1, INT4_MAX),
        };
        check_balanced(seed, &accounting::build_dividend_splits(&input));
        check_balanced(seed, &accounting::build_cap_gain_splits(&input));
    }
}
