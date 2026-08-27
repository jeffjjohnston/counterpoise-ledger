import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { getDb } from "@/db";
import { requireBookAuth } from "@/mcp/auth";
import {
  DESTRUCTIVE,
  READ,
  UPDATE,
  WRITE_NETWORK,
} from "@/mcp/tools/_annotations";
import { fail, ok } from "@/mcp/tools/_result";
import { toolShape } from "@/mcp/tools/_tool-shape";
import { assignAccountsSchema, pendingTransactionsQuery, updateTokenSchema } from "@/lib/schemas/sync";
import {
  clearSyncData,
  deletePlaidToken,
  getPlaidStatus,
  listTokenAccounts,
  PlaidTokenNotFoundError,
  PlaidTokenValidationError,
  setTokenAccounts,
  updatePlaidToken,
} from "@/lib/plaid-tokens";
import {
  getTransactionPlaidLink,
  listPendingPlaidTransactions,
  PlaidLinkNotFoundError,
  unlinkPlaidTransaction,
} from "@/lib/plaid-transactions";
import { syncToken, SyncTokenError } from "@/lib/plaid-sync";

export function registerPlaidTools(server: McpServer) {
  server.registerTool(
    "get_plaid_status",
    {
      title: "Get Plaid Status",
      description:
        "The state of a book's bank connections in one call: each connection (with its access token masked, and how many of the bank accounts it exposes are mapped to a Counterpoise account as mappedAccountCount of totalAccountCount), how many synced transactions are waiting to be reconciled, which accounts hold manually-entered transactions no bank transaction has matched, and every Plaid account mapped to a Counterpoise account — its plaidAccountMask (the last digits the bank shows) and its own pending and review counts.",
      inputSchema: {
        bookId: z.number().int().positive().describe("The book ID to query"),
      },
      annotations: READ,
    },
    async ({ bookId }) => {
      const auth = await requireBookAuth(bookId);
      if ("isError" in auth) return auth;

      return ok(await getPlaidStatus(getDb(), bookId));
    }
  );

  server.registerTool(
    "list_plaid_token_accounts",
    {
      title: "List Plaid Token Accounts",
      description:
        "List the bank accounts a Plaid connection exposes and which Counterpoise account each is mapped to. This reads only local data and never contacts Plaid.",
      inputSchema: {
        bookId: z.number().int().positive().describe("The book ID the connection belongs to"),
        tokenId: z.number().int().positive().describe("The Plaid connection ID"),
      },
      // refresh is deliberately not exposed here, even though
      // listTokenAccounts() in lib/plaid-tokens.ts still takes a refresh
      // option for the HTTP route. A refresh reconciles the local
      // plaidAccounts rows against what Plaid reports right now, and
      // DELETES any local row Plaid no longer lists — which cascades to
      // that account's staged reconciliation queue AND its matched history
      // (plaidTransactionReconciliation.plaidAccountLinkId is onDelete:
      // "cascade" in db/schema.ts, and buildPayeeMap() in
      // lib/plaid-auto-match.ts learns from matched rows, so the loss
      // outlives the call). Plaid returning accounts: [] deletes every
      // mapping on the connection without throwing. A future reader adding
      // refresh back here would silently turn a READ tool into one a
      // client can auto-approve straight into data loss — leave the option
      // to the HTTP route, where a human clicks the button and sees the
      // result.
      annotations: READ,
    },
    async ({ bookId, tokenId }) => {
      const auth = await requireBookAuth(bookId);
      if ("isError" in auth) return auth;

      try {
        return ok(await listTokenAccounts(getDb(), bookId, tokenId));
      } catch (err) {
        if (err instanceof PlaidTokenNotFoundError) return fail(err.message);
        throw err;
      }
    }
  );

  server.registerTool(
    "update_plaid_token",
    {
      title: "Update Plaid Token",
      description:
        "Replace a bank connection's institution name and item id. This is a full replace, not a " +
        "patch: financialInstitution and itemId are both required on every call. Rotating the " +
        "connection's access token is not available through this interface — that credential can " +
        "only be re-obtained through the Plaid Link browser flow, and this tool does not accept one.",
      inputSchema: {
        bookId: z.number().int().positive().describe("The book ID the connection belongs to"),
        tokenId: z.number().int().positive().describe("The Plaid connection ID to update"),
        // accessToken is intentionally omitted from updateTokenSchema here.
        // The library writes any non-empty string straight into the
        // credential column, and a Plaid access token exists only in that
        // column — it is re-obtainable only through the Link browser flow,
        // never by re-deriving it. A tool annotated UPDATE invites
        // auto-approval, so accepting a caller-supplied (and possibly
        // hallucinated) accessToken here would let a model destroy an
        // unrecoverable credential while returning what looks like a
        // success. updatePlaidToken() already treats a missing accessToken
        // as "keep the stored one", so this is the correct call shape, not
        // a workaround.
        ...toolShape(updateTokenSchema.omit({ accessToken: true })),
      },
      annotations: UPDATE,
    },
    async ({ bookId, tokenId, ...input }) => {
      const auth = await requireBookAuth(bookId);
      if ("isError" in auth) return auth;

      try {
        return ok(await updatePlaidToken(getDb(), bookId, tokenId, input));
      } catch (err) {
        if (err instanceof PlaidTokenNotFoundError || err instanceof PlaidTokenValidationError) {
          return fail(err.message);
        }
        throw err;
      }
    }
  );

  server.registerTool(
    "delete_plaid_token",
    {
      title: "Delete Plaid Token",
      description:
        "Delete a bank connection and its entire reconciliation history. This removes the " +
        "account mappings, every staged transaction still awaiting review, AND every " +
        "already-resolved row — the matched, created and ignored ones. Local transactions " +
        "are not deleted, but those that were matched lose their link to the bank " +
        "transaction that confirmed them, and the matched history that payee-based " +
        "auto-matching learns from is gone, so future syncs on a re-added connection will " +
        "match less well. To discard only the pending queue and re-fetch from scratch, use " +
        "clear_plaid_sync_data instead. This cannot be undone.",
      inputSchema: {
        bookId: z.number().int().positive().describe("The book ID the connection belongs to"),
        tokenId: z.number().int().positive().describe("The Plaid connection ID to delete"),
      },
      annotations: DESTRUCTIVE,
    },
    async ({ bookId, tokenId }) => {
      const auth = await requireBookAuth(bookId);
      if ("isError" in auth) return auth;

      try {
        await deletePlaidToken(getDb(), bookId, tokenId);
        return ok({ success: true, tokenId });
      } catch (err) {
        if (err instanceof PlaidTokenNotFoundError) return fail(err.message);
        throw err;
      }
    }
  );

  server.registerTool(
    "set_plaid_token_accounts",
    {
      title: "Set Plaid Account Mapping",
      description:
        "Map a Plaid connection's bank accounts to Counterpoise accounts. Pass counterpoiseAccountId null to unmap one. This replaces the mapping for every plaidAccountId you list and leaves any you omit alone. Refuses the whole batch if an id is not one of this connection's accounts, is not an account in this book, or is already mapped to a different Plaid account.",
      inputSchema: {
        bookId: z.number().int().positive().describe("The book ID the connection belongs to"),
        tokenId: z.number().int().positive().describe("The Plaid connection ID"),
        ...toolShape(assignAccountsSchema),
      },
      annotations: UPDATE,
    },
    async ({ bookId, tokenId, assignments }) => {
      const auth = await requireBookAuth(bookId);
      if ("isError" in auth) return auth;

      try {
        return ok(await setTokenAccounts(getDb(), bookId, tokenId, assignments));
      } catch (err) {
        if (
          err instanceof PlaidTokenNotFoundError ||
          err instanceof PlaidTokenValidationError
        ) {
          return fail(err.message);
        }
        throw err;
      }
    }
  );

  server.registerTool(
    "sync_plaid_token",
    {
      title: "Sync Plaid Connection",
      description:
        "Fetch new, changed and removed transactions from Plaid for one connection and stage them for reconciliation, then run auto-matching. Reaches Plaid and changes data. Returns counts of what was added, modified, removed and auto-matched. A demo connection cannot sync and says so.",
      inputSchema: {
        bookId: z.number().int().positive().describe("The book ID the connection belongs to"),
        tokenId: z.number().int().positive().describe("The Plaid connection ID to sync"),
      },
      annotations: WRITE_NETWORK,
    },
    async ({ bookId, tokenId }) => {
      const auth = await requireBookAuth(bookId);
      if ("isError" in auth) return auth;

      try {
        return ok(await syncToken(getDb(), bookId, tokenId));
      } catch (err) {
        if (err instanceof SyncTokenError) return fail(err.message);
        throw err;
      }
    }
  );

  server.registerTool(
    "clear_plaid_sync_data",
    {
      title: "Clear Plaid Sync Data",
      description:
        "Discard every staged transaction for a connection and reset its sync cursor, so the next sync re-fetches from the beginning. Local transactions already reconciled are not affected. This touches only this database and never calls Plaid.",
      inputSchema: {
        bookId: z.number().int().positive().describe("The book ID the connection belongs to"),
        tokenId: z.number().int().positive().describe("The Plaid connection ID"),
      },
      annotations: DESTRUCTIVE,
    },
    async ({ bookId, tokenId }) => {
      const auth = await requireBookAuth(bookId);
      if ("isError" in auth) return auth;

      try {
        await clearSyncData(getDb(), bookId, tokenId);
        return ok({ success: true });
      } catch (err) {
        if (err instanceof PlaidTokenNotFoundError) return fail(err.message);
        throw err;
      }
    }
  );

  server.registerTool(
    "list_pending_plaid_transactions",
    {
      title: "List Pending Plaid Transactions",
      description:
        "Bank transactions a Plaid sync has staged but nothing has reconciled yet — waiting to be matched to an existing Counterpoise transaction, created as a new one, or ignored. reviewReason marks a staged row Plaid later changed or removed after it was already resolved, so a human should look at it again. These are staged bank transactions, not Counterpoise transactions: their ids are synthetic placeholders and must never be passed to create_transaction, update_transaction, delete_transaction, or any other transaction tool.",
      inputSchema: {
        bookId: z.number().int().positive().describe("The book ID to query"),
        ...toolShape(pendingTransactionsQuery),
      },
      annotations: READ,
    },
    async ({ bookId, ...query }) => {
      const auth = await requireBookAuth(bookId);
      if ("isError" in auth) return auth;

      return ok(await listPendingPlaidTransactions(getDb(), bookId, query));
    }
  );

  server.registerTool(
    "get_transaction_plaid_link",
    {
      title: "Get Transaction Plaid Link",
      description:
        "The staged Plaid row a transaction is matched to. Returns null when the transaction was entered by hand rather than matched to a bank transaction.",
      inputSchema: {
        bookId: z.number().int().positive().describe("The book ID the transaction belongs to"),
        transactionId: z.number().int().positive().describe("The transaction ID to look up"),
      },
      annotations: READ,
    },
    async ({ bookId, transactionId }) => {
      const auth = await requireBookAuth(bookId);
      if ("isError" in auth) return auth;

      return ok(await getTransactionPlaidLink(getDb(), bookId, transactionId));
    }
  );

  server.registerTool(
    "unlink_plaid_transaction",
    {
      title: "Unlink Plaid Transaction",
      description:
        "Remove a transaction's Plaid link. The bank transaction returns to the pending queue, and the local transaction stops being reconciled — this does not delete anything.",
      inputSchema: {
        bookId: z.number().int().positive().describe("The book ID the transaction belongs to"),
        transactionId: z.number().int().positive().describe("The transaction ID to unlink"),
      },
      annotations: UPDATE,
    },
    async ({ bookId, transactionId }) => {
      const auth = await requireBookAuth(bookId);
      if ("isError" in auth) return auth;

      try {
        await unlinkPlaidTransaction(getDb(), bookId, transactionId);
        return ok({ success: true });
      } catch (err) {
        if (err instanceof PlaidLinkNotFoundError) return fail(err.message);
        throw err;
      }
    }
  );
}
