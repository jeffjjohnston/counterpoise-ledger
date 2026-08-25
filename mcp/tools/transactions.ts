import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import {
  accounts,
  transactions,
  transactionSplits,
  payees,
  investmentSplits,
  securities,
} from "@/db/schema";
import { searchBook } from "@/lib/search";
import { requireBookAuth } from "@/mcp/auth";
import { READ } from "@/mcp/tools/_annotations";
import { fail } from "@/mcp/tools/_result";
import { selectTransactionPage } from "@/lib/transactions-query";
import { TransactionValidationError } from "@/lib/transactions";

export function registerTransactionTools(server: McpServer) {
  server.registerTool(
    "list_transactions",
    {
      title: "List Transactions",
      description:
        "Query transactions with optional filters. Returns transactions with their splits (debit/credit entries), payee, and investment details. Use accountId for a single account, or accountIds for several at once. Results are ordered by date descending.",
      inputSchema: {
        bookId: z.number().int().positive().describe("The book ID to query"),
        accountId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Filter to transactions involving this account"),
        accountIds: z
          .array(z.number().int().positive())
          .min(1)
          .optional()
          .describe(
            "Filter to transactions involving ANY of these accounts. Takes " +
              "precedence over accountId when both are given."
          ),
        payeeId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Filter by payee"),
        startDate: z
          .iso
          .date()
          .optional()
          .describe("Start date inclusive (YYYY-MM-DD)"),
        endDate: z
          .iso
          .date()
          .optional()
          .describe("End date inclusive (YYYY-MM-DD)"),
        limit: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .default(50)
          .describe("Max results (default 50, max 500)"),
        offset: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .default(0)
          .describe("Pagination offset"),
      },
      annotations: READ,
    },
    async ({ bookId, accountId, accountIds, payeeId, startDate, endDate, limit, offset }) => {
      const auth = await requireBookAuth(bookId);
      if ("isError" in auth) return auth;

      const db = getDb();

      // accountIds wins over accountId, matching the web route's precedence.
      const filterAccountIds =
        accountIds ?? (accountId !== undefined ? [accountId] : null);

      let page;
      try {
        page = await selectTransactionPage(db, bookId, {
          accountIds: filterAccountIds,
          payeeId: payeeId ?? null,
          startDate: startDate ?? null,
          endDate: endDate ?? null,
          limit,
          offset,
        });
      } catch (err) {
        if (err instanceof TransactionValidationError) return fail(err.message);
        throw err;
      }

      const txnIds = page.rows.map((row) => row.id);
      const totalCount = page.totalCount ?? 0;

      // Hydrate the page, then restore the order the page select chose —
      // an IN (...) query does not preserve it.
      const unorderedTxnRows =
        txnIds.length > 0
          ? await db.select().from(transactions).where(inArray(transactions.id, txnIds))
          : [];
      const orderMap = new Map(txnIds.map((id, index) => [id, index]));
      const txnRows = unorderedTxnRows.sort(
        (a, b) => (orderMap.get(a.id) ?? 0) - (orderMap.get(b.id) ?? 0)
      );

      // Batch-load splits for all transactions
      const allSplits = txnIds.length > 0
        ? await db
            .select({
              id: transactionSplits.id,
              transactionId: transactionSplits.transactionId,
              accountId: transactionSplits.accountId,
              accountName: accounts.name,
              accountType: accounts.type,
              amount: transactionSplits.amount,
            })
            .from(transactionSplits)
            .leftJoin(accounts, eq(transactionSplits.accountId, accounts.id))
            .where(inArray(transactionSplits.transactionId, txnIds))
        : [];

      // Batch-load payees
      const payeeIds = [...new Set(txnRows.map((t) => t.payeeId).filter(Boolean))] as number[];
      const payeeMap = new Map<number, { id: number; name: string }>();
      if (payeeIds.length > 0) {
        const payeeRows = await db
          .select({ id: payees.id, name: payees.name })
          .from(payees)
          .where(inArray(payees.id, payeeIds));
        for (const p of payeeRows) {
          payeeMap.set(p.id, p);
        }
      }

      // Batch-load investment splits
      const allInvSplits = txnIds.length > 0
        ? await db
            .select({
              id: investmentSplits.id,
              transactionId: investmentSplits.transactionId,
              accountId: investmentSplits.accountId,
              securityId: investmentSplits.securityId,
              securitySymbol: securities.symbol,
              action: investmentSplits.action,
              sharesMicros: investmentSplits.sharesMicros,
              priceMicros: investmentSplits.priceMicros,
              feesCents: investmentSplits.feesCents,
            })
            .from(investmentSplits)
            .leftJoin(securities, eq(investmentSplits.securityId, securities.id))
            .where(inArray(investmentSplits.transactionId, txnIds))
        : [];

      // Group by transaction ID
      const splitsByTxn = new Map<number, typeof allSplits>();
      for (const s of allSplits) {
        const arr = splitsByTxn.get(s.transactionId);
        if (arr) arr.push(s);
        else splitsByTxn.set(s.transactionId, [s]);
      }
      const invSplitsByTxn = new Map<number, typeof allInvSplits>();
      for (const s of allInvSplits) {
        const arr = invSplitsByTxn.get(s.transactionId);
        if (arr) arr.push(s);
        else invSplitsByTxn.set(s.transactionId, [s]);
      }

      const enriched = txnRows.map((txn) => {
        const splits = (splitsByTxn.get(txn.id) ?? []).map((split) => {
          const { transactionId, ...splitWithoutTxnId } = split;
          void transactionId;
          return splitWithoutTxnId;
        });
        const invSplits = (invSplitsByTxn.get(txn.id) ?? []).map((invSplit) => {
          const { transactionId, ...invSplitWithoutTxnId } = invSplit;
          void transactionId;
          return invSplitWithoutTxnId;
        });

        return {
          id: txn.id,
          date: txn.date,
          description: txn.description,
          notes: txn.notes,
          checkNumber: txn.checkNumber,
          isReconciled: txn.isReconciled,
          payee: txn.payeeId ? payeeMap.get(txn.payeeId) ?? null : null,
          splits,
          investmentSplits: invSplits.length > 0 ? invSplits : undefined,
        };
      });

      const result = { transactions: enriched, totalCount, limit, offset };

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
    "search",
    {
      title: "Search",
      description:
        "Search across transactions (description, notes, payee, amount), accounts (name), and payees (name). Returns up to 25 results per entity type. Use this for free-text discovery.",
      inputSchema: {
        bookId: z.number().int().positive().describe("The book ID to query"),
        query: z.string().min(1).describe("Search query"),
        startDate: z
          .iso
          .date()
          .optional()
          .describe("Limit transaction search start date (YYYY-MM-DD)"),
        endDate: z
          .iso
          .date()
          .optional()
          .describe("Limit transaction search end date (YYYY-MM-DD)"),
      },
      annotations: READ,
    },
    async ({ bookId, query, startDate, endDate }) => {
      const auth = await requireBookAuth(bookId);
      if ("isError" in auth) return auth;

      const results = await searchBook(getDb(), bookId, query, { startDate, endDate });

      // Project onto this tool's established contract, then add. Existing
      // clients read `payeeName` on a transaction and `isActive` on an account;
      // returning the shared rows verbatim would have dropped both. The
      // capability gain — check numbers, splits, recurring rules — is purely
      // additive on top of what was already here.
      const result = {
        accounts: results.accounts.map((a) => ({
          id: a.id,
          name: a.name,
          type: a.type,
          subtype: a.subtype,
          isActive: a.isActive,
          isFavorite: a.isFavorite,
        })),
        payees: results.payees,
        transactions: results.transactions.map((t) => ({
          id: t.id,
          date: t.date,
          description: t.description,
          notes: t.notes,
          payeeName: t.payee?.name ?? null,
          checkNumber: t.checkNumber,
          splits: t.splits,
        })),
        recurringRules: results.recurringRules,
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
