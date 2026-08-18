import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/b/[bookId]/sync/stale-unmatched/route";
import { toDateString } from "@/lib/formatters";
import {
  createAccount,
  createPlaidAccount,
  createPlaidToken,
  createPlaidReconciliation,
  createTransactionWithSplits,
  resetTestDatabase,
  setupTestDatabase,
} from "@/tests/helpers/db";

vi.mock("@/lib/api-auth", async () => {
  const { mockApiAuth } = await import("@/tests/helpers/db");
  return mockApiAuth();
});

const daysAgo = (days: number) => {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return toDateString(d);
};

describe("GET /api/b/[bookId]/sync/stale-unmatched", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  async function makeRequest() {
    return GET(new Request("http://localhost"), {
      params: Promise.resolve({ bookId: "1" }),
    });
  }

  async function createLinkedPlaidAccount(
    accountName = "Checking",
    plaidAccountId = "plaid-acc-1"
  ) {
    const account = await createAccount({ name: accountName, type: "asset" });
    const token = await createPlaidToken({
      financialInstitution: "Chase",
      itemId: `item-${plaidAccountId}`,
      accessToken: `access-${plaidAccountId}`,
    });
    const plaidAccount = await createPlaidAccount({
      tokenId: token.id,
      plaidAccountId,
      name: `Chase ${accountName}`,
      type: "depository",
      subtype: "checking",
      counterpoiseAccountId: account.id,
    });
    return { account, plaidAccount };
  }

  async function createLocalTransaction(
    accountId: number,
    expenseAccountId: number,
    options: { date: string; isReconciled?: boolean; isFloating?: boolean }
  ) {
    return createTransactionWithSplits({
      date: options.date,
      description: "Local entry",
      isReconciled: options.isReconciled ?? false,
      isFloating: options.isFloating ?? false,
      splits: [
        { accountId, amount: -5000 },
        { accountId: expenseAccountId, amount: 5000 },
      ],
    });
  }

  it("returns zero counts when there are no transactions", async () => {
    await createLinkedPlaidAccount();
    const response = await makeRequest();
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toEqual({ totalCount: 0, accounts: [] });
  });

  it("flags unmatched local transactions older than 9 days", async () => {
    const { account } = await createLinkedPlaidAccount();
    const expense = await createAccount({ name: "Groceries", type: "expense" });

    await createLocalTransaction(account.id, expense.id, { date: daysAgo(10) });

    const response = await makeRequest();
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toEqual({
      totalCount: 1,
      accounts: [
        {
          accountId: account.id,
          accountName: "Checking",
          count: 1,
          oldestDate: daysAgo(10),
        },
      ],
    });
  });

  it("does not flag transactions exactly 9 days old", async () => {
    const { account } = await createLinkedPlaidAccount();
    const expense = await createAccount({ name: "Groceries", type: "expense" });

    await createLocalTransaction(account.id, expense.id, { date: daysAgo(9) });

    const response = await makeRequest();
    const payload = await response.json();
    expect(payload.totalCount).toBe(0);
  });

  it("only looks back 60 days", async () => {
    const { account } = await createLinkedPlaidAccount();
    const expense = await createAccount({ name: "Groceries", type: "expense" });

    await createLocalTransaction(account.id, expense.id, { date: daysAgo(61) });
    await createLocalTransaction(account.id, expense.id, { date: daysAgo(60) });

    const response = await makeRequest();
    const payload = await response.json();
    expect(payload.totalCount).toBe(1);
    expect(payload.accounts[0].oldestDate).toBe(daysAgo(60));
  });

  it("does not flag reconciled transactions", async () => {
    const { account } = await createLinkedPlaidAccount();
    const expense = await createAccount({ name: "Groceries", type: "expense" });

    await createLocalTransaction(account.id, expense.id, {
      date: daysAgo(15),
      isReconciled: true,
    });

    const response = await makeRequest();
    const payload = await response.json();
    expect(payload.totalCount).toBe(0);
  });

  it("does not flag transactions matched to a plaid transaction", async () => {
    const { account, plaidAccount } = await createLinkedPlaidAccount();
    const expense = await createAccount({ name: "Groceries", type: "expense" });

    const transaction = await createLocalTransaction(account.id, expense.id, {
      date: daysAgo(15),
    });
    await createPlaidReconciliation({
      plaidAccountLinkId: plaidAccount.id,
      plaidTransactionId: "txn-matched",
      date: daysAgo(15),
      amountCents: 5000,
      name: "Bank Side",
      resolutionStatus: "matched",
      matchedTransactionId: transaction.id,
    });

    const response = await makeRequest();
    const payload = await response.json();
    expect(payload.totalCount).toBe(0);
  });

  it("does not flag transactions on accounts without a plaid link", async () => {
    const cash = await createAccount({ name: "Cash", type: "asset" });
    const expense = await createAccount({ name: "Groceries", type: "expense" });

    await createLocalTransaction(cash.id, expense.id, { date: daysAgo(20) });

    const response = await makeRequest();
    const payload = await response.json();
    expect(payload.totalCount).toBe(0);
  });

  it("flags floating transactions by their stored date", async () => {
    const { account } = await createLinkedPlaidAccount();
    const expense = await createAccount({ name: "Groceries", type: "expense" });

    // A floating transaction's effective date advances to today, but the
    // stored entry date says it has gone unmatched for 12 days
    await createLocalTransaction(account.id, expense.id, {
      date: daysAgo(12),
      isFloating: true,
    });

    const response = await makeRequest();
    const payload = await response.json();
    expect(payload.totalCount).toBe(1);
  });

  it("groups counts by account with the oldest date per account", async () => {
    const checking = await createLinkedPlaidAccount("Checking", "plaid-checking");
    const savings = await createLinkedPlaidAccount("Savings", "plaid-savings");
    const expense = await createAccount({ name: "Groceries", type: "expense" });

    await createLocalTransaction(checking.account.id, expense.id, {
      date: daysAgo(12),
    });
    await createLocalTransaction(checking.account.id, expense.id, {
      date: daysAgo(30),
    });
    await createLocalTransaction(savings.account.id, expense.id, {
      date: daysAgo(14),
    });

    const response = await makeRequest();
    const payload = await response.json();
    expect(payload.totalCount).toBe(3);
    expect(payload.accounts).toEqual([
      {
        accountId: checking.account.id,
        accountName: "Checking",
        count: 2,
        oldestDate: daysAgo(30),
      },
      {
        accountId: savings.account.id,
        accountName: "Savings",
        count: 1,
        oldestDate: daysAgo(14),
      },
    ]);
  });

  it("counts a transaction with multiple splits on the same account once", async () => {
    const { account } = await createLinkedPlaidAccount();
    const expense = await createAccount({ name: "Groceries", type: "expense" });

    await createTransactionWithSplits({
      date: daysAgo(10),
      description: "Two splits on checking",
      splits: [
        { accountId: account.id, amount: -3000 },
        { accountId: account.id, amount: -2000 },
        { accountId: expense.id, amount: 5000 },
      ],
    });

    const response = await makeRequest();
    const payload = await response.json();
    expect(payload.totalCount).toBe(1);
    expect(payload.accounts[0].count).toBe(1);
  });
});
