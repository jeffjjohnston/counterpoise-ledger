/**
 * Route-to-tool coverage. Data only, no logic — route-parity.test.ts enforces
 * it.
 *
 * Every exported HTTP method under app/api must appear in exactly one of
 * ROUTE_TOOLS or ROUTE_WAIVERS. That is the whole point: before this file,
 * "no tool for this route" and "deliberately no tool for this route" looked
 * identical, and five domains fell out of MCP coverage unnoticed.
 *
 * Every waiver here is now a decision, not a promise. The `pending-plan-N`
 * mechanism that tracked the MCP parity project's staged rollout was removed
 * with the last plan of the MCP parity project — the routes it deferred all
 * have tools. A future deferral should get a dated comment naming what will
 * cover the route, not a revived scheme: the value was in every route being
 * accounted for, which the two tables below still deliver.
 */

export const ROUTE_TOOLS: Record<string, string[]> = {
  "GET /b/[bookId]/accounts": ["list_accounts", "get_account_tree"],
  "POST /b/[bookId]/accounts": ["create_account"],
  "PUT /b/[bookId]/accounts/[id]": ["update_account"],
  "DELETE /b/[bookId]/accounts/[id]": ["delete_account"],
  "GET /b/[bookId]/transactions": ["list_transactions"],
  "POST /b/[bookId]/transactions": ["create_transaction"],
  "PUT /b/[bookId]/transactions/[id]": ["update_transaction"],
  "DELETE /b/[bookId]/transactions/[id]": ["delete_transaction"],
  "GET /b/[bookId]/search": ["search"],
  "GET /b/[bookId]/reports/data": ["get_report_data"],
  "GET /b/[bookId]/reports/income-statement": ["get_income_statement"],
  "GET /b/[bookId]/reports/realized-gains": ["get_realized_gains"],
  "GET /b/[bookId]/investments/positions": ["get_investment_positions"],
  "GET /b/[bookId]/investments/account-values": ["get_investment_positions"],
  "GET /b/[bookId]/securities/[id]/detail": ["get_security_detail"],
  "GET /b/[bookId]/securities/[id]/lots": ["get_security_detail"],
  "GET /b/[bookId]/securities/[id]/splits": ["get_security_detail"],
  "GET /b/[bookId]/securities/[id]/prices": ["get_security_detail"],
  "POST /b/[bookId]/securities": ["create_security"],
  "GET /b/[bookId]/securities": ["list_securities"],
  "PUT /b/[bookId]/securities/[id]": ["update_security"],
  "DELETE /b/[bookId]/securities/[id]": ["delete_security"],
  "POST /b/[bookId]/security-prices/bulk": ["set_security_prices"],
  "PUT /b/[bookId]/securities/[id]/prices/[date]": ["update_security_price"],
  "DELETE /b/[bookId]/securities/[id]/prices/[date]": ["delete_security_price"],
  "GET /b/[bookId]/securities/prices-due": ["list_prices_due"],
  "POST /b/[bookId]/security-prices/tiingo": ["fetch_tiingo_prices"],
  "GET /books": ["list_books"],
  "POST /books": ["create_book"],
  "PUT /books/[bookId]": ["update_book"],
  "DELETE /books/[bookId]": ["delete_book"],
  "POST /books/demo": ["create_demo_book"],
  "GET /b/[bookId]/payees": ["list_payees"],
  "POST /b/[bookId]/payees": ["create_payee"],
  "GET /b/[bookId]/payees/[id]": ["get_payee"],
  "DELETE /b/[bookId]/payees/[id]": ["delete_payee"],
  "GET /issue-reports": ["list_issue_reports"],
  "POST /issue-reports": ["create_issue_report"],
  "PUT /issue-reports/[id]": ["update_issue_report"],
  "DELETE /issue-reports/[id]": ["delete_issue_report"],
  "GET /system/status": ["get_system_status"],
  "GET /b/[bookId]/recurring": ["list_recurring_rules"],
  "POST /b/[bookId]/recurring": ["create_recurring_rule"],
  "PUT /b/[bookId]/recurring/[id]": ["update_recurring_rule"],
  "DELETE /b/[bookId]/recurring/[id]": ["delete_recurring_rule"],
  "GET /b/[bookId]/recurring/projected": ["get_projected_transactions"],
  "GET /b/[bookId]/recurring/transactions": ["list_recurring_transactions"],
  "POST /b/[bookId]/recurring/process": ["process_recurring_rules"],
  "GET /b/[bookId]/sync/tokens": ["get_plaid_status"],
  "GET /b/[bookId]/sync/pending-count": ["get_plaid_status"],
  "GET /b/[bookId]/sync/stale-unmatched": ["get_plaid_status"],
  "GET /b/[bookId]/sync/assigned-accounts": ["get_plaid_status"],
  "GET /b/[bookId]/sync/tokens/[id]/accounts": ["list_plaid_token_accounts"],
  "PUT /b/[bookId]/sync/tokens/[id]": ["update_plaid_token"],
  "DELETE /b/[bookId]/sync/tokens/[id]": ["delete_plaid_token"],
  "PUT /b/[bookId]/sync/tokens/[id]/accounts": ["set_plaid_token_accounts"],
  "POST /b/[bookId]/sync/tokens/[id]/sync": ["sync_plaid_token"],
  "DELETE /b/[bookId]/sync/tokens/[id]/sync": ["clear_plaid_sync_data"],
  "GET /b/[bookId]/sync/pending-transactions": ["list_pending_plaid_transactions"],
  "GET /b/[bookId]/transactions/[id]/plaid": ["get_transaction_plaid_link"],
  "POST /b/[bookId]/transactions/[id]/plaid/unlink": ["unlink_plaid_transaction"],
  "GET /b/[bookId]/sync/accounts/[id]/reconcile": ["get_reconcile_candidates"],
  "POST /b/[bookId]/sync/accounts/[id]/reconcile": ["reconcile_plaid_transaction"],
};

