import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildPayeeMap,
  autoMatchPendingTransactions,
  pickMatchedDate,
} from "@/lib/plaid-auto-match";
import { captureEvent } from "@/lib/posthog-server";
import { SyncTokenResult } from "@/lib/plaid-sync";
import { getDb } from "@/db";
import {
  createAccount,
  createPayee,
  createPlaidAccount,
  createPlaidReconciliation,
  createPlaidToken,
  createTransactionWithSplits,
  resetTestDatabase,
  setupTestDatabase,
} from "@/tests/helpers/db";
import { db } from "@/tests/helpers/db-utils";
import { plaidTransactionReconciliation, transactions } from "@/db/schema";
import { eq } from "drizzle-orm";

/**
 * Run `matcher` against a reconciliation row that a human resolves first.
 *
 * The open transaction holds the row lock while `matcher` starts on another
 * pooled connection: auto-match reads the row while it is still pending, then
 * blocks on its own UPDATE until this transaction commits — at which point its
 * guarded WHERE re-evaluates against the human's committed write and matches
 * zero rows. Deterministic, rather than dependent on scheduling luck.
 */
async function raceAgainstManualMatch<T>(
  reconId: number,
  humansTransactionId: number,
  matcher: () => Promise<T>
): Promise<T> {
  let pending: Promise<T> | undefined;

  await db.transaction(async (tx) => {
    await tx
      .update(plaidTransactionReconciliation)
      .set({
        resolutionStatus: "matched",
        matchedTransactionId: humansTransactionId,
        resolvedAt: new Date(),
      })
      .where(eq(plaidTransactionReconciliation.id, reconId));

    pending = matcher();
    // Give auto-match time to read and reach its (blocking) write.
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  return pending!;
}

/**
 * Run `matcher` against a reconciliation row that a concurrent sync flags for
 * human review (e.g. stageRemovedTransactions setting reviewReason) between
 * the read and the claim, without touching resolutionStatus.
 *
 * Same locking technique as raceAgainstManualMatch: the open transaction
 * holds the row lock while `matcher` reads the row as still eligible (the
 * flag isn't visible yet), then blocks on its own claim UPDATE until this
 * transaction commits and the flag becomes visible.
 */
async function raceAgainstReviewFlag<T>(
  reconId: number,
  matcher: () => Promise<T>
): Promise<T> {
  let pending: Promise<T> | undefined;

  await db.transaction(async (tx) => {
    await tx
      .update(plaidTransactionReconciliation)
      .set({ reviewReason: "plaid_removed" })
      .where(eq(plaidTransactionReconciliation.id, reconId));

    pending = matcher();
    // Give auto-match time to read and reach its (blocking) write.
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  return pending!;
}

vi.mock("@/lib/posthog-server", () => ({
  captureEvent: vi.fn(),
}));

describe("pickMatchedDate", () => {
  it("keeps the authorized date when the posted date is less than 7 days later", () => {
    expect(pickMatchedDate("2026-03-10", "2026-03-12")).toBe("2026-03-10");
  });

  it("keeps the authorized date at the 6-day boundary", () => {
    expect(pickMatchedDate("2026-03-10", "2026-03-16")).toBe("2026-03-10");
  });

  it("uses the posted date at exactly 7 days", () => {
    expect(pickMatchedDate("2026-03-10", "2026-03-17")).toBe("2026-03-17");
  });

  it("uses the posted date when it is far after authorization", () => {
    expect(pickMatchedDate("2026-03-10", "2026-04-01")).toBe("2026-04-01");
  });

  it("uses the posted date when there is no authorized date", () => {
    expect(pickMatchedDate(null, "2026-03-10")).toBe("2026-03-10");
  });

  it("keeps the date when authorized equals posted", () => {
    expect(pickMatchedDate("2026-03-10", "2026-03-10")).toBe("2026-03-10");
  });
});

describe("buildPayeeMap", () => {
  const db = getDb();

  beforeAll(async () => {
    await setupTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("builds map from previously matched reconciliation rows", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const groceries = await createAccount({ name: "Groceries", type: "expense" });
    const payee = await createPayee({ name: "Blue Bottle" });
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
      date: "2026-03-01",
      description: "Blue Bottle",
      payeeId: payee.id,
      splits: [
        { accountId: checking.id, amount: -500 },
        { accountId: groceries.id, amount: 500 },
      ],
    });
    await createPlaidReconciliation({
      plaidAccountLinkId: link.id,
      plaidTransactionId: "ptx-1",
      date: "2026-03-01",
      amountCents: 500,
      name: "BLUE BOTTLE COFFEE",
      merchantName: "Blue Bottle Coffee",
      resolutionStatus: "matched",
      matchedTransactionId: txn.id,
    });

    const map = await buildPayeeMap(db, 1);

    const key = "blue bottle coffee";
    expect(map.has(key)).toBe(true);
    expect(map.get(key)!.has(payee.id)).toBe(true);
  });

  it("returns empty map when no matched reconciliations exist", async () => {
    const map = await buildPayeeMap(db, 1);
    expect(map.size).toBe(0);
  });

  it("falls back to name when merchantName is null", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const groceries = await createAccount({ name: "Groceries", type: "expense" });
    const payee = await createPayee({ name: "Venmo" });
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
      date: "2026-03-01",
      description: "Venmo payment",
      payeeId: payee.id,
      splits: [
        { accountId: checking.id, amount: -2000 },
        { accountId: groceries.id, amount: 2000 },
      ],
    });
    await createPlaidReconciliation({
      plaidAccountLinkId: link.id,
      plaidTransactionId: "ptx-2",
      date: "2026-03-01",
      amountCents: 2000,
      name: "VENMO PAYMENT",
      merchantName: null,
      resolutionStatus: "matched",
      matchedTransactionId: txn.id,
    });

    const map = await buildPayeeMap(db, 1);
    expect(map.has("venmo payment")).toBe(true);
    expect(map.get("venmo payment")!.has(payee.id)).toBe(true);
  });

  it("skips matched rows where transaction has no payee", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const groceries = await createAccount({ name: "Groceries", type: "expense" });
    const token = await createPlaidToken({
      financialInstitution: "Chase",
      itemId: "item-3",
      accessToken: "tok3",
    });
    const link = await createPlaidAccount({
      tokenId: token.id,
      plaidAccountId: "pa-3",
      name: "Plaid Checking",
      type: "depository",
      counterpoiseAccountId: checking.id,
    });
    const txn = await createTransactionWithSplits({
      date: "2026-03-01",
      description: "Mystery",
      splits: [
        { accountId: checking.id, amount: -1000 },
        { accountId: groceries.id, amount: 1000 },
      ],
    });
    await createPlaidReconciliation({
      plaidAccountLinkId: link.id,
      plaidTransactionId: "ptx-3",
      date: "2026-03-01",
      amountCents: 1000,
      name: "MYSTERY CHARGE",
      resolutionStatus: "matched",
      matchedTransactionId: txn.id,
    });

    const map = await buildPayeeMap(db, 1);
    expect(map.size).toBe(0);
  });

  it("maps same plaid name to multiple payee IDs", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const groceries = await createAccount({ name: "Groceries", type: "expense" });
    const payee1 = await createPayee({ name: "Amazon" });
    const payee2 = await createPayee({ name: "Amazon Prime" });
    const token = await createPlaidToken({
      financialInstitution: "Chase",
      itemId: "item-4",
      accessToken: "tok4",
    });
    const link = await createPlaidAccount({
      tokenId: token.id,
      plaidAccountId: "pa-4",
      name: "Plaid Checking",
      type: "depository",
      counterpoiseAccountId: checking.id,
    });

    const txn1 = await createTransactionWithSplits({
      date: "2026-03-01",
      description: "Amazon",
      payeeId: payee1.id,
      splits: [
        { accountId: checking.id, amount: -1000 },
        { accountId: groceries.id, amount: 1000 },
      ],
    });
    const txn2 = await createTransactionWithSplits({
      date: "2026-03-02",
      description: "Amazon Prime",
      payeeId: payee2.id,
      splits: [
        { accountId: checking.id, amount: -1500 },
        { accountId: groceries.id, amount: 1500 },
      ],
    });

    await createPlaidReconciliation({
      plaidAccountLinkId: link.id,
      plaidTransactionId: "ptx-4a",
      date: "2026-03-01",
      amountCents: 1000,
      name: "AMAZON",
      merchantName: "Amazon",
      resolutionStatus: "matched",
      matchedTransactionId: txn1.id,
    });
    await createPlaidReconciliation({
      plaidAccountLinkId: link.id,
      plaidTransactionId: "ptx-4b",
      date: "2026-03-02",
      amountCents: 1500,
      name: "AMAZON",
      merchantName: "Amazon",
      resolutionStatus: "matched",
      matchedTransactionId: txn2.id,
    });

    const map = await buildPayeeMap(db, 1);
    const amazonPayees = map.get("amazon");
    expect(amazonPayees).toBeDefined();
    expect(amazonPayees!.size).toBe(2);
    expect(amazonPayees!.has(payee1.id)).toBe(true);
    expect(amazonPayees!.has(payee2.id)).toBe(true);
  });
});

