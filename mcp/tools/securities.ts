// mcp/tools/securities.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import {
  accounts,
  investmentSplits,
  securities,
  securityPrices,
  transactions,
} from "@/db/schema";
import { effectiveDateSql } from "@/lib/accounting";
import { getPositions } from "@/lib/investments";
import { requireBookAuth } from "@/mcp/auth";
import { CREATE, READ } from "@/mcp/tools/_annotations";
import { fail, ok } from "@/mcp/tools/_result";
import { toolShape } from "@/mcp/tools/_tool-shape";
import {
  createSecurity,
  SecurityDuplicateError,
  SecurityValidationError,
} from "@/lib/securities";
import { createSecuritySchema } from "@/lib/schemas/securities";

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
      },
      annotations: READ,
    },
    async ({ bookId, securityId, priceLimit }) => {
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
        .limit(priceLimit);
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
          accountName: accounts.name,
        })
        .from(investmentSplits)
        .innerJoin(
          transactions,
          eq(transactions.id, investmentSplits.transactionId)
        )
        .leftJoin(accounts, eq(accounts.id, investmentSplits.accountId))
        .where(eq(investmentSplits.securityId, securityId))
        .orderBy(desc(effectiveDateSql));

      const txns = splitRows.map((row) => ({
        date: row.date,
        description: row.description,
        action: row.action,
        shares: row.sharesMicros / MICROS,
        price: row.priceMicros / MICROS,
        fees: row.feesCents / 100,
        account: row.accountName,
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

      const result = {
        security,
        position,
        recentPrices,
        transactions: txns,
      };

      return ok(result);
    }
  );
}
