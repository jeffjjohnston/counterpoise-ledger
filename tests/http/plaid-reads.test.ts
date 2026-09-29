import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  accounts, books, plaidTokens, plaidTransactionReconciliation, transactions, typesafeDecisions,
  typesafeEvaluations,
} from "../../db/schema";
import { toDateString } from "../../lib/formatters";
import {
  addBookMember, createAccount, createBook, createPlaidAccount, createPlaidReconciliation,
  createPlaidToken, createTransactionWithSplits, createUser, db, resetTestDatabase, setupTestDatabase,
} from "../helpers/db-utils";
import { sessionHttpClient, startHttpTestServer } from "../helpers/http-parity";

type Client = Awaited<ReturnType<typeof sessionHttpClient>>;

async function expectError(client: Client, path: string, init: RequestInit, status: number, error: string) {
  const response = await client.request(path, init);
  expect(response.status, `${init.method ?? "GET"} ${path}`).toBe(status);
  expect(await response.json()).toEqual({ error });
}

async function ok(client: Client, path: string, init?: RequestInit) {
  const response = await client.request(path, init);
  expect(response.status, `${init?.method ?? "GET"} ${path}`).toBe(200);
  return response.json();
}

/** The local calendar date this many days before today. */
function daysAgo(days: number) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return toDateString(date);
}

async function link(accountName: string, plaidAccountId: string, type: "asset" | "liability" | "expense" = "asset") {
  const account = await createAccount({ name: accountName, type });
  const token = await createPlaidToken({ financialInstitution: "Chase", itemId: `item-${plaidAccountId}`, accessToken: "t" });
  const plaidAccount = await createPlaidAccount({
    tokenId: token.id, plaidAccountId, name: `Chase ${accountName}`, type: "depository", counterpoiseAccountId: account.id,
  });
  return { account, token, plaidAccount };
}

async function viewerBook() {
  const owner = await createUser({ username: "owner" });
  const book = await createBook({ name: "Shared", userId: owner.id });
  await addBookMember({ bookId: book.id, userId: 1, role: "viewer" });
  return book;
}

beforeAll(async () => {
  await setupTestDatabase();
}, 120_000);

