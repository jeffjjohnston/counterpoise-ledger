import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { getDb } from "@/db";
import {
  getAccountsWithBalances,
  createAccount,
  updateAccount,
  deleteAccount,
  AccountValidationError,
  AccountNotFoundError,
} from "@/lib/accounts";
import { getDisplayBalance, buildAccountTree } from "@/lib/accounting";
import { requireBookAuth } from "@/mcp/auth";
import { CREATE, DESTRUCTIVE, READ, UPDATE } from "@/mcp/tools/_annotations";
import { fail, ok } from "@/mcp/tools/_result";
import { toolShape } from "@/mcp/tools/_tool-shape";
import { createAccountSchema, updateAccountSchema } from "@/lib/schemas/accounts";
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
      annotations: READ,
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

      return ok(result);
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
      annotations: READ,
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

      return ok(treeByType);
    }
  );

  server.registerTool(
    "create_account",
    {
      title: "Create Account",
      description:
        "Create an account in the chart of accounts. Creating an account with subtype 'investment' " +
        "also creates its paired cash sub-account automatically. Use get_account_tree to find a parentId.",
      inputSchema: {
        bookId: z.number().int().positive().describe("The book ID"),
        ...toolShape(createAccountSchema),
      },
      annotations: CREATE,
    },
    async ({ bookId, ...input }) => {
      const auth = await requireBookAuth(bookId);
      if ("isError" in auth) return auth;
      try {
        return ok(await createAccount(getDb(), bookId, input));
      } catch (error) {
        if (error instanceof AccountValidationError) return fail(error.message);
        throw error;
      }
    }
  );

  server.registerTool(
    "update_account",
    {
      title: "Update Account",
      description:
        "Update an account's fields. All fields are optional — only provided fields are changed. " +
        "Use list_accounts or get_account_tree to find an accountId.",
      inputSchema: {
        bookId: z.number().int().positive().describe("The book ID"),
        accountId: z.number().int().positive().describe("The account ID to update"),
        ...toolShape(updateAccountSchema),
      },
      annotations: UPDATE,
    },
    async ({ bookId, accountId, ...input }) => {
      const auth = await requireBookAuth(bookId);
      if ("isError" in auth) return auth;
      try {
        return ok(await updateAccount(getDb(), bookId, accountId, input));
      } catch (error) {
        if (error instanceof AccountValidationError || error instanceof AccountNotFoundError) {
          return fail(error.message);
        }
        throw error;
      }
    }
  );

  server.registerTool(
    "delete_account",
    {
      title: "Delete Account",
      description:
        "Delete an account. Refuses to delete an account that still has transactions or " +
        "sub-accounts — clear or reassign those first. This cannot be undone. " +
        "Use list_accounts or get_account_tree to find an accountId.",
      inputSchema: {
        bookId: z.number().int().positive().describe("The book ID"),
        accountId: z.number().int().positive().describe("The account ID to delete"),
      },
      annotations: DESTRUCTIVE,
    },
    async ({ bookId, accountId }) => {
      const auth = await requireBookAuth(bookId);
      if ("isError" in auth) return auth;
      try {
        await deleteAccount(getDb(), bookId, accountId);
        return ok({ success: true, accountId });
      } catch (error) {
        if (error instanceof AccountValidationError || error instanceof AccountNotFoundError) {
          return fail(error.message);
        }
        throw error;
      }
    }
  );
}
