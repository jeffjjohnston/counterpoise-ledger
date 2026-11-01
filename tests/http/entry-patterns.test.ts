import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  addBookMember, createAccount, createBook, createPayee, createSecurity, createTransactionWithSplits, createUser,
  resetTestDatabase, setupTestDatabase,
} from "../helpers/db-utils";
import { sessionHttpClient, startHttpTestServer } from "../helpers/http-parity";
import { insert } from "../helpers/sql";

type Client = Awaited<ReturnType<typeof sessionHttpClient>>;

/** A local date `offset` days from today (the server runs with TZ=UTC). */
function day(offset: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

describe("entry patterns route", () => {
  let baseUrl: string;
  let stop: () => Promise<void>;
  let client: Client;

  beforeAll(async () => {
    await setupTestDatabase();
    ({ baseUrl, stop } = await startHttpTestServer({ TZ: "UTC" }));
  }, 120_000);
  beforeEach(async () => {
    await resetTestDatabase();
    client = await sessionHttpClient(baseUrl);
  });
  afterAll(async () => { await stop?.(); });

  async function fixture(bookId = 1) {
    const checking = await createAccount({ name: "Checking", type: "asset", subtype: "bank", bookId });
    const groceries = await createAccount({ name: "Groceries", type: "expense", bookId });
    const household = await createAccount({ name: "Household", type: "expense", bookId });
    const costco = await createPayee({ name: "Costco", bookId });
    const spend = (date: string, to: number, amount: number, isFloating = false) =>
      createTransactionWithSplits({
        date, payeeId: costco.id, isFloating, bookId,
        splits: [{ accountId: to, amount }, { accountId: checking.id, amount: -amount }],
      });
    return { checking, groceries, household, costco, spend };
  }

  const path = (payeeId: number, accountId: number | string, bookId = 1) =>
    `/api/b/${bookId}/payees/${payeeId}/entry-patterns?accountId=${accountId}`;

  it("returns the patterns, newest first", async () => {
    const f = await fixture();
    await f.spend(day(-30), f.groceries.id, 3120);
    await f.spend(day(-20), f.household.id, 9000);
    await f.spend(day(-10), f.groceries.id, 4210);
    const response = await client.request(path(f.costco.id, f.checking.id));
    expect(response.status).toBe(200);
    const { patterns } = await response.json();
    expect(patterns).toEqual([
      {
        key: `${f.groceries.id}:in`,
        splits: expect.arrayContaining([
          { accountId: f.groceries.id, amount: 4210 },
          { accountId: f.checking.id, amount: -4210 },
        ]),
        count: 2, lastDate: day(-10), stable: false, range: { min: 3120, max: 4210 },
      },
      expect.objectContaining({ key: `${f.household.id}:in`, count: 1, stable: false }),
    ]);
  });

  it("uses the effective date of a floating transaction", async () => {
    const f = await fixture();
    await f.spend(day(-5), f.groceries.id, 100);
    await f.spend(day(-40), f.household.id, 200, true);
    const { patterns } = await (await client.request(path(f.costco.id, f.checking.id))).json();
    expect(patterns.map((p: { key: string }) => p.key)).toEqual([`${f.household.id}:in`, `${f.groceries.id}:in`]);
  });

  it("leaves out investment transactions and uses older than 24 months", async () => {
    const f = await fixture();
    await f.spend(day(-800), f.groceries.id, 100);
    const brokerage = await f.spend(day(-3), f.household.id, 200);
    const vti = await createSecurity({ name: "VTI", symbol: "VTI", securityType: "etf" });
    await insert("investment_splits", {
      bookId: 1, transactionId: brokerage.id, accountId: f.checking.id, securityId: vti.id,
      action: "buy", sharesMicros: 1_000_000, priceMicros: 1_000_000,
    });
    const { patterns } = await (await client.request(path(f.costco.id, f.checking.id))).json();
    expect(patterns).toEqual([]);
  });

  it("answers 404 for an account or a payee of another book, and 400 for a bad accountId", async () => {
    const f = await fixture();
    await createUser({ username: "owner2" });
    await createBook({ name: "Other", userId: 2 });
    const other = await createAccount({ name: "Elsewhere", type: "asset", bookId: 2 });
    const stranger = await createPayee({ name: "Stranger", bookId: 2 });
    expect((await client.request(path(f.costco.id, other.id))).status).toBe(404);
    expect((await client.request(path(stranger.id, f.checking.id))).status).toBe(404);
    expect((await client.request(`/api/b/1/payees/${f.costco.id}/entry-patterns`)).status).toBe(400);
    expect((await client.request(path(f.costco.id, "x"))).status).toBe(400);
  });

  it("lets a viewer read", async () => {
    await createUser({ username: "owner2" });
    await createBook({ name: "Shared", userId: 2 });
    await addBookMember({ bookId: 2, userId: 1, role: "viewer" });
    const f = await fixture(2);
    await f.spend(day(-3), f.groceries.id, 500);
    const response = await client.request(path(f.costco.id, f.checking.id, 2));
    expect(response.status).toBe(200);
    expect((await response.json()).patterns).toHaveLength(1);
  });
});
