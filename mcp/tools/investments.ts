import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { getDb } from "@/db";
import { getPositions, getMarketValuesByAccount } from "@/lib/investments";
import { getRealizedGains } from "@/lib/realized-gains";
import { requireBookAuth } from "@/mcp/auth";
import { READ } from "@/mcp/tools/_annotations";

const MICROS = 1_000_000;

export function registerInvestmentTools(server: McpServer) {
  server.registerTool(
    "get_investment_positions",
    {
      title: "Get Investment Positions",
      description:
        "Get current investment positions across all accounts or for a specific account. Returns each security held with: shares, cost basis, current price, market value, and gain/loss. Optionally get per-account market value totals.",
      inputSchema: {
        bookId: z.number().int().positive().describe("The book ID to query"),
        accountId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Filter to specific investment account"),
        includeAccountValues: z
          .boolean()
          .optional()
          .default(false)
          .describe("Also include total market value per account"),
      },
      annotations: READ,
    },
    async ({ bookId, accountId, includeAccountValues }) => {
      const auth = await requireBookAuth(bookId);
      if ("isError" in auth) return auth;

      const db = getDb();

      const rawPositions = await getPositions(db, bookId, accountId);

      const positions = rawPositions.map((p) => {
        const costBasis = p.costBasisCents / 100;
        const marketValue =
          p.marketValueCents !== null ? p.marketValueCents / 100 : null;
        const gainLoss =
          p.marketValueCents !== null
            ? (p.marketValueCents - p.costBasisCents) / 100
            : null;
        const gainLossPercent =
          gainLoss !== null && costBasis !== 0
            ? `${((gainLoss / costBasis) * 100).toFixed(2)}%`
            : "N/A";

        return {
          securityId: p.securityId,
          securityName: p.securityName,
          securitySymbol: p.securitySymbol,
          shares: p.sharesMicros / MICROS,
          costBasis,
          currentPrice:
            p.priceMicros !== null ? p.priceMicros / MICROS : null,
          priceDate: p.priceDate,
          marketValue,
          gainLoss,
          gainLossPercent,
        };
      });

      const result: {
        positions: typeof positions;
        accountValues?: { accountId: number; marketValue: number }[];
      } = { positions };

      if (includeAccountValues) {
        const raw = await getMarketValuesByAccount(db, bookId);
        const filtered = accountId
          ? raw.filter((av) => av.accountId === accountId)
          : raw;
        result.accountValues = filtered.map((av) => ({
          accountId: av.accountId,
          marketValue: av.marketValueCents / 100,
        }));
      }

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
    "get_realized_gains",
    {
      title: "Get Realized Gains",
      description:
        "Get realized capital gains and losses from investment sales for a date range — the answer to tax-time questions like 'what were my realized capital gains last year'. Returns one row per lot disposed of: a single sell that draws shares from three different purchase lots yields three rows (matching how a 1099-B reports each lot as a separate line), plus totals split into short-term and long-term gain, along with total proceeds and cost basis. A row with term 'unknown' means the sold shares couldn't be matched to a purchase lot — real proceeds but no basis or gain, excluded from the short/long totals and counted in unknownBasisDisposals so a data gap can't silently understate a reported gain.",
      inputSchema: {
        bookId: z.number().int().positive().describe("The book ID to query"),
        startDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("Start of the range, YYYY-MM-DD"),
        endDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("End of the range, YYYY-MM-DD"),
        accountId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Filter to a specific investment account"),
      },
      annotations: READ,
    },
    async ({ bookId, startDate, endDate, accountId }) => {
      const auth = await requireBookAuth(bookId);
      if ("isError" in auth) return auth;

      const result = await getRealizedGains(getDb(), bookId, { startDate, endDate, accountId });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                disposals: result.rows.map((row) => ({
                  sellDate: row.sellDate,
                  security: row.securitySymbol,
                  account: row.accountName,
                  shares: row.sharesMicros / MICROS,
                  acquired: row.acquiredDate,
                  proceeds: row.proceedsCents / 100,
                  costBasis: row.basisCents === null ? null : row.basisCents / 100,
                  gainLoss: row.gainCents === null ? null : row.gainCents / 100,
                  term: row.term,
                })),
                totals: {
                  shortTermGain: result.totals.shortTermGainCents / 100,
                  longTermGain: result.totals.longTermGainCents / 100,
                  proceeds: result.totals.proceedsCents / 100,
                  costBasis: result.totals.basisCents / 100,
                  unknownBasisDisposals: result.totals.unknownBasisRows,
                },
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
