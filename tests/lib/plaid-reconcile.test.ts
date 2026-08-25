import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { plaidTransactionReconciliation, transactions } from "@/db/schema";
import {
  getReconcilableLink,
  listReconciliationQueue,
  RECONCILE_EVENT_NAMES,
  ReconcileNotFoundError,
  ReconcileValidationError,
  resolveReconciliation,
} from "@/lib/plaid-reconcile";
import {
  createAccount,
  createPayee,
  createPlaidAccount,
  createPlaidReconciliation,
  createPlaidToken,
  createTransactionWithSplits,
  resetTestDatabase,
  setupTestDatabase,
} from "@/tests/helpers/db-utils";

describe("lib/plaid-reconcile read path", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("returns the link for an asset account", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const token = await createPlaidToken({
      financialInstitution: "Chase",
      itemId: "item-lib-1",
      accessToken: "token",
    });
    const link = await createPlaidAccount({
      tokenId: token.id,
      plaidAccountId: "plaid-lib-1",
      name: "Plaid Checking",
      type: "depository",
      subtype: "checking",
      counterpoiseAccountId: checking.id,
    });

    const resolved = await getReconcilableLink(getDb(), 1, link.id);

    expect(resolved.linkId).toBe(link.id);
    expect(resolved.counterpoiseAccountId).toBe(checking.id);
    expect(resolved.counterpoiseAccountType).toBe("asset");
  });

  it("throws ReconcileNotFoundError for an unknown link", async () => {
    await expect(getReconcilableLink(getDb(), 1, 987654)).rejects.toThrow(
      ReconcileNotFoundError
    );
  });

  it("throws ReconcileValidationError for a link on an expense account", async () => {
    const groceries = await createAccount({ name: "Groceries", type: "expense" });
    const token = await createPlaidToken({
      financialInstitution: "Chase",
      itemId: "item-lib-2",
      accessToken: "token",
    });
    const link = await createPlaidAccount({
      tokenId: token.id,
      plaidAccountId: "plaid-lib-2",
      name: "Plaid Guard",
      type: "depository",
      subtype: "checking",
      counterpoiseAccountId: groceries.id,
    });

    await expect(getReconcilableLink(getDb(), 1, link.id)).rejects.toThrow(
      ReconcileValidationError
    );
  });

  it("ranks an exact-amount same-day candidate first and suggests its counter account", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const groceries = await createAccount({ name: "Groceries", type: "expense" });
    const dining = await createAccount({ name: "Dining", type: "expense" });
    const payee = await createPayee({ name: "Blue Bottle" });

    const token = await createPlaidToken({
      financialInstitution: "Chase",
      itemId: "item-lib-3",
      accessToken: "token",
    });
    const link = await createPlaidAccount({
      tokenId: token.id,
      plaidAccountId: "plaid-lib-3",
      name: "Plaid Checking",
      type: "depository",
      subtype: "checking",
      counterpoiseAccountId: checking.id,
    });

    const exact = await createTransactionWithSplits({
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
      plaidTransactionId: "txn-lib-3",
      date: "2026-02-08",
      amountCents: 1500,
      name: "BLUE BOTTLE COFFEE",
      merchantName: "Blue Bottle",
      resolutionStatus: "pending",
    });

    const resolved = await getReconcilableLink(getDb(), 1, link.id);
    const page = await listReconciliationQueue(getDb(), 1, resolved, { limit: 25, offset: 0 });

    expect(page.totalCount).toBe(1);
    expect(page.hasMore).toBe(false);
    expect(page.items[0].candidates[0].transactionId).toBe(exact.id);
    expect(page.items[0].candidates[0].scoreTags).toContain("exact_amount");
    expect(page.items[0].suggestedCounterAccountId).toBe(groceries.id);
  });
});

