import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { GET } from "@/app/api/b/[bookId]/reports/income-statement/route";
import {
  createAccount,
  createTransactionWithSplits,
  resetTestDatabase,
  setupTestDatabase,
} from "@/tests/helpers/db";

vi.mock("@/lib/api-auth", async () => {
  const { mockApiAuth } = await import("@/tests/helpers/db");
  return mockApiAuth();
});

describe("GET /api/reports/income-statement", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("returns income and expense balances for the date range", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const salary = await createAccount({ name: "Salary", type: "income" });
    const interest = await createAccount({ name: "Interest", type: "income" });
    const groceries = await createAccount({ name: "Groceries", type: "expense" });
    const rent = await createAccount({ name: "Rent", type: "expense" });

    await createTransactionWithSplits({
      date: "2024-01-05",
      description: "Paycheck",
      splits: [
        { accountId: checking.id, amount: 10000 },
        { accountId: salary.id, amount: -10000 },
      ],
    });

    await createTransactionWithSplits({
      date: "2024-01-10",
      description: "Groceries",
      splits: [
        { accountId: groceries.id, amount: 2500 },
        { accountId: checking.id, amount: -2500 },
      ],
    });

    await createTransactionWithSplits({
      date: "2024-01-15",
      description: "Interest",
      splits: [
        { accountId: checking.id, amount: 500 },
        { accountId: interest.id, amount: -500 },
      ],
    });

    await createTransactionWithSplits({
      date: "2024-02-01",
      description: "Rent",
      splits: [
        { accountId: rent.id, amount: 3000 },
        { accountId: checking.id, amount: -3000 },
      ],
    });

    const response = await GET(
      new Request(
        "http://localhost/api/reports/income-statement?startDate=2024-01-01&endDate=2024-01-31"
      ),
      { params: Promise.resolve({ bookId: "1" }) }
    );
    const payload = await response.json();
    const accounts = payload.accounts as Array<{
      accountId: number;
      balance: number;
    }>;

    const balances = new Map(
      accounts.map((account) => [account.accountId, account.balance])
    );

    expect(balances.get(salary.id)).toBe(-10000);
    expect(balances.get(interest.id)).toBe(-500);
    expect(balances.get(groceries.id)).toBe(2500);
    expect(balances.get(rent.id)).toBe(0);
    expect(payload.totals).toEqual({ income: -10500, expense: 2500 });
  });
});
