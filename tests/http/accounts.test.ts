import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createAccount,
  createTransactionWithSplits,
  resetTestDatabase,
  setupTestDatabase,
} from "../helpers/db-utils";
import { sessionHttpClient, startHttpTestServer } from "../helpers/http-parity";
import { contract, type Contract } from "../helpers/contract";

const accountDetailSchema = contract("AccountDetail");
const accountNodeListSchema = contract("AccountNodeList");
const versionSchema = contract("Version");

type Client = Awaited<ReturnType<typeof sessionHttpClient>>;

function expectShape(schema: Contract<unknown>, body: unknown): void {
  schema.parse(body);
}

describe("account HTTP parity", () => {
  let baseUrl: string;
  let stop: () => Promise<void>;
  let client: Client;

  beforeAll(async () => {
    await setupTestDatabase();
    ({ baseUrl, stop } = await startHttpTestServer());
  }, 120_000);

  beforeEach(async () => {
    await resetTestDatabase();
    client = await sessionHttpClient(baseUrl);
  });

  afterAll(async () => { await stop?.(); });

  async function accounts(query = "") {
    const response = await client.request(`/api/b/1/accounts${query}`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expectShape(accountNodeListSchema, body);
    return body as Array<{
      id: number;
      name: string;
      type: string;
      balance: number;
      hasTransactions: boolean;
      children: Array<{ name: string; balance: number }>;
    }>;
  }

  it("serves the public version with its strict response shape", async () => {
    const response = await client.anonymous("/api/version");
    expect(response.status).toBe(200);
    expectShape(versionSchema, await response.json());
  });

  it("probes the owning server's database connection", async () => {
    const probe = await client.anonymous("/health");
    expect(probe.status).toBe(200);
    expect(await probe.text()).toBe("");
    // The deploy check reads this one. The container healthcheck reads /health.
    const response = await client.anonymous("/api/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, db: true });
  });

  it("returns a strict empty account list", async () => {
    expect(await accounts()).toEqual([]);
  });

  it("returns a book-scoped account detail with raw children and split balance", async () => {
    const parent = await createAccount({ name: "Checking", type: "asset" });
    const child = await createAccount({ name: "Savings", type: "asset", parentId: parent.id });
    const expense = await createAccount({ name: "Groceries", type: "expense" });
    await createTransactionWithSplits({
      date: "2025-01-01",
      splits: [{ accountId: parent.id, amount: -750 }, { accountId: expense.id, amount: 750 }],
    });
    const response = await client.request(`/api/b/1/accounts/${parent.id}`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expectShape(accountDetailSchema, body);
    expect(body).toMatchObject({ id: parent.id, balance: -750, hasTransactions: true });
    expect(body.children.map((row: { id: number }) => row.id)).toEqual([child.id]);
    expect(body.children[0]).not.toHaveProperty("balance");
    const missing = await client.request("/api/b/1/accounts/999999");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Account not found" });
  });

  it("orders roots and nests child accounts", async () => {
    const parent = await createAccount({ name: "Checking", type: "asset" });
    await createAccount({ name: "Savings Sub", type: "asset", parentId: parent.id });
    await createAccount({ name: "Groceries", type: "expense" });
    const list = await accounts();
    expect(list.map((account) => account.name)).toEqual(["Checking", "Groceries"]);
    expect(list[0].children.map((child) => child.name)).toEqual(["Savings Sub"]);
    expect(list[0]).toMatchObject({ balance: 0, hasTransactions: false });
    expect(list[0].children[0]).toMatchObject({ balance: 0 });
  });

  it("sums split balances and applies the asOfDate boundary", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const groceries = await createAccount({ name: "Groceries", type: "expense" });
    await createTransactionWithSplits({
      date: "2025-01-01",
      splits: [{ accountId: checking.id, amount: -1000 }, { accountId: groceries.id, amount: 1000 }],
    });
    await createTransactionWithSplits({
      date: "2025-06-01",
      splits: [{ accountId: checking.id, amount: -2000 }, { accountId: groceries.id, amount: 2000 }],
    });
    expect((await accounts()).find((account) => account.id === checking.id)).toMatchObject({
      balance: -3000, hasTransactions: true,
    });
    expect((await accounts("?asOfDate=2025-03-01")).find((account) => account.id === checking.id)).toMatchObject({
      balance: -1000, hasTransactions: true,
    });
  });

  it("filters type and inactive rows", async () => {
    await createAccount({ name: "Checking", type: "asset" });
    await createAccount({ name: "Closed", type: "asset", isActive: false });
    await createAccount({ name: "Groceries", type: "expense" });
    expect((await accounts("?type=asset")).map((account) => account.name)).toEqual(["Checking"]);
    expect((await accounts("?type=asset&includeInactive=true")).map((account) => account.name)).toEqual(["Checking", "Closed"]);
    expect((await accounts("?type=asset&type=banana")).map((account) => account.name)).toEqual(["Checking"]);
  });

  it("rejects invalid filters and inaccessible books with the same bodies", async () => {
    for (const [path, status, body] of [
      ["/api/b/1/accounts?asOfDate=2025-02-30", 400, { error: "Invalid ISO date" }],
      ["/api/b/1/accounts?type=banana", 400, { error: 'Invalid option: expected one of "asset"|"liability"|"equity"|"income"|"expense"' }],
      ["/api/b/999999/accounts", 404, { error: "Book not found" }],
      ["/api/b/not-a-book/accounts", 400, { error: "Invalid book ID" }],
      ["/api/b/99999999999/accounts", 500, { error: "Failed to fetch accounts" }],
      [`/api/b/${"9".repeat(400)}/accounts`, 500, { error: "Failed to fetch accounts" }],
    ] as const) {
      const response = await client.request(path);
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual(body);
    }
    const anonymous = await client.anonymous("/api/b/1/accounts");
    expect(anonymous.status).toBe(401);
  });
});
