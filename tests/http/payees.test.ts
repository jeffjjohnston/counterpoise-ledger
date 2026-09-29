import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { toDateString } from "../../lib/formatters";
import {
  createAccount, createBook, createPayee, createTransactionWithSplits,
  resetTestDatabase, setupTestDatabase,
} from "../helpers/db-utils";
import { sessionHttpClient, startHttpTestServer } from "../helpers/http-parity";
import { contract } from "../helpers/contract";

const payeeListSchema = contract("PayeeList");

describe("payee read HTTP parity", () => {
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

  it("lists usage with effective floating dates and ranks matches before the limit", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const expense = await createAccount({ name: "Expense", type: "expense" });
    const lowRank = await createPayee({ name: "American Union" });
    const highRank = await createPayee({ name: "United" });
    await createTransactionWithSplits({
      date: "2020-01-01", isFloating: true, payeeId: highRank.id,
      splits: [{ accountId: checking.id, amount: -100 }, { accountId: expense.id, amount: 100 }],
    });
    const response = await client.request("/api/b/1/payees?search=uni&limit=1");
    expect(response.status).toBe(200);
    const rows = await response.json();
    expect(payeeListSchema.safeParse(rows).success).toBe(true);
    expect(rows).toEqual([{
      id: highRank.id, name: "United", lastTransactionDate: toDateString(new Date()),
      transactionCount: 1,
    }]);
    expect(lowRank.id).not.toBe(highRank.id);
  });

  it("returns a payee summary and rejects invalid or missing IDs", async () => {
    const payee = await createPayee({ name: "Cafe" });
    const response = await client.request(`/api/b/1/payees/${payee.id}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: payee.id, name: "Cafe", createdAt: payee.createdAt.toISOString(), transactionCount: 0,
    });
    for (const [id, status, message] of [
      ["abc", 400, "Invalid payee id"], ["999999", 404, "Payee not found"],
      ["3000000000", 500, "Failed to fetch payee"],
    ] as const) {
      const missing = await client.request(`/api/b/1/payees/${id}`);
      expect(missing.status).toBe(status);
      expect(await missing.json()).toEqual({ error: message });
    }
  });

  it("treats search wildcard characters literally and scopes rows to the book", async () => {
    const literal = await createPayee({ name: "A_B" });
    await createPayee({ name: "ACB" });
    const otherBook = await createBook({ name: "Other" });
    await createPayee({ name: "A_B elsewhere", bookId: otherBook.id });
    const response = await client.request("/api/b/1/payees?search=_");
    expect(response.status).toBe(200);
    expect((await response.json()).map((row: { id: number }) => row.id)).toEqual([literal.id]);
  });

  it("selects the largest debit on the latest transaction, breaking ties by history", async () => {
    const cash = await createAccount({ name: "Cash", type: "asset" });
    const food = await createAccount({ name: "Food", type: "expense" });
    const other = await createAccount({ name: "Other", type: "expense" });
    const payee = await createPayee({ name: "Cafe" });
    const path = `/api/b/1/payees/${payee.id}/last-account`;
    expect(await (await client.request(path)).json()).toEqual({ accountId: null });
    await createTransactionWithSplits({
      date: "2025-01-01", payeeId: payee.id,
      splits: [{ accountId: cash.id, amount: -200 }, { accountId: food.id, amount: 200 }],
    });
    await createTransactionWithSplits({
      date: "2025-01-02", payeeId: payee.id,
      splits: [{ accountId: cash.id, amount: -200 }, { accountId: food.id, amount: 100 }, { accountId: other.id, amount: 100 }],
    });
    const response = await client.request(path);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accountId: food.id });
  });

  it("refuses a last-account payee ID that is NaN or not finite, and fails one outside int4", async () => {
    for (const [id, status, message] of [
      ["abc", 400, "Invalid payee id"],
      ["9".repeat(400), 400, "Invalid payee id"],
      ["99999999999", 500, "Failed to fetch last account"],
    ] as const) {
      const response = await client.request(`/api/b/1/payees/${id}/last-account`);
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error: message });
    }
  });
});
