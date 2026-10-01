import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createAccount, createPayee, createRecurringRule, createSecurity, createTransactionWithSplits,
  resetTestDatabase, setupTestDatabase,
} from "../helpers/db-utils";
import { sessionHttpClient, startHttpTestServer } from "../helpers/http-parity";

// These cases pin the text behaviour of the SQL engine: case folding, LIKE
// wildcards and name order. The database engine must not change them.
//
// Name order is UTF-8 byte order. The production and development PostgreSQL
// images are Alpine (musl), and musl collates `en_US.utf8` as bytes: "Banana"
// sorts before "apple", and "Éclair" sorts after "zebra". SQLite's BINARY
// collation gives the same order.
//
// Case folding is Unicode: PostgreSQL `lower()` folds "É" to "é". SQLite's
// built-in `lower()` folds ASCII only.
describe("text semantics HTTP parity", () => {
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

  async function ok(path: string, init: RequestInit = {}) {
    const response = await client.request(path, init);
    expect(response.status, `${init.method ?? "GET"} ${path}`).toBe(200);
    return response.json();
  }

  function post(body: unknown): RequestInit {
    return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
  }

  const names = (rows: { name: string }[]) => rows.map((row) => row.name);

  it("lists payees in UTF-8 byte order", async () => {
    for (const name of ["zebra", "Éclair", "apple", "Banana", "Zebra", "A Z", "AB", "eggs"]) {
      await createPayee({ name });
    }
    expect(names(await ok("/api/b/1/payees"))).toEqual(
      ["A Z", "AB", "Banana", "Zebra", "apple", "eggs", "zebra", "Éclair"],
    );
  });

  it("lists securities in UTF-8 byte order", async () => {
    for (const [name, symbol] of [["vanguard", "V1"], ["Éte Fund", "E1"], ["Zeta", "Z1"], ["alpha", "A1"]]) {
      await createSecurity({ name, symbol, securityType: "etf" });
    }
    expect(names(await ok("/api/b/1/securities"))).toEqual(["Zeta", "alpha", "vanguard", "Éte Fund"]);
  });

  it("folds non-ASCII case in the payee search and ranks prefixes first", async () => {
    await createPayee({ name: "Crème ÉCLAIR" });
    await createPayee({ name: "Éclair Café" });
    await createPayee({ name: "éclairs à la carte" });
    await createPayee({ name: "Eclair Plain" });
    expect(names(await ok(`/api/b/1/payees?search=${encodeURIComponent("ÉCLAIR")}`))).toEqual(
      ["Éclair Café", "éclairs à la carte", "Crème ÉCLAIR"],
    );
    expect(names(await ok(`/api/b/1/payees?search=${encodeURIComponent("café")}`))).toEqual(["Éclair Café"]);
  });

  it("treats the percent sign in a payee search as a literal", async () => {
    await createPayee({ name: "50% Off" });
    await createPayee({ name: "500 Club" });
    expect(names(await ok("/api/b/1/payees?search=50%25"))).toEqual(["50% Off"]);
  });

  it("returns the stored payee for a non-ASCII case variant", async () => {
    const stored = await createPayee({ name: "Éclair Café" });
    const found = await ok("/api/b/1/payees", post({ name: "ÉCLAIR CAFÉ" }));
    expect(found).toMatchObject({ id: stored.id, name: "Éclair Café" });
  });

  it("resolves a transaction payee name to a non-ASCII case variant", async () => {
    const cash = await createAccount({ name: "Cash", type: "asset" });
    const food = await createAccount({ name: "Food", type: "expense" });
    const stored = await createPayee({ name: "Ünique Bäckerei" });
    const created = await ok("/api/b/1/transactions", post({
      date: "2025-03-01", payeeName: "ÜNIQUE BÄCKEREI",
      splits: [{ accountId: cash.id, amount: -100 }, { accountId: food.id, amount: 100 }],
    }));
    expect(created.payeeId).toBe(stored.id);
    const payees = await ok("/api/b/1/payees");
    expect(names(payees)).toEqual(["Ünique Bäckerei"]);
  });

  it("finds a security symbol case-insensitively, including non-ASCII", async () => {
    const stored = await createSecurity({ name: "Straße Fund", symbol: "ÄBC", securityType: "etf" });
    const response = await client.request("/api/b/1/securities", post({
      name: "Again", symbol: "äbc", securityType: "etf",
    }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: `A security with symbol "äbc" already exists (id ${stored.id})` });
  });

  // The global search does not escape LIKE wildcards: "%" and "_" match any
  // text, and a backslash escapes the next character (the PostgreSQL default
  // escape). This is the behaviour today; the test pins it.
  it("folds case in the global search and keeps the LIKE wildcards", async () => {
    const cash = await createAccount({ name: "Cash", type: "asset" });
    const food = await createAccount({ name: "Food", type: "expense" });
    const splits = [{ accountId: cash.id, amount: -100 }, { accountId: food.id, amount: 100 }];
    const accented = await createTransactionWithSplits({ date: "2025-01-02", description: "Déjeuner ÉTÉ", splits });
    const noted = await createTransactionWithSplits({ date: "2025-01-01", description: "Lunch", notes: "été menu", splits });
    await createTransactionWithSplits({ date: "2025-01-03", description: "Ete plain", splits });
    const body = await ok(`/api/b/1/search?q=${encodeURIComponent("Été")}`);
    expect(body.transactions.map((row: { id: number }) => row.id)).toEqual([accented.id, noted.id]);

    const percent = await createTransactionWithSplits({ date: "2025-02-01", description: "Sale 20% off", splits });
    const digits = await createTransactionWithSplits({ date: "2025-02-02", description: "Sale 200 off", splits });
    const wildcard = await ok("/api/b/1/search?q=20%25");
    expect(wildcard.transactions.map((row: { id: number }) => row.id)).toEqual([digits.id, percent.id]);

    const escaped = await createTransactionWithSplits({ date: "2025-03-01", description: "Xylo", splits });
    await createTransactionWithSplits({ date: "2025-03-02", description: "X\\ylo", splits });
    const backslash = await ok(`/api/b/1/search?q=${encodeURIComponent("x\\y")}`);
    expect(backslash.transactions.map((row: { id: number }) => row.id)).toEqual([escaped.id]);
  });

  it("orders search buckets by exact match, prefix, then lower-cased byte order", async () => {
    for (const name of ["Zed Cafe", "cafe", "Éclair Cafe", "Cafe Bleu", "apple cafe"]) {
      await createPayee({ name });
    }
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const expense = await createAccount({ name: "Expense", type: "expense" });
    for (const name of ["Zoo Cafe", "CAFE", "cafeteria"]) {
      await createRecurringRule({
        name, frequency: "monthly", startDate: "2025-01-01", nextDate: "2025-02-01",
        templateSplits: [{ accountId: checking.id, amount: -100 }, { accountId: expense.id, amount: 100 }],
      });
    }
    const body = await ok("/api/b/1/search?q=CAFE");
    expect(names(body.payees.items)).toEqual(["cafe", "Cafe Bleu", "apple cafe", "Zed Cafe", "Éclair Cafe"]);
    expect(names(body.recurringRules.items)).toEqual(["CAFE", "cafeteria", "Zoo Cafe"]);
  });
});
