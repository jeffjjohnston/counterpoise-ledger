import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { GET } from "@/app/api/b/[bookId]/transactions/route";
import {
  createAccount,
  createBook,
  createInvestmentSplit,
  createPayee,
  createSecurity,
  createTransactionWithSplits,
  resetTestDatabase,
  setupTestDatabase,
} from "@/tests/helpers/db";

vi.mock("@/lib/api-auth", async () => {
  const { mockApiAuth } = await import("@/tests/helpers/db");
  return mockApiAuth();
});

describe("GET /api/transactions", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("returns paged transactions with starting balance and total count", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const groceries = await createAccount({ name: "Groceries", type: "expense" });
    const salary = await createAccount({ name: "Salary", type: "income" });
    const savings = await createAccount({ name: "Savings", type: "asset" });
    const bonus = await createAccount({ name: "Bonus", type: "income" });

    await createTransactionWithSplits({
      date: "2024-01-01",
      description: "Paycheck",
      splits: [
        { accountId: checking.id, amount: 10000 },
        { accountId: salary.id, amount: -10000 },
      ],
    });

    await createTransactionWithSplits({
      date: "2024-01-05",
      description: "Groceries",
      splits: [
        { accountId: groceries.id, amount: 2000 },
        { accountId: checking.id, amount: -2000 },
      ],
    });

    const latestTransaction = await createTransactionWithSplits({
      date: "2024-01-10",
      description: "More groceries",
      splits: [
        { accountId: groceries.id, amount: 1500 },
        { accountId: checking.id, amount: -1500 },
      ],
    });

    await createTransactionWithSplits({
      date: "2024-01-12",
      description: "Bonus",
      splits: [
        { accountId: savings.id, amount: 5000 },
        { accountId: bonus.id, amount: -5000 },
      ],
    });

    const response = await GET(
      new Request(
        `http://localhost/api/transactions?accountId=${checking.id}&limit=1&offset=0&includeMeta=true`
      ),
      { params: Promise.resolve({ bookId: "1" }) }
    );
    const payload = await response.json();

    expect(payload.totalCount).toBe(3);
    expect(payload.startingBalance).toBe(8000);
    expect(payload.transactions).toHaveLength(1);
    expect(payload.transactions[0].id).toBe(latestTransaction.id);
  });

  it("calculates starting balance within the date range", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const groceries = await createAccount({ name: "Groceries", type: "expense" });
    const salary = await createAccount({ name: "Salary", type: "income" });

    await createTransactionWithSplits({
      date: "2024-01-01",
      description: "Paycheck",
      splits: [
        { accountId: checking.id, amount: 10000 },
        { accountId: salary.id, amount: -10000 },
      ],
    });

    await createTransactionWithSplits({
      date: "2024-01-05",
      description: "Groceries",
      splits: [
        { accountId: groceries.id, amount: 2000 },
        { accountId: checking.id, amount: -2000 },
      ],
    });

    await createTransactionWithSplits({
      date: "2024-01-10",
      description: "More groceries",
      splits: [
        { accountId: groceries.id, amount: 1500 },
        { accountId: checking.id, amount: -1500 },
      ],
    });

    const response = await GET(
      new Request(
        `http://localhost/api/transactions?accountId=${checking.id}&startDate=2024-01-05&endDate=2024-01-10&limit=1&offset=0&includeMeta=true`
      ),
      { params: Promise.resolve({ bookId: "1" }) }
    );
    const payload = await response.json();

    expect(payload.totalCount).toBe(2);
    // Starting balance includes the $10,000 paycheck before the date range
    // plus the -$2,000 groceries (older than the page's oldest transaction)
    expect(payload.startingBalance).toBe(8000);
  });

  it("includes transactions for multiple accounts when accountIds is provided", async () => {
    const investment = await createAccount({
      name: "Brokerage",
      type: "asset",
      subtype: "investment",
    });
    const investmentCash = await createAccount({
      name: "Brokerage Cash",
      type: "asset",
      subtype: "cash",
      parentId: investment.id,
      isInvestmentCash: true,
    });
    const dividend = await createAccount({ name: "Dividend", type: "income" });

    const buyTransaction = await createTransactionWithSplits({
      date: "2024-01-03",
      description: "Buy shares",
      splits: [
        { accountId: investment.id, amount: 10000 },
        { accountId: investmentCash.id, amount: -10000 },
      ],
    });

    const dividendTransaction = await createTransactionWithSplits({
      date: "2024-01-05",
      description: "Dividend",
      splits: [
        { accountId: investmentCash.id, amount: 500 },
        { accountId: dividend.id, amount: -500 },
      ],
    });

    const response = await GET(
      new Request(
        `http://localhost/api/transactions?accountIds=${investment.id},${investmentCash.id}&balanceAccountId=${investmentCash.id}&limit=10&offset=0&includeMeta=true`
      ),
      { params: Promise.resolve({ bookId: "1" }) }
    );
    const payload = await response.json();

    expect(payload.totalCount).toBe(2);
    expect(payload.startingBalance).toBe(0);
    expect(payload.transactions.map((tx: { id: number }) => tx.id)).toEqual([
      dividendTransaction.id,
      buyTransaction.id,
    ]);
  });

  it("does not leak another book's balance through balanceAccountId", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const groceries = await createAccount({ name: "Groceries", type: "expense" });

    await createTransactionWithSplits({
      date: "2024-01-01",
      description: "Paycheck",
      splits: [
        { accountId: checking.id, amount: 10000 },
        { accountId: groceries.id, amount: -10000 },
      ],
    });
    await createTransactionWithSplits({
      date: "2024-02-01",
      description: "Groceries",
      splits: [
        { accountId: groceries.id, amount: 2000 },
        { accountId: checking.id, amount: -2000 },
      ],
    });

    // A second book, owned by the same user, with its own money in it.
    const otherBook = await createBook({ name: "Other Book" });
    const otherChecking = await createAccount({
      name: "Other Checking",
      type: "asset",
      bookId: otherBook.id,
    });
    const otherIncome = await createAccount({
      name: "Other Income",
      type: "income",
      bookId: otherBook.id,
    });
    await createTransactionWithSplits({
      date: "2023-06-01",
      description: "Other book paycheck",
      bookId: otherBook.id,
      splits: [
        { accountId: otherChecking.id, amount: 777700 },
        { accountId: otherIncome.id, amount: -777700 },
      ],
    });

    const response = await GET(
      new Request(
        `http://localhost/api/transactions?accountId=${checking.id}&balanceAccountId=${otherChecking.id}&limit=1&offset=0&includeMeta=true`
      ),
      { params: Promise.resolve({ bookId: "1" }) }
    );
    const payload = await response.json();

    // Book 2's balance must never surface in a book 1 request.
    expect(response.status).toBe(400);
    expect(payload.startingBalance).toBeUndefined();
  });

  it("returns investment splits with stock split ratios", async () => {
    const investment = await createAccount({
      name: "Brokerage",
      type: "asset",
      subtype: "investment",
    });
    const investmentCash = await createAccount({
      name: "Brokerage Cash",
      type: "asset",
      subtype: "cash",
      parentId: investment.id,
      isInvestmentCash: true,
    });
    const security = await createSecurity({
      name: "Acme Corp",
      symbol: "ACME",
      securityType: "stock",
    });

    const splitTransaction = await createTransactionWithSplits({
      date: "2024-02-01",
      description: "Stock split",
      splits: [
        { accountId: investment.id, amount: 0 },
        { accountId: investmentCash.id, amount: 0 },
      ],
    });

    await createInvestmentSplit({
      transactionId: splitTransaction.id,
      securityId: security.id,
      action: "split",
      sharesMicros: 0,
      priceMicros: 0,
      splitNumerator: 3,
      splitDenominator: 2,
    });

    const response = await GET(
      new Request(
        `http://localhost/api/transactions?accountId=${investment.id}&limit=10&offset=0&includeMeta=true`
      ),
      { params: Promise.resolve({ bookId: "1" }) }
    );
    const payload = await response.json();

    expect(payload.transactions).toHaveLength(1);
    expect(payload.transactions[0].investmentSplits).toEqual([
      expect.objectContaining({
        action: "split",
        splitNumerator: 3,
        splitDenominator: 2,
      }),
    ]);
  });

  it("filters transactions by payee", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const groceries = await createAccount({ name: "Groceries", type: "expense" });
    const coffee = await createAccount({ name: "Coffee", type: "expense" });
    const payee = await createPayee({ name: "Blue Bottle" });

    const matching = await createTransactionWithSplits({
      date: "2024-03-01",
      description: "Latte",
      payeeId: payee.id,
      splits: [
        { accountId: coffee.id, amount: 450 },
        { accountId: checking.id, amount: -450 },
      ],
    });

    await createTransactionWithSplits({
      date: "2024-03-02",
      description: "Groceries",
      splits: [
        { accountId: groceries.id, amount: 2200 },
        { accountId: checking.id, amount: -2200 },
      ],
    });

    const response = await GET(
      new Request(
        `http://localhost/api/transactions?payeeId=${payee.id}&limit=10&offset=0&includeMeta=true`
      ),
      { params: Promise.resolve({ bookId: "1" }) }
    );
    const payload = await response.json();

    expect(payload.transactions).toHaveLength(1);
    expect(payload.transactions[0].id).toBe(matching.id);
  });

  it("returns check numbers for bank-account transactions", async () => {
    const checking = await createAccount({
      name: "Checking",
      type: "asset",
      subtype: "bank",
    });
    const rent = await createAccount({ name: "Rent", type: "expense" });

    await createTransactionWithSplits({
      date: "2024-03-10",
      description: "Rent check",
      checkNumber: "1234",
      splits: [
        { accountId: rent.id, amount: 150000 },
        { accountId: checking.id, amount: -150000 },
      ],
    });

    const response = await GET(
      new Request(
        `http://localhost/api/transactions?accountId=${checking.id}&limit=10&offset=0&includeMeta=true`
      ),
      { params: Promise.resolve({ bookId: "1" }) }
    );
    const payload = await response.json();

    expect(payload.transactions).toHaveLength(1);
    expect(payload.transactions[0].checkNumber).toBe("1234");
  });

  it("returns transactions when ensureId expands page beyond variable limit", { timeout: 30000 }, async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const groceries = await createAccount({ name: "Groceries", type: "expense" });

    const totalTransactions = 1100;
    let ensureTransactionId: number | null = null;

    for (let i = 0; i < totalTransactions; i += 1) {
      const transaction = await createTransactionWithSplits({
        date: "2024-01-01",
        description: `Txn ${i + 1}`,
        splits: [
          { accountId: groceries.id, amount: 100 },
          { accountId: checking.id, amount: -100 },
        ],
      });
      if (i === 0) {
        ensureTransactionId = transaction.id;
      }
    }

    expect(ensureTransactionId).not.toBeNull();

    const response = await GET(
      new Request(
        `http://localhost/api/transactions?accountId=${checking.id}&limit=50&offset=0&includeMeta=true&ensureId=${ensureTransactionId}`
      ),
      { params: Promise.resolve({ bookId: "1" }) }
    );

    expect(response.status).toBe(200);
    const payload = await response.json();

    expect(payload.totalCount).toBe(totalTransactions);
    expect(payload.transactions.length).toBeGreaterThan(1000);
    expect(payload.transactions.some((tx: { id: number }) => tx.id === ensureTransactionId)).toBe(true);
  });
});
