//! The tool handlers, by tool name. Each handler gets arguments that the
//! tool's input schema has already accepted.

mod accounts;
mod book_members;
mod books;
mod investments;
mod issue_reports;
mod payees;
mod plaid;
mod recurring;
mod reports;
mod securities;
mod security_prices;
mod transactions;
mod usage;

use rmcp::model::CallToolResult;
use serde_json::{Map, Value};

use super::call::Caller;

pub(crate) use plaid::{
    COUNTERPOISE_ACCOUNT_ID_INVALID, PLAID_ACCOUNT_ID_REQUIRED, UPDATE_TOKEN_REQUIRED,
};

/// The tools that the Rust server serves. `tools/list` lists only these,
/// until every tool in the manifest has a Rust handler.
pub(crate) const IMPLEMENTED: &[&str] = &[
    "add_book_member",
    "analyze_usage",
    "clear_plaid_sync_data",
    "create_account",
    "create_book",
    "create_demo_book",
    "create_issue_report",
    "create_payee",
    "create_recurring_rule",
    "create_security",
    "create_transaction",
    "delete_account",
    "delete_book",
    "delete_issue_report",
    "delete_payee",
    "delete_plaid_token",
    "delete_recurring_rule",
    "delete_security",
    "delete_security_price",
    "delete_transaction",
    "fetch_tiingo_prices",
    "get_account_balance_history",
    "get_account_tree",
    "get_income_statement",
    "get_investment_positions",
    "get_payee",
    "get_plaid_status",
    "get_projected_transactions",
    "get_realized_gains",
    "get_reconcile_candidates",
    "get_report_data",
    "get_security_detail",
    "get_system_status",
    "get_transaction_plaid_link",
    "list_accounts",
    "list_book_members",
    "list_books",
    "list_issue_reports",
    "list_payees",
    "list_pending_plaid_transactions",
    "list_plaid_token_accounts",
    "list_prices_due",
    "list_recurring_rules",
    "list_recurring_transactions",
    "list_securities",
    "list_transactions",
    "process_recurring_rules",
    "reconcile_plaid_transaction",
    "remove_book_member",
    "search",
    "set_plaid_token_accounts",
    "set_security_prices",
    "sync_plaid_token",
    "unlink_plaid_transaction",
    "update_account",
    "update_book",
    "update_book_member",
    "update_issue_report",
    "update_plaid_token",
    "update_recurring_rule",
    "update_security",
    "update_security_price",
    "update_transaction",
];

/// Changes the arguments of the tool `name` as its zod schema preprocesses
/// them, before the JSON Schema check. The JSON Schema cannot hold a
/// preprocess, so without this it refuses a value that zod accepts.
pub(crate) fn prepare(name: &str, arguments: &mut Map<String, Value>) {
    match name {
        "create_recurring_rule" => recurring::prepare_create(arguments),
        "list_pending_plaid_transactions" => plaid::prepare_pending(arguments),
        _ => {}
    }
}

/// Refuses arguments of the tool `name` with zod's own message, before the
/// JSON Schema check, where that check would refuse them with other text.
/// A zod schema with a custom `error` gives that text for every failure of
/// the field; the JSON Schema cannot hold it.
pub(crate) fn precheck(name: &str, arguments: &Map<String, Value>) -> Option<CallToolResult> {
    match name {
        "update_plaid_token" => plaid::check_token_fields(name, arguments)
            .err()
            .map(|refused| *refused),
        "set_plaid_token_accounts" => plaid::check_assignments(name, arguments)
            .err()
            .map(|refused| *refused),
        "update_transaction" | "delete_transaction" => {
            transactions::check_expected_updated_at(name, arguments)
                .err()
                .map(|refused| *refused)
        }
        _ => None,
    }
}

