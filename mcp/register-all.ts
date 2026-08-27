import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerBooksTools } from "./tools/books";
import { registerAccountTools } from "./tools/accounts";
import { registerTransactionTools } from "./tools/transactions";
import { registerReportTools } from "./tools/reports";
import { registerInvestmentTools } from "./tools/investments";
import { registerSecurityTools } from "./tools/securities";
import { registerSecurityPriceTools } from "./tools/security-prices";
import { registerUsageTools } from "./tools/usage";
import { registerWriteTransactionTools } from "./tools/write-transactions";
import { registerPayeeTools } from "./tools/payees";
import { registerIssueReportTools } from "./tools/issue-reports";
import { registerRecurringTools } from "./tools/recurring";
import { registerPlaidTools } from "./tools/plaid";
import { registerPlaidReconcileTools } from "./tools/plaid-reconcile";

/**
 * Register every MCP tool this server exposes.
 *
 * Before this function existed, the eight register*Tools calls were
 * hand-listed in three places: mcp/server.ts, tests/mcp/annotations.test.ts,
 * and tests/mcp/route-parity.test.ts. A module added to server.ts but missed
 * in a test file failed loudly in route-parity.test.ts — but silently in
 * annotations.test.ts, whose set-equality check only ever compares the test
 * server's registry against its own table, so a whole file of unannotated
 * tools would pass unnoticed. One list, one place to add a module.
 *
 * Write tools were previously registered separately, inside server.ts's
 * main() after initMcpAuth() resolved. That split predates the change that
 * made every tool — read and write alike — require auth at call time (see
 * mcp/auth.ts's requireAuth/requireBookAuth); an earlier design gated write
 * tool *registration* on having a valid key, per the console messages that
 * design specified ("write tools enabled" / "write tools disabled
 * (read-only mode)"), which the shipped code never actually implements — it
 * registers write tools
 * unconditionally, regardless of the auth result. The split is a leftover of
 * that abandoned design, not a live invariant: registration only populates
 * this server's in-memory tool map, and no client can observe it before
 * server.connect() runs in main(), which happens after every register*Tools
 * call either way. Folding write tools into this same call does not change
 * when they become available.
 */
export function registerAllTools(server: McpServer): void {
  registerBooksTools(server);
  registerAccountTools(server);
  registerTransactionTools(server);
  registerReportTools(server);
  registerInvestmentTools(server);
  registerSecurityTools(server);
  registerSecurityPriceTools(server);
  registerUsageTools(server);
  registerWriteTransactionTools(server);
  registerPayeeTools(server);
  registerIssueReportTools(server);
  registerRecurringTools(server);
  registerPlaidTools(server);
  registerPlaidReconcileTools(server);
}
