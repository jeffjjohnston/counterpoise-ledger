//! Cent and micro arithmetic and shared account rules. No database access.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::formatters::parse_date;

const INT4_MIN: i64 = i32::MIN as i64;
const INT4_MAX: i64 = i32::MAX as i64;
const MICROS_PRODUCT_PER_CENT: i128 = 10_000_000_000;

pub fn is_valid_date_string(value: &str) -> bool {
    parse_date(value).is_some_and(|date| chrono::Datelike::year(&date) >= 100)
}

pub fn validate_splits(amounts: &[i64]) -> bool {
    amounts
        .iter()
        .all(|amount| (INT4_MIN..=INT4_MAX).contains(amount))
        && amounts
            .iter()
            .map(|amount| i128::from(*amount))
            .sum::<i128>()
            == 0
}

pub fn validate_splits_payload(amounts: &[Value]) -> bool {
    let Some(amounts) = amounts
        .iter()
        .map(|amount| {
            let number = amount.as_f64()?;
            (number.is_finite()
                && number.fract() == 0.0
                && number >= INT4_MIN as f64
                && number <= INT4_MAX as f64)
                .then_some(number as i64)
        })
        .collect::<Option<Vec<_>>>()
    else {
        return false;
    };
    validate_splits(&amounts)
}

/// JavaScript's `Math.round`, whose half ties go toward positive infinity.
pub fn round_js(value: f64) -> i64 {
    let floor = value.floor();
    (if value - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    }) as i64
}

pub fn try_gross_amount_cents(shares_micros: i64, price_micros: i64) -> Option<i64> {
    let product = i128::from(shares_micros) * i128::from(price_micros);
    let floor = product.div_euclid(MICROS_PRODUCT_PER_CENT);
    let remainder = product.rem_euclid(MICROS_PRODUCT_PER_CENT);
    i64::try_from(floor + i128::from(remainder * 2 >= MICROS_PRODUCT_PER_CENT)).ok()
}

