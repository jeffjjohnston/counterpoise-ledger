import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { getDb } from "@/db";
import { requireBookAuth } from "@/mcp/auth";
import {
  createTransaction,
  updateTransaction,
  TransactionValidationError,
  TransactionNotFoundError,
} from "@/lib/transactions";
// The payload shape lives in lib/schemas/transactions.ts so the HTTP routes
// and these tools validate the same thing. `bookId` is the one field the two
// surfaces genuinely differ on — it comes from the URL over HTTP, so the
// shared schema omits it and the tools add it back here.
//
// `isReconciled` is omitted in the other direction. The shared schema has to
// carry it for HTTP (the reconcile checkbox PUTs it and nothing else), but
// these tools have never exposed it and deliberately still don't: marking a
// transaction reconciled is a user's attestation that it matched a bank
// statement, and on a floating transaction it also clears `isFloating` and
// overwrites the stored date. Whether an assistant may do that is a product
// decision, not something a schema-sharing refactor should settle — so this
// preserves the tools' pre-existing field set exactly rather than restricting
// anything that previously worked.
import {
  createTransactionBodySchema,
  updateTransactionBodySchema,
} from "@/lib/schemas/transactions";

const createTransactionToolSchema = createTransactionBodySchema.omit({
  isReconciled: true,
});
const updateTransactionToolSchema = updateTransactionBodySchema.omit({
  isReconciled: true,
});

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
        ...createTransactionToolSchema.shape,
      },
    },
    async (args) => {
      const { bookId, ...input } = args;
      const auth = await requireBookAuth(bookId);
      if ("isError" in auth) return auth;

      try {
        const db = getDb();
        const result = await createTransaction(db, bookId, input);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        if (error instanceof TransactionValidationError) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ error: error.message }),
              },
            ],
            isError: true,
          };
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
        ...updateTransactionToolSchema.shape,
      },
    },
    async (args) => {
      const { bookId, transactionId, ...input } = args;
      const auth = await requireBookAuth(bookId);
      if ("isError" in auth) return auth;

      try {
        const db = getDb();
        const result = await updateTransaction(
          db,
          bookId,
          transactionId,
          input
        );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        if (
          error instanceof TransactionValidationError ||
          error instanceof TransactionNotFoundError
        ) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ error: error.message }),
              },
            ],
            isError: true,
          };
        }
        throw error;
      }
    }
  );
}
