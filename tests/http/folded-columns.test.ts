import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAccount, resetTestDatabase, setupTestDatabase } from "../helpers/db-utils";
import { onWorker, sessionHttpClient, startHttpTestServer } from "../helpers/http-parity";
import { exec, staleFolds } from "../helpers/sql";

const post = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/**
 * The `*_fold` columns: every write path stores them, and the server's start
 * repairs one that a write outside the app left stale.
 */
describe("folded columns", () => {
  let baseUrl: string;
  let stop: () => Promise<void>;

  beforeAll(async () => {
    await setupTestDatabase();
    ({ baseUrl, stop } = await startHttpTestServer());
  }, 120_000);
  afterAll(async () => { await stop?.(); });

  it("matches a payee that the API created to a non-ASCII case variant", async () => {
    await resetTestDatabase();
    const client = await sessionHttpClient(baseUrl);
    const cash = await createAccount({ name: "Cash", type: "asset" });
    const food = await createAccount({ name: "Food", type: "expense" });
    const created = await client.request("/api/b/1/payees", post({ name: "Ölmühle Straße" }));
    const payee = (await created.json()) as { id: number };
    const response = await client.request("/api/b/1/transactions", post({
      date: "2025-03-01", payeeName: "ÖLMÜHLE STRAßE", description: "ÉTÉ",
      splits: [{ accountId: cash.id, amount: -100 }, { accountId: food.id, amount: 100 }],
    }));
    expect(((await response.json()) as { payeeId: number }).payeeId).toBe(payee.id);
    const search = await client.request(`/api/b/1/search?q=${encodeURIComponent("été")}`);
    const body = (await search.json()) as { transactions: unknown[] };
    expect(body.transactions).toHaveLength(1);
  });

  it("repairs a stale fold when the server starts", async () => {
    await resetTestDatabase();
    const client = await sessionHttpClient(baseUrl);
    await client.request("/api/b/1/payees", post({ name: "Café" }));
    // An edit in the sqlite3 shell changes the name and not its fold.
    await exec("UPDATE payees SET name = 'ÉCOLE' WHERE name = 'Café'");
    expect(staleFolds()).toEqual([{ table: "payees", column: "name_fold", id: expect.any(Number) }]);

    const restarted = await startHttpTestServer();
    try {
      expect(staleFolds()).toEqual([]);
      const again = await sessionHttpClient(restarted.baseUrl);
      const search = await again.request("/api/b/1/search?q=école");
      const body = (await search.json()) as { payees: { items: Array<{ name: string }> } };
      expect(body.payees.items.map((item) => item.name)).toEqual(["ÉCOLE"]);
    } finally {
      await restarted.stop();
    }
  }, 120_000);

  // The object starts again after each hibernation, and the repair reads
  // every row, so a deployed object repairs once for each build
  // (BUILD_COMMIT), not at each start.
  it.runIf(onWorker)("repairs the folds on the Worker once for each build", async () => {
    await resetTestDatabase();
    const client = await sessionHttpClient(baseUrl);
    await client.request("/api/b/1/payees", post({ name: "Café" }));
    const startOn = async (build: string) => {
      const server = await startHttpTestServer({ BUILD_COMMIT: build });
      await server.stop();
    };
    await startOn("build-a");
    await exec("UPDATE payees SET name = 'ÉCOLE' WHERE name = 'Café'");

    await startOn("build-a");
    expect(staleFolds()).toEqual([{ table: "payees", column: "name_fold", id: expect.any(Number) }]);
    await startOn("build-b");
    expect(staleFolds()).toEqual([]);
  }, 180_000);
});
