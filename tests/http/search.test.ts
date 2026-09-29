import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createAccount, createPayee, createRecurringRule, createTransactionWithSplits,
  resetTestDatabase, setupTestDatabase,
} from "../helpers/db-utils";
import { sessionHttpClient, startHttpTestServer } from "../helpers/http-parity";
import { contract } from "../helpers/contract";

const searchResponseSchema = contract("SearchResponse");

describe("search HTTP parity", () => {
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

  it("returns strict empty buckets and validates date filters before searching", async () => {
    const empty = await client.request("/api/b/1/search?q=");
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({
      transactions: [], accounts: { items: [], total: 0, truncated: false },
      payees: { items: [], total: 0, truncated: false },
      recurringRules: { items: [], total: 0, truncated: false },
    });
    const invalid = await client.request("/api/b/1/search?startDate=2025-02-30");
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "Invalid ISO date" });
  });

  it("searches all buckets with strict response fields and relevance order", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const expense = await createAccount({ name: "Coffee Expense", type: "expense" });
    const payee = await createPayee({ name: "Coffee Shop" });
    await createRecurringRule({
      name: "Coffee Subscription", frequency: "monthly", startDate: "2025-01-01", nextDate: "2025-02-01",
      templateSplits: [{ accountId: checking.id, amount: -100 }, { accountId: expense.id, amount: 100 }],
    });
    const transaction = await createTransactionWithSplits({
      date: "2025-01-15", description: "Morning coffee", notes: "beans", payeeId: payee.id,
      splits: [{ accountId: checking.id, amount: -500 }, { accountId: expense.id, amount: 500 }],
    });
    const response = await client.request("/api/b/1/search?q=coffee");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(searchResponseSchema.safeParse(body).success).toBe(true);
    expect(body.transactions[0]).toMatchObject({ id: transaction.id, date: "2025-01-15", description: "Morning coffee" });
    expect(body.transactions[0]).not.toHaveProperty("notes");
    expect(body.accounts.items.map((row: { name: string }) => row.name)).toEqual(["Coffee Expense"]);
    expect(body.payees.items.map((row: { name: string }) => row.name)).toEqual(["Coffee Shop"]);
    expect(body.recurringRules.items.map((row: { name: string }) => row.name)).toEqual(["Coffee Subscription"]);
  });

  it("matches an amount and limits only transaction dates", async () => {
    const cash = await createAccount({ name: "Cash", type: "asset" });
    const food = await createAccount({ name: "Food", type: "expense" });
    const old = await createTransactionWithSplits({
      date: "2025-01-01", splits: [{ accountId: cash.id, amount: -7500 }, { accountId: food.id, amount: 7500 }],
    });
    const current = await createTransactionWithSplits({
      date: "2025-03-01", splits: [{ accountId: cash.id, amount: -7500 }, { accountId: food.id, amount: 7500 }],
    });
    const response = await client.request("/api/b/1/search?q=75.00&startDate=2025-02-01");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.transactions.map((row: { id: number }) => row.id)).toEqual([current.id]);
    expect(body.transactions[0].splits).toHaveLength(2);
    expect(old.id).not.toBe(current.id);
  });

  it("parses whitespace after a currency symbol like JavaScript parseFloat", async () => {
    const cash = await createAccount({ name: "Cash", type: "asset" });
    const food = await createAccount({ name: "Food", type: "expense" });
    const transaction = await createTransactionWithSplits({
      date: "2025-03-01", splits: [{ accountId: cash.id, amount: -5000 }, { accountId: food.id, amount: 5000 }],
    });
    const response = await client.request(`/api/b/1/search?q=${encodeURIComponent("$ 50")}`);
    expect(response.status).toBe(200);
    expect((await response.json()).transactions.map((row: { id: number }) => row.id))
      .toEqual([transaction.id]);
  });

  it("reports the total when the account bucket is truncated", async () => {
    for (let index = 0; index < 26; index++) {
      await createAccount({ name: `Alpha ${String(index).padStart(2, "0")}`, type: "asset" });
    }
    const response = await client.request("/api/b/1/search?q=alpha");
    expect(response.status).toBe(200);
    expect((await response.json()).accounts).toMatchObject({ total: 26, truncated: true });
  });
});
