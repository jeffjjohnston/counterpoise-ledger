use ledger_core::{accounting, accounts, expression, formatters, investments, lots, recurring};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
struct Corpus {
    version: u32,
    cases: Vec<Case>,
}

#[derive(Deserialize)]
struct Case {
    name: String,
    op: String,
    input: Value,
    expected: Value,
}

fn decode<T: serde::de::DeserializeOwned>(value: &Value) -> T {
    serde_json::from_value(value.clone()).unwrap()
}

fn string<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap()
}
fn integer(value: &Value, key: &str) -> i64 {
    value[key].as_i64().unwrap()
}
fn array<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value[key].as_array().unwrap()
}
fn outcome<T: serde::Serialize, E: std::fmt::Display>(result: Result<T, E>) -> Value {
    match result {
        Ok(value) => json!(value),
        Err(error) => json!({ "error": error.to_string() }),
    }
}
fn js_number(value: Option<f64>) -> Value {
    // JSON.stringify turns integral doubles into integers and erases -0.
    // expressionIsNegativeZero asserts the sign separately in the core.
    match value {
        Some(number) if number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_991.0 => {
            json!(number as i64)
        }
        other => json!(other),
    }
}

fn run(case: &Case) -> Value {
    let input = &case.input;
    match case.op.as_str() {
        "validateSplits" => json!(accounting::validate_splits_payload(array(input, "amounts"))),
        "mathRound" => json!(accounting::round_js(input["value"].as_f64().unwrap())),
        "grossAmount" => json!(accounting::gross_amount_cents(
            integer(input, "sharesMicros"),
            integer(input, "priceMicros")
        )),
        "buildDividend" => json!(accounting::build_dividend_splits(&decode(input))),
        "buildCapGain" => json!(accounting::build_cap_gain_splits(&decode(input))),
        "buildBuy" => outcome(accounting::build_buy_splits(&decode(input))),
        "buildSell" => outcome(accounting::build_sell_splits(&decode(input))),
        "mapInvestmentAction" => json!(accounting::map_investment_action_to_splits(&decode(input))),
        "validateInvestmentAction" => json!(accounting::validate_investment_action(&decode(input))),
        "validateInvestmentActions" => json!(accounting::validate_investment_actions(&decode::<
            Vec<accounting::InvestmentActionInput>,
        >(
            &input["actions"]
        ))),
        "validateInvestmentSplitPayload" => {
            json!(accounting::validate_investment_split_payload(input))
        }
        "accountTypeLabel" => json!(accounting::account_type_label(string(input, "type"))),
        "accountSubtypeLabel" => json!(accounting::account_subtype_label(string(input, "subtype"))),
        "isValidDate" => json!(accounting::is_valid_date_string(string(input, "value"))),
        "formatterValidDate" => json!(formatters::is_valid_date_string(string(input, "value"))),
        "nextBusinessDay" => outcome(recurring::get_next_business_day(string(input, "value"))),
        "isBusinessDay" => outcome(recurring::is_business_day(string(input, "value"))),
        "advanceBusinessDay" => outcome(recurring::advance_to_business_day(string(input, "value"))),
        "normalBalanceSign" => json!(accounting::normal_balance_sign(string(input, "type"))),
        "displayBalance" => json!(accounting::display_balance(
            integer(input, "balance"),
            string(input, "type")
        )),
        "effectiveDate" => json!(recurring::effective_date(
            string(input, "date"),
            input["isFloating"].as_bool().unwrap(),
            string(input, "today")
        )),
        "evaluateExpression" => js_number(expression::evaluate_expression(string(input, "value"))),
        "expressionIsNegativeZero" => json!(
            expression::evaluate_expression(string(input, "value"))
                .is_some_and(|value| value == 0.0 && value.is_sign_negative())
        ),
        "formatCurrency" => json!(formatters::format_currency(integer(input, "cents"))),
        "parseCurrency" => json!(formatters::parse_currency(string(input, "value"))),
        "parseStrictCurrency" => json!(formatters::parse_strict_currency(string(input, "value"))),
        "resolveAmountOnBlur" => json!(formatters::resolve_amount_on_blur(string(input, "value"))),
        "formatDate" => formatters::format_date(string(input, "value")).map_or_else(
            || json!({ "error": "Invalid time value" }),
            |value| json!(value),
        ),
        "formatDateShort" => formatters::format_date_short(string(input, "value")).map_or_else(
            || json!({ "error": "Invalid time value" }),
            |value| json!(value),
        ),
        "toDateString" => json!(formatters::to_date_string(
            formatters::parse_date(string(input, "value")).unwrap()
        )),
        "shortName" => json!(formatters::account_short_name(string(input, "value"))),
        "relativeAge" => json!(formatters::format_relative_age(
            input["ms"].as_f64().unwrap()
        )),
        "priceMicrosInput" => json!(formatters::format_price_micros_input(integer(
            input,
            "priceMicros"
        ))),
        "groupAccounts" => accounts::group_accounts_by_type(array(input, "accounts")),
        "buildAccountTree" => json!(accounts::build_account_tree(array(input, "accounts"))),
        "flattenAccounts" => json!(accounts::flatten_accounts(array(input, "accounts"))),
        "flattenWithDepth" => json!(accounts::flatten_account_tree_with_depth(
            array(input, "accounts"),
            0
        )),
        "isDescendant" => json!(accounts::is_descendant_of(
            &input["candidate"],
            integer(input, "ancestorId"),
            array(input, "accounts")
        )),
        "hierarchyName" => json!(accounts::build_account_hierarchy_name(
            &input["account"],
            array(input, "accounts")
        )),
        "resolveIcon" => json!(accounts::resolve_account_icon(
            &input["account"],
            array(input, "accounts")
        )),
        "resolveIconSource" => {
            accounts::resolve_account_icon_source(&input["account"], array(input, "accounts"))
        }
        "categoryLabels" => accounts::build_category_label_map(array(input, "accounts")),
        "nextDate" => outcome(recurring::next_date(
            string(input, "currentDate"),
            &decode(&input["config"]),
        )),
        "initialNextDate" => outcome(recurring::initial_next_date(
            string(input, "startDate"),
            &decode(&input["config"]),
        )),
        "describeRecurrence" => json!(recurring::describe_recurrence(&decode(&input["config"]))),
        "advanceNextDate" => outcome(recurring::advance_next_date_to_future(
            string(input, "nextDate"),
            &decode(&input["config"]),
            string(input, "today"),
            input["businessDaysOnly"].as_bool().unwrap(),
        )),
        "occurrenceDate" => outcome(recurring::occurrence_date(
            string(input, "value"),
            input["businessDaysOnly"].as_bool().unwrap(),
        )),
        "isRuleDue" => outcome(recurring::is_recurring_rule_due(
            string(input, "value"),
            string(input, "today"),
            integer(input, "leadDays"),
            input["businessDaysOnly"].as_bool().unwrap(),
        )),
        "scheduleKey" => json!(recurring::schedule_key(&decode(&input["config"]))),
        "preview" => outcome(recurring::preview_occurrences(&decode(input))),
        "buildRuleConfig" => json!(recurring::build_rule_recurrence_config(&decode(input))),
        "parseLead" => json!(recurring::parse_auto_create_days_before_value(
            input.get("value"),
            integer(input, "fallback")
        )),
        "validLead" => json!(recurring::is_valid_auto_create_days_before_value(
            &input["value"]
        )),
        "maxInterval" => json!(recurring::max_interval_for(string(input, "frequency"))),
        "addDays" => outcome(recurring::add_days_to_date_string(
            string(input, "value"),
            integer(input, "days"),
        )),
        "replayLots" => json!(lots::replay_lots(&decode::<Vec<lots::ReplaySplit>>(
            input.get("splits").unwrap()
        ))),
        "aggregatePositions" => json!(investments::aggregate_positions(&decode(input))),
        "aggregateMarketValues" => json!(investments::aggregate_market_values_by_account(&decode(
            input
        ))),
        "fixedPriceRow" => json!(investments::fixed_price_row(
            integer(input, "securityId"),
            integer(input, "fixedPriceMicros"),
            string(input, "today")
        )),
        other => panic!("unknown fixture operation: {other}"),
    }
}

#[test]
fn matches_generated_typescript_corpus() {
    let corpus: Corpus = serde_json::from_str(include_str!("../fixtures/core.json")).unwrap();
    assert_eq!(corpus.version, 1);
    assert!(
        corpus.cases.len() >= 375,
        "fixture coverage fell unexpectedly"
    );
    let mut failures = Vec::new();
    for case in &corpus.cases {
        let actual = run(case);
        if actual != case.expected {
            failures.push(format!(
                "{} ({}): expected {}, got {}",
                case.name, case.op, case.expected, actual
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