describe("lib/plaid-reconcile write path", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("marks the row matched and the transaction reconciled", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const groceries = await createAccount({ name: "Groceries", type: "expense" });

    const token = await createPlaidToken({
      financialInstitution: "Chase",
      itemId: "item-lib-4",
      accessToken: "token",
    });
    const link = await createPlaidAccount({
      tokenId: token.id,
      plaidAccountId: "plaid-lib-4",
      name: "Plaid Checking",
      type: "depository",
      subtype: "checking",
      counterpoiseAccountId: checking.id,
    });

    const txn = await createTransactionWithSplits({
      date: "2026-02-08",
      description: "Blue Bottle",
      splits: [
        { accountId: checking.id, amount: -1500 },
        { accountId: groceries.id, amount: 1500 },
      ],
    });
    const recon = await createPlaidReconciliation({
      plaidAccountLinkId: link.id,
      plaidTransactionId: "txn-lib-4",
      date: "2026-02-08",
      amountCents: 1500,
      name: "BLUE BOTTLE",
      merchantName: null,
      resolutionStatus: "pending",
    });

    const resolved = await getReconcilableLink(getDb(), 1, link.id);
    const item = await resolveReconciliation(getDb(), 1, resolved, {
      action: "match",
      reconciliationId: recon.id,
      transactionId: txn.id,
    });

    expect(item.resolutionStatus).toBe("matched");
    expect(item.matchedTransactionId).toBe(txn.id);

    const stored = await getDb().query.transactions.findFirst({
      where: eq(transactions.id, txn.id),
    });
    expect(stored?.isReconciled).toBe(true);
  });

  it("checks the action requirement before it looks up the row", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const token = await createPlaidToken({
      financialInstitution: "Chase",
      itemId: "item-lib-5",
      accessToken: "token",
    });
    const link = await createPlaidAccount({
      tokenId: token.id,
      plaidAccountId: "plaid-lib-5",
      name: "Plaid Checking",
      type: "depository",
      subtype: "checking",
      counterpoiseAccountId: checking.id,
    });

    const resolved = await getReconcilableLink(getDb(), 1, link.id);

    // Both faults present. The validation error must win, or the HTTP route's
    // 400-before-404 ordering flips when it delegates here.
    await expect(
      resolveReconciliation(getDb(), 1, resolved, {
        action: "match",
        reconciliationId: 987654,
      })
    ).rejects.toThrow("transactionId is required for match");
  });

  it("refuses to link a bank row that is already resolved", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const groceries = await createAccount({ name: "Groceries", type: "expense" });

    const token = await createPlaidToken({
      financialInstitution: "Chase",
      itemId: "item-guard-1",
      accessToken: "token",
    });
    const link = await createPlaidAccount({
      tokenId: token.id,
      plaidAccountId: "plaid-guard-1",
      name: "Plaid Checking",
      type: "depository",
      subtype: "checking",
      counterpoiseAccountId: checking.id,
    });
    const recon = await createPlaidReconciliation({
      plaidAccountLinkId: link.id,
      plaidTransactionId: "txn-guard-1",
      date: "2026-02-08",
      amountCents: 1500,
      name: "BLUE BOTTLE",
      merchantName: null,
      resolutionStatus: "pending",
    });

    const resolved = await getReconcilableLink(getDb(), 1, link.id);

    // First create resolves the row and links it to the transaction it wrote.
    const first = await resolveReconciliation(getDb(), 1, resolved, {
      action: "create",
      reconciliationId: recon.id,
      counterAccountId: groceries.id,
    });
    expect(first.resolutionStatus).toBe("created");

    // A repeat must refuse. Without the guard it inserts a SECOND transaction
    // and repoints matchedTransactionId at it, orphaning the first — which
    // stays marked reconciled and can never resurface in getStaleUnmatched().
    await expect(
      resolveReconciliation(getDb(), 1, resolved, {
        action: "create",
        reconciliationId: recon.id,
        counterAccountId: groceries.id,
      })
    ).rejects.toThrow(ReconcileValidationError);

    const written = await getDb().query.transactions.findMany({});
    expect(written).toHaveLength(1);
  });

  it("still allows re-linking a row that came back for review", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const groceries = await createAccount({ name: "Groceries", type: "expense" });

    const token = await createPlaidToken({
      financialInstitution: "Chase",
      itemId: "item-guard-2",
      accessToken: "token",
    });
    const link = await createPlaidAccount({
      tokenId: token.id,
      plaidAccountId: "plaid-guard-2",
      name: "Plaid Checking",
      type: "depository",
      subtype: "checking",
      counterpoiseAccountId: checking.id,
    });
    const recon = await createPlaidReconciliation({
      plaidAccountLinkId: link.id,
      plaidTransactionId: "txn-guard-2",
      date: "2026-02-08",
      amountCents: 1500,
      name: "BLUE BOTTLE",
      merchantName: null,
      resolutionStatus: "pending",
    });

    const resolved = await getReconcilableLink(getDb(), 1, link.id);
    await resolveReconciliation(getDb(), 1, resolved, {
      action: "create",
      reconciliationId: recon.id,
      counterAccountId: groceries.id,
    });

    // Plaid changed the transaction, so the row is back in the queue flagged
    // for review. ReconciliationModal renders match/create for exactly this
    // state (it gates on `pending || reviewReason !== null`), so the guard
    // must not fire here or those buttons start returning 400.
    await getDb()
      .update(plaidTransactionReconciliation)
      .set({ reviewReason: "plaid_modified" })
      .where(eq(plaidTransactionReconciliation.id, recon.id));

    const txn = await createTransactionWithSplits({
      date: "2026-02-08",
      description: "Hand entered",
      splits: [
        { accountId: checking.id, amount: -1500 },
        { accountId: groceries.id, amount: 1500 },
      ],
    });

    const item = await resolveReconciliation(getDb(), 1, resolved, {
      action: "match",
      reconciliationId: recon.id,
      transactionId: txn.id,
    });

    expect(item.resolutionStatus).toBe("matched");
    expect(item.matchedTransactionId).toBe(txn.id);
  });

  it("un-reconciles the transaction when unlink removes its only bank link", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const groceries = await createAccount({ name: "Groceries", type: "expense" });

    const token = await createPlaidToken({
      financialInstitution: "Chase",
      itemId: "item-unlink-1",
      accessToken: "token",
    });
    const link = await createPlaidAccount({
      tokenId: token.id,
      plaidAccountId: "plaid-unlink-1",
      name: "Plaid Checking",
      type: "depository",
      subtype: "checking",
      counterpoiseAccountId: checking.id,
    });

    const txn = await createTransactionWithSplits({
      date: "2026-02-08",
      description: "Blue Bottle",
      splits: [
        { accountId: checking.id, amount: -1500 },
        { accountId: groceries.id, amount: 1500 },
      ],
    });
    const recon = await createPlaidReconciliation({
      plaidAccountLinkId: link.id,
      plaidTransactionId: "txn-unlink-1",
      date: "2026-02-08",
      amountCents: 1500,
      name: "BLUE BOTTLE",
      merchantName: null,
      resolutionStatus: "pending",
    });

    const resolved = await getReconcilableLink(getDb(), 1, link.id);
    await resolveReconciliation(getDb(), 1, resolved, {
      action: "match",
      reconciliationId: recon.id,
      transactionId: txn.id,
    });

    await resolveReconciliation(getDb(), 1, resolved, {
      action: "unlink",
      reconciliationId: recon.id,
    });

    // Nothing links to it any more, so it must stop asserting a bank match —
    // otherwise getStaleUnmatched() (which filters isReconciled = false) can
    // never surface it again.
    const stored = await getDb().query.transactions.findFirst({
      where: eq(transactions.id, txn.id),
    });
    expect(stored?.isReconciled).toBe(false);
  });

  it("leaves a transfer reconciled when unlink removes only one of its two links", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const savings = await createAccount({ name: "Savings", type: "asset" });

    const token = await createPlaidToken({
      financialInstitution: "Chase",
      itemId: "item-unlink-2",
      accessToken: "token",
    });
    const checkingLink = await createPlaidAccount({
      tokenId: token.id,
      plaidAccountId: "plaid-unlink-checking",
      name: "Plaid Checking",
      type: "depository",
      subtype: "checking",
      counterpoiseAccountId: checking.id,
    });
    const savingsLink = await createPlaidAccount({
      tokenId: token.id,
      plaidAccountId: "plaid-unlink-savings",
      name: "Plaid Savings",
      type: "depository",
      subtype: "savings",
      counterpoiseAccountId: savings.id,
    });

    // One transfer, seen by the bank on both sides. Per-link uniqueness is
    // enforced per link (the match branch's conflict check filters on
    // plaidAccountLinkId), so matching it on both is legitimate.
    const transfer = await createTransactionWithSplits({
      date: "2026-02-08",
      description: "Transfer to savings",
      splits: [
        { accountId: checking.id, amount: -5000 },
        { accountId: savings.id, amount: 5000 },
      ],
    });

    const checkingSide = await createPlaidReconciliation({
      plaidAccountLinkId: checkingLink.id,
      plaidTransactionId: "txn-transfer-out",
      date: "2026-02-08",
      amountCents: 5000,
      name: "TRANSFER OUT",
      merchantName: null,
      resolutionStatus: "pending",
    });
    const savingsSide = await createPlaidReconciliation({
      plaidAccountLinkId: savingsLink.id,
      plaidTransactionId: "txn-transfer-in",
      date: "2026-02-08",
      amountCents: -5000,
      name: "TRANSFER IN",
      merchantName: null,
      resolutionStatus: "pending",
    });

    const checkingResolved = await getReconcilableLink(getDb(), 1, checkingLink.id);
    const savingsResolved = await getReconcilableLink(getDb(), 1, savingsLink.id);

    await resolveReconciliation(getDb(), 1, checkingResolved, {
      action: "match",
      reconciliationId: checkingSide.id,
      transactionId: transfer.id,
    });
    await resolveReconciliation(getDb(), 1, savingsResolved, {
      action: "match",
      reconciliationId: savingsSide.id,
      transactionId: transfer.id,
    });

    // Detach one side only. The savings side still matches it, so the
    // transaction is still genuinely reconciled — clearing the flag here would
    // make it a false positive in the stale-unmatched health check.
    await resolveReconciliation(getDb(), 1, checkingResolved, {
      action: "unlink",
      reconciliationId: checkingSide.id,
    });

    const stored = await getDb().query.transactions.findFirst({
      where: eq(transactions.id, transfer.id),
    });
    expect(stored?.isReconciled).toBe(true);
  });

  it("settles a floating transaction when matching it", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const groceries = await createAccount({ name: "Groceries", type: "expense" });

    const token = await createPlaidToken({
      financialInstitution: "Chase",
      itemId: "item-float-1",
      accessToken: "token",
    });
    const link = await createPlaidAccount({
      tokenId: token.id,
      plaidAccountId: "plaid-float-1",
      name: "Plaid Checking",
      type: "depository",
      subtype: "checking",
      counterpoiseAccountId: checking.id,
    });

    // A floating transaction's stored date is its ORIGINAL ENTRY date while
    // its effective date advances to today. Clearing isFloating without
    // stamping a real date would snap it back to 2026-01-15.
    const floating = await createTransactionWithSplits({
      date: "2026-01-15",
      description: "Blue Bottle",
      isFloating: true,
      splits: [
        { accountId: checking.id, amount: -1500 },
        { accountId: groceries.id, amount: 1500 },
      ],
    });
    const recon = await createPlaidReconciliation({
      plaidAccountLinkId: link.id,
      plaidTransactionId: "txn-float-1",
      date: "2026-02-10",
      authorizedDate: "2026-02-08",
      amountCents: 1500,
      name: "BLUE BOTTLE",
      merchantName: null,
      resolutionStatus: "pending",
    });

    const resolved = await getReconcilableLink(getDb(), 1, link.id);
    await resolveReconciliation(getDb(), 1, resolved, {
      action: "match",
      reconciliationId: recon.id,
      transactionId: floating.id,
    });

    const stored = await getDb().query.transactions.findFirst({
      where: eq(transactions.id, floating.id),
    });
    expect(stored?.isReconciled).toBe(true);
    expect(stored?.isFloating).toBe(false);
    // pickMatchedDate prefers the authorization date when it is within 7 days
    // of the posted date — the same rule auto-match uses.
    expect(stored?.date).toBe("2026-02-08");
  });

  it("leaves a non-floating transaction's date alone when matching it", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const groceries = await createAccount({ name: "Groceries", type: "expense" });

    const token = await createPlaidToken({
      financialInstitution: "Chase",
      itemId: "item-float-2",
      accessToken: "token",
    });
    const link = await createPlaidAccount({
      tokenId: token.id,
      plaidAccountId: "plaid-float-2",
      name: "Plaid Checking",
      type: "depository",
      subtype: "checking",
      counterpoiseAccountId: checking.id,
    });

    const fixed = await createTransactionWithSplits({
      date: "2026-02-01",
      description: "Blue Bottle",
      splits: [
        { accountId: checking.id, amount: -1500 },
        { accountId: groceries.id, amount: 1500 },
      ],
    });
    const recon = await createPlaidReconciliation({
      plaidAccountLinkId: link.id,
      plaidTransactionId: "txn-float-2",
      date: "2026-02-10",
      authorizedDate: "2026-02-08",
      amountCents: 1500,
      name: "BLUE BOTTLE",
      merchantName: null,
      resolutionStatus: "pending",
    });

    const resolved = await getReconcilableLink(getDb(), 1, link.id);
    await resolveReconciliation(getDb(), 1, resolved, {
      action: "match",
      reconciliationId: recon.id,
      transactionId: fixed.id,
    });

    // CLAUDE.md's auto-match date rule records that manual match leaves the
    // date untouched, deliberately: the user picked this transaction, and its
    // date is the one they entered. Only the floating case needs a stamp.
    const stored = await getDb().query.transactions.findFirst({
      where: eq(transactions.id, fixed.id),
    });
    expect(stored?.isReconciled).toBe(true);
    expect(stored?.date).toBe("2026-02-01");
  });

  it("names an event for every action the schema accepts", () => {
    // tsc already catches most of the ways this map can go wrong:
    // RECONCILE_EVENT_NAMES is Record<ReconcileAction, string>, a direct
    // object literal, so a key deleted from it is a compile error (TS2741,
    // "missing in type") and a key renamed on only one side is too (TS2561,
    // "does not exist in type"). What tsc cannot see is a rename applied
    // consistently to both reconcileActionValues and this map: ReconcileAction
    // is derived from reconcileActionValues, so the two drift together
    // without tripping the type checker. This test pins the actual six action
    // strings, so that rename still fails here.
    expect(Object.keys(RECONCILE_EVENT_NAMES).sort()).toEqual([
      "create",
      "ignore",
      "keep_local",
      "match",
      "match_update_amount",
      "unlink",
    ]);
  });
});
