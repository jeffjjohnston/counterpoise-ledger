pub(crate) mod accounts;
mod auth;
mod books;
mod cron;
mod events;
pub(crate) mod investments;
mod issue_reports;
mod members;
pub(crate) mod payees;
pub(crate) mod plaid_sync;
pub(crate) mod realized_gains;
pub(crate) mod reconcile;
mod recurring;
pub(crate) mod reports;
pub(crate) mod search;
pub(crate) mod securities;
pub(crate) mod security_prices;
pub(crate) mod sync;
pub(crate) mod system;
pub(crate) mod transactions;
mod typesafe;
mod typesafe_suggestion;

use self::{
    accounts::{create_account, delete_account, get_account, list_accounts, update_account},
    auth::{
        change_password, create_key, delete_key, list_keys, login, logout, me, register,
        registration_status,
    },
    books::{create_book, create_demo_book, delete_book, list_books, update_book},
    cron::{
        plaid_sync as plaid_sync_cron, price_sync as price_sync_cron, recurring as recurring_cron,
    },
    events::book_events,
    investments::{account_values, get_positions},
    issue_reports::{create_report, delete_report, list_reports, update_report},
    members::{add_member, change_member, list_members, remove_member},
    payees::{create_payee, delete_payee, get_payee, last_account, list_payees},
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
        list_tokens, pending_count, pending_transactions, set_token_accounts, stale_unmatched,
        transaction_plaid_link, unlink_transaction, update_token,
    },
    system::{api_health, health, status, version},
    transactions::{
        create_transaction, delete_transaction, get_transaction, list_transactions,
        update_transaction,
    },
    typesafe::{cleanup_route, clear_settings, get_settings, update_settings},
    typesafe_suggestion::{confirm_route, display_route, request_route},
};
use crate::state::AppState;
use axum::{Router, routing::get};
use serde::Deserialize;

#[derive(Deserialize)]
struct ManifestRoute {
    method: String,
    path: String,
    handler: String,
}

