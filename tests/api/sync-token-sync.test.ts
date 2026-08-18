import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import {
  plaidTokens,
  plaidTransactionReconciliation,
  transactionSplits,
} from "@/db/schema";
import {
  POST,
  DELETE,
} from "@/app/api/b/[bookId]/sync/tokens/[id]/sync/route";
import {
  createAccount,
  createPlaidAccount,
  createPlaidReconciliation,
  createPlaidToken,
  createTransactionWithSplits,
  resetTestDatabase,
  setupTestDatabase,
} from "@/tests/helpers/db";
import { and, eq } from "drizzle-orm";

vi.mock("@/lib/api-auth", async () => {
  const { mockApiAuth } = await import("@/tests/helpers/db");
  return mockApiAuth();
});

function makePlaidTxn(overrides: Partial<{
  transaction_id: string;
  account_id: string;
  amount: number;
  date: string;
  name: string;
  merchant_name: string | null;
  pending: boolean;
}> = {}) {
  return {
    transaction_id: overrides.transaction_id ?? "txn-1",
    account_id: overrides.account_id ?? "plaid-checking",
    amount: overrides.amount ?? 12.34,
    iso_currency_code: "USD",
    unofficial_currency_code: null,
    category: null,
    personal_finance_category: null,
    pending: overrides.pending ?? false,
    pending_transaction_id: null,
    authorized_date: null,
    date: overrides.date ?? new Date().toISOString().slice(0, 10),
    name: overrides.name ?? "Test Transaction",
    merchant_name: overrides.merchant_name ?? null,
    original_description: null,
  };
}

