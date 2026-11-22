mod access_handoff;
pub(crate) mod account_balance;
pub(crate) mod accounts;
pub(crate) mod auth;
pub(crate) mod books;
pub(crate) mod cron;
mod entry_suggestion;
pub(crate) mod investments;
mod issue_reports;
pub(crate) mod members;
pub(crate) mod net_worth;
pub(crate) mod payees;
pub(crate) mod plaid_link;
pub(crate) mod plaid_sync;
pub(crate) mod realized_gains;
pub(crate) mod reconcile;
mod recurring;
pub(crate) mod reports;
pub(crate) mod search;
pub(crate) mod securities;
pub(crate) mod security_prices;
// The native socket. A Durable Object serves the path with its own API.
#[cfg(feature = "native")]
pub(crate) mod socket;
pub(crate) mod sync;
pub(crate) mod system;
mod transaction_changes;
pub(crate) mod transactions;
pub(crate) mod typesafe;
mod typesafe_suggestion;
pub(crate) mod weekly_review;

#[cfg(feature = "native")]
use self::socket::book_socket;
use self::{
    account_balance::account_balance_history,
    accounts::{create_account, delete_account, get_account, list_accounts, update_account},
    auth::{
        change_password, change_username, create_key, delete_key, list_keys, login, logout, me,
        register, registration_status,
    },
    books::{
        create_book, create_demo_book, delete_book, list_books, list_demo_datasets, update_book,
    },
    cron::{
        backup as backup_cron, plaid_sync as plaid_sync_cron, price_sync as price_sync_cron,
        recurring as recurring_cron,
    },
    entry_suggestion::{get_entry_patterns, record_entry_outcome, request_entry_suggestion},
    investments::{account_values, get_positions},
    issue_reports::{create_report, delete_report, list_reports, update_report},
    members::{add_member, change_member, list_members, remove_member},
    net_worth::net_worth_history,
    payees::{create_payee, delete_payee, get_payee, last_account, list_payees},
    plaid_link::{check_link_session, create_link_session},
    plaid_sync::sync_now,
    realized_gains::realized_gains,
    reconcile::{book_queue, link_queue, resolve_route},
    recurring::{
        create_rule, delete_rule, get_rule, list_rules, process_rules, projected,
        rule_transactions, update_rule,
    },
    reports::{income_statement, report_data},
    search::search,
    securities::{
        create_security, delete_security, get_security, list_securities, security_detail,
        security_lots, security_splits, update_security,
    },
    security_prices::{
        bulk_prices, delete_price, price_history, prices_due, tiingo_prices, update_price,
    },
    sync::{
        assigned_accounts, clear_sync_data, create_token, delete_token, list_token_accounts,
        list_tokens, pending_count, pending_transactions, refresh_token_accounts,
        set_token_accounts, stale_unmatched, transaction_plaid_link, unlink_transaction,
        update_token,
    },
    system::{api_health, health, status, version},
    transaction_changes::list_transaction_changes,
    transactions::{
        create_transaction, delete_transaction, get_transaction, list_transactions,
        update_transaction,
    },
    typesafe::{cleanup_route, clear_settings, get_settings, update_settings},
    typesafe_suggestion::{confirm_route, display_route, request_route},
    weekly_review::{
        clear_weekly_review_settings, dismiss_weekly_review_item, get_weekly_review,
        get_weekly_review_settings, restore_weekly_review_item, run_weekly_review_now,
        update_weekly_review_settings, weekly_review_cron,
    },
};
use crate::state::AppState;
use axum::{Router, routing::get};

/// One route of the table: its method, its path in the form of the manifest
/// (`/api/b/[bookId]/payees/[id]`), its name in the manifest, and the
/// function that adds its handler to the router.
pub(crate) struct Route {
    // The method and the name go only to `routes.json` and to the tests.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) method: &'static str,
    pub(crate) path: &'static str,
    #[cfg_attr(not(test), allow(dead_code))]
    name: &'static str,
    add: fn(Router<AppState>, &str) -> Router<AppState>,
}