describe("Plaid read HTTP parity", () => {
  let baseUrl: string;
  let stop: () => Promise<void>;
  let client: Client;

  beforeAll(async () => {
    ({ baseUrl, stop } = await startHttpTestServer());
  }, 120_000);
  beforeEach(async () => {
    await resetTestDatabase();
    client = await sessionHttpClient(baseUrl);
  });
  afterAll(async () => { await stop?.(); });

  it("lists the mapped accounts of the book with their queue counts", async () => {
    const checking = await link("Checking", "pa-checking");
    const card = await createAccount({ name: "Card", type: "liability" });
    const zeta = await createPlaidToken({ financialInstitution: "Zeta", itemId: "item-zeta", accessToken: "t" });
    const lastSyncedAt = new Date("2025-03-04T05:06:07.890Z");
    await db.update(plaidTokens).set({ lastSyncedAt, lastError: "Plaid said no" }).where(eq(plaidTokens.id, zeta.id));
    const cardLink = await createPlaidAccount({ tokenId: zeta.id, plaidAccountId: "pa-card", name: "Card", mask: "4242", type: "credit", counterpoiseAccountId: card.id });
    await createPlaidAccount({ tokenId: zeta.id, plaidAccountId: "pa-unmapped", name: "Unmapped", type: "depository" });
    for (const [plaidTransactionId, status, reviewReason] of [
      ["p1", "pending", null], ["p2", "pending", null], ["r1", "matched", "plaid_modified"],
      ["r2", "pending", "plaid_removed"], ["done", "matched", null], ["ignored", "ignored", null],
    ] as const) {
      await createPlaidReconciliation({
        plaidAccountLinkId: checking.plaidAccount.id, plaidTransactionId, date: "2025-01-01", amountCents: 1,
        name: plaidTransactionId, resolutionStatus: status, reviewReason,
      });
    }
    const stranger = await createUser({ username: "stranger" });
    const other = await createBook({ name: "Other", userId: stranger.id });
    const foreignAccount = await createAccount({ name: "Foreign", type: "asset", bookId: other.id });
    const foreignToken = await createPlaidToken({ financialInstitution: "F", itemId: "item-f", accessToken: "t", bookId: other.id });
    await createPlaidAccount({ tokenId: foreignToken.id, plaidAccountId: "pa-f", name: "F", type: "depository", counterpoiseAccountId: foreignAccount.id, bookId: other.id });

    expect(await ok(client, "/api/b/1/sync/assigned-accounts")).toEqual([
      {
        plaidLinkId: checking.plaidAccount.id, financialInstitution: "Chase", tokenId: checking.token.id,
        itemId: "item-pa-checking", plaidAccountId: "pa-checking", plaidAccountName: "Chase Checking",
        plaidAccountMask: null, counterpoiseAccountId: checking.account.id, counterpoiseAccountName: "Checking",
        lastSyncedAt: null, lastError: null, pendingCount: 2, reviewCount: 2,
      },
      {
        plaidLinkId: cardLink.id, financialInstitution: "Zeta", tokenId: zeta.id, itemId: "item-zeta",
        plaidAccountId: "pa-card", plaidAccountName: "Card", plaidAccountMask: "4242",
        counterpoiseAccountId: card.id, counterpoiseAccountName: "Card",
        lastSyncedAt: lastSyncedAt.toISOString(), lastError: "Plaid said no", pendingCount: 0, reviewCount: 0,
      },
    ]);
  });

  it("flags unmatched local transactions older than nine days on synced accounts", async () => {
    const checking = await link("Checking", "pa-checking");
    const savings = await link("Savings", "pa-savings");
    const unsynced = await createAccount({ name: "Cash", type: "asset" });
    const food = await createAccount({ name: "Food", type: "expense" });
    const local = (accountId: number, date: string, options: { isReconciled?: boolean; isFloating?: boolean } = {}) =>
      createTransactionWithSplits({ date, ...options, splits: [{ accountId, amount: -500 }, { accountId: food.id, amount: 500 }] });

    await local(checking.account.id, daysAgo(10));
    await local(checking.account.id, daysAgo(59));
    await local(checking.account.id, daysAgo(9));
    await local(checking.account.id, daysAgo(61));
    await local(checking.account.id, daysAgo(20), { isReconciled: true });
    // The stored date counts, not the effective date of today.
    await local(savings.account.id, daysAgo(30), { isFloating: true });
    await local(unsynced.id, daysAgo(20));
    const matched = await local(checking.account.id, daysAgo(15));
    await createPlaidReconciliation({
      plaidAccountLinkId: checking.plaidAccount.id, plaidTransactionId: "m", date: daysAgo(15), amountCents: 500,
      name: "M", resolutionStatus: "matched", matchedTransactionId: matched.id,
    });
    // Two splits on one account count once.
    await createTransactionWithSplits({
      date: daysAgo(40),
      splits: [{ accountId: savings.account.id, amount: -300 }, { accountId: savings.account.id, amount: -200 }, { accountId: food.id, amount: 500 }],
    });

    expect(await ok(client, "/api/b/1/sync/stale-unmatched")).toEqual({
      totalCount: 4,
      accounts: [
        { accountId: checking.account.id, accountName: "Checking", count: 2, oldestDate: daysAgo(59) },
        { accountId: savings.account.id, accountName: "Savings", count: 2, oldestDate: daysAgo(40) },
      ],
    });
  });

  it("returns an empty stale list and an empty pending list for a book without sync", async () => {
    expect(await ok(client, "/api/b/1/sync/stale-unmatched")).toEqual({ totalCount: 0, accounts: [] });
    expect(await ok(client, "/api/b/1/sync/pending-transactions")).toEqual([]);
    expect(await ok(client, "/api/b/1/sync/assigned-accounts")).toEqual([]);
  });

  it("shows unmatched bank transactions as display transactions, newest first", async () => {
    const checking = await link("Checking", "pa-checking");
    const card = await link("Card", "pa-card", "liability");
    const unmapped = await createPlaidAccount({ tokenId: checking.token.id, plaidAccountId: "pa-none", name: "None", type: "depository" });
    const coffee = await createPlaidReconciliation({
      plaidAccountLinkId: checking.plaidAccount.id, plaidTransactionId: "coffee", date: "2025-06-03",
      authorizedDate: "2025-06-01", amountCents: 450, name: "SQ *COFFEE", merchantName: "Coffee", categoryPrimary: "FOOD_AND_DRINK",
    });
    const refund = await createPlaidReconciliation({
      plaidAccountLinkId: card.plaidAccount.id, plaidTransactionId: "refund", date: "2025-06-02",
      amountCents: -1200, name: "REFUND", categoryPrimary: "",
    });
    const early = await createPlaidReconciliation({
      plaidAccountLinkId: checking.plaidAccount.id, plaidTransactionId: "early", date: "2025-05-20",
      amountCents: 0, name: "Zero", categoryPrimary: "TRANSFER_IN_ACCOUNT_TRANSFER",
    });
    for (const [linkId, id, status, review] of [
      [checking.plaidAccount.id, "matched", "matched", null], [checking.plaidAccount.id, "review", "pending", "plaid_modified"],
      [unmapped.id, "unmapped", "pending", null],
    ] as const) {
      await createPlaidReconciliation({ plaidAccountLinkId: linkId, plaidTransactionId: id, date: "2025-07-01", amountCents: 1, name: id, resolutionStatus: status, reviewReason: review });
    }
    const [checkingRow, cardRow] = await Promise.all([checking.account.id, card.account.id].map(async (id) => {
      const [row] = await db.select().from(accounts).where(eq(accounts.id, id));
      return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
    }));
    const epoch = "1970-01-01T00:00:00.000Z";
    const display = (reconId: number, date: string, name: string, payee: string, amount: number, account: typeof checkingRow, category: string | null) => {
      const id = -(1_000_000_000_000 + reconId);
      return {
        id, bookId: 1, date, description: name, checkNumber: null, notes: null, payeeId: null,
        isReconciled: false, isFloating: false, recurringRuleId: null, createdBy: null, updatedBy: null,
        createdAt: epoch, updatedAt: epoch,
        payee: { id, bookId: 1, name: payee, createdAt: epoch },
        splits: [{ id, bookId: 1, transactionId: id, accountId: account.id, amount, account }],
        investmentSplits: [], isPlaidPending: true, plaidCategory: category,
      };
    };
    const coffeeRow = display(coffee.id, "2025-06-01", "SQ *COFFEE", "Coffee", -450, checkingRow, "Food And Drink");
    const refundRow = display(refund.id, "2025-06-02", "REFUND", "REFUND", 1200, cardRow, null);
    const earlyRow = display(early.id, "2025-05-20", "Zero", "Zero", 0, checkingRow, "Transfer In Account Transfer");
    expect(await ok(client, "/api/b/1/sync/pending-transactions")).toEqual([refundRow, coffeeRow, earlyRow]);
    expect(await ok(client, `/api/b/1/sync/pending-transactions?accountId=${checking.account.id}`)).toEqual([coffeeRow, earlyRow]);
    expect(await ok(client, `/api/b/1/sync/pending-transactions?accountId=%20${card.account.id}.0&accountId=x`)).toEqual([refundRow]);
    expect(await ok(client, "/api/b/1/sync/pending-transactions?accountId=")).toHaveLength(3);
    expect(await ok(client, "/api/b/1/sync/pending-transactions?accountId=-4")).toEqual([]);
    for (const value of ["abc", "1.5", "Infinity", "9007199254740993", "1e400"]) {
      await expectError(client, `/api/b/1/sync/pending-transactions?accountId=${value}`, {}, 400, "Invalid accountId");
    }
    await expectError(client, "/api/b/1/sync/pending-transactions?accountId=3000000000", {}, 500, "Failed to fetch pending Plaid transactions");
  });

  it("reads the bank transaction linked to a transaction", async () => {
    const checking = await link("Checking", "pa-checking");
    const food = await createAccount({ name: "Food", type: "expense" });
    const txn = await createTransactionWithSplits({ date: "2025-06-01", splits: [{ accountId: checking.account.id, amount: -500 }, { accountId: food.id, amount: 500 }] });
    const manual = await createTransactionWithSplits({ date: "2025-06-01", splits: [{ accountId: checking.account.id, amount: -1 }, { accountId: food.id, amount: 1 }] });
    const recon = await createPlaidReconciliation({
      plaidAccountLinkId: checking.plaidAccount.id, plaidTransactionId: "plaid-txn-1", date: "2025-06-02", authorizedDate: "2025-06-01",
      amountCents: 500, name: "COFFEE SHOP", merchantName: "Coffee Shop", originalDescription: "COFFEE SHOP #1234",
      categoryPrimary: "FOOD_AND_DRINK", resolutionStatus: "matched", matchedTransactionId: txn.id,
    });
    const [stored] = await db.select().from(plaidTransactionReconciliation).where(eq(plaidTransactionReconciliation.id, recon.id));
    expect(await ok(client, `/api/b/1/transactions/${txn.id}/plaid`)).toEqual({
      id: recon.id, plaidTransactionId: "plaid-txn-1", date: "2025-06-02", authorizedDate: "2025-06-01", amountCents: 500,
      name: "COFFEE SHOP", merchantName: "Coffee Shop", originalDescription: "COFFEE SHOP #1234", pending: false,
      isoCurrencyCode: stored.isoCurrencyCode, categoryPrimary: "FOOD_AND_DRINK", categoryDetailed: null, rawJson: stored.rawJson,
    });
    expect(await ok(client, `/api/b/1/transactions/${txn.id}abc/plaid`)).toMatchObject({ id: recon.id });
    for (const id of [manual.id, "abc", "-5"]) {
      const response = await client.request(`/api/b/1/transactions/${id}/plaid`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("null");
    }
    await expectError(client, "/api/b/1/transactions/3000000000/plaid", {}, 500, "Failed to fetch Plaid link");
    const viewer = await viewerBook();
    expect(await ok(client, `/api/b/${viewer.id}/transactions/${txn.id}/plaid`)).toBeNull();
  });

  it("unlinks every bank row of a transaction and clears its reconciled flag", async () => {
    const checking = await link("Checking", "pa-checking");
    const savings = await link("Savings", "pa-savings");
    const transfer = await createTransactionWithSplits({
      date: "2025-06-01", isReconciled: true,
      splits: [{ accountId: checking.account.id, amount: -2000 }, { accountId: savings.account.id, amount: 2000 }],
    });
    const rows = [];
    for (const [plaidAccount, id] of [[checking.plaidAccount, "out"], [savings.plaidAccount, "in"]] as const) {
      rows.push(await createPlaidReconciliation({
        plaidAccountLinkId: plaidAccount.id, plaidTransactionId: id, date: "2025-06-01", amountCents: 2000, name: id,
        resolutionStatus: "matched", reviewReason: "plaid_modified", matchedTransactionId: transfer.id,
      }));
    }
    await db.update(plaidTransactionReconciliation).set({ resolvedAt: new Date(), reviewMetadataJson: "{}" });

    expect(await ok(client, `/api/b/1/transactions/${transfer.id}/plaid/unlink`, { method: "POST" })).toEqual({ success: true });
    const staged = await db.select().from(plaidTransactionReconciliation).orderBy(asc(plaidTransactionReconciliation.id));
    expect(staged.map((row) => row.id)).toEqual(rows.map((row) => row.id));
    for (const row of staged) {
      expect(row).toMatchObject({ resolutionStatus: "pending", matchedTransactionId: null, reviewReason: null, reviewMetadataJson: null, resolvedAt: null });
      expect(Math.abs(row.updatedAt.getTime() - Date.now())).toBeLessThan(60_000);
    }
    const [stored] = await db.select().from(transactions).where(eq(transactions.id, transfer.id));
    expect(stored).toMatchObject({ isReconciled: false, updatedBy: 1 });

    const path = `/api/b/1/transactions/${transfer.id}/plaid/unlink`;
    await expectError(client, path, { method: "POST" }, 404, "No Plaid link found");
    await expectError(client, "/api/b/1/transactions/abc/plaid/unlink", { method: "POST" }, 400, "Invalid transaction ID");
    await expectError(client, "/api/b/1/transactions/3000000000/plaid/unlink", { method: "POST" }, 500, "Failed to unlink from Plaid");
    const viewer = await viewerBook();
    await expectError(client, `/api/b/${viewer.id}/transactions/${transfer.id}/plaid/unlink`, { method: "POST" }, 403, "You have read-only access to this book");
  });

  it("records one TypeSafe unlink per evaluation when the book takes part", async () => {
    const checking = await link("Checking", "pa-checking");
    const food = await createAccount({ name: "Food", type: "expense" });
    const make = () => createTransactionWithSplits({ date: "2025-06-01", splits: [{ accountId: checking.account.id, amount: -1 }, { accountId: food.id, amount: 1 }] });
    const [first, second] = [await make(), await make()];
    const recon = (id: string, transactionId: number) => createPlaidReconciliation({
      plaidAccountLinkId: checking.plaidAccount.id, plaidTransactionId: id, date: "2025-06-01", amountCents: 1, name: id,
      resolutionStatus: "matched", matchedTransactionId: transactionId,
    });
    const [firstRow, secondRow] = [await recon("a", first.id), await recon("b", second.id)];
    const evaluation = async (fingerprint: string) => (await db.insert(typesafeEvaluations).values({
      bookId: 1, reconciliationId: firstRow.id, linkId: checking.plaidAccount.id, revision: 0, fingerprint,
      attempt: fingerprint, snapshot: {} as never, status: "ready",
    }).returning())[0];
    const [e1, e2] = [await evaluation("f1"), await evaluation("f2")];
    await db.insert(typesafeDecisions).values([
      { bookId: 1, reconciliationId: firstRow.id, evaluationId: e1.id, action: "match", transactionId: first.id },
      { bookId: 1, reconciliationId: firstRow.id, evaluationId: e1.id, action: "match", transactionId: first.id },
      { bookId: 1, reconciliationId: 77, evaluationId: e2.id, action: "match", transactionId: first.id },
      { bookId: 1, reconciliationId: firstRow.id, evaluationId: null, action: "match", transactionId: first.id },
      { bookId: 1, reconciliationId: firstRow.id, evaluationId: e2.id, action: "create", transactionId: first.id },
      { bookId: 1, reconciliationId: secondRow.id, evaluationId: e2.id, action: "match", transactionId: second.id },
    ]);
    const unlinks = async () => (await db.select().from(typesafeDecisions).where(eq(typesafeDecisions.action, "unlink")).orderBy(asc(typesafeDecisions.id)))
      .map(({ bookId, reconciliationId, evaluationId, transactionId, suggestionVisible, acceptedSuggestion }) =>
        ({ bookId, reconciliationId, evaluationId, transactionId, suggestionVisible, acceptedSuggestion }));

    // A book that has not opted in records nothing.
    await ok(client, `/api/b/1/transactions/${second.id}/plaid/unlink`, { method: "POST" });
    expect(await unlinks()).toEqual([]);

    await db.update(books).set({ typesafeReconciliationEnabled: true }).where(eq(books.id, 1));
    await ok(client, `/api/b/1/transactions/${first.id}/plaid/unlink`, { method: "POST" });
    expect(await unlinks()).toEqual([
      { bookId: 1, reconciliationId: firstRow.id, evaluationId: e1.id, transactionId: first.id, suggestionVisible: false, acceptedSuggestion: false },
      { bookId: 1, reconciliationId: 77, evaluationId: e2.id, transactionId: first.id, suggestionVisible: false, acceptedSuggestion: false },
    ]);
  });

  it("enforces read membership on the read routes", async () => {
    const viewer = await viewerBook();
    for (const path of ["assigned-accounts", "stale-unmatched", "pending-transactions"]) {
      await expectError(client, `/api/b/999999/sync/${path}`, {}, 404, "Book not found");
      await expectError(client, `/api/b/invalid/sync/${path}`, {}, 400, "Invalid book ID");
      expect((await client.anonymous(`/api/b/1/sync/${path}`)).status).toBe(401);
      expect((await client.request(`/api/b/${viewer.id}/sync/${path}`)).status).toBe(200);
    }
  });
});
