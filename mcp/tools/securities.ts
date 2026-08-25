// mcp/tools/securities.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { and, asc, desc, eq, gt, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import {
  accounts,
  investmentLots,
  investmentSplits,
  securities,
  securityPrices,
  transactions,
  transactionSplits,
} from "@/db/schema";
import { effectiveDateSql } from "@/lib/accounting";
import { getPositions } from "@/lib/investments";
import { requireBookAuth } from "@/mcp/auth";
import { CREATE, DESTRUCTIVE, READ, UPDATE } from "@/mcp/tools/_annotations";
import { fail, ok } from "@/mcp/tools/_result";
import { toolShape } from "@/mcp/tools/_tool-shape";
import {
  createSecurity,
  deleteSecurity,
  listSecurities,
  updateSecurity,
  SecurityDuplicateError,
  SecurityNotFoundError,
  SecurityValidationError,
} from "@/lib/securities";
import { createSecuritySchema, updateSecuritySchema } from "@/lib/schemas/securities";

const MICROS = 1_000_000;

export function registerSecurityTools(server: McpServer) {
  // -------------------------------------------------------------------------
  // create_security
  // -------------------------------------------------------------------------
  server.registerTool(
    "create_security",
    {
      title: "Create Security",
      description:
        "Create a new security (ETF, mutual fund, or stock) in a book. Fails with an error if a security with the same symbol (case-insensitive) already exists in the book. " +
        "Set fixedPriceMicros for a security whose price never moves, such as a money market fund at a $1.00 NAV. Doing so forces price fetching off.",
      // Spread rather than restate. The four fields listed here by hand went
      // stale when fixedPriceMicros was added to the shared schema and to
      // createSecurity(), leaving MCP unable to create a fixed-NAV security.
      // write-transactions.ts has always spread its schema and never drifted.
      inputSchema: {
        bookId: z
          .number()
          .int()
          .positive()
          .describe("The book ID to create the security in"),
        ...toolShape(createSecuritySchema),
      },
      annotations: CREATE,
    },
    async ({ bookId, ...input }) => {
      const auth = await requireBookAuth(bookId);
      if ("isError" in auth) return auth;

      try {
        return ok(await createSecurity(getDb(), bookId, input));
      } catch (err) {
        if (
          err instanceof SecurityValidationError ||
          err instanceof SecurityDuplicateError
        ) {
          return fail(err.message);
        }
        throw err;
      }
    }
  );

  // -------------------------------------------------------------------------
  // list_securities
  // -------------------------------------------------------------------------
  server.registerTool(
    "list_securities",
    {
      title: "List Securities",
      description:
        "List every security in a book with its current position: shares held, cost basis from FIFO lots, latest price, market value, and total dividend and capital-gain income received. Book-wide, so holdings in inactive accounts are included.",
      inputSchema: {
        bookId: z.number().int().positive().describe("The book ID to query"),
      },
      annotations: READ,
    },
    async ({ bookId }) => {
      const auth = await requireBookAuth(bookId);
      if ("isError" in auth) return auth;

      return ok(await listSecurities(getDb(), bookId));
    }
  );

  // -------------------------------------------------------------------------
  // update_security
  // -------------------------------------------------------------------------
  server.registerTool(
    "update_security",
    {
      title: "Update Security",
      description:
        "Update a security's name, symbol, type, price-fetching setting, or fixed price. Only the fields you pass are changed. Setting fixedPriceMicros forces price fetching off.",
      inputSchema: {
        bookId: z.number().int().positive().describe("The book ID the security belongs to"),
        securityId: z.number().int().positive().describe("The security ID to update"),
        ...toolShape(updateSecuritySchema),
      },
      annotations: UPDATE,
    },
    async ({ bookId, securityId, ...input }) => {
      const auth = await requireBookAuth(bookId);
      if ("isError" in auth) return auth;

      try {
        return ok(await updateSecurity(getDb(), bookId, securityId, input));
      } catch (err) {
        if (
          err instanceof SecurityNotFoundError ||
          err instanceof SecurityValidationError
        ) {
          return fail(err.message);
        }
        throw err;
      }
    }
  );

  // -------------------------------------------------------------------------
  // delete_security
  // -------------------------------------------------------------------------
  server.registerTool(
    "delete_security",
    {
      title: "Delete Security",
      description:
        "Permanently delete a security from a book. Refuses when the security still has investment transactions, so a delete cannot orphan them. This does not protect price history: deleting a security also deletes every price ever recorded for it, even one with no investment transactions at all.",
      inputSchema: {
        bookId: z.number().int().positive().describe("The book ID the security belongs to"),
        securityId: z.number().int().positive().describe("The security ID to delete"),
      },
      annotations: DESTRUCTIVE,
    },
    async ({ bookId, securityId }) => {
      const auth = await requireBookAuth(bookId);
      if ("isError" in auth) return auth;

      try {
        await deleteSecurity(getDb(), bookId, securityId);
        return ok({ success: true });
      } catch (err) {
        if (
          err instanceof SecurityValidationError ||
          err instanceof SecurityNotFoundError
        ) {
          return fail(err.message);
        }
        throw err;
      }
    }
  );

  // -------------------------------------------------------------------------
  // get_security_detail (moved verbatim from investments.ts)
  // -------------------------------------------------------------------------
  server.registerTool(
    "get_security_detail",
    {
      title: "Get Security Detail",
      description:
        "Get detailed information about a specific security including: basic info, current position, price history, and all related transactions.",
      inputSchema: {
        bookId: z.number().int().positive().describe("The book ID to query"),
        securityId: z
          .number()
          .int()
          .positive()
          .describe("The security ID to look up"),
        priceLimit: z
          .number()
          .int()
          .positive()
          .max(200)
          .optional()
          .default(50)
          .describe("Number of recent prices to return (default 50, max 200)"),
        priceOffset: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .default(0)
          .describe(
            "Number of most-recent prices to skip before taking priceLimit. Use with " +
              "priceLimit to page through price history older than the most recent " +
              "priceLimit rows."
          ),
        includeLots: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Include the open FIFO lots for this security — one row per lot with its account, " +
              "acquisition date, remaining shares, and remaining cost basis. Off by default " +
              "because most questions do not need lot-level detail."
          ),
      },
      annotations: READ,
    },
    async ({ bookId, securityId, priceLimit, priceOffset, includeLots }) => {
      const auth = await requireBookAuth(bookId);
      if ("isError" in auth) return auth;

      const db = getDb();

      // 1. Look up security
      const [security] = await db
        .select()
        .from(securities)
        .where(and(eq(securities.bookId, bookId), eq(securities.id, securityId)));

      if (!security) {
        return fail(`Security with id ${securityId} not found`);
      }

      // 2. Price history
      const recentPriceRows = await db
        .select({
          date: securityPrices.priceDate,
          priceMicros: securityPrices.priceMicros,
        })
        .from(securityPrices)
        .where(eq(securityPrices.securityId, securityId))
        .orderBy(desc(securityPrices.priceDate))
        .limit(priceLimit)
        .offset(priceOffset);
      const recentPrices = recentPriceRows.map((row) => ({
        date: row.date,
        price: row.priceMicros / MICROS,
      }));

      // 3. Investment splits with transaction and account info
      const splitRows = await db
        .select({
          date: effectiveDateSql.as("date"),
          description: transactions.description,
          action: investmentSplits.action,
          sharesMicros: investmentSplits.sharesMicros,
          priceMicros: investmentSplits.priceMicros,
          feesCents: investmentSplits.feesCents,
          splitNumerator: investmentSplits.splitNumerator,
          splitDenominator: investmentSplits.splitDenominator,
          accountName: accounts.name,
          transactionId: investmentSplits.transactionId,
        })
        .from(investmentSplits)
        .innerJoin(
          transactions,
          eq(transactions.id, investmentSplits.transactionId)
        )
        .leftJoin(accounts, eq(accounts.id, investmentSplits.accountId))
        .where(eq(investmentSplits.securityId, securityId))
        .orderBy(desc(effectiveDateSql));

      // Dividend and capital-gain rows carry no shares or price, so the only
      // meaningful number on them is the cash received. It lives on the
      // transaction's own splits, not the investment split.
      const incomeTxIds = splitRows
        .filter((row) => row.action === "dividend" || row.action === "capGain")
        .map((row) => row.transactionId);

      const cashByTransaction = new Map<number, number>();
      if (incomeTxIds.length > 0) {
        // Only the ASSET legs count. A positive amount is a debit, but not
        // every debit on a dividend is cash: a transaction that withholds
        // tax debits an expense account too, and summing that in reports an
        // $85 dividend with $15 withheld as $100 received. The account join
        // is what separates them.
        //
        // securities/[id]/splits/route.ts intends the same rule — its
        // comment says "positive amount for asset accounts" and it joins
        // `accounts` to do it — but it never applies the filter, and then
        // takes the first positive row it finds rather than the sum, which
        // is unordered when there is more than one. That route still has
        // that bug; this is deliberately the corrected behavior, not a
        // reproduction of it.
        const cashSplits = await db
          .select({
            transactionId: transactionSplits.transactionId,
            amount: transactionSplits.amount,
          })
          .from(transactionSplits)
          .innerJoin(accounts, eq(accounts.id, transactionSplits.accountId))
          .where(
            and(
              inArray(transactionSplits.transactionId, incomeTxIds),
              eq(accounts.type, "asset")
            )
          );

        for (const split of cashSplits) {
          if (split.amount <= 0) continue;
          cashByTransaction.set(
            split.transactionId,
            (cashByTransaction.get(split.transactionId) ?? 0) + split.amount
          );
        }
      }

      const txns = splitRows.map((row) => ({
        date: row.date,
        description: row.description,
        action: row.action,
        shares: row.sharesMicros / MICROS,
        price: row.priceMicros / MICROS,
        fees: row.feesCents / 100,
        // Populated only for action === "split"; a stock split is written
        // with sharesMicros: 0, priceMicros: 0, so this is the only place
        // its ratio is recoverable.
        splitNumerator: row.splitNumerator,
        splitDenominator: row.splitDenominator,
        account: row.accountName,
        cashAmount:
          row.action === "dividend" || row.action === "capGain"
            ? (cashByTransaction.get(row.transactionId) ?? 0) / 100
            : null,
      }));

      // 4. Current position
      const allPositions = await getPositions(db, bookId);
      const match = allPositions.find((p) => p.securityId === securityId);

      const position = match
        ? {
            shares: match.sharesMicros / MICROS,
            costBasis: match.costBasisCents / 100,
            marketValue:
              match.marketValueCents !== null
                ? match.marketValueCents / 100
                : null,
            latestPrice:
              match.priceMicros !== null ? match.priceMicros / MICROS : null,
            priceDate: match.priceDate,
          }
        : null;

      // Open lots only — a fully consumed lot has no remaining shares and is
      // reported by get_realized_gains instead.
      const lots = includeLots
        ? (
            await db
              .select({
                lotId: investmentLots.id,
                accountId: investmentLots.accountId,
                accountName: accounts.name,
                acquiredDate: investmentLots.acquiredDate,
                sharesMicros: investmentLots.remainingSharesMicros,
                basisCents: investmentLots.remainingBasisCents,
              })
              .from(investmentLots)
              .innerJoin(accounts, eq(accounts.id, investmentLots.accountId))
              .where(
                and(
                  eq(investmentLots.bookId, bookId),
                  eq(investmentLots.securityId, securityId),
                  gt(investmentLots.remainingSharesMicros, 0)
                )
              )
              .orderBy(asc(investmentLots.acquiredDate), asc(investmentLots.id))
          ).map((lot) => ({
            lotId: lot.lotId,
            accountId: lot.accountId,
            accountName: lot.accountName,
            acquiredDate: lot.acquiredDate,
            shares: lot.sharesMicros / MICROS,
            costBasis: lot.basisCents / 100,
          }))
        : undefined;

      const result = {
        security,
        position,
        recentPrices,
        transactions: txns,
        ...(lots !== undefined && { lots }),
      };

      return ok(result);
    }
  );
}