describe("autoMatchPendingTransactions", () => {
  const db = getDb();

  beforeAll(async () => {
    await setupTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  async function setupLinkedAccount() {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const groceries = await createAccount({ name: "Groceries", type: "expense" });
    const payee = await createPayee({ name: "Blue Bottle" });
    const token = await createPlaidToken({
      financialInstitution: "Chase",
      itemId: "item-am",
      accessToken: "tok-am",
    });
    const link = await createPlaidAccount({
      tokenId: token.id,
      plaidAccountId: "pa-am",
      name: "Plaid Checking",
      type: "depository",
      counterpoiseAccountId: checking.id,
    });
    return { checking, groceries, payee, token, link };
  }

  async function createMatchedHistory(
    linkId: number,
    checkingId: number,
    groceriesId: number,
    payeeId: number
  ) {
    const historyTxn = await createTransactionWithSplits({
      date: "2026-02-15",
      description: "Blue Bottle",
      payeeId,
      splits: [
        { accountId: checkingId, amount: -400 },
        { accountId: groceriesId, amount: 400 },
      ],
    });
    await createPlaidReconciliation({
      plaidAccountLinkId: linkId,
      plaidTransactionId: "ptx-history",
      date: "2026-02-15",
      amountCents: 400,
      name: "BLUE BOTTLE COFFEE",
      merchantName: "Blue Bottle Coffee",
      resolutionStatus: "matched",
      matchedTransactionId: historyTxn.id,
    });
  }

  it("auto-matches a pending row with exact amount and date within 1 day", async () => {
    const { checking, groceries, payee, link } = await setupLinkedAccount();
    await createMatchedHistory(link.id, checking.id, groceries.id, payee.id);

    const txn = await createTransactionWithSplits({
      date: "2026-03-10",
      description: "Blue Bottle",
      payeeId: payee.id,
      splits: [
        { accountId: checking.id, amount: -500 },
        { accountId: groceries.id, amount: 500 },
      ],
    });

    const recon = await createPlaidReconciliation({
      plaidAccountLinkId: link.id,
      plaidTransactionId: "ptx-new-1",
      date: "2026-03-10",
      amountCents: 500,
      name: "BLUE BOTTLE COFFEE",
      merchantName: "Blue Bottle Coffee",
      resolutionStatus: "pending",
    });

    const count = await autoMatchPendingTransactions(db, 1, [link.id]);
    expect(count).toBe(1);

    const [updated] = await db
      .select()
      .from(plaidTransactionReconciliation)
      .where(eq(plaidTransactionReconciliation.id, recon.id));
    expect(updated.resolutionStatus).toBe("matched");
    expect(updated.matchedTransactionId).toBe(txn.id);
    expect(updated.resolvedAt).not.toBeNull();

    const [updatedTxn] = await db
      .select()
      .from(transactions)
      .where(eq(transactions.id, txn.id));
    expect(updatedTxn.isReconciled).toBe(true);
  });

  it("captures a sync_transaction_auto_matched event for each match", async () => {
    vi.mocked(captureEvent).mockClear();
    const { checking, groceries, payee, link } = await setupLinkedAccount();
    await createMatchedHistory(link.id, checking.id, groceries.id, payee.id);

    await createTransactionWithSplits({
      date: "2026-03-10",
      description: "Blue Bottle",
      payeeId: payee.id,
      splits: [
        { accountId: checking.id, amount: -500 },
        { accountId: groceries.id, amount: 500 },
      ],
    });
    await createPlaidReconciliation({
      plaidAccountLinkId: link.id,
      plaidTransactionId: "ptx-event-1",
      date: "2026-03-10",
      amountCents: 500,
      name: "BLUE BOTTLE COFFEE",
      merchantName: "Blue Bottle Coffee",
      resolutionStatus: "pending",
    });

    const count = await autoMatchPendingTransactions(db, 1, [link.id]);
    expect(count).toBe(1);

    expect(captureEvent).toHaveBeenCalledTimes(1);
    expect(captureEvent).toHaveBeenCalledWith(1, "sync_transaction_auto_matched", {
      bookId: 1,
    });
  });

  it("does not capture events when nothing matches", async () => {
    vi.mocked(captureEvent).mockClear();
    const { link } = await setupLinkedAccount();

    const count = await autoMatchPendingTransactions(db, 1, [link.id]);
    expect(count).toBe(0);
    expect(captureEvent).not.toHaveBeenCalled();
  });

  it("matches when date differs by exactly 1 day", async () => {
    const { checking, groceries, payee, link } = await setupLinkedAccount();
    await createMatchedHistory(link.id, checking.id, groceries.id, payee.id);

    await createTransactionWithSplits({
      date: "2026-03-11",
      description: "Blue Bottle",
      payeeId: payee.id,
      splits: [
        { accountId: checking.id, amount: -500 },
        { accountId: groceries.id, amount: 500 },
      ],
    });

    await createPlaidReconciliation({
      plaidAccountLinkId: link.id,
      plaidTransactionId: "ptx-new-2",
      date: "2026-03-10",
      amountCents: 500,
      name: "BLUE BOTTLE COFFEE",
      merchantName: "Blue Bottle Coffee",
      resolutionStatus: "pending",
    });

    const count = await autoMatchPendingTransactions(db, 1, [link.id]);
    expect(count).toBe(1);
  });

  it("skips when date differs by more than 1 day", async () => {
    const { checking, groceries, payee, link } = await setupLinkedAccount();
    await createMatchedHistory(link.id, checking.id, groceries.id, payee.id);

    await createTransactionWithSplits({
      date: "2026-03-13",
      description: "Blue Bottle",
      payeeId: payee.id,
      splits: [
        { accountId: checking.id, amount: -500 },
        { accountId: groceries.id, amount: 500 },
      ],
    });

    await createPlaidReconciliation({
      plaidAccountLinkId: link.id,
      plaidTransactionId: "ptx-new-3",
      date: "2026-03-10",
      amountCents: 500,
      name: "BLUE BOTTLE COFFEE",
      merchantName: "Blue Bottle Coffee",
      resolutionStatus: "pending",
    });

    const count = await autoMatchPendingTransactions(db, 1, [link.id]);
    expect(count).toBe(0);
  });

  it("skips when amount does not match exactly", async () => {
    const { checking, groceries, payee, link } = await setupLinkedAccount();
    await createMatchedHistory(link.id, checking.id, groceries.id, payee.id);

    await createTransactionWithSplits({
      date: "2026-03-10",
      description: "Blue Bottle",
      payeeId: payee.id,
      splits: [
        { accountId: checking.id, amount: -501 },
        { accountId: groceries.id, amount: 501 },
      ],
    });

    await createPlaidReconciliation({
      plaidAccountLinkId: link.id,
      plaidTransactionId: "ptx-new-4",
      date: "2026-03-10",
      amountCents: 500,
      name: "BLUE BOTTLE COFFEE",
      merchantName: "Blue Bottle Coffee",
      resolutionStatus: "pending",
    });

    const count = await autoMatchPendingTransactions(db, 1, [link.id]);
    expect(count).toBe(0);
  });

  it("skips when plaid name is not in learned payee map", async () => {
    const { checking, groceries, payee, link } = await setupLinkedAccount();
    await createMatchedHistory(link.id, checking.id, groceries.id, payee.id);

    await createTransactionWithSplits({
      date: "2026-03-10",
      description: "Starbucks",
      payeeId: payee.id,
      splits: [
        { accountId: checking.id, amount: -500 },
        { accountId: groceries.id, amount: 500 },
      ],
    });

    await createPlaidReconciliation({
      plaidAccountLinkId: link.id,
      plaidTransactionId: "ptx-new-5",
      date: "2026-03-10",
      amountCents: 500,
      name: "STARBUCKS",
      merchantName: "Starbucks",
      resolutionStatus: "pending",
    });

    const count = await autoMatchPendingTransactions(db, 1, [link.id]);
    expect(count).toBe(0);
  });

  it("matches first candidate when multiple exist, leaving the rest for other plaid rows", async () => {
    const { checking, groceries, payee, link } = await setupLinkedAccount();
    await createMatchedHistory(link.id, checking.id, groceries.id, payee.id);

    const txn1 = await createTransactionWithSplits({
      date: "2026-03-10",
      description: "Blue Bottle",
      payeeId: payee.id,
      splits: [
        { accountId: checking.id, amount: -500 },
        { accountId: groceries.id, amount: 500 },
      ],
    });
    const txn2 = await createTransactionWithSplits({
      date: "2026-03-10",
      description: "Blue Bottle",
      payeeId: payee.id,
      splits: [
        { accountId: checking.id, amount: -500 },
        { accountId: groceries.id, amount: 500 },
      ],
    });

    const recon1 = await createPlaidReconciliation({
      plaidAccountLinkId: link.id,
      plaidTransactionId: "ptx-new-6a",
      date: "2026-03-10",
      amountCents: 500,
      name: "BLUE BOTTLE COFFEE",
      merchantName: "Blue Bottle Coffee",
      resolutionStatus: "pending",
    });
    const recon2 = await createPlaidReconciliation({
      plaidAccountLinkId: link.id,
      plaidTransactionId: "ptx-new-6b",
      date: "2026-03-10",
      amountCents: 500,
      name: "BLUE BOTTLE COFFEE",
      merchantName: "Blue Bottle Coffee",
      resolutionStatus: "pending",
    });

    const count = await autoMatchPendingTransactions(db, 1, [link.id]);
    expect(count).toBe(2);

    // Both recon rows should be matched to different transactions
    const [updated1] = await db
      .select()
      .from(plaidTransactionReconciliation)
      .where(eq(plaidTransactionReconciliation.id, recon1.id));
    const [updated2] = await db
      .select()
      .from(plaidTransactionReconciliation)
      .where(eq(plaidTransactionReconciliation.id, recon2.id));

    expect(updated1.resolutionStatus).toBe("matched");
    expect(updated2.resolutionStatus).toBe("matched");
    // They should match different transactions
    expect(updated1.matchedTransactionId).not.toBe(updated2.matchedTransactionId);
    const matchedIds = new Set([updated1.matchedTransactionId, updated2.matchedTransactionId]);
    expect(matchedIds.has(txn1.id)).toBe(true);
    expect(matchedIds.has(txn2.id)).toBe(true);
  });

  it("skips candidates already linked to another reconciliation row", async () => {
    const { checking, groceries, payee, link } = await setupLinkedAccount();
    await createMatchedHistory(link.id, checking.id, groceries.id, payee.id);

    const txn = await createTransactionWithSplits({
      date: "2026-03-10",
      description: "Blue Bottle",
      payeeId: payee.id,
      splits: [
        { accountId: checking.id, amount: -500 },
        { accountId: groceries.id, amount: 500 },
      ],
    });

    await createPlaidReconciliation({
      plaidAccountLinkId: link.id,
      plaidTransactionId: "ptx-existing",
      date: "2026-03-10",
      amountCents: 500,
      name: "BLUE BOTTLE COFFEE",
      merchantName: "Blue Bottle Coffee",
      resolutionStatus: "matched",
      matchedTransactionId: txn.id,
    });

    await createPlaidReconciliation({
      plaidAccountLinkId: link.id,
      plaidTransactionId: "ptx-new-7",
      date: "2026-03-10",
      amountCents: 500,
      name: "BLUE BOTTLE COFFEE",
      merchantName: "Blue Bottle Coffee",
      resolutionStatus: "pending",
    });

    const count = await autoMatchPendingTransactions(db, 1, [link.id]);
    expect(count).toBe(0);
  });

  it("skips rows with reviewReason set", async () => {
    const { checking, groceries, payee, link } = await setupLinkedAccount();
    await createMatchedHistory(link.id, checking.id, groceries.id, payee.id);

    await createTransactionWithSplits({
      date: "2026-03-10",
      description: "Blue Bottle",
      payeeId: payee.id,
      splits: [
        { accountId: checking.id, amount: -500 },
        { accountId: groceries.id, amount: 500 },
      ],
    });

    await createPlaidReconciliation({
      plaidAccountLinkId: link.id,
      plaidTransactionId: "ptx-new-8",
      date: "2026-03-10",
      amountCents: 500,
      name: "BLUE BOTTLE COFFEE",
      merchantName: "Blue Bottle Coffee",
      resolutionStatus: "pending",
      reviewReason: "plaid_modified",
    });

    const count = await autoMatchPendingTransactions(db, 1, [link.id]);
    expect(count).toBe(0);
  });

  it("returns 0 when no pending rows exist", async () => {
    const { link } = await setupLinkedAccount();
    const count = await autoMatchPendingTransactions(db, 1, [link.id]);
    expect(count).toBe(0);
  });

  it("uses authorizedDate for date matching when available", async () => {
    const { checking, groceries, payee, link } = await setupLinkedAccount();
    await createMatchedHistory(link.id, checking.id, groceries.id, payee.id);

    await createTransactionWithSplits({
      date: "2026-03-09",
      description: "Blue Bottle",
      payeeId: payee.id,
      splits: [
        { accountId: checking.id, amount: -500 },
        { accountId: groceries.id, amount: 500 },
      ],
    });

    // Plaid date is March 11 (2 days off from txn), but authorizedDate is March 10 (1 day off)
    await createPlaidReconciliation({
      plaidAccountLinkId: link.id,
      plaidTransactionId: "ptx-new-9",
      date: "2026-03-11",
      authorizedDate: "2026-03-10",
      amountCents: 500,
      name: "BLUE BOTTLE COFFEE",
      merchantName: "Blue Bottle Coffee",
      resolutionStatus: "pending",
    });

    const count = await autoMatchPendingTransactions(db, 1, [link.id]);
    expect(count).toBe(1);
  });

  it("matches a delayed settlement entered on the posted date", async () => {
    const { checking, groceries, payee, link } = await setupLinkedAccount();
    await createMatchedHistory(link.id, checking.id, groceries.id, payee.id);

    // User entered the transaction on the settlement/posted date (March 20),
    // 10 days after authorization (March 10). The posted date is the meaningful
    // one here, so the candidate must match against it, not the auth date.
    await createTransactionWithSplits({
      date: "2026-03-20",
      description: "Blue Bottle",
      payeeId: payee.id,
      splits: [
        { accountId: checking.id, amount: -500 },
        { accountId: groceries.id, amount: 500 },
      ],
    });

    await createPlaidReconciliation({
      plaidAccountLinkId: link.id,
      plaidTransactionId: "ptx-delayed-1",
      date: "2026-03-20",
      authorizedDate: "2026-03-10",
      amountCents: 500,
      name: "BLUE BOTTLE COFFEE",
      merchantName: "Blue Bottle Coffee",
      resolutionStatus: "pending",
    });

    const count = await autoMatchPendingTransactions(db, 1, [link.id]);
    expect(count).toBe(1);
  });

  it("still matches a delayed settlement entered on the authorization date", async () => {
    const { checking, groceries, payee, link } = await setupLinkedAccount();
    await createMatchedHistory(link.id, checking.id, groceries.id, payee.id);

    // Same 10-day gap, but the user entered the transaction on the
    // authorization date (March 10). Widening the window must not drop this.
    await createTransactionWithSplits({
      date: "2026-03-10",
      description: "Blue Bottle",
      payeeId: payee.id,
      splits: [
        { accountId: checking.id, amount: -500 },
        { accountId: groceries.id, amount: 500 },
      ],
    });

    await createPlaidReconciliation({
      plaidAccountLinkId: link.id,
      plaidTransactionId: "ptx-delayed-2",
      date: "2026-03-20",
      authorizedDate: "2026-03-10",
      amountCents: 500,
      name: "BLUE BOTTLE COFFEE",
      merchantName: "Blue Bottle Coffee",
      resolutionStatus: "pending",
    });

    const count = await autoMatchPendingTransactions(db, 1, [link.id]);
    expect(count).toBe(1);
  });

  it("does not match a transaction in the settlement gap of a delayed settlement", async () => {
    const { checking, groceries, payee, link } = await setupLinkedAccount();
    await createMatchedHistory(link.id, checking.id, groceries.id, payee.id);

    // Transaction dated March 15 sits in the gap: >1 day from both the
    // authorization (March 10) and posted (March 20) dates. The widened window
    // is ±1 of EACH anchor, not the whole range between them, so this must
    // remain unmatched.
    await createTransactionWithSplits({
      date: "2026-03-15",
      description: "Blue Bottle",
      payeeId: payee.id,
      splits: [
        { accountId: checking.id, amount: -500 },
        { accountId: groceries.id, amount: 500 },
      ],
    });

    await createPlaidReconciliation({
      plaidAccountLinkId: link.id,
      plaidTransactionId: "ptx-delayed-3",
      date: "2026-03-20",
      authorizedDate: "2026-03-10",
      amountCents: 500,
      name: "BLUE BOTTLE COFFEE",
      merchantName: "Blue Bottle Coffee",
      resolutionStatus: "pending",
    });

    const count = await autoMatchPendingTransactions(db, 1, [link.id]);
    expect(count).toBe(0);
  });

  it("picks the posted-date candidate over the authorization-date candidate for a delayed settlement", async () => {
    const { checking, groceries, payee, link } = await setupLinkedAccount();
    await createMatchedHistory(link.id, checking.id, groceries.id, payee.id);

    // Two same-payee, same-amount transactions straddle a 10-day auth->posted
    // gap: one on the authorization date (March 10), one on the posted date
    // (March 20). The widened window makes both valid candidates. Because the
    // gap is >= 7 days, the match will be stamped to the posted date, so the
    // posted-date transaction is the correct one to attach to — picking the
    // earlier auth-date transaction would re-date it and strand the posted one.
    const authTxn = await createTransactionWithSplits({
      date: "2026-03-10",
      description: "Blue Bottle",
      payeeId: payee.id,
      splits: [
        { accountId: checking.id, amount: -500 },
        { accountId: groceries.id, amount: 500 },
      ],
    });
    const postedTxn = await createTransactionWithSplits({
      date: "2026-03-20",
      description: "Blue Bottle",
      payeeId: payee.id,
      splits: [
        { accountId: checking.id, amount: -500 },
        { accountId: groceries.id, amount: 500 },
      ],
    });

    const recon = await createPlaidReconciliation({
      plaidAccountLinkId: link.id,
      plaidTransactionId: "ptx-delayed-4",
      date: "2026-03-20",
      authorizedDate: "2026-03-10",
      amountCents: 500,
      name: "BLUE BOTTLE COFFEE",
      merchantName: "Blue Bottle Coffee",
      resolutionStatus: "pending",
    });

    const count = await autoMatchPendingTransactions(db, 1, [link.id]);
    expect(count).toBe(1);

    const [updatedRecon] = await db
      .select()
      .from(plaidTransactionReconciliation)
      .where(eq(plaidTransactionReconciliation.id, recon.id));
    expect(updatedRecon.matchedTransactionId).toBe(postedTxn.id);

    // The posted-date transaction is reconciled and keeps its date.
    const [updatedPosted] = await db
      .select()
      .from(transactions)
      .where(eq(transactions.id, postedTxn.id));
    expect(updatedPosted.isReconciled).toBe(true);
    expect(updatedPosted.date).toBe("2026-03-20");

    // The authorization-date transaction is left untouched for a later row.
    const [updatedAuth] = await db
      .select()
      .from(transactions)
      .where(eq(transactions.id, authTxn.id));
    expect(updatedAuth.isReconciled).toBe(false);
    expect(updatedAuth.date).toBe("2026-03-10");
  });

  async function matchAndGetDate(opts: {
    txnDate: string;
    plaidDate: string;
    authorizedDate: string | null;
  }): Promise<string> {
    const { checking, groceries, payee, link } = await setupLinkedAccount();
    await createMatchedHistory(link.id, checking.id, groceries.id, payee.id);

    const txn = await createTransactionWithSplits({
      date: opts.txnDate,
      description: "Blue Bottle",
      payeeId: payee.id,
      splits: [
        { accountId: checking.id, amount: -500 },
        { accountId: groceries.id, amount: 500 },
      ],
    });

    await createPlaidReconciliation({
      plaidAccountLinkId: link.id,
      plaidTransactionId: "ptx-date",
      date: opts.plaidDate,
      authorizedDate: opts.authorizedDate,
      amountCents: 500,
      name: "BLUE BOTTLE COFFEE",
      merchantName: "Blue Bottle Coffee",
      resolutionStatus: "pending",
    });

    const count = await autoMatchPendingTransactions(db, 1, [link.id]);
    expect(count).toBe(1);

    const [updatedTxn] = await db
      .select()
      .from(transactions)
      .where(eq(transactions.id, txn.id));
    return updatedTxn.date;
  }

  it("keeps the authorized date when the posted date is less than 7 days later", async () => {
    const resultDate = await matchAndGetDate({
      txnDate: "2026-03-10",
      authorizedDate: "2026-03-10",
      plaidDate: "2026-03-12", // posted 2 days after authorization
    });
    expect(resultDate).toBe("2026-03-10");
  });

  it("keeps the authorized date at the 6-day boundary", async () => {
    const resultDate = await matchAndGetDate({
      txnDate: "2026-03-10",
      authorizedDate: "2026-03-10",
      plaidDate: "2026-03-16", // posted exactly 6 days after authorization
    });
    expect(resultDate).toBe("2026-03-10");
  });

  it("uses the posted date when it is 7 or more days after the authorized date", async () => {
    const resultDate = await matchAndGetDate({
      txnDate: "2026-03-10",
      authorizedDate: "2026-03-10",
      plaidDate: "2026-03-17", // posted exactly 7 days after authorization
    });
    expect(resultDate).toBe("2026-03-17");
  });

  it("uses the posted date when there is no authorized date", async () => {
    const resultDate = await matchAndGetDate({
      txnDate: "2026-03-10",
      authorizedDate: null,
      plaidDate: "2026-03-10",
    });
    expect(resultDate).toBe("2026-03-10");
  });

  it("does not overwrite a row a human matched first", async () => {
    const { checking, groceries, payee, link } = await setupLinkedAccount();
    await createMatchedHistory(link.id, checking.id, groceries.id, payee.id);

    // Created first (lower id) so candidate selection's (date, id) tiebreak
    // deterministically picks this one over humansChoice — otherwise both
    // scenarios independently land on the same transaction and the race
    // never produces an observable difference.
    const autoMatchWouldPick = await createTransactionWithSplits({
      date: "2026-03-10",
      description: "Blue Bottle",
      payeeId: payee.id,
      splits: [
        { accountId: checking.id, amount: -500 },
        { accountId: groceries.id, amount: 500 },
      ],
    });
    const humansChoice = await createTransactionWithSplits({
      date: "2026-03-10",
      description: "Blue Bottle",
      payeeId: payee.id,
      splits: [
        { accountId: checking.id, amount: -500 },
        { accountId: groceries.id, amount: 500 },
      ],
    });

    const recon = await createPlaidReconciliation({
      plaidAccountLinkId: link.id,
      plaidTransactionId: "txn-race",
      date: "2026-03-10",
      amountCents: 500,
      name: "BLUE BOTTLE COFFEE",
      merchantName: "Blue Bottle Coffee",
      resolutionStatus: "pending",
    });

    await raceAgainstManualMatch(recon.id, humansChoice.id, () =>
      autoMatchPendingTransactions(db, 1, [link.id])
    );

    const [row] = await db
      .select()
      .from(plaidTransactionReconciliation)
      .where(eq(plaidTransactionReconciliation.id, recon.id));

    expect(row.matchedTransactionId).toBe(humansChoice.id);
    expect(row.matchedTransactionId).not.toBe(autoMatchWouldPick.id);
  });

  it("does not reconcile its candidate when the claim is refused", async () => {
    // The damaging half. Losing the match is harmless; marking a local
    // transaction reconciled against a match that never happened leaves the
    // ledger silently wrong.
    const { checking, groceries, payee, link } = await setupLinkedAccount();
    await createMatchedHistory(link.id, checking.id, groceries.id, payee.id);

    // Created first (lower id) so candidate selection's (date, id) tiebreak
    // deterministically picks this one over humansChoice — see the comment
    // in the previous test for why the creation order matters here.
    const candidate = await createTransactionWithSplits({
      date: "2026-03-11",
      description: "Blue Bottle",
      payeeId: payee.id,
      splits: [
        { accountId: checking.id, amount: -600 },
        { accountId: groceries.id, amount: 600 },
      ],
    });
    const humansChoice = await createTransactionWithSplits({
      date: "2026-03-11",
      description: "Blue Bottle",
      payeeId: payee.id,
      splits: [
        { accountId: checking.id, amount: -600 },
        { accountId: groceries.id, amount: 600 },
      ],
    });

    const recon = await createPlaidReconciliation({
      plaidAccountLinkId: link.id,
      plaidTransactionId: "txn-race-2",
      date: "2026-03-11",
      amountCents: 600,
      name: "BLUE BOTTLE COFFEE",
      merchantName: "Blue Bottle Coffee",
      resolutionStatus: "pending",
    });

    await raceAgainstManualMatch(recon.id, humansChoice.id, () =>
      autoMatchPendingTransactions(db, 1, [link.id])
    );

    const [row] = await db
      .select()
      .from(transactions)
      .where(eq(transactions.id, candidate.id));

    expect(row.isReconciled).toBe(false);
  });

  it("does not claim a row flagged for review between read and claim", async () => {
    // stageRemovedTransactions can set reviewReason on a pending row without
    // touching resolutionStatus. If the claim's WHERE only checked
    // resolutionStatus, a row flagged for review mid-race would still be
    // claimable — reconciling a transaction against a bank row Plaid just
    // withdrew.
    const { checking, groceries, payee, link } = await setupLinkedAccount();
    await createMatchedHistory(link.id, checking.id, groceries.id, payee.id);

    const candidate = await createTransactionWithSplits({
      date: "2026-03-10",
      description: "Blue Bottle",
      payeeId: payee.id,
      splits: [
        { accountId: checking.id, amount: -500 },
        { accountId: groceries.id, amount: 500 },
      ],
    });

    const recon = await createPlaidReconciliation({
      plaidAccountLinkId: link.id,
      plaidTransactionId: "ptx-review-race",
      date: "2026-03-10",
      amountCents: 500,
      name: "BLUE BOTTLE COFFEE",
      merchantName: "Blue Bottle Coffee",
      resolutionStatus: "pending",
    });

    const count = await raceAgainstReviewFlag(recon.id, () =>
      autoMatchPendingTransactions(db, 1, [link.id])
    );

    expect(count).toBe(0);

    const [row] = await db
      .select()
      .from(plaidTransactionReconciliation)
      .where(eq(plaidTransactionReconciliation.id, recon.id));
    expect(row.resolutionStatus).toBe("pending");
    expect(row.matchedTransactionId).toBeNull();
    expect(row.reviewReason).toBe("plaid_removed");

    const [txn] = await db
      .select()
      .from(transactions)
      .where(eq(transactions.id, candidate.id));
    expect(txn.isReconciled).toBe(false);
  });
});

describe("SyncTokenResult type", () => {
  it("includes autoMatched field", () => {
    const result: SyncTokenResult = {
      synced: { added: 0, modified: 0, removed: 0 },
      autoMatched: 0,
      lastSyncedAt: new Date(),
      pendingCount: 0,
      reviewCount: 0,
    };
    expect(result.autoMatched).toBe(0);
  });
});