export const ROUTE_WAIVERS: Record<string, string> = {
  // Permanent — excluded by the 2026-08-23 parity design.
  "POST /auth/login": "Session auth. MCP authenticates with an API key.",
  "POST /auth/logout": "Session auth. MCP authenticates with an API key.",
  "POST /auth/register": "Account creation is not an MCP capability.",
  "GET /auth/me": "Session identity. MCP identity comes from the API key.",
  "PUT /auth/password": "Credential change. Out of scope by decision.",
  "GET /auth/api-keys": "A tool that reads API keys is privilege escalation.",
  "POST /auth/api-keys": "A tool that mints API keys is privilege escalation.",
  "DELETE /auth/api-keys/[id]": "Credential management. Out of scope by decision.",
  "GET /cron/plaid-sync": "CRON_SECRET machine endpoint, not a user capability.",
  "GET /cron/price-sync": "CRON_SECRET machine endpoint, not a user capability.",
  "GET /cron/recurring": "CRON_SECRET machine endpoint, not a user capability.",
  "GET /health": "Infrastructure probe.",
  "POST /b/[bookId]/sync/tokens":
    "Creating a connection requires an access token that only the Plaid Link browser flow can " +
    "produce, so there is no legitimate way for an MCP caller to supply one — a tool that " +
    "accepted a caller-supplied credential here would be a way to write an arbitrary token into " +
    "the database.",
  "GET /b/[bookId]/accounts/[id]": "Covered by list_accounts.",
  "GET /b/[bookId]/transactions/[id]": "Covered by list_transactions.",
  "GET /b/[bookId]/securities/[id]": "Covered by get_security_detail.",
  "GET /b/[bookId]/payees/[id]/last-account": "Folded into get_payee.",
  "GET /b/[bookId]/recurring/[id]": "Covered by list_recurring_rules.",
};

/** Tools with no HTTP counterpart. Not drift. */
export const TOOLS_WITHOUT_ROUTES: string[] = [
  "get_account_balance_history",
  "analyze_usage",
];