macro_rules! method_router {
    (GET) => {
        axum::routing::get
    };
    (POST) => {
        axum::routing::post
    };
    (PUT) => {
        axum::routing::put
    };
    (PATCH) => {
        axum::routing::patch
    };
    (DELETE) => {
        axum::routing::delete
    };
}

/// Makes the route table from lines of the form
/// `GET "/api/b/[bookId]/things" "things.list" => list_things,`.
/// `tests/lib/book-access-levels.test.ts` reads these lines to find the
/// handler of each book route: keep one route on one line.
macro_rules! route_table {
    ($( $(#[$attr:meta])* $method:ident $path:literal $name:literal => $handler:path ),* $(,)?) => {{
        let mut table: Vec<Route> = Vec::new();
        $(
            $(#[$attr])*
            table.push(Route {
                method: stringify!($method),
                path: $path,
                name: $name,
                add: |router, path| router.route(path, method_router!($method)($handler)),
            });
        )*
        table
    }};
}

/// THE ROUTE TABLE: each route of the API, one line each. To add a route,
/// add its line here, then write `rust-api/routes.json` again from the table
/// (the test below says how). The tests in `tests/` read that file.
///
/// A route with two methods on one path has two lines. The order is the
/// order of `routes.json`.
#[rustfmt::skip]
pub(crate) fn table() -> Vec<Route> {
    route_table![
        GET "/api/version" "version.get" => version,
        GET "/api/system/status" "system.status" => status,
        GET "/api/books" "books.list" => list_books,
        POST "/api/books" "books.create" => create_book,
        POST "/api/books/demo" "books.demo" => create_demo_book,
        GET "/api/books/demo/datasets" "books.datasets" => list_demo_datasets,
        PUT "/api/books/[bookId]" "books.update" => update_book,
        DELETE "/api/books/[bookId]" "books.delete" => delete_book,
        GET "/api/books/[bookId]/members" "members.list" => list_members,
        POST "/api/books/[bookId]/members" "members.add" => add_member,
        PUT "/api/books/[bookId]/members/[userId]" "members.change" => change_member,
        DELETE "/api/books/[bookId]/members/[userId]" "members.remove" => remove_member,
        GET "/api/issue-reports" "issues.list" => list_reports,
        POST "/api/issue-reports" "issues.create" => create_report,
        PUT "/api/issue-reports/[id]" "issues.update" => update_report,
        DELETE "/api/issue-reports/[id]" "issues.delete" => delete_report,
        GET "/api/b/[bookId]/accounts" "accounts.list" => list_accounts,
        POST "/api/b/[bookId]/accounts" "accounts.create" => create_account,
        GET "/api/b/[bookId]/accounts/[id]" "accounts.get" => get_account,
        PUT "/api/b/[bookId]/accounts/[id]" "accounts.update" => update_account,
        DELETE "/api/b/[bookId]/accounts/[id]" "accounts.delete" => delete_account,
        GET "/api/b/[bookId]/accounts/[id]/balance-history" "accounts.balancehistory" => account_balance_history,
        // The native socket. A Durable Object serves the path with its own API.
        #[cfg(feature = "native")]
        GET "/api/b/[bookId]/socket" "events.socket" => book_socket,
        POST "/api/b/[bookId]/sync/accounts/[id]/reconcile/suggestion" "typesafe.suggest" => request_route,
        PATCH "/api/b/[bookId]/sync/accounts/[id]/reconcile/suggestion" "typesafe.display" => display_route,
        PUT "/api/b/[bookId]/sync/accounts/[id]/reconcile/suggestion" "typesafe.confirm" => confirm_route,
        GET "/api/b/[bookId]/settings/typesafe" "typesafe.settings" => get_settings,
        PATCH "/api/b/[bookId]/settings/typesafe" "typesafe.update" => update_settings,
        DELETE "/api/b/[bookId]/settings/typesafe" "typesafe.clear" => clear_settings,
        GET "/api/b/[bookId]/settings/weekly-review" "weeklyreview.settings" => get_weekly_review_settings,
        PATCH "/api/b/[bookId]/settings/weekly-review" "weeklyreview.update" => update_weekly_review_settings,
        DELETE "/api/b/[bookId]/settings/weekly-review" "weeklyreview.clear" => clear_weekly_review_settings,
        GET "/api/b/[bookId]/weekly-review" "weeklyreview.get" => get_weekly_review,
        POST "/api/b/[bookId]/weekly-review/run" "weeklyreview.run" => run_weekly_review_now,
        POST "/api/b/[bookId]/weekly-review/items/[id]/dismiss" "weeklyreview.dismiss" => dismiss_weekly_review_item,
        POST "/api/b/[bookId]/weekly-review/items/[id]/restore" "weeklyreview.restore" => restore_weekly_review_item,
        GET "/api/cron/typesafe-cleanup" "typesafe.cleanup" => cleanup_route,
        GET "/api/cron/plaid-sync" "cron.plaidsync" => plaid_sync_cron,
        GET "/api/cron/price-sync" "cron.pricesync" => price_sync_cron,
        GET "/api/cron/recurring" "cron.recurring" => recurring_cron,
        GET "/api/cron/backup" "cron.backup" => backup_cron,
        GET "/api/cron/weekly-review" "weeklyreview.cron" => weekly_review_cron,
        GET "/api/b/[bookId]/sync/pending-count" "sync.pendingcount" => pending_count,
        GET "/api/b/[bookId]/sync/tokens" "sync.tokens" => list_tokens,
        POST "/api/b/[bookId]/sync/tokens" "sync.createtoken" => create_token,
        PUT "/api/b/[bookId]/sync/tokens/[id]" "sync.updatetoken" => update_token,
        DELETE "/api/b/[bookId]/sync/tokens/[id]" "sync.deletetoken" => delete_token,
        GET "/api/b/[bookId]/sync/tokens/[id]/accounts" "sync.tokenaccounts" => list_token_accounts,
        PUT "/api/b/[bookId]/sync/tokens/[id]/accounts" "sync.assignaccounts" => set_token_accounts,
        POST "/api/b/[bookId]/sync/tokens/[id]/accounts/refresh" "sync.refreshaccounts" => refresh_token_accounts,
        DELETE "/api/b/[bookId]/sync/tokens/[id]/sync" "sync.clear" => clear_sync_data,
        POST "/api/b/[bookId]/sync/tokens/[id]/sync" "sync.run" => sync_now,
        POST "/api/b/[bookId]/sync/link-sessions" "sync.createlinksession" => create_link_session,
        POST "/api/b/[bookId]/sync/link-sessions/[id]/check" "sync.checklinksession" => check_link_session,
        GET "/api/b/[bookId]/sync/reconcile" "sync.bookqueue" => book_queue,
        GET "/api/b/[bookId]/sync/accounts/[id]/reconcile" "sync.linkqueue" => link_queue,
        POST "/api/b/[bookId]/sync/accounts/[id]/reconcile" "sync.resolve" => resolve_route,
        GET "/api/b/[bookId]/sync/assigned-accounts" "sync.assigned" => assigned_accounts,
        GET "/api/b/[bookId]/sync/pending-transactions" "sync.pendingtransactions" => pending_transactions,
        GET "/api/b/[bookId]/sync/stale-unmatched" "sync.stale" => stale_unmatched,
        GET "/api/b/[bookId]/transactions/[id]/plaid" "transactions.plaidlink" => transaction_plaid_link,
        POST "/api/b/[bookId]/transactions/[id]/plaid/unlink" "transactions.plaidunlink" => unlink_transaction,
        GET "/api/b/[bookId]/payees" "payees.list" => list_payees,
        POST "/api/b/[bookId]/payees" "payees.create" => create_payee,
        GET "/api/b/[bookId]/payees/[id]" "payees.get" => get_payee,
        DELETE "/api/b/[bookId]/payees/[id]" "payees.delete" => delete_payee,
        GET "/api/b/[bookId]/payees/[id]/last-account" "payees.lastaccount" => last_account,
        GET "/api/b/[bookId]/payees/[id]/entry-patterns" "entrysuggestion.patterns" => get_entry_patterns,
        POST "/api/b/[bookId]/entry-suggestion" "entrysuggestion.request" => request_entry_suggestion,
        POST "/api/b/[bookId]/entry-suggestion/outcome" "entrysuggestion.outcome" => record_entry_outcome,
        GET "/api/b/[bookId]/reports/data" "reports.data" => report_data,
        GET "/api/b/[bookId]/reports/income-statement" "reports.income" => income_statement,
        GET "/api/b/[bookId]/search" "search.get" => search,
        GET "/api/b/[bookId]/investments/positions" "investments.positions" => get_positions,
        GET "/api/b/[bookId]/investments/account-values" "investments.accountvalues" => account_values,
        GET "/api/b/[bookId]/securities" "securities.list" => list_securities,
        POST "/api/b/[bookId]/securities" "securities.create" => create_security,
        GET "/api/b/[bookId]/securities/[id]" "securities.get" => get_security,
        PUT "/api/b/[bookId]/securities/[id]" "securities.update" => update_security,
        DELETE "/api/b/[bookId]/securities/[id]" "securities.delete" => delete_security,
        GET "/api/b/[bookId]/securities/[id]/detail" "securities.detail" => security_detail,
        GET "/api/b/[bookId]/securities/[id]/lots" "securities.lots" => security_lots,
        GET "/api/b/[bookId]/securities/[id]/splits" "securities.splits" => security_splits,
        GET "/api/b/[bookId]/reports/realized-gains" "reports.realizedgains" => realized_gains,
        GET "/api/b/[bookId]/reports/net-worth-history" "reports.networth" => net_worth_history,
        GET "/api/b/[bookId]/securities/[id]/prices" "prices.history" => price_history,
        PUT "/api/b/[bookId]/securities/[id]/prices/[date]" "prices.update" => update_price,
        DELETE "/api/b/[bookId]/securities/[id]/prices/[date]" "prices.delete" => delete_price,
        GET "/api/b/[bookId]/securities/prices-due" "prices.due" => prices_due,
        POST "/api/b/[bookId]/security-prices/bulk" "prices.bulk" => bulk_prices,
        POST "/api/b/[bookId]/security-prices/tiingo" "prices.tiingo" => tiingo_prices,
        GET "/api/b/[bookId]/transactions" "transactions.list" => list_transactions,
        POST "/api/b/[bookId]/transactions" "transactions.create" => create_transaction,
        GET "/api/b/[bookId]/transactions/changes" "transactions.changes" => list_transaction_changes,
        GET "/api/b/[bookId]/transactions/[id]" "transactions.get" => get_transaction,
        PUT "/api/b/[bookId]/transactions/[id]" "transactions.update" => update_transaction,
        DELETE "/api/b/[bookId]/transactions/[id]" "transactions.delete" => delete_transaction,
        GET "/api/b/[bookId]/recurring" "recurring.list" => list_rules,
        POST "/api/b/[bookId]/recurring" "recurring.create" => create_rule,
        GET "/api/b/[bookId]/recurring/[id]" "recurring.get" => get_rule,
        PUT "/api/b/[bookId]/recurring/[id]" "recurring.update" => update_rule,
        DELETE "/api/b/[bookId]/recurring/[id]" "recurring.delete" => delete_rule,
        POST "/api/b/[bookId]/recurring/process" "recurring.process" => process_rules,
        GET "/api/b/[bookId]/recurring/projected" "recurring.projected" => projected,
        GET "/api/b/[bookId]/recurring/transactions" "recurring.transactions" => rule_transactions,
        GET "/api/auth/registration-open" "auth.registration" => registration_status,
        POST "/api/auth/login" "auth.login" => login,
        POST "/api/auth/register" "auth.register" => register,
        POST "/api/auth/logout" "auth.logout" => logout,
        GET "/api/auth/me" "auth.me" => me,
        PUT "/api/auth/password" "auth.password" => change_password,
        PUT "/api/auth/username" "auth.username" => change_username,
        GET "/api/auth/api-keys" "auth.keys" => list_keys,
        POST "/api/auth/api-keys" "auth.create" => create_key,
        DELETE "/api/auth/api-keys/[id]" "auth.delete" => delete_key,
    ]
}

/// The axum form of a manifest path: `[bookId]` becomes `{book_id}`.
fn axum_path(path: &str) -> String {
    let mut out = String::with_capacity(path.len() + 4);
    let mut in_parameter = false;
    for character in path.chars() {
        match character {
            '[' => {
                in_parameter = true;
                out.push('{');
            }
            ']' => {
                in_parameter = false;
                out.push('}');
            }
            upper if in_parameter && upper.is_ascii_uppercase() => {
                out.push('_');
                out.push(upper.to_ascii_lowercase());
            }
            other => out.push(other),
        }
    }
    out
}

/// The text of `rust-api/routes.json`: the method, path and name of each
/// route of the table.
#[cfg(test)]
fn manifest_json() -> String {
    let rows: Vec<String> = table()
        .iter()
        .map(|route| {
            format!(
                r#"  {{ "method": "{}", "path": "{}", "handler": "{}" }}"#,
                route.method, route.path, route.name
            )
        })
        .collect();
    format!("[\n{}\n]\n", rows.join(",\n"))
}

pub(crate) fn routes() -> Router<AppState> {
    table().into_iter().fold(
        Router::new()
            .route("/health", get(health))
            .route("/api/health", get(api_health))
            // Not in the table: MCP over HTTP and WebMCP take each method on
            // one path, and the tests that read routes.json do not cover them.
            .route(crate::mcp::PATH, axum::routing::any(crate::mcp::http))
            // Not in the table either: only a server behind Cloudflare Access
            // answers it, and no browser page calls it.
            .route(
                "/api/auth/access-handoff",
                get(access_handoff::access_handoff),
            )
            .route(
                "/api/b/{book_id}/webmcp",
                get(crate::mcp::webmcp::list).post(crate::mcp::webmcp::call),
            )
            // OAuth for MCP: the discovery documents and /api/oauth/*.
            .merge(crate::oauth::routes()),
        |router, route| (route.add)(router, &axum_path(route.path)),
    )
}

#[cfg(test)]
mod tests {
    /// axum refuses two handlers for one method and path, so building the
    /// router proves that the table has no such pair.
    #[test]
    fn the_router_takes_every_route_of_the_table() {
        let _ = super::routes();
    }

    #[test]
    fn a_manifest_path_becomes_an_axum_path() {
        assert_eq!(super::axum_path("/api/version"), "/api/version");
        assert_eq!(
            super::axum_path("/api/books/[bookId]/members/[userId]"),
            "/api/books/{book_id}/members/{user_id}"
        );
        assert_eq!(
            super::axum_path("/api/b/[bookId]/securities/[id]/prices/[date]"),
            "/api/b/{book_id}/securities/{id}/prices/{date}"
        );
    }

    /// `rust-api/routes.json` is written from the table. The tests in
    /// `tests/` read it (the access levels, the MCP route coverage), and so
    /// does the OpenAPI check. To write it again after a change to the table:
    ///
    /// ```text
    /// UPDATE_ROUTES_JSON=1 cargo test -p counterpoise-rust-api routes_json
    /// ```
    #[test]
    fn routes_json_lists_the_route_table() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../routes.json");
        let expected = super::manifest_json();
        if std::env::var_os("UPDATE_ROUTES_JSON").is_some() {
            std::fs::write(path, &expected).expect("write routes.json");
        }
        let actual = std::fs::read_to_string(path).expect("read routes.json");
        assert!(
            actual == expected,
            "rust-api/routes.json does not match the route table in routes/mod.rs. \
             Run: UPDATE_ROUTES_JSON=1 cargo test -p counterpoise-rust-api routes_json"
        );
    }
}