pub fn gross_amount_cents(shares_micros: i64, price_micros: i64) -> i64 {
    try_gross_amount_cents(shares_micros, price_micros).unwrap_or({
        if (shares_micros < 0) ^ (price_micros < 0) {
            i64::MIN
        } else {
            i64::MAX
        }
    })
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum InvestmentAction {
    Buy,
    Sell,
    Dividend,
    CapGain,
    Fee,
    Split,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InvestmentActionInput {
    pub action: InvestmentAction,
    pub shares_micros: i64,
    pub price_micros: i64,
    #[serde(default)]
    pub fees_cents: i64,
    pub split_numerator: Option<i64>,
    pub split_denominator: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InvestmentActionSplit {
    pub amount: i64,
    pub role: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InvestmentSplit {
    pub account_id: i64,
    pub amount: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IncomeBuilderInput {
    pub cash_account_id: i64,
    pub income_account_id: i64,
    pub amount_cents: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuyBuilderInput {
    pub security_account_id: i64,
    pub cash_account_id: i64,
    pub fee_account_id: Option<i64>,
    pub shares_micros: i64,
    pub price_micros: i64,
    #[serde(default)]
    pub fees_cents: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SellBuilderInput {
    pub security_account_id: i64,
    pub cash_account_id: i64,
    pub fee_account_id: Option<i64>,
    pub gain_loss_account_id: Option<i64>,
    pub shares_micros: i64,
    pub price_micros: i64,
    #[serde(default)]
    pub fees_cents: i64,
    pub cost_basis_cents: Option<i64>,
}

pub fn build_dividend_splits(input: &IncomeBuilderInput) -> Vec<InvestmentSplit> {
    vec![
        InvestmentSplit {
            account_id: input.cash_account_id,
            amount: input.amount_cents,
        },
        InvestmentSplit {
            account_id: input.income_account_id,
            amount: input.amount_cents.saturating_neg(),
        },
    ]
}

pub fn build_cap_gain_splits(input: &IncomeBuilderInput) -> Vec<InvestmentSplit> {
    build_dividend_splits(input)
}

pub fn build_buy_splits(input: &BuyBuilderInput) -> Result<Vec<InvestmentSplit>, &'static str> {
    let gross = try_gross_amount_cents(input.shares_micros, input.price_micros)
        .ok_or("Amount exceeds i64 cents.")?;
    if input.fees_cents > 0 && input.fee_account_id.is_none() {
        return Err("feeAccountId is required when feesCents is provided.");
    }
    let mut splits = vec![InvestmentSplit {
        account_id: input.security_account_id,
        amount: gross,
    }];
    if input.fees_cents > 0 {
        splits.push(InvestmentSplit {
            account_id: input.fee_account_id.unwrap(),
            amount: input.fees_cents,
        });
    }
    let cash = gross
        .checked_add(input.fees_cents)
        .and_then(i64::checked_neg)
        .ok_or("Amount exceeds i64 cents.")?;
    splits.push(InvestmentSplit {
        account_id: input.cash_account_id,
        amount: cash,
    });
    Ok(splits)
}

pub fn build_sell_splits(input: &SellBuilderInput) -> Result<Vec<InvestmentSplit>, &'static str> {
    let gross = try_gross_amount_cents(input.shares_micros, input.price_micros)
        .ok_or("Amount exceeds i64 cents.")?;
    let security_amount = input.cost_basis_cents.unwrap_or(gross);
    let gain_loss = input
        .cost_basis_cents
        .map_or(Some(0), |basis| gross.checked_sub(basis))
        .ok_or("Amount exceeds i64 cents.")?;
    if input.fees_cents > 0 && input.fee_account_id.is_none() {
        return Err("feeAccountId is required when feesCents is provided.");
    }
    if gain_loss != 0 && input.gain_loss_account_id.is_none() {
        return Err("gainLossAccountId is required when costBasisCents produces a gain or loss.");
    }
    let net_cash = gross
        .checked_sub(input.fees_cents)
        .ok_or("Amount exceeds i64 cents.")?;
    let security_offset = security_amount
        .checked_neg()
        .ok_or("Amount exceeds i64 cents.")?;
    let gain_loss_offset = gain_loss.checked_neg().ok_or("Amount exceeds i64 cents.")?;
    let mut splits = vec![InvestmentSplit {
        account_id: input.cash_account_id,
        amount: net_cash,
    }];
    if input.fees_cents > 0 {
        splits.push(InvestmentSplit {
            account_id: input.fee_account_id.unwrap(),
            amount: input.fees_cents,
        });
    }
    if gain_loss != 0 {
        splits.push(InvestmentSplit {
            account_id: input.gain_loss_account_id.unwrap(),
            amount: gain_loss_offset,
        });
    }
    splits.push(InvestmentSplit {
        account_id: input.security_account_id,
        amount: security_offset,
    });
    Ok(splits)
}

pub fn map_investment_action_to_splits(
    input: &InvestmentActionInput,
) -> Vec<InvestmentActionSplit> {
    let gross = gross_amount_cents(input.shares_micros, input.price_micros);
    let fees = input.fees_cents;
    let pair = |first: (&str, i64), second: (&str, i64)| {
        vec![
            InvestmentActionSplit {
                role: first.0.to_owned(),
                amount: first.1,
            },
            InvestmentActionSplit {
                role: second.0.to_owned(),
                amount: second.1,
            },
        ]
    };
    match input.action {
        InvestmentAction::Buy => {
            let mut splits = vec![InvestmentActionSplit {
                role: "security".into(),
                amount: gross,
            }];
            if fees > 0 {
                splits.push(InvestmentActionSplit {
                    role: "expense".into(),
                    amount: fees,
                });
            }
            splits.push(InvestmentActionSplit {
                role: "cash".into(),
                amount: gross.saturating_add(fees).saturating_neg(),
            });
            splits
        }
        InvestmentAction::Sell => {
            let mut splits = vec![InvestmentActionSplit {
                role: "cash".into(),
                amount: gross.saturating_sub(fees),
            }];
            if fees > 0 {
                splits.push(InvestmentActionSplit {
                    role: "expense".into(),
                    amount: fees,
                });
            }
            splits.push(InvestmentActionSplit {
                role: "security".into(),
                amount: gross.saturating_neg(),
            });
            splits
        }
        InvestmentAction::Dividend | InvestmentAction::CapGain => {
            pair(("cash", gross), ("income", gross.saturating_neg()))
        }
        InvestmentAction::Fee => {
            let amount = if fees > 0 { fees } else { gross };
            pair(("expense", amount), ("cash", amount.saturating_neg()))
        }
        InvestmentAction::Split => vec![],
    }
}

pub fn validate_investment_action(input: &InvestmentActionInput) -> bool {
    if input.shares_micros < 0 || input.price_micros < 0 || input.fees_cents < 0 {
        return false;
    }
    if input.action == InvestmentAction::Split {
        return input.split_numerator.is_some_and(|n| n > 0)
            && input.split_denominator.is_some_and(|d| d > 0);
    }
    let Some(gross) = try_gross_amount_cents(input.shares_micros, input.price_micros) else {
        return false;
    };
    match input.action {
        InvestmentAction::Fee if input.fees_cents <= 0 && gross <= 0 => return false,
        InvestmentAction::Buy | InvestmentAction::Sell if gross <= 0 => return false,
        _ => {}
    }
    let splits = map_investment_action_to_splits(input);
    validate_splits(&splits.iter().map(|split| split.amount).collect::<Vec<_>>())
}

pub fn validate_investment_actions(inputs: &[InvestmentActionInput]) -> bool {
    inputs.iter().all(validate_investment_action)
}

/// Validate the untrusted JSON boundary before converting amounts to integer micros.
pub fn validate_investment_split_payload(input: &Value) -> bool {
    let finite = |key: &str| {
        input
            .get(key)
            .and_then(Value::as_f64)
            .is_some_and(f64::is_finite)
    };
    let optional_finite = |key: &str| {
        input
            .get(key)
            .is_none_or(|value| value.as_f64().is_some_and(f64::is_finite))
    };
    let optional_integer = |key: &str| {
        input.get(key).is_none_or(|value| {
            value
                .as_f64()
                .is_some_and(|number| number.is_finite() && number.fract() == 0.0)
        })
    };
    if !finite("securityId")
        || !finite("sharesMicros")
        || !finite("priceMicros")
        || !optional_finite("feesCents")
        || !optional_integer("splitNumerator")
        || !optional_integer("splitDenominator")
    {
        return false;
    }
    if input["action"] == "split" {
        return input["splitNumerator"].as_f64().is_some_and(|n| n > 0.0)
            && input["splitDenominator"].as_f64().is_some_and(|d| d > 0.0);
    }
    true
}

pub const ACCOUNT_TYPE_LABELS: [(&str, &str); 5] = [
    ("asset", "Assets"),
    ("liability", "Liabilities"),
    ("equity", "Equity"),
    ("income", "Income"),
    ("expense", "Expenses"),
];

pub const ACCOUNT_SUBTYPE_LABELS: [(&str, &str); 6] = [
    ("bank", "Bank Account"),
    ("credit_card", "Credit Card"),
    ("loan", "Loan"),
    ("investment", "Investment"),
    ("cash", "Cash"),
    ("other", "Other"),
];

pub fn account_type_label(account_type: &str) -> Option<&'static str> {
    ACCOUNT_TYPE_LABELS
        .iter()
        .find(|(key, _)| *key == account_type)
        .map(|(_, label)| *label)
}

pub fn account_subtype_label(subtype: &str) -> Option<&'static str> {
    ACCOUNT_SUBTYPE_LABELS
        .iter()
        .find(|(key, _)| *key == subtype)
        .map(|(_, label)| *label)
}

pub fn normal_balance_sign(account_type: &str) -> i64 {
    match account_type {
        "liability" | "equity" | "income" => -1,
        _ => 1,
    }
}

pub fn display_balance(balance: i64, account_type: &str) -> i64 {
    balance.saturating_mul(normal_balance_sign(account_type))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oversized_investment_amounts_are_rejected_without_panicking() {
        let action = InvestmentActionInput {
            action: InvestmentAction::Buy,
            shares_micros: 1_000_000_000_000_000,
            price_micros: 100_000_000_000_000,
            fees_cents: 0,
            split_numerator: None,
            split_denominator: None,
        };
        assert!(!validate_investment_action(&action));
        assert!(!map_investment_action_to_splits(&action).is_empty());
        assert!(
            build_buy_splits(&BuyBuilderInput {
                security_account_id: 1,
                cash_account_id: 2,
                fee_account_id: None,
                shares_micros: action.shares_micros,
                price_micros: action.price_micros,
                fees_cents: 0,
            })
            .is_err()
        );
        assert!(
            build_sell_splits(&SellBuilderInput {
                security_account_id: 1,
                cash_account_id: 2,
                fee_account_id: None,
                gain_loss_account_id: None,
                shares_micros: action.shares_micros,
                price_micros: action.price_micros,
                fees_cents: 0,
                cost_basis_cents: None,
            })
            .is_err()
        );
    }

    #[test]
    fn fees_that_overflow_cash_offset_are_rejected() {
        let input = BuyBuilderInput {
            security_account_id: 1,
            cash_account_id: 2,
            fee_account_id: Some(3),
            shares_micros: 1_000_000,
            price_micros: 1_000_000,
            fees_cents: i64::MAX,
        };
        assert!(build_buy_splits(&input).is_err());
    }
}
