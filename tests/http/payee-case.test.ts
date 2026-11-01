import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAccount, createPayee, resetTestDatabase, setupTestDatabase } from "../helpers/db-utils";
import { sessionHttpClient, startHttpTestServer } from "../helpers/http-parity";
import { scalar } from "../helpers/sql";

type Client = Awaited<ReturnType<typeof sessionHttpClient>>;

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

/**
 * A payee name matches without letter case. The database refuses variants
 * that differ only by ASCII case; variants that differ by a non-ASCII letter
 * ("ÉCLAIR", "éclair") can still exist, and then the exact spelling wins,
 * then the oldest.
 */
describe("payee names that differ only by letter case", () => {
  let baseUrl: string;
  let stop: () => Promise<void>;
  let client: Client;

  beforeAll(async () => {
    await setupTestDatabase();
    ({ baseUrl, stop } = await startHttpTestServer({}));
  }, 120_000);
  beforeEach(async () => {
    await resetTestDatabase();
    client = await sessionHttpClient(baseUrl);
  });
  afterAll(async () => { await stop?.(); });

  async function fixture() {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const food = await createAccount({ name: "Food", type: "expense" });
    const upper = await createPayee({ name: "ÉCLAIR" });
    const mixed = await createPayee({ name: "éclair" });
    const spend = (payeeName: string) => ({
      date: "2026-03-01", payeeName,
      splits: [{ accountId: checking.id, amount: -100 }, { accountId: food.id, amount: 100 }],
    });
    return { upper, mixed, spend };
  }

  it("links a transaction to the exact spelling, else to the oldest payee", async () => {
    const f = await fixture();
    for (const [typed, expected] of [["éclair", f.mixed.id], ["ÉCLAIR", f.upper.id], ["Éclair", f.upper.id]] as const) {
      const response = await client.request("/api/b/1/transactions", json("POST", f.spend(typed)));
      expect(response.status, typed).toBe(200);
      const { id } = await response.json();
      expect(await scalar("SELECT payee_id FROM transactions WHERE id = $1", [id]), typed).toBe(expected);
    }
    expect(await scalar("SELECT COUNT(*) FROM payees")).toBe(2);
  });

  it("returns the exact spelling from POST /payees, else the oldest payee", async () => {
    const f = await fixture();
    for (const [typed, expected] of [["éclair", f.mixed.id], ["ÉCLAIR", f.upper.id], ["Éclair", f.upper.id]] as const) {
      const response = await client.request("/api/b/1/payees", json("POST", { name: typed }));
      expect((await response.json()).id, typed).toBe(expected);
    }
  });

  it("creates one payee when case variants of a new name arrive at the same time", async () => {
    const names = ["PayPal", "Paypal", "PAYPAL", "paypal", "PayPAL", "payPal", "PaYpAl", "PAYpal"];
    const answers = await Promise.all(names.map((name) => client.request("/api/b/1/payees", json("POST", { name }))));
    for (const answer of answers) expect(answer.status).toBe(200);
    expect(await scalar("SELECT COUNT(*) FROM payees WHERE lower(name) = 'paypal'")).toBe(1);
  });
});