/// Runs the tool `name`. `None` means that no Rust handler has that name.
pub(crate) async fn call(
    caller: &Caller,
    name: &str,
    arguments: &Map<String, Value>,
) -> Option<CallToolResult> {
    let outcome = match name {
        "list_books" => books::list_books(caller).await,
        "create_book" => books::create_book(caller, arguments).await,
        "update_book" => books::update_book(caller, arguments).await,
        "create_demo_book" => books::create_demo_book(caller).await,
        "delete_book" => books::delete_book(caller, arguments).await,
        "list_book_members" => book_members::list(caller, arguments).await,
        "add_book_member" => book_members::add(caller, arguments).await,
        "update_book_member" => book_members::update(caller, arguments).await,
        "remove_book_member" => book_members::remove(caller, arguments).await,
        "list_accounts" => accounts::list(caller, arguments).await,
        "get_account_tree" => accounts::tree(caller, arguments).await,
        "create_account" => accounts::create(caller, arguments).await,
        "update_account" => accounts::update(caller, arguments).await,
        "delete_account" => accounts::delete(caller, arguments).await,
        "create_issue_report" => issue_reports::create(caller, arguments).await,
        "list_issue_reports" => issue_reports::list(caller).await,
        "update_issue_report" => issue_reports::update(caller, arguments).await,
        "delete_issue_report" => issue_reports::delete(caller, arguments).await,
        "get_system_status" => issue_reports::system_status(caller).await,
        "analyze_usage" => usage::analyze(caller, arguments).await,
        "list_recurring_rules" => recurring::list(caller, arguments).await,
        "create_recurring_rule" => recurring::create(caller, arguments).await,
        "update_recurring_rule" => recurring::update(caller, arguments).await,
        "delete_recurring_rule" => recurring::delete(caller, arguments).await,
        "get_projected_transactions" => recurring::projected(caller, arguments).await,
        "list_recurring_transactions" => recurring::transactions(caller, arguments).await,
        "process_recurring_rules" => recurring::process(caller, arguments).await,
        "create_security" => securities::create(caller, arguments).await,
        "list_securities" => securities::list(caller, arguments).await,
        "update_security" => securities::update(caller, arguments).await,
        "delete_security" => securities::delete(caller, arguments).await,
        "get_security_detail" => securities::detail(caller, arguments).await,
        "set_security_prices" => security_prices::set(caller, arguments).await,
        "update_security_price" => security_prices::update(caller, arguments).await,
        "delete_security_price" => security_prices::delete(caller, arguments).await,
        "list_prices_due" => security_prices::due(caller, arguments).await,
        "fetch_tiingo_prices" => security_prices::tiingo(caller, arguments).await,
        "get_investment_positions" => investments::positions(caller, arguments).await,
        "get_realized_gains" => investments::realized_gains(caller, arguments).await,
        "list_transactions" => transactions::list(caller, arguments).await,
        "search" => transactions::search(caller, arguments).await,
        "create_transaction" => transactions::create(caller, arguments).await,
        "update_transaction" => transactions::update(caller, arguments).await,
        "delete_transaction" => transactions::delete(caller, arguments).await,
        "get_income_statement" => reports::income_statement(caller, arguments).await,
        "get_report_data" => reports::report_data(caller, arguments).await,
        "get_account_balance_history" => reports::balance_history(caller, arguments).await,
        "get_plaid_status" => plaid::status(caller, arguments).await,
        "list_plaid_token_accounts" => plaid::token_accounts(caller, arguments).await,
        "update_plaid_token" => plaid::update_token(caller, arguments).await,
        "delete_plaid_token" => plaid::delete_token(caller, arguments).await,
        "set_plaid_token_accounts" => plaid::set_token_accounts(caller, arguments).await,
        "sync_plaid_token" => plaid::sync(caller, arguments).await,
        "clear_plaid_sync_data" => plaid::clear_sync_data(caller, arguments).await,
        "list_pending_plaid_transactions" => plaid::pending_transactions(caller, arguments).await,
        "get_transaction_plaid_link" => plaid::transaction_link(caller, arguments).await,
        "unlink_plaid_transaction" => plaid::unlink(caller, arguments).await,
        "get_reconcile_candidates" => plaid::reconcile_candidates(caller, arguments).await,
        "reconcile_plaid_transaction" => plaid::reconcile(caller, arguments).await,
        "list_payees" => payees::list(caller, arguments).await,
        "get_payee" => payees::get(caller, arguments).await,
        "create_payee" => payees::create(caller, arguments).await,
        "delete_payee" => payees::delete(caller, arguments).await,
        _ => return None,
    };
    Some(outcome.unwrap_or_else(|result| *result))
}
