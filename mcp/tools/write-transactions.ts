import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { getDb } from "@/db";
import { requireBookAuth } from "@/mcp/auth";
import { CREATE, DESTRUCTIVE } from "@/mcp/tools/_annotations";
import { fail, ok } from "@/mcp/tools/_result";
import { toolShape } from "@/mcp/tools/_tool-shape";
import {
  createTransaction,
  deleteTransaction,
  updateTransaction,
  TransactionValidationError,
  TransactionNotFoundError,
} from "@/lib/transactions";
// The payload shape lives in lib/schemas/transactions.ts so the HTTP routes
// and these tools validate the same thing. `bookId` is the one field the two
// surfaces differ on — it comes from the URL over HTTP, so the shared schema
// omits it and the tools add it back here.
//
// isReconciled was withheld from these tools until 2026-08-23, when the MCP
// surface was brought to parity with the web UI. That same change explains
// the destructiveHint on update_transaction and delete_transaction: it tells
// a client to confirm before an update or delete lands. create_transaction
// carries CREATE, not DESTRUCTIVE, so that hint does not apply to it.
import {
  createTransactionBodySchema,
  updateTransactionBodySchema,
} from "@/lib/schemas/transactions";

export function registerWriteTransactionTools(server: McpServer) {
  server.registerTool(
    "create_transaction",
    {
      title: "Create Transaction",
      description:
        "Create a new transaction with double-entry splits. Requires a valid API key (COUNTERPOISE_API_KEY env var). " +
        "Each split has an accountId and amount in cents. Positive amounts are debits, negative are credits. " +
        "All splits MUST sum to zero. Optionally include investmentSplits for investment transactions. " +
        "Use list_accounts to find account IDs first.",
      inputSchema: {
        bookId: z.number().int().positive().describe("The book ID"),
        ...toolShape(createTransactionBodySchema),
      },
      annotations: CREATE,
    },
    async (args) => {
      const { bookId, ...input } = args;
      const auth = await requireBookAuth(bookId);
      if ("isError" in auth) return auth;

      try {
        const db = getDb();
        return ok(await createTransaction(db, bookId, input));
      } catch (error) {
        if (error instanceof TransactionValidationError) {
          return fail(error.message);
        }
        throw error;
      }
    }
  );

  server.registerTool(
    "update_transaction",
    {
      title: "Update Transaction",
      description:
        "Update an existing transaction. Requires a valid API key (COUNTERPOISE_API_KEY env var). " +
        "All fields are optional — only provided fields will be updated. " +
        "If splits are provided, they replace ALL existing splits (must sum to zero). " +
        "Use list_transactions or search to find transaction IDs.",
      inputSchema: {
        bookId: z.number().int().positive().describe("The book ID"),
        transactionId: z
          .number()
          .int()
          .positive()
          .describe("The transaction ID to update"),
        ...toolShape(updateTransactionBodySchema),
      },
      // DESTRUCTIVE, not UPDATE: when this tool receives `splits`, it replaces
      // every existing split rather than merging. A caller that sends one split
      // to correct an amount silently discards the others. The hint is what
      // tells a client to confirm before that happens.
      annotations: DESTRUCTIVE,
    },
    async (args) => {
      const { bookId, transactionId, ...input } = args;
      const auth = await requireBookAuth(bookId);
      if ("isError" in auth) return auth;

      try {
        const db = getDb();
        return ok(await updateTransaction(db, bookId, transactionId, input));
      } catch (error) {
        if (
          error instanceof TransactionValidationError ||
          error instanceof TransactionNotFoundError
        ) {
          return fail(error.message);
        }
        throw error;
      }
    }
  );

  server.registerTool(
    "delete_transaction",
    {
      title: "Delete Transaction",
      description:
        "Delete a transaction and all of its splits. This cannot be undone. " +
        "Any Plaid reconciliation row matched to this transaction returns to pending, " +
        "and investment lots are rebuilt for every affected security. " +
        "Use list_transactions or search to find the transaction ID first.",
      inputSchema: {
        bookId: z.number().int().positive().describe("The book ID"),
        transactionId: z
          .number()
          .int()
          .positive()
          .describe("The transaction ID to delete"),
      },
      annotations: DESTRUCTIVE,
    },
    async ({ bookId, transactionId }) => {
      const auth = await requireBookAuth(bookId);
      if ("isError" in auth) return auth;

      try {
        await deleteTransaction(getDb(), bookId, transactionId);
        return ok({ success: true, transactionId });
      } catch (error) {
        if (error instanceof TransactionNotFoundError) {
          return fail(error.message);
        }
        throw error;
      }
    }
  );
}
