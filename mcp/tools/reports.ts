import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { eq, and, gte, lte, lt, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { accounts, transactions, transactionSplits } from "@/db/schema";
import { getDisplayBalance, effectiveDateSql } from "@/lib/accounting";
import { getIncomeStatement, getReportSplits } from "@/lib/reports-queries";
import { requireBookAuth } from "@/mcp/auth";

export function registerReportTools(server: McpServer) {
  // ── Tool 1: get_income_statement ─────────────────────────────────────
  server.registerTool(
    "get_income_statement",
    {
      title: "Get Income Statement",
      description:
        "Get an income statement (profit & loss) for a date range. Returns all income and expense accounts with their balances, plus totals. Balances are shown as positive numbers (income earned, expenses spent).",
      inputSchema: {
        bookId: z.number().int().positive().describe("The book ID to query"),
        startDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .describe("Start date inclusive (YYYY-MM-DD)"),
        endDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .describe("End date inclusive (YYYY-MM-DD)"),
        includeInactive: z
          .boolean()
          .optional()
          .default(false)
          .describe("Include inactive accounts (default false)"),
      },
    },
    async ({ bookId, startDate, endDate, includeInactive }) => {
      const auth = await requireBookAuth(bookId);
      if ("isError" in auth) return auth;

      const rows = await getIncomeStatement(getDb(), bookId, {
        startDate,
        endDate,
        includeInactive,
      });

      const income: Array<{ id: number; name: string; balanceCents: number }> = [];
      const expenses: Array<{ id: number; name: string; balanceCents: number }> = [];
      let totalIncomeCents = 0;
      let totalExpensesCents = 0;

      for (const row of rows) {
        const displayBalance = getDisplayBalance(row.balanceCents, row.type);
        if (displayBalance === 0) continue;

        const entry = { id: row.accountId, name: row.name, balanceCents: displayBalance };
        if (row.type === "income") {
          income.push(entry);
          totalIncomeCents += displayBalance;
        } else {
          expenses.push(entry);
          totalExpensesCents += displayBalance;
        }
      }

      const netIncomeCents = totalIncomeCents - totalExpensesCents;

      const result = {
        startDate,
        endDate,
        income,
        expenses,
        totals: {
          incomeCents: totalIncomeCents,
          expensesCents: totalExpensesCents,
          netIncomeCents,
        },
      };

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

  // ── Tool 2: get_report_data ──────────────────────────────────────────
  server.registerTool(
    "get_report_data",
    {
      title: "Get Report Data",
      description:
        "Get raw transaction split data for custom analysis. Returns every split with its account info, transaction date, and payee. Useful for building custom reports, grouping by category/payee/month, etc.",
      inputSchema: {
        bookId: z.number().int().positive().describe("The book ID to query"),
        startDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .describe("Start date inclusive (YYYY-MM-DD)"),
        endDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .describe("End date inclusive (YYYY-MM-DD)"),
        accountTypes: z
          .array(z.enum(["asset", "liability", "equity", "income", "expense"]))
          .optional()
          .describe("Filter by account types"),
        accountIds: z
          .array(z.number().int().positive())
          .optional()
          .describe("Filter by specific account IDs"),
        limit: z
          .number()
          .int()
          .positive()
          .max(5000)
          .optional()
          .default(2000)
          .describe("Max rows to return (default 2000, max 5000)"),
      },
    },
    async ({ bookId, startDate, endDate, accountTypes, accountIds, limit }) => {
      const auth = await requireBookAuth(bookId);
      if ("isError" in auth) return auth;

      const { splits, totalCount } = await getReportSplits(getDb(), bookId, {
        startDate,
        endDate,
        accountIds,
        accountTypes,
        limit,
      });

      const rows = splits.map((s) => ({
        date: s.date,
        description: s.description,
        payeeName: s.payeeName,
        accountId: s.accountId,
        accountName: s.accountName,
        accountType: s.accountType,
        amountCents: s.amount,
      }));

      const result = {
        rowCount: rows.length,
        totalCount,
        truncated: totalCount > limit,
        data: rows,
      };

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

  // ── Tool 3: get_account_balance_history ──────────────────────────────
  server.registerTool(
    "get_account_balance_history",
    {
      title: "Get Account Balance History",
      description:
        "Get the running balance for an account over time, showing each transaction's impact. Useful for tracking balance progression, finding when balances changed, or plotting account trends.",
      inputSchema: {
        bookId: z.number().int().positive().describe("The book ID to query"),
        accountId: z
          .number()
          .int()
          .positive()
          .describe("The account ID to get history for"),
        startDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("Start date inclusive (YYYY-MM-DD)"),
        endDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("End date inclusive (YYYY-MM-DD)"),
        limit: z
          .number()
          .int()
          .positive()
          .max(1000)
          .optional()
          .default(200)
          .describe("Max entries to return (default 200, max 1000)"),
      },
    },
    async ({ bookId, accountId, startDate, endDate, limit }) => {
      const auth = await requireBookAuth(bookId);
      if ("isError" in auth) return auth;

      const db = getDb();

      // Look up the account
      const [account] = await db
        .select({
          id: accounts.id,
          name: accounts.name,
          type: accounts.type,
        })
        .from(accounts)
        .where(and(eq(accounts.bookId, bookId), eq(accounts.id, accountId)));

      if (!account) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: `Account ${accountId} not found` }),
            },
          ],
          isError: true,
        };
      }

      // Compute starting balance if startDate is provided
      let startingBalanceCents = 0;
      if (startDate) {
        const [row] = await db
          .select({
            total: sql<number>`CAST(COALESCE(SUM(${transactionSplits.amount}), 0) AS INTEGER)`,
          })
          .from(transactionSplits)
          .innerJoin(transactions, eq(transactionSplits.transactionId, transactions.id))
          .where(
            and(
              eq(transactionSplits.accountId, accountId),
              lt(effectiveDateSql, startDate)
            )
          );
        startingBalanceCents = row.total;
      }

      // Query splits in date range
      const conditions = [eq(transactionSplits.accountId, accountId)];
      if (startDate) {
        conditions.push(gte(effectiveDateSql, startDate));
      }
      if (endDate) {
        conditions.push(lte(effectiveDateSql, endDate));
      }

      const rows = await db
        .select({
          date: effectiveDateSql.as("date"),
          description: transactions.description,
          amount: transactionSplits.amount,
          transactionId: transactionSplits.transactionId,
        })
        .from(transactionSplits)
        .innerJoin(transactions, eq(transactionSplits.transactionId, transactions.id))
        .where(and(...conditions))
        .orderBy(effectiveDateSql, transactionSplits.id)
        .limit(limit);

      // Build running balance
      let runningBalance = startingBalanceCents;
      const entries = rows.map((row) => {
        runningBalance += row.amount;
        return {
          date: row.date,
          description: row.description,
          changeCents: row.amount,
          balanceCents: runningBalance,
          displayBalance: getDisplayBalance(runningBalance, account.type),
          transactionId: row.transactionId,
        };
      });

      const result = {
        account: { id: account.id, name: account.name, type: account.type },
        startingBalanceCents,
        entries,
      };

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
}
