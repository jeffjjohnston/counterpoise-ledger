// mcp/tools/security-prices.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { getDb } from "@/db";
import { requireBookAuth } from "@/mcp/auth";
import { READ, READ_NETWORK, UPDATE, DESTRUCTIVE } from "@/mcp/tools/_annotations";
import { fail, ok } from "@/mcp/tools/_result";
import { toolShape } from "@/mcp/tools/_tool-shape";
import {
  setSecurityPrices,
  updateSecurityPrice,
  deleteSecurityPrice,
  listPricesDue,
  PriceEntryNotFoundError,
  PriceEntryConflictError,
} from "@/lib/security-prices";
import { updateSecurityPriceSchema, tiingoFetchSchema } from "@/lib/schemas/security-prices";
import { SecurityValidationError, SecurityNotFoundError } from "@/lib/securities";
import { fetchLatestTiingoPrices, isTiingoConfigured } from "@/lib/tiingo";

export function registerSecurityPriceTools(server: McpServer) {
  // -------------------------------------------------------------------------
  // set_security_prices
  // -------------------------------------------------------------------------
  //
  // The one tool in this plan that does NOT spread its shared schema.
  // bulkPricesSchema drops malformed items inside a .transform(), so a
  // spreading tool receives only the survivors and cannot report what it
  // lost. The published JSON Schema is identical either way — a transform
  // is not expressible in JSON Schema — so this costs nothing at the wire
  // and buys the caller a list of what was rejected.
  server.registerTool(
    "set_security_prices",
    {
      title: "Set Security Prices",
      description:
        "Record manual prices for securities in a book. Each entry overwrites any existing price for the same security and date. Entries that are malformed are skipped and reported back in `discarded`; the whole batch is rejected only if no entry is usable, or if any security belongs to a different book.",
      inputSchema: {
        bookId: z.number().int().positive().describe("The book ID the securities belong to"),
        priceUpdates: z
          .array(z.unknown())
          .describe(
            "Prices to record. Each entry is an object with securityId (positive integer), " +
              "priceMicros (positive number, 1,000,000 = $1.00), and priceDate (YYYY-MM-DD)."
          ),
      },
      annotations: UPDATE,
    },
    async ({ bookId, priceUpdates }) => {
      const auth = await requireBookAuth(bookId);
      if ("isError" in auth) return auth;

      try {
        return ok(await setSecurityPrices(getDb(), bookId, priceUpdates));
      } catch (err) {
        if (err instanceof SecurityValidationError) return fail(err.message);
        throw err;
      }
    }
  );

  // -------------------------------------------------------------------------
  // update_security_price
  // -------------------------------------------------------------------------
  server.registerTool(
    "update_security_price",
    {
      title: "Update Security Price",
      description:
        "Change a recorded price for one security on one date. Pass a different priceDate to move the entry to another date.",
      inputSchema: {
        bookId: z.number().int().positive().describe("The book ID the security belongs to"),
        securityId: z.number().int().positive().describe("The security whose price is being changed"),
        currentDate: z
          .iso
          .date()
          .describe("The date of the existing price entry to change (YYYY-MM-DD)"),
        ...toolShape(updateSecurityPriceSchema),
      },
      annotations: UPDATE,
    },
    async ({ bookId, securityId, currentDate, ...input }) => {
      const auth = await requireBookAuth(bookId);
      if ("isError" in auth) return auth;

      try {
        await updateSecurityPrice(getDb(), bookId, securityId, currentDate, input);
        return ok({ success: true });
      } catch (err) {
        if (
          err instanceof SecurityNotFoundError ||
          err instanceof PriceEntryNotFoundError ||
          err instanceof PriceEntryConflictError
        ) {
          return fail(err.message);
        }
        throw err;
      }
    }
  );

  // -------------------------------------------------------------------------
  // delete_security_price
  // -------------------------------------------------------------------------
  server.registerTool(
    "delete_security_price",
    {
      title: "Delete Security Price",
      description:
        "Delete one recorded price for a security on a specific date. The security and its other prices are left alone.",
      inputSchema: {
        bookId: z.number().int().positive().describe("The book ID the security belongs to"),
        securityId: z.number().int().positive().describe("The security whose price is being deleted"),
        priceDate: z
          .iso
          .date()
          .describe("The date of the price entry to delete (YYYY-MM-DD)"),
      },
      annotations: DESTRUCTIVE,
    },
    async ({ bookId, securityId, priceDate }) => {
      const auth = await requireBookAuth(bookId);
      if ("isError" in auth) return auth;

      try {
        await deleteSecurityPrice(getDb(), bookId, securityId, priceDate);
        return ok({ success: true });
      } catch (err) {
        if (
          err instanceof SecurityNotFoundError ||
          err instanceof PriceEntryNotFoundError
        ) {
          return fail(err.message);
        }
        throw err;
      }
    }
  );

  // -------------------------------------------------------------------------
  // list_prices_due
  // -------------------------------------------------------------------------
  server.registerTool(
    "list_prices_due",
    {
      title: "List Prices Due",
      description:
        "List securities in a book that need a manual price entry: those with automatic fetching off, no fixed price, an open position, and no price recorded for the most recent market day. Returns that due date alongside the securities.",
      inputSchema: {
        bookId: z.number().int().positive().describe("The book ID to query"),
      },
      annotations: READ,
    },
    async ({ bookId }) => {
      const auth = await requireBookAuth(bookId);
      if ("isError" in auth) return auth;

      return ok(await listPricesDue(getDb(), bookId));
    }
  );

  // -------------------------------------------------------------------------
  // fetch_tiingo_prices
  // -------------------------------------------------------------------------
  server.registerTool(
    "fetch_tiingo_prices",
    {
      title: "Fetch Tiingo Prices",
      description:
        "Fetch the latest end-of-day price for one or more ticker symbols from Tiingo. This reads an external service and records nothing — pass the results to set_security_prices to save them. Requires TIINGO_API_KEY to be configured on the server.",
      inputSchema: {
        bookId: z.number().int().positive().describe("The book ID making the request"),
        ...toolShape(tiingoFetchSchema),
      },
      annotations: READ_NETWORK,
    },
    async ({ bookId, symbols }) => {
      const auth = await requireBookAuth(bookId);
      if ("isError" in auth) return auth;

      if (!isTiingoConfigured()) {
        return fail("TIINGO_API_KEY environment variable not configured");
      }

      return ok(await fetchLatestTiingoPrices(symbols));
    }
  );
}
