import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { getDb } from "@/db";
import { requireBookAuth } from "@/mcp/auth";
import { DESTRUCTIVE_NONIDEMPOTENT, READ } from "@/mcp/tools/_annotations";
import { fail, ok } from "@/mcp/tools/_result";
import { toolShape } from "@/mcp/tools/_tool-shape";
import {
  getReconcilableLink,
  listReconciliationQueue,
  ReconcileNotFoundError,
  ReconcileValidationError,
  resolveReconciliation,
} from "@/lib/plaid-reconcile";
import { reconcileSchema } from "@/lib/schemas/sync";

export function registerPlaidReconcileTools(server: McpServer) {
  server.registerTool(
    "get_reconcile_candidates",
    {
      title: "Get Reconcile Candidates",
      description:
        "The reconciliation queue for one linked bank account: every synced transaction still " +
        "awaiting a decision, plus any already-resolved one the bank has since changed or " +
        "removed. Each item carries up to five ranked local transactions that might be the same " +
        "spend, with a score and the reasons behind it, and a suggested counter account drawn " +
        "from what this payee was categorised as before. Feed an item's id to " +
        "reconcile_plaid_transaction to resolve it. Rows needing review are listed first.",
      inputSchema: {
        bookId: z.number().int().positive().describe("The book ID the connection belongs to"),
        plaidAccountLinkId: z
          .number()
          .int()
          .positive()
          .describe(
            "The Plaid account link ID, as returned by get_plaid_status in " +
              "assignedAccounts[].plaidLinkId"
          ),
        // Not a spread of reconcileListQuery. That schema's limit/offset are
        // z.coerce.number<string>() — built to read a URL query string, and
        // publishing them here would tell a client to send strings. It also
        // has no upper bound, which the route can afford and this tool cannot:
        // every item runs a candidate search and a counter-account suggestion,
        // several queries each, so an unbounded limit is an unbounded number
        // of round trips. Same shape list_transactions declares for its own
        // pagination.
        limit: z
          .number()
          .int()
          .positive()
          .max(100)
          .optional()
          .default(25)
          .describe("Max items to return (default 25, max 100)"),
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
    async ({ bookId, plaidAccountLinkId, limit, offset }) => {
      const auth = await requireBookAuth(bookId);
      if ("isError" in auth) return auth;

      try {
        const db = getDb();
        const link = await getReconcilableLink(db, bookId, plaidAccountLinkId);
        return ok(await listReconciliationQueue(db, bookId, link, { limit, offset }));
      } catch (err) {
        if (err instanceof ReconcileNotFoundError) return fail(err.message);
        if (err instanceof ReconcileValidationError) return fail(err.message);
        throw err;
      }
    }
  );

  server.registerTool(
    "reconcile_plaid_transaction",
    {
      title: "Reconcile Plaid Transaction",
      description:
        "Resolve one staged bank transaction from the reconciliation queue. Six actions: 'match' " +
        "links it to a transaction you already entered and marks that transaction reconciled; " +
        "'match_update_amount' does the same and rewrites the transaction's two splits to the " +
        "bank's amount (two-split, non-investment transactions only); 'create' writes a new " +
        "two-split transaction from the bank's data; 'ignore' dismisses the bank transaction; " +
        "'keep_local' clears a review flag and keeps what you already have; 'unlink' returns a " +
        "resolved row to the pending queue and stops its transaction being reconciled, unless " +
        "another bank row still matches that transaction (a transfer seen on both sides). " +
        "Matching or creating against a bank row that is already linked is refused \u2014 unlink it " +
        "first. Matching a floating transaction also settles it, clearing its floating flag and " +
        "stamping the bank's date. Get the reconciliationId and its candidate matches from " +
        "get_reconcile_candidates first.",
      inputSchema: {
        bookId: z.number().int().positive().describe("The book ID the connection belongs to"),
        plaidAccountLinkId: z
          .number()
          .int()
          .positive()
          .describe("The Plaid account link ID this staged transaction belongs to"),
        ...toolShape(reconcileSchema, {
          objectRefineHandledBy: "lib/plaid-reconcile.ts:resolveReconciliation",
        }),
        // reconcileSchema types these three as z.unknown() so the HTTP route
        // can report one action-specific message for every way they can be
        // wrong. Spread unchanged they publish as unconstrained JSON schema,
        // which tells a model nothing about what to send — so they are
        // re-declared here with their real types. This makes the tool stricter
        // than the route for a wrong-typed value (zod's message rather than
        // the ported one) and identical for every well-formed call. The
        // action-conditional REQUIREMENT rules are not restated here: those
        // live once in reconcileActionIssue() and reach this tool through
        // resolveReconciliation().
        transactionId: z
          .number()
          .int()
          .optional()
          .describe(
            "The existing transaction to link to. Required for 'match' and 'match_update_amount', ignored otherwise."
          ),
        counterAccountId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "The account the other side of the new transaction posts to. Required for 'create', ignored otherwise, and it must not be the account this connection is linked to."
          ),
        payeeName: z
          .string()
          .optional()
          .describe(
            "The payee to record on a created transaction. Only read for 'create'; defaults to the bank's merchant name, then to the raw transaction name. " +
              "If no payee with this name already exists in the book (case-insensitively), a new payee row is created — an additive, reversible side effect of 'create'."
          ),
      },
      annotations: DESTRUCTIVE_NONIDEMPOTENT,
    },
    async ({ bookId, plaidAccountLinkId, ...input }) => {
      const auth = await requireBookAuth(bookId);
      if ("isError" in auth) return auth;

      try {
        const db = getDb();
        const link = await getReconcilableLink(db, bookId, plaidAccountLinkId);
        return ok(await resolveReconciliation(db, bookId, link, input));
      } catch (err) {
        if (err instanceof ReconcileNotFoundError) return fail(err.message);
        if (err instanceof ReconcileValidationError) return fail(err.message);
        throw err;
      }
    }
  );
}