pub(crate) fn routes() -> Router<AppState> {
    let manifest: Vec<ManifestRoute> = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../routes.json"
    )))
    .expect("valid Rust route manifest");
    manifest.into_iter().fold(
        Router::new()
            .route("/health", get(health))
            .route("/api/health", get(api_health))
            // Not in routes.json: that manifest lists the routes that had a
            // Next fallback, and MCP over HTTP and WebMCP never had one.
            .route("/api/mcp", axum::routing::any(crate::mcp::http))
            .route(
                "/api/b/{book_id}/webmcp",
                get(crate::mcp::webmcp::list).post(crate::mcp::webmcp::call),
            ),
        |router, route| match (
            route.method.as_str(),
            route.path.as_str(),
            route.handler.as_str(),
        ) {
            ("GET", "/api/version", "version.get") => router.route(&route.path, get(version)),
            ("GET", "/api/system/status", "system.status") => {
                router.route(&route.path, get(status))
            }
            ("GET", "/api/books", "books.list") => router.route(&route.path, get(list_books)),
            ("POST", "/api/books", "books.create") => {
                router.route(&route.path, axum::routing::post(create_book))
            }
            ("POST", "/api/books/demo", "books.demo") => {
                router.route(&route.path, axum::routing::post(create_demo_book))
            }
            ("PUT", "/api/books/[bookId]", "books.update") => {
                router.route("/api/books/{book_id}", axum::routing::put(update_book))
            }
            ("DELETE", "/api/books/[bookId]", "books.delete") => {
                router.route("/api/books/{book_id}", axum::routing::delete(delete_book))
            }
            ("GET", "/api/books/[bookId]/members", "members.list") => {
                router.route("/api/books/{book_id}/members", get(list_members))
            }
            ("POST", "/api/books/[bookId]/members", "members.add") => router.route(
                "/api/books/{book_id}/members",
                axum::routing::post(add_member),
            ),
            ("PUT", "/api/books/[bookId]/members/[userId]", "members.change") => router.route(
                "/api/books/{book_id}/members/{user_id}",
                axum::routing::put(change_member),
            ),
            ("DELETE", "/api/books/[bookId]/members/[userId]", "members.remove") => router.route(
                "/api/books/{book_id}/members/{user_id}",
                axum::routing::delete(remove_member),
            ),
            ("GET", "/api/issue-reports", "issues.list") => {
                router.route(&route.path, get(list_reports))
            }
            ("POST", "/api/issue-reports", "issues.create") => {
                router.route(&route.path, axum::routing::post(create_report))
            }
            ("PUT", "/api/issue-reports/[id]", "issues.update") => {
                router.route("/api/issue-reports/{id}", axum::routing::put(update_report))
            }
            ("DELETE", "/api/issue-reports/[id]", "issues.delete") => router.route(
                "/api/issue-reports/{id}",
                axum::routing::delete(delete_report),
            ),
            ("GET", "/api/b/[bookId]/accounts", "accounts.list") => {
                router.route("/api/b/{book_id}/accounts", get(list_accounts))
            }
            ("POST", "/api/b/[bookId]/accounts", "accounts.create") => router.route(
                "/api/b/{book_id}/accounts",
                axum::routing::post(create_account),
            ),
            ("GET", "/api/b/[bookId]/accounts/[id]", "accounts.get") => {
                router.route("/api/b/{book_id}/accounts/{id}", get(get_account))
            }
            ("PUT", "/api/b/[bookId]/accounts/[id]", "accounts.update") => router.route(
                "/api/b/{book_id}/accounts/{id}",
                axum::routing::put(update_account),
            ),
            ("DELETE", "/api/b/[bookId]/accounts/[id]", "accounts.delete") => router.route(
                "/api/b/{book_id}/accounts/{id}",
                axum::routing::delete(delete_account),
            ),
            (
                "POST",
                "/api/b/[bookId]/sync/accounts/[id]/reconcile/suggestion",
                "typesafe.suggest",
            ) => router.route(
                "/api/b/{book_id}/sync/accounts/{id}/reconcile/suggestion",
                axum::routing::post(request_route),
            ),
            (
                "PATCH",
                "/api/b/[bookId]/sync/accounts/[id]/reconcile/suggestion",
                "typesafe.display",
            ) => router.route(
                "/api/b/{book_id}/sync/accounts/{id}/reconcile/suggestion",
                axum::routing::patch(display_route),
            ),
            (
                "PUT",
                "/api/b/[bookId]/sync/accounts/[id]/reconcile/suggestion",
                "typesafe.confirm",
            ) => router.route(
                "/api/b/{book_id}/sync/accounts/{id}/reconcile/suggestion",
                axum::routing::put(confirm_route),
            ),
            ("GET", "/api/b/[bookId]/settings/typesafe", "typesafe.settings") => {
                router.route("/api/b/{book_id}/settings/typesafe", get(get_settings))
            }
            ("PATCH", "/api/b/[bookId]/settings/typesafe", "typesafe.update") => router.route(
                "/api/b/{book_id}/settings/typesafe",
                axum::routing::patch(update_settings),
            ),
            ("DELETE", "/api/b/[bookId]/settings/typesafe", "typesafe.clear") => router.route(
                "/api/b/{book_id}/settings/typesafe",
                axum::routing::delete(clear_settings),
            ),
            ("GET", "/api/cron/typesafe-cleanup", "typesafe.cleanup") => {
                router.route(&route.path, get(cleanup_route))
            }
            ("GET", "/api/cron/plaid-sync", "cron.plaidsync") => {
                router.route(&route.path, get(plaid_sync_cron))
            }
            ("GET", "/api/cron/price-sync", "cron.pricesync") => {
                router.route(&route.path, get(price_sync_cron))
            }
            ("GET", "/api/cron/recurring", "cron.recurring") => {
                router.route(&route.path, get(recurring_cron))
            }
            ("GET", "/api/b/[bookId]/events", "events.stream") => {
                router.route("/api/b/{book_id}/events", get(book_events))
            }
            ("GET", "/api/b/[bookId]/sync/pending-count", "sync.pendingcount") => {
                router.route("/api/b/{book_id}/sync/pending-count", get(pending_count))
            }
            ("GET", "/api/b/[bookId]/sync/tokens", "sync.tokens") => {
                router.route("/api/b/{book_id}/sync/tokens", get(list_tokens))
            }
            ("POST", "/api/b/[bookId]/sync/tokens", "sync.createtoken") => router.route(
                "/api/b/{book_id}/sync/tokens",
                axum::routing::post(create_token),
            ),
            ("PUT", "/api/b/[bookId]/sync/tokens/[id]", "sync.updatetoken") => router.route(
                "/api/b/{book_id}/sync/tokens/{id}",
                axum::routing::put(update_token),
            ),
            ("DELETE", "/api/b/[bookId]/sync/tokens/[id]", "sync.deletetoken") => router.route(
                "/api/b/{book_id}/sync/tokens/{id}",
                axum::routing::delete(delete_token),
            ),
            ("GET", "/api/b/[bookId]/sync/tokens/[id]/accounts", "sync.tokenaccounts") => router
                .route(
                    "/api/b/{book_id}/sync/tokens/{id}/accounts",
                    get(list_token_accounts),
                ),
            ("PUT", "/api/b/[bookId]/sync/tokens/[id]/accounts", "sync.assignaccounts") => router
                .route(
                    "/api/b/{book_id}/sync/tokens/{id}/accounts",
                    axum::routing::put(set_token_accounts),
                ),
            ("DELETE", "/api/b/[bookId]/sync/tokens/[id]/sync", "sync.clear") => router.route(
                "/api/b/{book_id}/sync/tokens/{id}/sync",
                axum::routing::delete(clear_sync_data),
            ),
            ("POST", "/api/b/[bookId]/sync/tokens/[id]/sync", "sync.run") => router.route(
                "/api/b/{book_id}/sync/tokens/{id}/sync",
                axum::routing::post(sync_now),
            ),
            ("GET", "/api/b/[bookId]/sync/reconcile", "sync.bookqueue") => {
                router.route("/api/b/{book_id}/sync/reconcile", get(book_queue))
            }
            ("GET", "/api/b/[bookId]/sync/accounts/[id]/reconcile", "sync.linkqueue") => router
                .route(
                    "/api/b/{book_id}/sync/accounts/{id}/reconcile",
                    get(link_queue),
                ),
            ("POST", "/api/b/[bookId]/sync/accounts/[id]/reconcile", "sync.resolve") => router
                .route(
                    "/api/b/{book_id}/sync/accounts/{id}/reconcile",
                    axum::routing::post(resolve_route),
                ),
            ("GET", "/api/b/[bookId]/sync/assigned-accounts", "sync.assigned") => router.route(
                "/api/b/{book_id}/sync/assigned-accounts",
                get(assigned_accounts),
            ),
            ("GET", "/api/b/[bookId]/sync/pending-transactions", "sync.pendingtransactions") => {
                router.route(
                    "/api/b/{book_id}/sync/pending-transactions",
                    get(pending_transactions),
                )
            }
            ("GET", "/api/b/[bookId]/sync/stale-unmatched", "sync.stale") => router.route(
                "/api/b/{book_id}/sync/stale-unmatched",
                get(stale_unmatched),
            ),
            ("GET", "/api/b/[bookId]/transactions/[id]/plaid", "transactions.plaidlink") => router
                .route(
                    "/api/b/{book_id}/transactions/{id}/plaid",
                    get(transaction_plaid_link),
                ),
            (
                "POST",
                "/api/b/[bookId]/transactions/[id]/plaid/unlink",
                "transactions.plaidunlink",
            ) => router.route(
                "/api/b/{book_id}/transactions/{id}/plaid/unlink",
                axum::routing::post(unlink_transaction),
            ),
            ("GET", "/api/b/[bookId]/payees", "payees.list") => {
                router.route("/api/b/{book_id}/payees", get(list_payees))
            }
            ("POST", "/api/b/[bookId]/payees", "payees.create") => {
                router.route("/api/b/{book_id}/payees", axum::routing::post(create_payee))
            }
            ("GET", "/api/b/[bookId]/payees/[id]", "payees.get") => {
                router.route("/api/b/{book_id}/payees/{id}", get(get_payee))
            }
            ("DELETE", "/api/b/[bookId]/payees/[id]", "payees.delete") => router.route(
                "/api/b/{book_id}/payees/{id}",
                axum::routing::delete(delete_payee),
            ),
            ("GET", "/api/b/[bookId]/payees/[id]/last-account", "payees.lastaccount") => router
                .route(
                    "/api/b/{book_id}/payees/{id}/last-account",
                    get(last_account),
                ),
            ("GET", "/api/b/[bookId]/reports/data", "reports.data") => {
                router.route("/api/b/{book_id}/reports/data", get(report_data))
            }
            ("GET", "/api/b/[bookId]/reports/income-statement", "reports.income") => router.route(
                "/api/b/{book_id}/reports/income-statement",
                get(income_statement),
            ),
            ("GET", "/api/b/[bookId]/search", "search.get") => {
                router.route("/api/b/{book_id}/search", get(search))
            }
            ("GET", "/api/b/[bookId]/investments/positions", "investments.positions") => {
                router.route("/api/b/{book_id}/investments/positions", get(get_positions))
            }
            ("GET", "/api/b/[bookId]/investments/account-values", "investments.accountvalues") => {
                router.route(
                    "/api/b/{book_id}/investments/account-values",
                    get(account_values),
                )
            }
            ("GET", "/api/b/[bookId]/securities", "securities.list") => {
                router.route("/api/b/{book_id}/securities", get(list_securities))
            }
            ("POST", "/api/b/[bookId]/securities", "securities.create") => router.route(
                "/api/b/{book_id}/securities",
                axum::routing::post(create_security),
            ),
            ("GET", "/api/b/[bookId]/securities/[id]", "securities.get") => {
                router.route("/api/b/{book_id}/securities/{id}", get(get_security))
            }
            ("PUT", "/api/b/[bookId]/securities/[id]", "securities.update") => router.route(
                "/api/b/{book_id}/securities/{id}",
                axum::routing::put(update_security),
            ),
            ("DELETE", "/api/b/[bookId]/securities/[id]", "securities.delete") => router.route(
                "/api/b/{book_id}/securities/{id}",
                axum::routing::delete(delete_security),
            ),
            ("GET", "/api/b/[bookId]/securities/[id]/detail", "securities.detail") => router.route(
                "/api/b/{book_id}/securities/{id}/detail",
                get(security_detail),
            ),
            ("GET", "/api/b/[bookId]/securities/[id]/lots", "securities.lots") => {
                router.route("/api/b/{book_id}/securities/{id}/lots", get(security_lots))
            }
            ("GET", "/api/b/[bookId]/securities/[id]/splits", "securities.splits") => router.route(
                "/api/b/{book_id}/securities/{id}/splits",
                get(security_splits),
            ),
            ("GET", "/api/b/[bookId]/securities/[id]/prices", "prices.history") => router.route(
                "/api/b/{book_id}/securities/{id}/prices",
                get(price_history),
            ),
            ("PUT", "/api/b/[bookId]/securities/[id]/prices/[date]", "prices.update") => router
                .route(
                    "/api/b/{book_id}/securities/{id}/prices/{date}",
                    axum::routing::put(update_price),
                ),
            ("DELETE", "/api/b/[bookId]/securities/[id]/prices/[date]", "prices.delete") => router
                .route(
                    "/api/b/{book_id}/securities/{id}/prices/{date}",
                    axum::routing::delete(delete_price),
                ),
            ("GET", "/api/b/[bookId]/securities/prices-due", "prices.due") => {
                router.route("/api/b/{book_id}/securities/prices-due", get(prices_due))
            }
            ("POST", "/api/b/[bookId]/security-prices/bulk", "prices.bulk") => router.route(
                "/api/b/{book_id}/security-prices/bulk",
                axum::routing::post(bulk_prices),
            ),
            ("POST", "/api/b/[bookId]/security-prices/tiingo", "prices.tiingo") => router.route(
                "/api/b/{book_id}/security-prices/tiingo",
                axum::routing::post(tiingo_prices),
            ),
            ("GET", "/api/b/[bookId]/reports/realized-gains", "reports.realizedgains") => router
                .route(
                    "/api/b/{book_id}/reports/realized-gains",
                    get(realized_gains),
                ),
            ("GET", "/api/b/[bookId]/transactions", "transactions.list") => {
                router.route("/api/b/{book_id}/transactions", get(list_transactions))
            }
            ("POST", "/api/b/[bookId]/transactions", "transactions.create") => router.route(
                "/api/b/{book_id}/transactions",
                axum::routing::post(create_transaction),
            ),
            ("GET", "/api/b/[bookId]/transactions/[id]", "transactions.get") => {
                router.route("/api/b/{book_id}/transactions/{id}", get(get_transaction))
            }
            ("PUT", "/api/b/[bookId]/transactions/[id]", "transactions.update") => router.route(
                "/api/b/{book_id}/transactions/{id}",
                axum::routing::put(update_transaction),
            ),
            ("DELETE", "/api/b/[bookId]/transactions/[id]", "transactions.delete") => router.route(
                "/api/b/{book_id}/transactions/{id}",
                axum::routing::delete(delete_transaction),
            ),
            ("GET", "/api/b/[bookId]/recurring", "recurring.list") => {
                router.route("/api/b/{book_id}/recurring", get(list_rules))
            }
            ("POST", "/api/b/[bookId]/recurring", "recurring.create") => router.route(
                "/api/b/{book_id}/recurring",
                axum::routing::post(create_rule),
            ),
            ("GET", "/api/b/[bookId]/recurring/[id]", "recurring.get") => {
                router.route("/api/b/{book_id}/recurring/{id}", get(get_rule))
            }
            ("PUT", "/api/b/[bookId]/recurring/[id]", "recurring.update") => router.route(
                "/api/b/{book_id}/recurring/{id}",
                axum::routing::put(update_rule),
            ),
            ("DELETE", "/api/b/[bookId]/recurring/[id]", "recurring.delete") => router.route(
                "/api/b/{book_id}/recurring/{id}",
                axum::routing::delete(delete_rule),
            ),
            ("POST", "/api/b/[bookId]/recurring/process", "recurring.process") => router.route(
                "/api/b/{book_id}/recurring/process",
                axum::routing::post(process_rules),
            ),
            ("GET", "/api/b/[bookId]/recurring/projected", "recurring.projected") => {
                router.route("/api/b/{book_id}/recurring/projected", get(projected))
            }
            ("GET", "/api/b/[bookId]/recurring/transactions", "recurring.transactions") => router
                .route(
                    "/api/b/{book_id}/recurring/transactions",
                    get(rule_transactions),
                ),
            ("GET", "/api/auth/registration-open", "auth.registration") => {
                router.route(&route.path, get(registration_status))
            }
            ("POST", "/api/auth/login", "auth.login") => {
                router.route(&route.path, axum::routing::post(login))
            }
            ("POST", "/api/auth/register", "auth.register") => {
                router.route(&route.path, axum::routing::post(register))
            }
            ("POST", "/api/auth/logout", "auth.logout") => {
                router.route(&route.path, axum::routing::post(logout))
            }
            ("GET", "/api/auth/me", "auth.me") => router.route(&route.path, get(me)),
            ("PUT", "/api/auth/password", "auth.password") => {
                router.route(&route.path, axum::routing::put(change_password))
            }
            ("GET", "/api/auth/api-keys", "auth.keys") => router.route(&route.path, get(list_keys)),
            ("POST", "/api/auth/api-keys", "auth.create") => {
                router.route(&route.path, axum::routing::post(create_key))
            }
            ("DELETE", "/api/auth/api-keys/[id]", "auth.delete") => {
                router.route("/api/auth/api-keys/{id}", axum::routing::delete(delete_key))
            }
            _ => panic!(
                "no Rust handler for {} {} ({})",
                route.method, route.path, route.handler
            ),
        },
    )
}

#[cfg(test)]
mod tests {
    #[test]
    fn every_manifest_entry_has_a_registered_handler() {
        let _ = super::routes();
    }
}
