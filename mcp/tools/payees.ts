import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { getDb } from "@/db";
import {
  createPayee,
  deletePayee,
  getPayeeDetail,
  listPayees,
  PayeeNotFoundError,
  PayeeValidationError,
} from "@/lib/payees";
import { createPayeeSchema } from "@/lib/schemas/payees";
import { requireBookAuth } from "@/mcp/auth";
import { CREATE, DESTRUCTIVE, READ } from "@/mcp/tools/_annotations";
import { fail, ok } from "@/mcp/tools/_result";
import { toolShape } from "@/mcp/tools/_tool-shape";

export function registerPayeeTools(server: McpServer) {
  server.registerTool(
    "list_payees",
    {
      title: "List Payees",
      description:
        "List payees in the book. Each row carries its transaction count and the date " +
        "of its most recent transaction (null when unused). Sorted by name. A book imported " +
        "from another app can hold thousands of payees, so pass search or limit rather than " +
        "listing them all when you are looking for a particular one.",
      // Plain zod types, not lib/schemas/payees.ts's listPayeesQuery: that
      // schema is shaped for URL params, where everything arrives as a string
      // and a malformed limit coerces away to "no limit". An MCP client sends
      // JSON and should be told the real types.
      inputSchema: {
        bookId: z.number().int().positive().describe("The book ID to query"),
        search: z
          .string()
          .optional()
          .describe(
            "Case-insensitive substring match on the payee name. Omit to list every payee."
          ),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum payees to return, applied after sorting by name. Omit for all."),
      },
      annotations: READ,
    },
    async ({ bookId, search, limit }) => {
      const auth = await requireBookAuth(bookId);
      if ("isError" in auth) return auth;

      return ok(await listPayees(getDb(), bookId, { search, limit }));
    }
  );

  server.registerTool(
    "get_payee",
    {
      title: "Get Payee",
      description:
        "Get one payee by ID, with its transaction count and lastAccountId — the account on " +
        "the largest debit split of its most recent transaction (null when the payee has no " +
        "transactions). Use list_payees to find a payeeId.",
      inputSchema: {
        bookId: z.number().int().positive().describe("The book ID"),
        payeeId: z.number().int().positive().describe("The payee ID to fetch"),
      },
      annotations: READ,
    },
    async ({ bookId, payeeId }) => {
      const auth = await requireBookAuth(bookId);
      if ("isError" in auth) return auth;

      // getPayeeDetail folds in GET /payees/[id]/last-account, which is why
      // tests/mcp/route-coverage.ts waives that route permanently.
      const payee = await getPayeeDetail(getDb(), bookId, payeeId);
      if (!payee) {
        return fail(`Payee with id ${payeeId} not found`);
      }

      return ok(payee);
    }
  );

  server.registerTool(
    "create_payee",
    {
      title: "Create Payee",
      description:
        "Create a payee in the book. Does not fold case, so 'IKEA' and 'Ikea' are both " +
        "created as distinct payees, and it does not search for a similar existing payee — " +
        "use list_payees first to check for one. An EXACT repeat of an existing name in this " +
        "book fails rather than inserting a second row, since the book allows only one payee " +
        "per exact name.",
      inputSchema: {
        bookId: z.number().int().positive().describe("The book ID"),
        ...toolShape(createPayeeSchema),
      },
      annotations: CREATE,
    },
    async ({ bookId, ...input }) => {
      const auth = await requireBookAuth(bookId);
      if ("isError" in auth) return auth;
      try {
        return ok(await createPayee(getDb(), bookId, input));
      } catch (error) {
        if (error instanceof PayeeValidationError) return fail(error.message);
        throw error;
      }
    }
  );

  server.registerTool(
    "delete_payee",
    {
      title: "Delete Payee",
      description:
        "Delete a payee. Refuses when the payee still has transactions — reassign or delete " +
        "those first. This cannot be undone. Use list_payees to find a payeeId.",
      inputSchema: {
        bookId: z.number().int().positive().describe("The book ID"),
        payeeId: z.number().int().positive().describe("The payee ID to delete"),
      },
      annotations: DESTRUCTIVE,
    },
    async ({ bookId, payeeId }) => {
      const auth = await requireBookAuth(bookId);
      if ("isError" in auth) return auth;
      try {
        await deletePayee(getDb(), bookId, payeeId);
        return ok({ success: true, payeeId });
      } catch (error) {
        if (error instanceof PayeeValidationError || error instanceof PayeeNotFoundError) {
          return fail(error.message);
        }
        throw error;
      }
    }
  );
}
