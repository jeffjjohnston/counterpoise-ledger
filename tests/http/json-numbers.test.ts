import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createAccount, createSecurity, createSecurityPrice, resetTestDatabase, setupTestDatabase,
} from "../helpers/db-utils";
import { rows } from "../helpers/sql";
import { sessionHttpClient, startHttpTestServer } from "../helpers/http-parity";

/**
 * `JSON.parse` reads a number beyond the double range as Infinity, and one
 * below it as 0. Zod then refuses Infinity with its own "received Infinity"
 * issue, and a field that is not validated keeps it. `JSON.stringify` cannot
 * write these bodies, so each one is raw text.
 */
const HUGE = "1e400";
const LONG_INTEGER = "9".repeat(400);

describe("JSON numbers outside the double range", () => {
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

  async function send(method: string, path: string, body: string) {
    const response = await client.request(path, { method, headers: { "content-type": "application/json" }, body });
    return { status: response.status, body: await response.json() };
  }

  it("get the zod issue for Infinity, not the route's 500 message", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset", subtype: "bank" });
    const food = await createAccount({ name: "Food", type: "expense" });
    const acme = await createSecurity({ name: "Acme", symbol: "ACME", securityType: "stock" });
    const split = (amount: string) =>
      `{"date":"2025-01-02","splits":[{"accountId":${checking.id},"amount":${amount}},{"accountId":${food.id},"amount":1}]}`;

    const results: Record<string, unknown> = {};
    for (const [label, method, path, body] of [
      ["top-level body", "PUT", `/api/b/1/securities/${acme.id}`, HUGE],
      ["security name", "PUT", `/api/b/1/securities/${acme.id}`, `{"name":${HUGE}}`],
      ["negative security name", "PUT", `/api/b/1/securities/${acme.id}`, `{"name":-${HUGE}}`],
      ["fixed price", "POST", "/api/b/1/securities", `{"name":"A","symbol":"B","securityType":"etf","fixedPriceMicros":${HUGE}}`],
      ["account parent", "POST", "/api/b/1/accounts", `{"name":"A","type":"asset","parentId":${HUGE}}`],
      ["payee name", "POST", "/api/b/1/payees", `{"name":${HUGE}}`],
      ["split amount", "POST", "/api/b/1/transactions", split(HUGE)],
      ["negative split amount", "POST", "/api/b/1/transactions", split(`-${HUGE}`)],
      ["long integer amount", "POST", "/api/b/1/transactions", split(LONG_INTEGER)],
      ["upcoming days", "PUT", "/api/books/1", `{"name":"Book","upcomingDays":${HUGE}}`],
      ["price micros", "PUT", `/api/b/1/securities/${acme.id}/prices/2025-01-10`, `{"priceDate":"2025-01-10","priceMicros":${HUGE}}`],
      ["issue report", "POST", "/api/issue-reports", `{"description":${HUGE}}`],
    ] as const) {
      results[label] = await send(method, path, body);
    }
    expect(results["security name"]).toEqual({
      status: 400, body: { error: "Invalid input: expected string, received Infinity" },
    });
    expect(results["negative split amount"]).toEqual({
      status: 400, body: { error: "Invalid input: expected number, received -Infinity" },
    });
    expect(Object.values(results).every((result) => (result as { status: number }).status < 500)).toBe(true);
    expect(results).toMatchSnapshot();
  });

  it("keep Infinity in a field that is not validated and read an underflow as 0", async () => {
    const acme = await createSecurity({ name: "Acme", symbol: "ACME", securityType: "stock" });
    await createSecurityPrice({ securityId: acme.id, priceDate: "2025-01-10", priceMicros: 5 });
    const path = `/api/b/1/securities/${acme.id}/prices/2025-01-10`;
    const source = async () =>
      (await rows<{ source: string | null }>("SELECT source FROM security_prices WHERE security_id = $1", [acme.id]))[0].source;

    expect(await send("PUT", path, `{"priceDate":"2025-01-10","priceMicros":5,"source":${HUGE}}`))
      .toEqual({ status: 200, body: { success: true } });
    expect(await source()).toBe("Infinity");
    await send("PUT", path, `{"priceDate":"2025-01-10","priceMicros":5,"source":[-${HUGE},1e-400]}`);
    expect(await source()).toBe("-Infinity,0");
    expect(await send("PUT", path, `{"priceDate":"2025-01-10","priceMicros":1e-400}`))
      .toEqual({ status: 400, body: { error: "Invalid priceMicros" } });

    // The bulk write drops an item with an infinite field and keeps the rest.
    expect(await send("POST", "/api/b/1/security-prices/bulk",
      `{"priceUpdates":[{"securityId":${acme.id},"priceMicros":${HUGE},"priceDate":"2025-01-11"},` +
      `{"securityId":${HUGE},"priceMicros":1,"priceDate":"2025-01-12"},` +
      `{"securityId":${acme.id},"priceMicros":7,"priceDate":"2025-01-13"}]}`))
      .toEqual({ status: 200, body: { message: "Successfully updated 1 price(s)", count: 1 } });
  });
});
