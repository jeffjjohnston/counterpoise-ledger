//! Synchronous browser entry point. The JavaScript adapter keeps the existing
//! TypeScript signatures; this dispatcher only converts JSON at the WASM edge.

use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use wasm_bindgen::prelude::*;

use crate::{accounting, accounts, expression, formatters, recurring};

fn arg<T: DeserializeOwned>(args: &[Value], index: usize) -> Result<T, String> {
    serde_json::from_value(args.get(index).cloned().unwrap_or(Value::Null))
        .map_err(|error| format!("Invalid argument {index}: {error}"))
}

fn result(op: &str, args: &[Value]) -> Result<Value, String> {
    let value = match op {
        "validateSplits" => {
            let splits: Vec<Value> = arg(args, 0)?;
            let amounts = splits
                .iter()
                .map(|split| split.get("amount").cloned().unwrap_or(Value::Null))
                .collect::<Vec<_>>();
            json!(accounting::validate_splits_payload(&amounts))
        }
        "getInvestmentGrossAmountCents" => {
            json!(accounting::gross_amount_cents(arg(args, 0)?, arg(args, 1)?))
        }
        "buildDividendSplits" => json!(accounting::build_dividend_splits(&arg(args, 0)?)),
        "buildCapGainSplits" => json!(accounting::build_cap_gain_splits(&arg(args, 0)?)),
        "buildBuySplits" => {
            json!(accounting::build_buy_splits(&arg(args, 0)?).map_err(str::to_owned)?)
        }
        "buildSellSplits" => {
            json!(accounting::build_sell_splits(&arg(args, 0)?).map_err(str::to_owned)?)
        }
        "getEffectiveDate" => {
            let transaction: Value = arg(args, 0)?;
            let today: String = arg(args, 1)?;
            json!(recurring::effective_date(
                transaction
                    .get("date")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
                transaction
                    .get("isFloating")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                &today
            ))
        }
        "getNextBusinessDay" => json!(recurring::get_next_business_day(&arg::<String>(args, 0)?)?),
        "getNextDate" => json!(recurring::next_date(
            &arg::<String>(args, 0)?,
            &arg(args, 1)?
        )?),
        "getDisplayBalance" => json!(accounting::display_balance(
            arg(args, 0)?,
            &arg::<String>(args, 1)?
        )),
        "accountTypeLabels" => json!(
            accounting::ACCOUNT_TYPE_LABELS
                .iter()
                .map(|(key, label)| (key.to_string(), json!(label)))
                .collect::<serde_json::Map<String, Value>>()
        ),
        "accountSubtypeLabels" => json!(
            accounting::ACCOUNT_SUBTYPE_LABELS
                .iter()
                .map(|(key, label)| (key.to_string(), json!(label)))
                .collect::<serde_json::Map<String, Value>>()
        ),
        "accountTypeOrder" => json!(accounts::ACCOUNT_TYPE_ORDER),
        "balanceSheetTypes" => json!(accounts::BALANCE_SHEET_TYPES),
        "describeRecurrence" => json!(recurring::describe_recurrence(&arg(args, 0)?)),
        "buildAccountTree" => json!(accounts::build_account_tree(&arg::<Vec<Value>>(args, 0)?)),
        "flattenAccounts" => json!(accounts::flatten_accounts(&arg::<Vec<Value>>(args, 0)?)),
        "flattenAccountTreeWithDepth" => json!(accounts::flatten_account_tree_with_depth(
            &arg::<Vec<Value>>(args, 0)?,
            args.get(1).and_then(Value::as_u64).unwrap_or(0) as usize
        )),
        "isDescendantOf" => json!(accounts::is_descendant_of(
            &arg(args, 0)?,
            arg(args, 1)?,
            &arg::<Vec<Value>>(args, 2)?
        )),
        "descendantAccountIds" => {
            let ancestor_id: i64 = arg(args, 0)?;
            let all_accounts: Vec<Value> = arg(args, 1)?;
            json!(
                all_accounts
                    .iter()
                    .filter_map(|candidate| {
                        accounts::is_descendant_of(candidate, ancestor_id, &all_accounts)
                            .then(|| candidate.get("id").and_then(Value::as_i64))
                            .flatten()
                    })
                    .collect::<Vec<_>>()
            )
        }
        "buildAccountHierarchyName" => json!(accounts::build_account_hierarchy_name(
            &arg(args, 0)?,
            &arg::<Vec<Value>>(args, 1)?
        )),
        "accountHierarchyNames" => {
            let all_accounts: Vec<Value> = arg(args, 0)?;
            json!(
                all_accounts
                    .iter()
                    .filter_map(|account| {
                        Some((
                            account.get("id")?.as_i64()?.to_string(),
                            json!(accounts::build_account_hierarchy_name(
                                account,
                                &all_accounts
                            )),
                        ))
                    })
                    .collect::<serde_json::Map<String, Value>>()
            )
        }
        "resolveAccountIconSource" => json!(accounts::resolve_account_icon_source(
            &arg(args, 0)?,
            &arg::<Vec<Value>>(args, 1)?
        )),
        "buildCategoryLabelMap" => json!(accounts::build_category_label_map(&arg::<Vec<Value>>(
            args, 0
        )?)),
        "buildRuleRecurrenceConfig" => {
            json!(recurring::build_rule_recurrence_config(&arg(args, 0)?))
        }
        "getOccurrenceDate" => json!(recurring::occurrence_date(
            &arg::<String>(args, 0)?,
            arg(args, 1)?
        )?),
        "isRecurringRuleDue" => json!(recurring::is_recurring_rule_due(
            &arg::<String>(args, 0)?,
            &arg::<String>(args, 1)?,
            arg(args, 2)?,
            args.get(3).and_then(Value::as_bool).unwrap_or(false)
        )?),
        "maxIntervalFor" => json!(recurring::max_interval_for(&arg::<String>(args, 0)?)),
        "maxAutoCreateDaysBefore" => json!(recurring::MAX_AUTO_CREATE_DAYS_BEFORE),
        "previewOccurrences" => json!(recurring::preview_occurrences(&arg(args, 0)?)?),
        "scheduleKey" => json!(recurring::schedule_key(&arg(args, 0)?)),
        "formatCurrency" => json!(formatters::format_currency(arg(args, 0)?)),
        "formatDate" => {
            json!(formatters::format_date(&arg::<String>(args, 0)?).ok_or("Invalid date")?)
        }
        "formatDateShort" => {
            json!(formatters::format_date_short(&arg::<String>(args, 0)?).ok_or("Invalid date")?)
        }
        "toDateString" => {
            let year: i32 = arg(args, 0)?;
            let month: u32 = arg(args, 1)?;
            let day: u32 = arg(args, 2)?;
            json!(formatters::to_date_string(
                chrono::NaiveDate::from_ymd_opt(year, month, day).ok_or("Invalid date")?
            ))
        }
        "isValidDateString" => json!(formatters::is_valid_date_string(&arg::<String>(args, 0)?)),
        "parseStrictCurrency" => json!(formatters::parse_strict_currency(&arg::<String>(args, 0)?)),
        "resolveAmountOnBlur" => {
            json!(formatters::resolve_amount_on_blur(&arg::<String>(args, 0)?))
        }
        "getAccountShortName" => json!(formatters::account_short_name(&arg::<String>(args, 0)?)),
        "formatRelativeAge" => json!(formatters::format_relative_age(
            args.first().and_then(Value::as_f64).unwrap_or(f64::NAN)
        )),
        "formatPriceMicrosInput" => json!(formatters::format_price_micros_input(arg(args, 0)?)),
        "evaluateExpression" => json!(expression::evaluate_expression(&arg::<String>(args, 0)?)),
        _ => return Err(format!("Unknown core operation: {op}")),
    };
    Ok(value)
}

#[wasm_bindgen]
pub fn invoke(op: &str, args_json: &str) -> String {
    let output = serde_json::from_str::<Vec<Value>>(args_json)
        .map_err(|error| error.to_string())
        .and_then(|args| result(op, &args));
    match output {
        Ok(value) => json!({ "ok": value }).to_string(),
        Err(error) => json!({ "error": error }).to_string(),
    }
}
