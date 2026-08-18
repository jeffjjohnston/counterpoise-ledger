import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import {
  plaidTransactionReconciliation,
  transactions,
  transactionSplits,
} from "@/db/schema";
import { GET, POST } from "@/app/api/b/[bookId]/sync/accounts/[id]/reconcile/route";
import {
  createAccount,
  createInvestmentSplit,
  createPayee,
  createPlaidAccount,
  createPlaidReconciliation,
  createPlaidToken,
  createSecurity,
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

describe("/api/sync/accounts/[id]/reconcile", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
    vi.mocked(captureEvent).mockClear();
  });

  it("returns unresolved items with ranked candidates and suggestion", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const groceries = await createAccount({ name: "Groceries", type: "expense" });
    const dining = await createAccount({ name: "Dining", type: "expense" });

    const payee = await createPayee({ name: "Blue Bottle" });

    const token = await createPlaidToken({
      financialInstitution: "Chase",
      itemId: "item-a",
      accessToken: "token",
    });
    const link = await createPlaidAccount({
      tokenId: token.id,
      plaidAccountId: "plaid-checking",
      name: "Plaid Checking",
      type: "depository",
      subtype: "checking",
      counterpoiseAccountId: checking.id,
    });

    const exactTxn = await createTransactionWithSplits({
      date: "2026-02-08",
      description: "Blue Bottle",
      payeeId: payee.id,
      splits: [
        { accountId: checking.id, amount: -1500 },
        { accountId: groceries.id, amount: 1500 },
      ],
    });

    await createTransactionWithSplits({
      date: "2026-02-09",
      description: "Blue Bottle 2",
      payeeId: payee.id,
      splits: [
        { accountId: checking.id, amount: -1600 },
        { accountId: dining.id, amount: 1600 },
      ],
    });

    await createPlaidReconciliation({
      plaidAccountLinkId: link.id,
      plaidTransactionId: "txn-1",
      date: "2026-02-08",
      amountCents: 1500,
      name: "BLUE BOTTLE COFFEE",
      merchantName: "Blue Bottle",
      resolutionStatus: "pending",
    });

    const response = await GET(
      new Request(`http://localhost/api/sync/accounts/${link.id}/reconcile?limit=25&offset=0`),
      { params: Promise.resolve({ bookId: "1", id: String(link.id) }) }
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.items).toHaveLength(1);

    const item = payload.items[0];
    expect(item.candidates.length).toBeGreaterThan(0);
    expect(item.candidates[0].transactionId).toBe(exactTxn.id);
    expect(item.candidates[0].scoreTags).toContain("exact_amount");
    expect(item.suggestedCounterAccountId).toBe(groceries.id);
  });

  it("matches transactions and prevents duplicate link on same account", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const groceries = await createAccount({ name: "Groceries", type: "expense" });

    const token = await createPlaidToken({
      financialInstitution: "Chase",
      itemId: "item-b",
      accessToken: "token",
    });
    const link = await createPlaidAccount({
      tokenId: token.id,
      plaidAccountId: "plaid-checking",
      name: "Plaid Checking",
      type: "depository",
      subtype: "checking",
      counterpoiseAccountId: checking.id,
    });

    const tx = await createTransactionWithSplits({
      date: "2026-02-08",
      description: "Match Me",
      splits: [
        { accountId: checking.id, amount: -1000 },
        { accountId: groceries.id, amount: 1000 },
      ],
    });

    const reconA = await createPlaidReconciliation({
      plaidAccountLinkId: link.id,
      plaidTransactionId: "txn-a",
      date: "2026-02-08",
      amountCents: 1000,
      name: "A",
    });
    const reconB = await createPlaidReconciliation({
      plaidAccountLinkId: link.id,
      plaidTransactionId: "txn-b",
      date: "2026-02-08",
      amountCents: 1000,
      name: "B",
    });

    const first = await POST(
      new Request(`http://localhost/api/sync/accounts/${link.id}/reconcile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "match",
          reconciliationId: reconA.id,
          transactionId: tx.id,
        }),
      }),
      { params: Promise.resolve({ bookId: "1", id: String(link.id) }) }
    );

    expect(first.status).toBe(200);
    const firstPayload = await first.json();
    expect(firstPayload.resolutionStatus).toBe("matched");
    expect(firstPayload.matchedTransactionId).toBe(tx.id);

    const matchedTx = await getDb().query.transactions.findFirst({
      where: eq(transactions.id, tx.id),
    });
    expect(matchedTx?.isReconciled).toBe(true);

    const second = await POST(
      new Request(`http://localhost/api/sync/accounts/${link.id}/reconcile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "match",
          reconciliationId: reconB.id,
          transactionId: tx.id,
        }),
      }),
      { params: Promise.resolve({ bookId: "1", id: String(link.id) }) }
    );

    expect(second.status).toBe(400);
  });

  it("creates a balanced transaction from plaid item and links it", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const groceries = await createAccount({ name: "Groceries", type: "expense" });

    const token = await createPlaidToken({
      financialInstitution: "Chase",
      itemId: "item-c",
      accessToken: "token",
    });
    const link = await createPlaidAccount({
      tokenId: token.id,
      plaidAccountId: "plaid-checking",
      name: "Plaid Checking",
      type: "depository",
      subtype: "checking",
      counterpoiseAccountId: checking.id,
    });

    const recon = await createPlaidReconciliation({
      plaidAccountLinkId: link.id,
      plaidTransactionId: "txn-create",
      date: "2026-02-08",
      amountCents: 3210,
      name: "Trader Joe's",
      merchantName: "Trader Joe's",
      resolutionStatus: "pending",
    });

    const response = await POST(
      new Request(`http://localhost/api/sync/accounts/${link.id}/reconcile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create",
          reconciliationId: recon.id,
          counterAccountId: groceries.id,
          payeeName: "Custom Market",
        }),
      }),
      { params: Promise.resolve({ bookId: "1", id: String(link.id) }) }
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.resolutionStatus).toBe("created");
    expect(typeof payload.matchedTransactionId).toBe("number");

    const db = getDb();
    const splits = await db
      .select({ accountId: transactionSplits.accountId, amount: transactionSplits.amount })
      .from(transactionSplits)
      .where(eq(transactionSplits.transactionId, payload.matchedTransactionId));

    expect(splits).toEqual(
      expect.arrayContaining([
        { accountId: checking.id, amount: -3210 },
        { accountId: groceries.id, amount: 3210 },
      ])
    );

    const created = await db.query.transactions.findFirst({
      where: eq(transactions.id, payload.matchedTransactionId),
      with: { payee: true },
    });
    expect(created?.payee?.name).toBe("Custom Market");
    expect(created?.isReconciled).toBe(true);
  });

  it("uses the Plaid authorized date when creating a transaction", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const groceries = await createAccount({ name: "Groceries", type: "expense" });

    const token = await createPlaidToken({
      financialInstitution: "Chase",
      itemId: "item-authdate",
      accessToken: "token",
    });
    const link = await createPlaidAccount({
      tokenId: token.id,
      plaidAccountId: "plaid-checking",
      name: "Plaid Checking",
      type: "depository",
      subtype: "checking",
      counterpoiseAccountId: checking.id,
    });

    const recon = await createPlaidReconciliation({
      plaidAccountLinkId: link.id,
      plaidTransactionId: "txn-authdate",
      date: "2026-02-10",
      authorizedDate: "2026-02-08",
      amountCents: 3210,
      name: "Trader Joe's",
      merchantName: "Trader Joe's",
      resolutionStatus: "pending",
    });

    const response = await POST(
      new Request(`http://localhost/api/sync/accounts/${link.id}/reconcile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create",
          reconciliationId: recon.id,
          counterAccountId: groceries.id,
        }),
      }),
      { params: Promise.resolve({ bookId: "1", id: String(link.id) }) }
    );

    expect(response.status).toBe(200);
    const payload = await response.json();

    const db = getDb();
    const created = await db.query.transactions.findFirst({
      where: eq(transactions.id, payload.matchedTransactionId),
    });
    expect(created?.date).toBe("2026-02-08");
  });

  it("falls back to the posted date when no authorized date exists", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const groceries = await createAccount({ name: "Groceries", type: "expense" });

    const token = await createPlaidToken({
      financialInstitution: "Chase",
      itemId: "item-nodate",
      accessToken: "token",
    });
    const link = await createPlaidAccount({
      tokenId: token.id,
      plaidAccountId: "plaid-checking",
      name: "Plaid Checking",
      type: "depository",
      subtype: "checking",
      counterpoiseAccountId: checking.id,
    });

    const recon = await createPlaidReconciliation({
      plaidAccountLinkId: link.id,
      plaidTransactionId: "txn-nodate",
      date: "2026-02-10",
      authorizedDate: null,
      amountCents: 3210,
      name: "Trader Joe's",
      merchantName: "Trader Joe's",
      resolutionStatus: "pending",
    });

    const response = await POST(
      new Request(`http://localhost/api/sync/accounts/${link.id}/reconcile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create",
          reconciliationId: recon.id,
          counterAccountId: groceries.id,
        }),
      }),
      { params: Promise.resolve({ bookId: "1", id: String(link.id) }) }
    );

    expect(response.status).toBe(200);
    const payload = await response.json();

    const db = getDb();
    const created = await db.query.transactions.findFirst({
      where: eq(transactions.id, payload.matchedTransactionId),
    });
    expect(created?.date).toBe("2026-02-10");
  });

  it("supports ignore, keep_local, and unlink state transitions", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const groceries = await createAccount({ name: "Groceries", type: "expense" });

    const token = await createPlaidToken({
      financialInstitution: "Chase",
      itemId: "item-d",
      accessToken: "token",
    });
    const link = await createPlaidAccount({
      tokenId: token.id,
      plaidAccountId: "plaid-checking",
      name: "Plaid Checking",
      type: "depository",
      subtype: "checking",
      counterpoiseAccountId: checking.id,
    });

    const tx = await createTransactionWithSplits({
      date: "2026-02-08",
      description: "keep local",
      splits: [
        { accountId: checking.id, amount: -700 },
        { accountId: groceries.id, amount: 700 },
      ],
    });

    const ignoreRecon = await createPlaidReconciliation({
      plaidAccountLinkId: link.id,
      plaidTransactionId: "txn-ignore",
      date: "2026-02-08",
      amountCents: 700,
      name: "Ignore me",
      resolutionStatus: "pending",
    });

    const reviewRecon = await createPlaidReconciliation({
      plaidAccountLinkId: link.id,
      plaidTransactionId: "txn-review",
      date: "2026-02-08",
      amountCents: 700,
      name: "Review me",
      resolutionStatus: "matched",
      reviewReason: "plaid_modified",
      matchedTransactionId: tx.id,
    });

    const ignoreRes = await POST(
      new Request(`http://localhost/api/sync/accounts/${link.id}/reconcile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "ignore",
          reconciliationId: ignoreRecon.id,
        }),
      }),
      { params: Promise.resolve({ bookId: "1", id: String(link.id) }) }
    );

    expect(ignoreRes.status).toBe(200);
    const ignorePayload = await ignoreRes.json();
    expect(ignorePayload.resolutionStatus).toBe("ignored");

    const keepRes = await POST(
      new Request(`http://localhost/api/sync/accounts/${link.id}/reconcile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "keep_local",
          reconciliationId: reviewRecon.id,
        }),
      }),
      { params: Promise.resolve({ bookId: "1", id: String(link.id) }) }
    );

    expect(keepRes.status).toBe(200);
    const keepPayload = await keepRes.json();
    expect(keepPayload.reviewReason).toBeNull();
    expect(keepPayload.resolutionStatus).toBe("matched");
    expect(keepPayload.matchedTransactionId).toBe(tx.id);

    const unlinkRes = await POST(
      new Request(`http://localhost/api/sync/accounts/${link.id}/reconcile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "unlink",
          reconciliationId: reviewRecon.id,
        }),
      }),
      { params: Promise.resolve({ bookId: "1", id: String(link.id) }) }
    );

    expect(unlinkRes.status).toBe(200);
    const unlinkPayload = await unlinkRes.json();
    expect(unlinkPayload.resolutionStatus).toBe("pending");
    expect(unlinkPayload.matchedTransactionId).toBeNull();

    const db = getDb();
    const rows = await db
      .select({
        resolutionStatus: plaidTransactionReconciliation.resolutionStatus,
        matchedTransactionId: plaidTransactionReconciliation.matchedTransactionId,
        reviewReason: plaidTransactionReconciliation.reviewReason,
      })
      .from(plaidTransactionReconciliation)
      .where(
        and(
          eq(plaidTransactionReconciliation.id, reviewRecon.id),
          eq(plaidTransactionReconciliation.plaidAccountLinkId, link.id)
        )
      );

    expect(rows[0].resolutionStatus).toBe("pending");
    expect(rows[0].matchedTransactionId).toBeNull();
    expect(rows[0].reviewReason).toBeNull();
  });

  it("emits sync_transaction_matched event on match action", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const groceries = await createAccount({ name: "Groceries", type: "expense" });

    const token = await createPlaidToken({
      financialInstitution: "Chase",
      itemId: "item-ev-1",
      accessToken: "token-ev",
    });
    const link = await createPlaidAccount({
      tokenId: token.id,
      plaidAccountId: "plaid-ev-checking",
      name: "Plaid EV Checking",
      type: "depository",
      subtype: "checking",
      counterpoiseAccountId: checking.id,
    });

    const tx = await createTransactionWithSplits({
      date: "2026-02-10",
      description: "Test Match",
      splits: [
        { accountId: checking.id, amount: -2000 },
        { accountId: groceries.id, amount: 2000 },
      ],
    });

    const recon = await createPlaidReconciliation({
      plaidAccountLinkId: link.id,
      plaidTransactionId: "txn-ev-1",
      date: "2026-02-10",
      amountCents: 2000,
      name: "Test Match",
    });

    const req = new Request("http://localhost/api/sync/accounts/1/reconcile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reconciliationId: recon.id,
        action: "match",
        transactionId: tx.id,
      }),
    });

    const res = await POST(req, {
      params: Promise.resolve({ bookId: "1", id: String(link.id) }),
    });

    expect(res.status).toBe(200);
    expect(captureEvent).toHaveBeenCalledWith(
      expect.any(Number),
      "sync_transaction_matched",
      { bookId: 1 }
    );
  });

  it("emits sync_transaction_created event on create action", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const groceries = await createAccount({ name: "Groceries", type: "expense" });

    const token = await createPlaidToken({
      financialInstitution: "Chase",
      itemId: "item-ev-2",
      accessToken: "token-ev-2",
    });
    const link = await createPlaidAccount({
      tokenId: token.id,
      plaidAccountId: "plaid-ev-checking-2",
      name: "Plaid EV Checking 2",
      type: "depository",
      subtype: "checking",
      counterpoiseAccountId: checking.id,
    });

    const recon = await createPlaidReconciliation({
      plaidAccountLinkId: link.id,
      plaidTransactionId: "txn-ev-2",
      date: "2026-02-10",
      amountCents: 3000,
      name: "New Purchase",
    });

    const req = new Request("http://localhost/api/sync/accounts/1/reconcile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reconciliationId: recon.id,
        action: "create",
        counterAccountId: groceries.id,
      }),
    });

    const res = await POST(req, {
      params: Promise.resolve({ bookId: "1", id: String(link.id) }),
    });

    expect(res.status).toBe(200);
    expect(captureEvent).toHaveBeenCalledWith(
      expect.any(Number),
      "sync_transaction_created",
      { bookId: 1 }
    );
  });

  it("match_update_amount adjusts 2-split transaction to plaid amount", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const dining = await createAccount({ name: "Dining", type: "expense" });

    const token = await createPlaidToken({
      financialInstitution: "Chase",
      itemId: "item-mua",
      accessToken: "token-mua",
    });
    const link = await createPlaidAccount({
      tokenId: token.id,
      plaidAccountId: "plaid-mua-checking",
      name: "Plaid MUA Checking",
      type: "depository",
      subtype: "checking",
      counterpoiseAccountId: checking.id,
    });

    // Local transaction: $50.00 (user forgot the $8 tip)
    const tx = await createTransactionWithSplits({
      date: "2026-02-08",
      description: "Restaurant",
      splits: [
        { accountId: checking.id, amount: -5000 },
        { accountId: dining.id, amount: 5000 },
      ],
    });

    // Plaid shows $58.00
    const recon = await createPlaidReconciliation({
      plaidAccountLinkId: link.id,
      plaidTransactionId: "txn-mua-1",
      date: "2026-02-08",
      amountCents: 5800,
      name: "Restaurant",
    });

    const res = await POST(
      new Request(`http://localhost/api/sync/accounts/${link.id}/reconcile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "match_update_amount",
          reconciliationId: recon.id,
          transactionId: tx.id,
        }),
      }),
      { params: Promise.resolve({ bookId: "1", id: String(link.id) }) }
    );

    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.resolutionStatus).toBe("matched");
    expect(payload.matchedTransactionId).toBe(tx.id);

    // Verify splits were updated to Plaid amount
    const db = getDb();
    const splits = await db
      .select({ accountId: transactionSplits.accountId, amount: transactionSplits.amount })
      .from(transactionSplits)
      .where(eq(transactionSplits.transactionId, tx.id));

    expect(splits).toEqual(
      expect.arrayContaining([
        { accountId: checking.id, amount: -5800 },
        { accountId: dining.id, amount: 5800 },
      ])
    );

    // Verify transaction is reconciled
    const matched = await db.query.transactions.findFirst({
      where: eq(transactions.id, tx.id),
    });
    expect(matched?.isReconciled).toBe(true);
  });

  it("match_update_amount rejects transactions with more than 2 splits", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const dining = await createAccount({ name: "Dining", type: "expense" });
    const tips = await createAccount({ name: "Tips", type: "expense" });

    const token = await createPlaidToken({
      financialInstitution: "Chase",
      itemId: "item-mua-multi",
      accessToken: "token-mua-multi",
    });
    const link = await createPlaidAccount({
      tokenId: token.id,
      plaidAccountId: "plaid-mua-multi",
      name: "Plaid MUA Multi",
      type: "depository",
      subtype: "checking",
      counterpoiseAccountId: checking.id,
    });

    // 3-split transaction
    const tx = await createTransactionWithSplits({
      date: "2026-02-08",
      description: "Split dinner",
      splits: [
        { accountId: checking.id, amount: -5000 },
        { accountId: dining.id, amount: 4000 },
        { accountId: tips.id, amount: 1000 },
      ],
    });

    const recon = await createPlaidReconciliation({
      plaidAccountLinkId: link.id,
      plaidTransactionId: "txn-mua-multi",
      date: "2026-02-08",
      amountCents: 5800,
      name: "Split dinner",
    });

    const res = await POST(
      new Request(`http://localhost/api/sync/accounts/${link.id}/reconcile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "match_update_amount",
          reconciliationId: recon.id,
          transactionId: tx.id,
        }),
      }),
      { params: Promise.resolve({ bookId: "1", id: String(link.id) }) }
    );

    expect(res.status).toBe(400);
    const payload = await res.json();
    expect(payload.error).toMatch(/2 splits/i);
  });

  it("emits sync_transaction_amount_updated event on match_update_amount", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const dining = await createAccount({ name: "Dining", type: "expense" });

    const token = await createPlaidToken({
      financialInstitution: "Chase",
      itemId: "item-mua-ev",
      accessToken: "token-mua-ev",
    });
    const link = await createPlaidAccount({
      tokenId: token.id,
      plaidAccountId: "plaid-mua-ev",
      name: "Plaid MUA EV",
      type: "depository",
      subtype: "checking",
      counterpoiseAccountId: checking.id,
    });

    const tx = await createTransactionWithSplits({
      date: "2026-02-08",
      description: "Cafe",
      splits: [
        { accountId: checking.id, amount: -1000 },
        { accountId: dining.id, amount: 1000 },
      ],
    });

    const recon = await createPlaidReconciliation({
      plaidAccountLinkId: link.id,
      plaidTransactionId: "txn-mua-ev",
      date: "2026-02-08",
      amountCents: 1200,
      name: "Cafe",
    });

    const res = await POST(
      new Request(`http://localhost/api/sync/accounts/${link.id}/reconcile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "match_update_amount",
          reconciliationId: recon.id,
          transactionId: tx.id,
        }),
      }),
      { params: Promise.resolve({ bookId: "1", id: String(link.id) }) }
    );

    expect(res.status).toBe(200);
    expect(captureEvent).toHaveBeenCalledWith(
      expect.any(Number),
      "sync_transaction_amount_updated",
      { bookId: 1 }
    );
  });

  it("match_update_amount rejects investment-backed transactions", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const investmentAcct = await createAccount({
      name: "Brokerage",
      type: "asset",
      subtype: "investment",
    });

    const security = await createSecurity({
      name: "VTI",
      symbol: "VTI",
      securityType: "etf",
    });

    const token = await createPlaidToken({
      financialInstitution: "Chase",
      itemId: "item-mua-inv",
      accessToken: "token-mua-inv",
    });
    const link = await createPlaidAccount({
      tokenId: token.id,
      plaidAccountId: "plaid-mua-inv",
      name: "Plaid MUA Inv",
      type: "depository",
      subtype: "checking",
      counterpoiseAccountId: checking.id,
    });

    // 2-split investment buy (cash + security account)
    const tx = await createTransactionWithSplits({
      date: "2026-02-08",
      description: "Buy VTI",
      splits: [
        { accountId: checking.id, amount: -10000 },
        { accountId: investmentAcct.id, amount: 10000 },
      ],
    });

    await createInvestmentSplit({
      transactionId: tx.id,
      accountId: investmentAcct.id,
      securityId: security.id,
      action: "buy",
      sharesMicros: 1_000_000,
      priceMicros: 100_000_000,
    });

    const recon = await createPlaidReconciliation({
      plaidAccountLinkId: link.id,
      plaidTransactionId: "txn-mua-inv",
      date: "2026-02-08",
      amountCents: 10500,
      name: "Buy VTI",
    });

    const res = await POST(
      new Request(`http://localhost/api/sync/accounts/${link.id}/reconcile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "match_update_amount",
          reconciliationId: recon.id,
          transactionId: tx.id,
        }),
      }),
      { params: Promise.resolve({ bookId: "1", id: String(link.id) }) }
    );

    expect(res.status).toBe(400);
    const payload = await res.json();
    expect(payload.error).toMatch(/investment/i);
  });

  it("match_update_amount rejects when both splits are on the linked account", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });

    const token = await createPlaidToken({
      financialInstitution: "Chase",
      itemId: "item-mua-dup",
      accessToken: "token-mua-dup",
    });
    const link = await createPlaidAccount({
      tokenId: token.id,
      plaidAccountId: "plaid-mua-dup",
      name: "Plaid MUA Dup",
      type: "depository",
      subtype: "checking",
      counterpoiseAccountId: checking.id,
    });

    // Unusual 2-split transaction where both splits hit the same account
    const tx = await createTransactionWithSplits({
      date: "2026-02-08",
      description: "Self transfer",
      splits: [
        { accountId: checking.id, amount: -500 },
        { accountId: checking.id, amount: 500 },
      ],
    });

    const recon = await createPlaidReconciliation({
      plaidAccountLinkId: link.id,
      plaidTransactionId: "txn-mua-dup",
      date: "2026-02-08",
      amountCents: 500,
      name: "Self transfer",
    });

    const res = await POST(
      new Request(`http://localhost/api/sync/accounts/${link.id}/reconcile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "match_update_amount",
          reconciliationId: recon.id,
          transactionId: tx.id,
        }),
      }),
      { params: Promise.resolve({ bookId: "1", id: String(link.id) }) }
    );

    expect(res.status).toBe(400);
    const payload = await res.json();
    expect(payload.error).toMatch(/counterpart/i);
  });

  it("emits sync_transaction_ignored event on ignore action", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });

    const token = await createPlaidToken({
      financialInstitution: "Chase",
      itemId: "item-ev-3",
      accessToken: "token-ev-3",
    });
    const link = await createPlaidAccount({
      tokenId: token.id,
      plaidAccountId: "plaid-ev-checking-3",
      name: "Plaid EV Checking 3",
      type: "depository",
      subtype: "checking",
      counterpoiseAccountId: checking.id,
    });

    const recon = await createPlaidReconciliation({
      plaidAccountLinkId: link.id,
      plaidTransactionId: "txn-ev-3",
      date: "2026-02-10",
      amountCents: 500,
      name: "Ignore Me",
    });

    const req = new Request("http://localhost/api/sync/accounts/1/reconcile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reconciliationId: recon.id,
        action: "ignore",
      }),
    });

    const res = await POST(req, {
      params: Promise.resolve({ bookId: "1", id: String(link.id) }),
    });

    expect(res.status).toBe(200);
    expect(captureEvent).toHaveBeenCalledWith(
      expect.any(Number),
      "sync_transaction_ignored",
      { bookId: 1 }
    );
  });
});
