/**
 * Route-to-tool coverage. Data only, no logic — route-parity.test.ts enforces
 * it.
 *
 * Every exported HTTP method under app/api must appear in exactly one of
 * ROUTE_TOOLS or ROUTE_WAIVERS. That is the whole point: before this file,
 * "no tool for this route" and "deliberately no tool for this route" looked
 * identical, and five domains fell out of MCP coverage unnoticed.
 *
 * A `pending-plan-N` waiver is a promise, not a decision. The last plan in the
 * series removes the mechanism.
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
  "POST /b/[bookId]/securities": ["create_security"],
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
    "Exchanges a public_token that only the Plaid Link browser flow produces.",
  "GET /b/[bookId]/accounts/[id]": "Covered by list_accounts.",
  "GET /b/[bookId]/transactions/[id]": "Covered by list_transactions.",
  "GET /b/[bookId]/securities/[id]": "Covered by get_security_detail.",
  "GET /b/[bookId]/payees/[id]/last-account": "Folded into get_payee.",
  "GET /b/[bookId]/recurring/[id]": "Covered by list_recurring_rules.",

  // Pending. Each plan deletes its own entries as it lands.
  "GET /b/[bookId]/securities/[id]/lots": "pending-plan-4 — folds into get_security_detail",
  "GET /b/[bookId]/securities/[id]/splits": "pending-plan-4 — folds into get_security_detail",
  "GET /b/[bookId]/securities/[id]/prices": "pending-plan-4 — folds into get_security_detail",
  "GET /b/[bookId]/sync/tokens": "pending-plan-6 — folds into get_plaid_status",
  "GET /b/[bookId]/sync/pending-count": "pending-plan-6 — folds into get_plaid_status",
  "GET /b/[bookId]/sync/stale-unmatched": "pending-plan-6 — folds into get_plaid_status",
  "GET /b/[bookId]/sync/assigned-accounts": "pending-plan-6 — folds into get_plaid_status",
  "GET /b/[bookId]/sync/tokens/[id]/accounts": "pending-plan-6 — folds into get_plaid_status",
  "GET /b/[bookId]/securities": "pending-plan-4",
  "PUT /b/[bookId]/securities/[id]": "pending-plan-4",
  "DELETE /b/[bookId]/securities/[id]": "pending-plan-4",
  "PUT /b/[bookId]/securities/[id]/prices/[date]": "pending-plan-4",
  "DELETE /b/[bookId]/securities/[id]/prices/[date]": "pending-plan-4",
  "GET /b/[bookId]/securities/prices-due": "pending-plan-4",
  "POST /b/[bookId]/security-prices/bulk": "pending-plan-4",
  "POST /b/[bookId]/security-prices/tiingo": "pending-plan-4",
  "GET /b/[bookId]/sync/pending-transactions": "pending-plan-6",
  "GET /b/[bookId]/sync/accounts/[id]/reconcile": "pending-plan-6",
  "POST /b/[bookId]/sync/accounts/[id]/reconcile": "pending-plan-6",
  "PUT /b/[bookId]/sync/tokens/[id]": "pending-plan-6",
  "DELETE /b/[bookId]/sync/tokens/[id]": "pending-plan-6",
  "PUT /b/[bookId]/sync/tokens/[id]/accounts": "pending-plan-6",
  "POST /b/[bookId]/sync/tokens/[id]/sync": "pending-plan-6",
  "DELETE /b/[bookId]/sync/tokens/[id]/sync": "pending-plan-6",
  "GET /b/[bookId]/transactions/[id]/plaid": "pending-plan-6",
  "POST /b/[bookId]/transactions/[id]/plaid/unlink": "pending-plan-6",
};

/** Tools with no HTTP counterpart. Not drift. */
export const TOOLS_WITHOUT_ROUTES: string[] = [
  "get_account_balance_history",
  "analyze_usage",
];
