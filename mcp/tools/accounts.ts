import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { getDb } from "@/db";
import { getAccountsWithBalances } from "@/lib/accounts";
import { getDisplayBalance, buildAccountTree } from "@/lib/accounting";
import { requireBookAuth } from "@/mcp/auth";
import type { AccountWithBalance } from "@/types";

function formatCurrencyString(cents: number): string {
  // Use a Unicode minus (U+2212) to match formatCurrency and the rest of the UI.
  const sign = cents < 0 ? "−" : "";
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

export function registerAccountTools(server: McpServer) {
  server.registerTool(
    "list_accounts",
    {
      title: "List Accounts",
      description:
        "List all accounts in a book with their balances. Optionally filter by account type, active status, or compute balances as of a specific date.",
      inputSchema: {
        bookId: z.number().int().positive().describe("The book ID to query"),
        type: z
          .enum(["asset", "liability", "equity", "income", "expense"])
          .optional()
          .describe("Filter by account type"),
        includeInactive: z
          .boolean()
          .optional()
          .default(false)
          .describe("Include inactive accounts (default false)"),
        asOfDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("Compute balances as of this date (YYYY-MM-DD)"),
      },
    },
    async ({ bookId, type, includeInactive, asOfDate }) => {
      const auth = await requireBookAuth(bookId);
      if ("isError" in auth) return auth;

      const rows = await getAccountsWithBalances(getDb(), bookId, {
        type,
        includeInactive,
        asOfDate,
      });

      const result = rows.map((row) => {
        const displayBalance = getDisplayBalance(row.balanceCents, row.type);
        return {
          id: row.id,
          name: row.name,
          type: row.type,
          subtype: row.subtype,
          parentId: row.parentId,
          isActive: row.isActive,
          isFavorite: row.isFavorite,
          isInvestmentCash: row.isInvestmentCash,
          balanceCents: row.balanceCents,
          displayBalance,
          formattedBalance: formatCurrencyString(displayBalance),
        };
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  server.registerTool(
    "get_account_tree",
    {
      title: "Get Account Tree",
      description:
        "Get a hierarchical tree of all active accounts grouped by type (asset, liability, equity, income, expense), with computed balances.",
      inputSchema: {
        bookId: z.number().int().positive().describe("The book ID to query"),
      },
    },
    async ({ bookId }) => {
      const auth = await requireBookAuth(bookId);
      if ("isError" in auth) return auth;

      // Defaults to active-only, which is what this tool has always returned.
      const rows = await getAccountsWithBalances(getDb(), bookId);

      const accountsWithBalance: AccountWithBalance[] = rows.map((row) => ({
        ...row,
        balance: row.balanceCents,
        children: [],
      }));

      // Group by type
      const grouped: Record<string, AccountWithBalance[]> = {};
      for (const acct of accountsWithBalance) {
        if (!grouped[acct.type]) {
          grouped[acct.type] = [];
        }
        grouped[acct.type].push(acct);
      }

      // Build tree per type
      const treeByType: Record<string, AccountWithBalance[]> = {};
      for (const [acctType, accts] of Object.entries(grouped)) {
        treeByType[acctType] = buildAccountTree(accts);
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(treeByType, null, 2),
          },
        ],
      };
    }
  );
}
