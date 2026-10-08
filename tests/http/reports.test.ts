import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { toDateString } from "../../lib/formatters";
import {
  createAccount, createBook, createPayee, createTransactionWithSplits, resetTestDatabase, setupTestDatabase,
} from "../helpers/db-utils";
import { sessionHttpClient, startHttpTestServer } from "../helpers/http-parity";

describe("report HTTP parity", () => {
  let baseUrl: string;
  let stop: () => Promise<void>;
  let client: Awaited<ReturnType<typeof sessionHttpClient>>;
  beforeAll(async () => {
    await setupTestDatabase();
    ({ baseUrl, stop } = await startHttpTestServer());
  }, 120_000);
  beforeEach(async () => {
    await resetTestDatabase();
    client = await sessionHttpClient(baseUrl);
  });
  afterAll(async () => { await stop?.(); });

  it("reports filtered splits in effective-date order while listing all accounts", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const salary = await createAccount({ name: "Salary", type: "income" });
    const groceries = await createAccount({ name: "Groceries", type: "expense" });
    await createTransactionWithSplits({
      date: "2025-01-01", splits: [
        { accountId: checking.id, amount: 1000 }, { accountId: salary.id, amount: -1000 },
      ],
    });
    await createTransactionWithSplits({
      date: "2020-01-01", isFloating: true, splits: [
        { accountId: checking.id, amount: -300 }, { accountId: groceries.id, amount: 300 },
      ],
    });
    const today = toDateString(new Date());
    const response = await client.request(
      `/api/b/1/reports/data?startDate=${today}&endDate=${today}&accountTypes=expense,invalid`,
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.accounts).toHaveLength(3);
    expect(body.splits).toEqual([{
      splitId: expect.any(Number), transactionId: expect.any(Number), date: today,
      amount: 300, accountId: groceries.id, accountName: "Groceries",
      accountType: "expense", accountParentId: null, payeeId: null, payeeName: null,
    }]);
    expect(body.splits[0]).not.toHaveProperty("description");
  });

  it("filters the splits by payeeId and keeps the filter inside the book", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const groceries = await createAccount({ name: "Groceries", type: "expense" });
    const market = await createPayee({ name: "Market" });
    const cafe = await createPayee({ name: "Cafe" });
    for (const [payee, amount] of [[market, 300], [cafe, 500]] as const) {
      await createTransactionWithSplits({
        date: "2025-01-10", payeeId: payee.id, splits: [
          { accountId: checking.id, amount: -amount }, { accountId: groceries.id, amount },
        ],
      });
    }
    const otherBook = await createBook({ name: "Other" });
    const foreign = await createPayee({ name: "Foreign", bookId: otherBook.id });

    const own = await client.request(`/api/b/1/reports/data?payeeId=${market.id}&accountTypes=expense`);
    expect(own.status).toBe(200);
    const ownBody = await own.json();
    expect(ownBody.splits).toHaveLength(1);
    expect(ownBody.splits[0]).toMatchObject({ amount: 300, payeeId: market.id, payeeName: "Market" });

    const foreignResponse = await client.request(`/api/b/1/reports/data?payeeId=${foreign.id}`);
    expect(foreignResponse.status).toBe(200);
    expect((await foreignResponse.json()).splits).toEqual([]);
  });

  it("rejects a payeeId that is not a positive integer", async () => {
    for (const value of ["abc", "0", "-3", "1.5", "", "2x"]) {
      const response = await client.request(`/api/b/1/reports/data?payeeId=${value}`);
      expect(response.status, value).toBe(400);
      expect(await response.json()).toEqual({ error: "Invalid payeeId" });
    }
  });

  it("keeps signed income and expense totals, including zero-balance accounts", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const salary = await createAccount({ name: "Salary", type: "income" });
    const rent = await createAccount({ name: "Rent", type: "expense" });
    const unused = await createAccount({ name: "Unused", type: "expense", isActive: false });
    await createTransactionWithSplits({
      date: "2025-01-15", splits: [
        { accountId: checking.id, amount: 1000 }, { accountId: salary.id, amount: -1000 },
      ],
    });
    await createTransactionWithSplits({
      date: "2025-01-16", splits: [
        { accountId: checking.id, amount: -250 }, { accountId: rent.id, amount: 250 },
      ],
    });
    const response = await client.request(
      "/api/b/1/reports/income-statement?startDate=2025-01-01&endDate=2025-01-31&includeInactive=true",
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.accounts).toEqual([
      { accountId: rent.id, name: "Rent", type: "expense", balance: 250 },
      { accountId: unused.id, name: "Unused", type: "expense", balance: 0 },
      { accountId: salary.id, name: "Salary", type: "income", balance: -1000 },
    ]);
    expect(body.totals).toEqual({ income: -1000, expense: 250 });
  });

  it("keeps a zero-padded account ID filter instead of dropping it", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const salary = await createAccount({ name: "Salary", type: "income" });
    await createTransactionWithSplits({
      date: "2025-01-01", splits: [
        { accountId: checking.id, amount: 1000 }, { accountId: salary.id, amount: -1000 },
      ],
    });
    const paddedId = String(checking.id).padStart(30, "0");
    const response = await client.request(`/api/b/1/reports/data?accountIds=${paddedId}`);
    expect(response.status).toBe(200);
    expect((await response.json()).splits.map((row: { accountId: number }) => row.accountId))
      .toEqual([checking.id]);
  });

  it("preserves query errors and read access denials", async () => {
    for (const [path, message] of [
      ["/reports/data?startDate=2025-02-30", "Invalid ISO date"],
      ["/reports/income-statement?startDate=2025-01-01", "Both startDate and endDate are required"],
    ] as const) {
      const response = await client.request(`/api/b/1${path}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: message });
    }
    const missing = await client.request("/api/b/999999/reports/data");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Book not found" });
  });
});