describe("POST /api/sync/tokens/[id]/sync", () => {
  const originalEnv = {
    PLAID_CLIENT_ID: process.env.PLAID_CLIENT_ID,
    PLAID_SECRET: process.env.PLAID_SECRET,
    PLAID_ENV: process.env.PLAID_ENV,
  };

  beforeAll(async () => {
    await setupTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
    process.env.PLAID_CLIENT_ID = "client-id";
    process.env.PLAID_SECRET = "secret";
    process.env.PLAID_ENV = "sandbox";
    vi.restoreAllMocks();
  });

  it("initial sync distributes transactions by account_id", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const savings = await createAccount({ name: "Savings", type: "asset" });
    const token = await createPlaidToken({
      financialInstitution: "Chase",
      itemId: "item-1",
      accessToken: "access-token",
    });
    const linkChecking = await createPlaidAccount({
      tokenId: token.id,
      plaidAccountId: "plaid-checking",
      name: "Plaid Checking",
      type: "depository",
      subtype: "checking",
      counterpoiseAccountId: checking.id,
    });
    const linkSavings = await createPlaidAccount({
      tokenId: token.id,
      plaidAccountId: "plaid-savings",
      name: "Plaid Savings",
      type: "depository",
      subtype: "savings",
      counterpoiseAccountId: savings.id,
    });

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        added: [
          makePlaidTxn({ transaction_id: "txn-chk-1", account_id: "plaid-checking", amount: 10.00, name: "Checking Txn" }),
          makePlaidTxn({ transaction_id: "txn-sav-1", account_id: "plaid-savings", amount: 20.00, name: "Savings Txn" }),
        ],
        modified: [],
        removed: [],
        has_more: false,
        next_cursor: "cursor-after-initial",
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(
      new Request("http://localhost/api/sync/tokens/1/sync", { method: "POST" }),
      { params: Promise.resolve({ bookId: "1", id: String(token.id) }) }
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.synced.added).toBe(2);
    expect(payload.pendingCount).toBe(2);

    // Verify days_requested: 7 sent, no cursor
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    const body = JSON.parse((calls[0][1]?.body as string) || "{}");
    expect(body.options?.days_requested).toBe(7);
    expect(body.cursor).toBeUndefined();

    // Verify cursor saved on plaidTokens
    const db = getDb();
    const tokenRows = await db
      .select({ syncCursor: plaidTokens.syncCursor })
      .from(plaidTokens)
      .where(eq(plaidTokens.id, token.id));
    expect(tokenRows[0].syncCursor).toBe("cursor-after-initial");

    // Verify checking txn staged under checking link
    const chkRows = await db
      .select()
      .from(plaidTransactionReconciliation)
      .where(
        and(
          eq(plaidTransactionReconciliation.plaidAccountLinkId, linkChecking.id),
          eq(plaidTransactionReconciliation.plaidTransactionId, "txn-chk-1")
        )
      );
    expect(chkRows).toHaveLength(1);
    expect(chkRows[0].amountCents).toBe(1000);

    // Verify savings txn staged under savings link
    const savRows = await db
      .select()
      .from(plaidTransactionReconciliation)
      .where(
        and(
          eq(plaidTransactionReconciliation.plaidAccountLinkId, linkSavings.id),
          eq(plaidTransactionReconciliation.plaidTransactionId, "txn-sav-1")
        )
      );
    expect(savRows).toHaveLength(1);
    expect(savRows[0].amountCents).toBe(2000);
  });

  it("incremental sync uses existing cursor", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const token = await createPlaidToken({
      financialInstitution: "Chase",
      itemId: "item-2",
      accessToken: "access-token",
      syncCursor: "cursor-old",
    });
    await createPlaidAccount({
      tokenId: token.id,
      plaidAccountId: "plaid-checking",
      name: "Plaid Checking",
      type: "depository",
      subtype: "checking",
      counterpoiseAccountId: checking.id,
    });

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        added: [],
        modified: [],
        removed: [],
        has_more: false,
        next_cursor: "cursor-new",
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(
      new Request("http://localhost/api/sync/tokens/1/sync", { method: "POST" }),
      { params: Promise.resolve({ bookId: "1", id: String(token.id) }) }
    );

    expect(response.status).toBe(200);
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    const body = JSON.parse((calls[0][1]?.body as string) || "{}");
    expect(body.cursor).toBe("cursor-old");
    expect(body.options?.days_requested).toBeUndefined();
  });

  it("transactions for unmapped account_ids are silently dropped", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const token = await createPlaidToken({
      financialInstitution: "Chase",
      itemId: "item-3",
      accessToken: "access-token",
      syncCursor: "cursor-x",
    });
    await createPlaidAccount({
      tokenId: token.id,
      plaidAccountId: "plaid-checking",
      name: "Plaid Checking",
      type: "depository",
      subtype: "checking",
      counterpoiseAccountId: checking.id,
    });

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        added: [
          makePlaidTxn({ transaction_id: "txn-unmapped", account_id: "plaid-unknown", name: "Unknown Acct Txn" }),
          makePlaidTxn({ transaction_id: "txn-mapped", account_id: "plaid-checking", name: "Known Acct Txn" }),
        ],
        modified: [],
        removed: [],
        has_more: false,
        next_cursor: "cursor-y",
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(
      new Request("http://localhost/api/sync/tokens/1/sync", { method: "POST" }),
      { params: Promise.resolve({ bookId: "1", id: String(token.id) }) }
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.synced.added).toBe(1);

    // Verify only the mapped txn was created
    const db = getDb();
    const allRows = await db.select().from(plaidTransactionReconciliation);
    expect(allRows).toHaveLength(1);
    expect(allRows[0].plaidTransactionId).toBe("txn-mapped");
  });

  it("restarts pagination from base cursor on mutation-during-pagination", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const token = await createPlaidToken({
      financialInstitution: "Chase",
      itemId: "item-4",
      accessToken: "access-token",
      syncCursor: "cursor-start",
    });
    await createPlaidAccount({
      tokenId: token.id,
      plaidAccountId: "plaid-checking",
      name: "Plaid Checking",
      type: "depository",
      subtype: "checking",
      counterpoiseAccountId: checking.id,
    });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          added: [],
          modified: [],
          removed: [],
          has_more: true,
          next_cursor: "cursor-mid",
        }),
      })
      .mockResolvedValueOnce({
        ok: false,
        json: async () => ({
          error_message: "mutation during pagination",
          error_code: "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          added: [],
          modified: [],
          removed: [],
          has_more: false,
          next_cursor: "cursor-end",
        }),
      });

    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(
      new Request("http://localhost/api/sync/tokens/1/sync", { method: "POST" }),
      { params: Promise.resolve({ bookId: "1", id: String(token.id) }) }
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    const firstBody = JSON.parse((calls[0][1]?.body as string) || "{}");
    const secondBody = JSON.parse((calls[1][1]?.body as string) || "{}");
    const thirdBody = JSON.parse((calls[2][1]?.body as string) || "{}");

    expect(firstBody.cursor).toBe("cursor-start");
    expect(secondBody.cursor).toBe("cursor-mid");
    expect(thirdBody.cursor).toBe("cursor-start");

    // Verify cursor saved on plaidTokens
    const db = getDb();
    const tokenRows = await db
      .select({ syncCursor: plaidTokens.syncCursor })
      .from(plaidTokens)
      .where(eq(plaidTokens.id, token.id));
    expect(tokenRows[0].syncCursor).toBe("cursor-end");
  });

  it("flags matched rows on modify and pending rows on remove", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const groceries = await createAccount({ name: "Groceries", type: "expense" });
    const token = await createPlaidToken({
      financialInstitution: "Chase",
      itemId: "item-5",
      accessToken: "access-token",
      syncCursor: "cursor-base",
    });
    const link = await createPlaidAccount({
      tokenId: token.id,
      plaidAccountId: "plaid-checking",
      name: "Plaid Checking",
      type: "depository",
      subtype: "checking",
      counterpoiseAccountId: checking.id,
    });

    const localTxn = await createTransactionWithSplits({
      date: "2026-02-08",
      description: "Blue Bottle",
      splits: [
        { accountId: checking.id, amount: -500 },
        { accountId: groceries.id, amount: 500 },
      ],
    });

    await createPlaidReconciliation({
      plaidAccountLinkId: link.id,
      plaidTransactionId: "txn-modified",
      date: "2026-02-08",
      amountCents: 500,
      name: "Blue Bottle",
      resolutionStatus: "matched",
      matchedTransactionId: localTxn.id,
    });

    await createPlaidReconciliation({
      plaidAccountLinkId: link.id,
      plaidTransactionId: "txn-removed",
      date: "2026-02-08",
      amountCents: 777,
      name: "Old Pending",
      resolutionStatus: "pending",
    });

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        added: [
          makePlaidTxn({ transaction_id: "txn-pending-added", account_id: "plaid-checking", amount: 4.2, pending: true, name: "Pending Item" }),
        ],
        modified: [
          makePlaidTxn({ transaction_id: "txn-modified", account_id: "plaid-checking", amount: 6.5, name: "Blue Bottle Updated" }),
        ],
        removed: [{ transaction_id: "txn-removed" }],
        has_more: false,
        next_cursor: "cursor-next",
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(
      new Request("http://localhost/api/sync/tokens/1/sync", { method: "POST" }),
      { params: Promise.resolve({ bookId: "1", id: String(token.id) }) }
    );

    expect(response.status).toBe(200);

    const db = getDb();
    const modifiedRows = await db
      .select()
      .from(plaidTransactionReconciliation)
      .where(
        and(
          eq(plaidTransactionReconciliation.plaidAccountLinkId, link.id),
          eq(plaidTransactionReconciliation.plaidTransactionId, "txn-modified")
        )
      );
    expect(modifiedRows[0].reviewReason).toBe("plaid_modified");

    const removedRows = await db
      .select()
      .from(plaidTransactionReconciliation)
      .where(
        and(
          eq(plaidTransactionReconciliation.plaidAccountLinkId, link.id),
          eq(plaidTransactionReconciliation.plaidTransactionId, "txn-removed")
        )
      );
    expect(removedRows[0].reviewReason).toBe("plaid_removed");

    // Pending added items should be skipped
    const pendingRows = await db
      .select()
      .from(plaidTransactionReconciliation)
      .where(
        and(
          eq(plaidTransactionReconciliation.plaidAccountLinkId, link.id),
          eq(plaidTransactionReconciliation.plaidTransactionId, "txn-pending-added")
        )
      );
    expect(pendingRows).toHaveLength(0);

    // Original transaction splits remain intact
    const splitRows = await db
      .select()
      .from(transactionSplits)
      .where(eq(transactionSplits.transactionId, localTxn.id));
    expect(splitRows).toHaveLength(2);
  });

  it("DELETE resets cursor, pending items, and lastError", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const token = await createPlaidToken({
      financialInstitution: "Chase",
      itemId: "item-6",
      accessToken: "access-token",
      syncCursor: "cursor-existing",
      lastSyncedAt: new Date(),
    });

    // A prior failed sync left an error message. Without clearing it, the
    // page would show "Last sync: Never" (from the cursor/lastSyncedAt reset)
    // right above a stale "Last sync failed: ..." for a sync that no longer
    // has any record of ever running.
    await getDb()
      .update(plaidTokens)
      .set({ lastError: "ITEM_LOGIN_REQUIRED" })
      .where(eq(plaidTokens.id, token.id));

    const link = await createPlaidAccount({
      tokenId: token.id,
      plaidAccountId: "plaid-checking",
      name: "Plaid Checking",
      type: "depository",
      subtype: "checking",
      counterpoiseAccountId: checking.id,
    });

    await createPlaidReconciliation({
      plaidAccountLinkId: link.id,
      plaidTransactionId: "txn-pending-1",
      date: "2026-02-08",
      amountCents: 100,
      name: "Pending 1",
      resolutionStatus: "pending",
    });

    await createPlaidReconciliation({
      plaidAccountLinkId: link.id,
      plaidTransactionId: "txn-matched-1",
      date: "2026-02-08",
      amountCents: 200,
      name: "Matched 1",
      resolutionStatus: "matched",
    });

    const response = await DELETE(
      new Request("http://localhost/api/sync/tokens/1/sync", { method: "DELETE" }),
      { params: Promise.resolve({ bookId: "1", id: String(token.id) }) }
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.success).toBe(true);

    const db = getDb();

    // Cursor, lastSyncedAt, and lastError all cleared on token
    const tokenRows = await db
      .select({
        syncCursor: plaidTokens.syncCursor,
        lastSyncedAt: plaidTokens.lastSyncedAt,
        lastError: plaidTokens.lastError,
      })
      .from(plaidTokens)
      .where(eq(plaidTokens.id, token.id));
    expect(tokenRows[0].syncCursor).toBeNull();
    expect(tokenRows[0].lastSyncedAt).toBeNull();
    expect(tokenRows[0].lastError).toBeNull();

    // Pending reconciliation deleted, matched remains
    const reconRows = await db
      .select()
      .from(plaidTransactionReconciliation)
      .where(eq(plaidTransactionReconciliation.plaidAccountLinkId, link.id));
    expect(reconRows).toHaveLength(1);
    expect(reconRows[0].plaidTransactionId).toBe("txn-matched-1");
  });

  it("initial sync date cutoff filters old transactions", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const token = await createPlaidToken({
      financialInstitution: "Chase",
      itemId: "item-7",
      accessToken: "access-token",
    });
    await createPlaidAccount({
      tokenId: token.id,
      plaidAccountId: "plaid-checking",
      name: "Plaid Checking",
      type: "depository",
      subtype: "checking",
      counterpoiseAccountId: checking.id,
    });

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        added: [
          makePlaidTxn({ transaction_id: "txn-old", account_id: "plaid-checking", date: "2020-01-01", name: "Old Transaction" }),
          makePlaidTxn({ transaction_id: "txn-recent", account_id: "plaid-checking", date: new Date().toISOString().slice(0, 10), name: "Recent Transaction" }),
        ],
        modified: [],
        removed: [],
        has_more: false,
        next_cursor: "cursor-cutoff",
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(
      new Request("http://localhost/api/sync/tokens/1/sync", { method: "POST" }),
      { params: Promise.resolve({ bookId: "1", id: String(token.id) }) }
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.synced.added).toBe(1);

    const db = getDb();
    const allRows = await db.select().from(plaidTransactionReconciliation);
    expect(allRows).toHaveLength(1);
    expect(allRows[0].plaidTransactionId).toBe("txn-recent");
  });

  afterAll(() => {
    process.env.PLAID_CLIENT_ID = originalEnv.PLAID_CLIENT_ID;
    process.env.PLAID_SECRET = originalEnv.PLAID_SECRET;
    process.env.PLAID_ENV = originalEnv.PLAID_ENV;
  });
});
