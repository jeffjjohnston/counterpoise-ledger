import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { plaidTransactionReconciliation } from "@/db/schema";
import { GET } from "@/app/api/b/[bookId]/transactions/[id]/plaid/route";
import { POST } from "@/app/api/b/[bookId]/transactions/[id]/plaid/unlink/route";
import {
  createAccount,
  createPlaidAccount,
  createPlaidReconciliation,
  createPlaidToken,
  createTransactionWithSplits,
  resetTestDatabase,
  setupTestDatabase,
} from "@/tests/helpers/db";

vi.mock("@/lib/api-auth", async () => {
  const { mockApiAuth } = await import("@/tests/helpers/db");
  return mockApiAuth();
});

import { captureEvent } from "@/lib/posthog-server";

vi.mock("@/lib/posthog-server", () => ({
  captureEvent: vi.fn(),
}));

function makeGetRequest(bookId: string, transactionId: string) {
  return {
    request: new Request(`http://localhost/api/b/${bookId}/transactions/${transactionId}/plaid`),
    params: Promise.resolve({ bookId, id: transactionId }),
  };
}

function makeUnlinkRequest(bookId: string, transactionId: string) {
  return {
    request: new Request(`http://localhost/api/b/${bookId}/transactions/${transactionId}/plaid/unlink`, {
      method: "POST",
    }),
    params: Promise.resolve({ bookId, id: transactionId }),
  };
}

describe("GET /api/b/[bookId]/transactions/[id]/plaid", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("returns plaid data for a linked transaction", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const groceries = await createAccount({ name: "Groceries", type: "expense" });
    const token = await createPlaidToken({
      financialInstitution: "Chase",
      itemId: "item-1",
      accessToken: "tok",
    });
    const link = await createPlaidAccount({
      tokenId: token.id,
      plaidAccountId: "pa-1",
      name: "Plaid Checking",
      type: "depository",
      counterpoiseAccountId: checking.id,
    });
    const txn = await createTransactionWithSplits({
      date: "2025-06-01",
      description: "Coffee Shop",
      splits: [
        { accountId: checking.id, amount: -500 },
        { accountId: groceries.id, amount: 500 },
      ],
    });
    await createPlaidReconciliation({
      plaidAccountLinkId: link.id,
      plaidTransactionId: "plaid-txn-1",
      date: "2025-06-01",
      amountCents: -500,
      name: "COFFEE SHOP",
      merchantName: "Coffee Shop",
      originalDescription: "COFFEE SHOP #1234",
      resolutionStatus: "matched",
      matchedTransactionId: txn.id,
    });

    const { request, params } = makeGetRequest("1", String(txn.id));
    const res = await GET(request, { params });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toMatchObject({
      plaidTransactionId: "plaid-txn-1",
      name: "COFFEE SHOP",
      merchantName: "Coffee Shop",
      amountCents: -500,
    });
    expect(body.rawJson).toBeDefined();
  });

  it("returns null for a transaction with no plaid link", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const groceries = await createAccount({ name: "Groceries", type: "expense" });
    const txn = await createTransactionWithSplits({
      date: "2025-06-01",
      description: "Manual",
      splits: [
        { accountId: checking.id, amount: -500 },
        { accountId: groceries.id, amount: 500 },
      ],
    });

    const { request, params } = makeGetRequest("1", String(txn.id));
    const res = await GET(request, { params });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toBeNull();
  });
});

describe("POST /api/b/[bookId]/transactions/[id]/plaid/unlink", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
    vi.mocked(captureEvent).mockClear();
  });

  it("unlinks a matched transaction and resets reconciliation row", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const groceries = await createAccount({ name: "Groceries", type: "expense" });
    const token = await createPlaidToken({
      financialInstitution: "Chase",
      itemId: "item-2",
      accessToken: "tok2",
    });
    const link = await createPlaidAccount({
      tokenId: token.id,
      plaidAccountId: "pa-2",
      name: "Plaid Checking",
      type: "depository",
      counterpoiseAccountId: checking.id,
    });
    const txn = await createTransactionWithSplits({
      date: "2025-06-01",
      description: "Grocery Store",
      splits: [
        { accountId: checking.id, amount: -2000 },
        { accountId: groceries.id, amount: 2000 },
      ],
    });
    const recon = await createPlaidReconciliation({
      plaidAccountLinkId: link.id,
      plaidTransactionId: "plaid-txn-2",
      date: "2025-06-01",
      amountCents: -2000,
      name: "GROCERY STORE",
      resolutionStatus: "matched",
      matchedTransactionId: txn.id,
    });

    const { request, params } = makeUnlinkRequest("1", String(txn.id));
    const res = await POST(request, { params });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toEqual({ success: true });

    // Verify reconciliation row was reset
    const db = getDb();
    const [updated] = await db
      .select()
      .from(plaidTransactionReconciliation)
      .where(eq(plaidTransactionReconciliation.id, recon.id));

    expect(updated.resolutionStatus).toBe("pending");
    expect(updated.matchedTransactionId).toBeNull();
    expect(updated.reviewReason).toBeNull();
    expect(updated.resolvedAt).toBeNull();

    // Verify PostHog event
    expect(captureEvent).toHaveBeenCalledWith(1, "sync_transaction_unlinked", {
      bookId: 1,
    });
  });

  it("returns 404 when transaction has no plaid link", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const groceries = await createAccount({ name: "Groceries", type: "expense" });
    const txn = await createTransactionWithSplits({
      date: "2025-06-01",
      description: "Manual",
      splits: [
        { accountId: checking.id, amount: -500 },
        { accountId: groceries.id, amount: 500 },
      ],
    });

    const { request, params } = makeUnlinkRequest("1", String(txn.id));
    const res = await POST(request, { params });
    expect(res.status).toBe(404);
  });
});
