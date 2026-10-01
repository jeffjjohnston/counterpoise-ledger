import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { toDateString } from "../../lib/formatters";
import {
  addBookMember, createAccount, createBook, createInvestmentSplit, createSecurity, createSecurityPrice,
  createTransactionWithSplits, createUser, resetTestDatabase, setupTestDatabase,
} from "../helpers/db-utils";
import { rows } from "../helpers/sql";
import { sessionHttpClient, startHttpTestServer } from "../helpers/http-parity";

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

type Client = Awaited<ReturnType<typeof sessionHttpClient>>;

async function ok(client: Client, path: string, init?: RequestInit) {
  const response = await client.request(path, init);
  expect(response.status, `${init?.method ?? "GET"} ${path}`).toBe(200);
  return response.json();
}

async function expectError(client: Client, path: string, init: RequestInit, status: number, error: string) {
  const response = await client.request(path, init);
  expect(response.status, `${init.method ?? "GET"} ${path} ${String(init.body)}`).toBe(status);
  expect(await response.json()).toEqual({ error });
}

async function pricesOf(securityId: number) {
  return rows<{ priceDate: string; priceMicros: number; source: string | null }>(
    "SELECT price_date, price_micros, source FROM security_prices WHERE security_id = $1 ORDER BY price_date",
    [securityId],
  );
}

/** Buy (or sell) shares in a fresh transaction on the given account. */
async function trade(accountId: number, securityId: number, action: "buy" | "sell", sharesMicros: number, date: string) {
  const transaction = await createTransactionWithSplits({
    date, description: `${action} ${date}`,
    splits: [{ accountId, amount: 100 }, { accountId, amount: -100 }],
  });
  await createInvestmentSplit({ transactionId: transaction.id, accountId, securityId, action, sharesMicros, priceMicros: 1_000_000 });
}

/** JavaScript `Date#getDay`: Sunday is 0 and Saturday is 6. */
function lastWeekday(): string {
  const date = new Date();
  while (date.getDay() === 0 || date.getDay() === 6) date.setDate(date.getDate() - 1);
  return toDateString(date);
}

const TIINGO_KEY = "test-key";

/**
 * The replies of the Tiingo mock, by decoded symbol. An unknown symbol is a
 * 404. The server may not call the real API.
 */
const TIINGO_REPLIES: Record<string, { status: number; body?: unknown; raw?: string }> = {
  VTI: { status: 200, body: [{ ticker: "VTI", date: "2026-07-02T00:00:00.000Z", close: 300.1, adjClose: 299.123456 }] },
  bnd: { status: 200, body: [{ ticker: "BND", date: "2026-07-01", close: 73, adjClose: 73 }, { date: "2026-06-30", adjClose: 1 }] },
  "ß": { status: 200, body: [{ date: "2026-07-02T00:00:00.000Z", adjClose: 1.5 }] },
  EMPTY: { status: 200, body: [] },
  NULLBODY: { status: 200, body: null },
  NOADJ: { status: 200, body: [{ date: "2026-07-02T12:00:00Z" }] },
  NULLADJ: { status: 200, body: [{ date: "2026-07-02", adjClose: null }] },
  NODATE: { status: 200, body: [{ adjClose: 1 }] },
  NULLDATE: { status: 200, body: [{ adjClose: 1, date: null }] },
  BADDATE: { status: 200, body: [{ adjClose: 1, date: 5 }] },
  OBJ: { status: 200, body: { detail: "Not found." } },
  NULLFIRST: { status: 200, body: [null] },
  LENGTHZERO: { status: 200, body: { length: 0 } },
  BROKE: { status: 500, body: { detail: "broken" } },
  "5": { status: 200, body: [{ date: "2026-07-02", adjClose: 5 }] },
  null: { status: 200, body: [{ date: "2026-07-02", adjClose: 5 }] },
  "[object Object]": { status: 200, body: [{ date: "2026-07-02", adjClose: 5 }] },
  // Beyond the double range, so JSON.parse reads Infinity.
  OVER: { status: 200, raw: '[{"date":"2026-07-02","adjClose":1e400}]' },
};

async function startTiingoMock(): Promise<{ url: string; requests: string[]; server: Server }> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    const url = new URL(request.url ?? "/", "http://mock");
    const match = /^\/tiingo\/daily\/([^/]*)\/prices$/.exec(url.pathname);
    const reply = match && url.searchParams.get("token") === TIINGO_KEY
      ? TIINGO_REPLIES[decodeURIComponent(match[1])]
      : undefined;
    const { status, body, raw } = reply ?? { status: 404, body: { detail: "Not found." } };
    response.writeHead(status, { "content-type": "application/json" });
    response.end(raw ?? JSON.stringify(body));
  });
  await new Promise<void>((resolveReady) => server.listen(0, "127.0.0.1", () => resolveReady()));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, requests, server };
}

beforeAll(async () => {
  await setupTestDatabase();
}, 120_000);

describe("security price HTTP parity", () => {
  let baseUrl: string;
  let stop: () => Promise<void>;
  let client: Client;
  let tiingo: Awaited<ReturnType<typeof startTiingoMock>>;

  beforeAll(async () => {
    tiingo = await startTiingoMock();
    ({ baseUrl, stop } = await startHttpTestServer({ TIINGO_API_KEY: TIINGO_KEY, TIINGO_API_URL: tiingo.url }));
  }, 120_000);
  beforeEach(async () => {
    await resetTestDatabase();
    client = await sessionHttpClient(baseUrl);
    tiingo.requests.length = 0;
  });
  afterAll(async () => {
    await stop?.();
    await new Promise((resolveClosed) => tiingo?.server.close(resolveClosed));
  });

  it("pages the price history newest first", async () => {
    const acme = await createSecurity({ name: "Acme", symbol: "ACME", securityType: "stock" });
    const other = await createSecurity({ name: "Other", symbol: "OTH", securityType: "stock" });
    await createSecurityPrice({ securityId: acme.id, priceDate: "2024-01-10", priceMicros: 10_000_000, source: "manual" });
    await createSecurityPrice({ securityId: acme.id, priceDate: "2024-03-10", priceMicros: 12_000_000 });
    await createSecurityPrice({ securityId: acme.id, priceDate: "2024-02-10", priceMicros: 11_000_000, source: "tiingo" });
    await createSecurityPrice({ securityId: other.id, priceDate: "2024-04-10", priceMicros: 1 });
    const path = `/api/b/1/securities/${acme.id}/prices`;

    const all = {
      prices: [
        { priceDate: "2024-03-10", priceMicros: 12_000_000, source: null },
        { priceDate: "2024-02-10", priceMicros: 11_000_000, source: "tiingo" },
        { priceDate: "2024-01-10", priceMicros: 10_000_000, source: "manual" },
      ],
      totalCount: 3,
      hasMore: false,
    };
    expect(await ok(client, path)).toEqual(all);
    expect(await ok(client, `${path}?limit=2`)).toEqual({ ...all, prices: all.prices.slice(0, 2), hasMore: true });
    expect(await ok(client, `${path}?limit=2&offset=2`)).toEqual({ ...all, prices: all.prices.slice(2) });
    expect(await ok(client, `${path}?offset=5`)).toEqual({ ...all, prices: [] });
    // A malformed value falls back to its default.
    for (const query of ["limit=abc&offset=x", "limit=0&offset=-1", "limit=1.5", "limit=1e300", "limit=&offset="]) {
      expect(await ok(client, `${path}?${query}`), query).toEqual(all);
    }
    expect((await ok(client, `/api/b/1/securities/${acme.id}abc/prices?limit=1`)).prices).toHaveLength(1);

    await expectError(client, "/api/b/1/securities/abc/prices", {}, 400, "Invalid security id");
    await expectError(client, "/api/b/1/securities/999999/prices", {}, 404, "Security not found");
    await expectError(client, "/api/b/1/securities/3000000000/prices", {}, 500, "Failed to fetch security price history");
  });

  it("updates a price in place or moves it to another date", async () => {
    const acme = await createSecurity({ name: "Acme", symbol: "ACME", securityType: "stock" });
    await createSecurityPrice({ securityId: acme.id, priceDate: "2025-01-10", priceMicros: 5_000_000, source: "manual" });
    await createSecurityPrice({ securityId: acme.id, priceDate: "2025-01-11", priceMicros: 6_000_000, source: "manual" });
    const path = `/api/b/1/securities/${acme.id}/prices/2025-01-10`;

    expect(await ok(client, path, json("PUT", { priceDate: "2025-01-10", priceMicros: 7_000_000, source: "tiingo" })))
      .toEqual({ success: true });
    expect((await pricesOf(acme.id))[0]).toEqual({ priceDate: "2025-01-10", priceMicros: 7_000_000, source: "tiingo" });
    // An absent source clears it.
    await ok(client, path, json("PUT", { priceDate: "2025-01-10", priceMicros: 7_500_000, bookId: 99 }));
    expect((await pricesOf(acme.id))[0]).toEqual({ priceDate: "2025-01-10", priceMicros: 7_500_000, source: null });

    await expectError(client, path, json("PUT", { priceDate: "2025-01-11", priceMicros: 1 }), 409,
      "A price already exists for 2025-01-11");
    expect(await ok(client, path, json("PUT", { priceDate: "2025-01-20", priceMicros: 8_000_000, source: "manual" })))
      .toEqual({ success: true });
    expect(await pricesOf(acme.id)).toEqual([
      { priceDate: "2025-01-11", priceMicros: 6_000_000, source: "manual" },
      { priceDate: "2025-01-20", priceMicros: 8_000_000, source: "manual" },
    ]);
    await expectError(client, path, json("PUT", { priceDate: "2025-01-10", priceMicros: 1 }), 404, "Price entry not found");
  });

  it("stores a source that is not a string as Node does", async () => {
    const acme = await createSecurity({ name: "Acme", symbol: "ACME", securityType: "stock" });
    await createSecurityPrice({ securityId: acme.id, priceDate: "2025-01-10", priceMicros: 5_000_000 });
    const path = `/api/b/1/securities/${acme.id}/prices/2025-01-10`;
    const stored: Record<string, { status: number; source?: string | null }> = {};
    for (const source of [null, "", 5, 1.5, true, false, { a: 1 }, [1, "b"]]) {
      const response = await client.request(path, json("PUT", { priceDate: "2025-01-10", priceMicros: 5_000_000, source }));
      stored[JSON.stringify(source)] = response.status === 200
        ? { status: 200, source: (await pricesOf(acme.id))[0].source }
        : { status: response.status };
    }
    expect(stored).toMatchSnapshot();
  });

  it("validates a price update in the Node order", async () => {
    const acme = await createSecurity({ name: "Acme", symbol: "ACME", securityType: "stock" });
    const owner = await createUser({ username: "owner" });
    const otherBook = await createBook({ name: "Other", userId: owner.id });
    const foreign = await createSecurity({ name: "Foreign", symbol: "FOR", securityType: "stock", bookId: otherBook.id });
    await createSecurityPrice({ securityId: foreign.id, priceDate: "2025-01-10", priceMicros: 1, bookId: otherBook.id });
    await createSecurityPrice({ securityId: acme.id, priceDate: "2025-01-10", priceMicros: 5_000_000 });
    const valid = { priceDate: "2025-01-10", priceMicros: 1 };
    const path = `/api/b/1/securities/${acme.id}/prices/2025-01-10`;

    for (const [body, error] of [
      [null, "priceDate is required"],
      [[], "priceDate is required"],
      ["x", "priceDate is required"],
      [{}, "priceDate is required"],
      [{ priceDate: "2025-02-30", priceMicros: 1 }, "priceDate is required"],
      [{ priceDate: "20250110", priceMicros: 1 }, "priceDate is required"],
      [{ priceDate: 20250110, priceMicros: 1 }, "priceDate is required"],
      [{ priceDate: "2025-01-10" }, "Invalid priceMicros"],
      [{ priceDate: "2025-01-10", priceMicros: "5" }, "Invalid priceMicros"],
      [{ priceDate: "2025-01-10", priceMicros: 1.5 }, "Invalid priceMicros"],
      [{ priceDate: "2025-01-10", priceMicros: 0 }, "Invalid priceMicros"],
      [{ priceDate: "2025-01-10", priceMicros: -1 }, "Invalid priceMicros"],
      [{ priceDate: "2025-01-10", priceMicros: 9_007_199_254_740_992 }, "Invalid priceMicros"],
    ] as const) {
      await expectError(client, path, json("PUT", body), 400, error);
    }
    expect(await pricesOf(acme.id)).toEqual([{ priceDate: "2025-01-10", priceMicros: 5_000_000, source: null }]);

    // The ID is checked before the body is read, and the body before the
    // security is looked up.
    await expectError(client, "/api/b/1/securities/abc/prices/2025-01-10", { method: "PUT", body: "{" }, 400, "Invalid security id");
    await expectError(client, path, { method: "PUT", body: "{" }, 500, "Failed to update security price");
    await expectError(client, "/api/b/1/securities/3000000000/prices/2025-01-10", json("PUT", {}), 400, "priceDate is required");
    await expectError(client, "/api/b/1/securities/3000000000/prices/2025-01-10", json("PUT", valid), 500, "Failed to update security price");
    await expectError(client, "/api/b/1/securities/999999/prices/2025-01-10", json("PUT", valid), 404, "Security not found");
    await expectError(client, `/api/b/1/securities/${foreign.id}/prices/2025-01-10`, json("PUT", valid), 404, "Security not found");
    expect(await pricesOf(foreign.id)).toEqual([{ priceDate: "2025-01-10", priceMicros: 1, source: null }]);
  });

  it("deletes a price entry", async () => {
    const acme = await createSecurity({ name: "Acme", symbol: "ACME", securityType: "stock" });
    await createSecurityPrice({ securityId: acme.id, priceDate: "2025-01-10", priceMicros: 5_000_000 });
    await createSecurityPrice({ securityId: acme.id, priceDate: "2025-01-11", priceMicros: 6_000_000 });
    const path = `/api/b/1/securities/${acme.id}/prices/2025-01-10`;

    expect(await ok(client, path, { method: "DELETE" })).toEqual({ success: true });
    expect(await pricesOf(acme.id)).toEqual([{ priceDate: "2025-01-11", priceMicros: 6_000_000, source: null }]);
    await expectError(client, path, { method: "DELETE" }, 404, "Price entry not found");
    await expectError(client, "/api/b/1/securities/abc/prices/2025-01-11", { method: "DELETE" }, 400, "Invalid security id");
    await expectError(client, "/api/b/1/securities/999999/prices/2025-01-11", { method: "DELETE" }, 404, "Security not found");
    await expectError(client, "/api/b/1/securities/3000000000/prices/2025-01-11", { method: "DELETE" }, 500,
      "Failed to delete security price");
  });

  it("writes bulk prices, keeps the source of an updated row, and drops malformed items", async () => {
    const acme = await createSecurity({ name: "Acme", symbol: "ACME", securityType: "stock" });
    const beta = await createSecurity({ name: "Beta", symbol: "BETA", securityType: "stock" });
    await createSecurityPrice({ securityId: acme.id, priceDate: "2025-01-01", priceMicros: 10_000_000, source: "tiingo" });

    expect(await ok(client, "/api/b/1/security-prices/bulk", json("POST", {
      bookId: 99,
      priceUpdates: [
        { securityId: acme.id, priceMicros: 11_500_000, priceDate: "2025-01-01" },
        { securityId: acme.id, priceMicros: 12_250_000, priceDate: "2025-01-02", source: "tiingo" },
        { securityId: beta.id, priceMicros: 1, priceDate: "2025-01-02" },
        { securityId: beta.id, priceMicros: 2, priceDate: "2025-01-02" },
        { securityId: beta.id, priceMicros: 3.5, priceDate: "2025-01-03" },
        { securityId: beta.id, priceMicros: 3, priceDate: "2025-02-30" },
        { securityId: "1", priceMicros: 3, priceDate: "2025-01-04" },
        [beta.id, 3, "2025-01-05"],
        null,
      ],
    }))).toEqual({ message: "Successfully updated 4 price(s)", count: 4 });
    expect(await pricesOf(acme.id)).toEqual([
      { priceDate: "2025-01-01", priceMicros: 11_500_000, source: "tiingo" },
      { priceDate: "2025-01-02", priceMicros: 12_250_000, source: "manual" },
    ]);
    expect(await pricesOf(beta.id)).toEqual([{ priceDate: "2025-01-02", priceMicros: 2, source: "manual" }]);
  });

  it("refuses a bulk write in the Node order and writes nothing", async () => {
    const acme = await createSecurity({ name: "Acme", symbol: "ACME", securityType: "stock" });
    const owner = await createUser({ username: "owner" });
    const otherBook = await createBook({ name: "Other", userId: owner.id });
    const foreign = await createSecurity({ name: "Foreign", symbol: "FOR", securityType: "stock", bookId: otherBook.id });
    const item = (securityId: number) => ({ securityId, priceMicros: 1, priceDate: "2025-01-02" });
    const path = "/api/b/1/security-prices/bulk";

    for (const [body, error] of [
      [null, "priceUpdates must be an array"],
      [[], "priceUpdates must be an array"],
      [{}, "priceUpdates must be an array"],
      [{ priceUpdates: {} }, "priceUpdates must be an array"],
      [{ priceUpdates: [] }, "No valid price updates provided"],
      [{ priceUpdates: [{ securityId: acme.id, priceMicros: 0, priceDate: "2025-01-02" }, 5] }, "No valid price updates provided"],
      [{ priceUpdates: [item(acme.id), item(foreign.id)] }, "One or more securities do not belong to this book"],
      [{ priceUpdates: [item(acme.id), item(999999)] }, "One or more securities do not belong to this book"],
    ] as const) {
      await expectError(client, path, json("POST", body), 400, error);
    }
    await expectError(client, path, json("POST", { priceUpdates: [item(acme.id), item(3_000_000_000)] }), 500,
      "Failed to update security prices");
    await expectError(client, path, { method: "POST", body: "{" }, 500, "Failed to update security prices");
    expect(await pricesOf(acme.id)).toEqual([]);
  });

  it("lists manually priced open positions that lack the due date's price", async () => {
    const brokerage = await createAccount({ name: "Brokerage", type: "asset", subtype: "investment" });
    const vti = await createSecurity({ name: "VTI", symbol: "VTI", securityType: "etf" });
    await createSecurityPrice({ securityId: vti.id, priceDate: "2026-06-30", priceMicros: 1 });
    // The newest fetched price sets the due date, held or not.
    const bnd = await createSecurity({ name: "BND", symbol: "BND", securityType: "etf" });
    await createSecurityPrice({ securityId: bnd.id, priceDate: "2026-07-02", priceMicros: 1 });
    await trade(brokerage.id, vti.id, "buy", 1_000_000, "2026-06-01");

    const stale = await createSecurity({ name: "banana call", symbol: "BAN", securityType: "stock", fetchPrices: false });
    await trade(brokerage.id, stale.id, "buy", 2_000_000, "2026-06-05");
    await createSecurityPrice({ securityId: stale.id, priceDate: "2026-07-01", priceMicros: 4_350_000 });
    const never = await createSecurity({ name: "Apple put", symbol: "APP", securityType: "stock", fetchPrices: false });
    await trade(brokerage.id, never.id, "buy", 1_000_000, "2026-07-01");
    const umlaut = await createSecurity({ name: "Äpfel", symbol: "APF", securityType: "stock", fetchPrices: false });
    await trade(brokerage.id, umlaut.id, "buy", 1_000_000, "2026-07-01");
    await createSecurityPrice({ securityId: umlaut.id, priceDate: "2026-06-01", priceMicros: 7 });
    const current = await createSecurity({ name: "Current", symbol: "CUR", securityType: "stock", fetchPrices: false });
    await trade(brokerage.id, current.id, "buy", 1_000_000, "2026-06-01");
    await createSecurityPrice({ securityId: current.id, priceDate: "2026-07-02", priceMicros: 1 });
    const closed = await createSecurity({ name: "Closed", symbol: "CLO", securityType: "stock", fetchPrices: false });
    await trade(brokerage.id, closed.id, "buy", 1_000_000, "2026-05-01");
    await trade(brokerage.id, closed.id, "sell", 1_000_000, "2026-06-30");
    const fixed = await createSecurity({
      name: "Money Market", symbol: "MMF", securityType: "mutual_fund", fetchPrices: false, fixedPriceMicros: 1_000_000,
    });
    await trade(brokerage.id, fixed.id, "buy", 5_000_000, "2026-06-01");

    expect(await ok(client, "/api/b/1/securities/prices-due")).toEqual({
      dueDate: "2026-07-02",
      securities: [
        { securityId: umlaut.id, name: "Äpfel", symbol: "APF", lastPriceMicros: 7, lastPriceDate: "2026-06-01" },
        { securityId: never.id, name: "Apple put", symbol: "APP", lastPriceMicros: null, lastPriceDate: null },
        { securityId: stale.id, name: "banana call", symbol: "BAN", lastPriceMicros: 4_350_000, lastPriceDate: "2026-07-01" },
      ],
    });
  });

  it("falls back to the last weekday and returns nothing without manual securities", async () => {
    expect(await ok(client, "/api/b/1/securities/prices-due")).toEqual({ dueDate: null, securities: [] });
    const brokerage = await createAccount({ name: "Brokerage", type: "asset", subtype: "investment" });
    const option = await createSecurity({ name: "Option", symbol: "OPT", securityType: "stock", fetchPrices: false });
    await trade(brokerage.id, option.id, "buy", 1_000_000, "2026-06-01");
    // A price on a security that no longer fetches does not set the due date.
    await createSecurityPrice({ securityId: option.id, priceDate: "2000-01-03", priceMicros: 9 });
    expect(await ok(client, "/api/b/1/securities/prices-due")).toEqual({
      dueDate: lastWeekday(),
      securities: [{ securityId: option.id, name: "Option", symbol: "OPT", lastPriceMicros: 9, lastPriceDate: "2000-01-03" }],
    });
  });

  it("fetches Tiingo prices per symbol and reports each failure", async () => {
    const symbols = [
      "VTI", "bnd", "ß", "MISS", "EMPTY", "NULLBODY", "NOADJ", "NULLADJ", "NODATE", "NULLDATE", "BADDATE", "OBJ",
      "NULLFIRST", "LENGTHZERO", "BROKE", 5, 1.5, 1e21, 1e-7, -0, ["A", ["B", null]], null, true, { x: 1 },
      "BRK B", "X?y=1", "../x",
    ];
    const body = await ok(client, "/api/b/1/security-prices/tiingo", json("POST", { symbols, bookId: 99 }));
    // A TypeError names the variable, and the Next build minifies it.
    const notUpperCase = expect.stringMatching(/^\w+\.toUpperCase is not a function$/);
    expect(body).toEqual({
      prices: [
        { symbol: "VTI", price: 299.123456, date: "2026-07-02" },
        { symbol: "BND", price: 73, date: "2026-07-01" },
        { symbol: "SS", price: 1.5, date: "2026-07-02" },
        { symbol: "NOADJ", date: "2026-07-02" },
        { symbol: "NULLADJ", price: null, date: "2026-07-02" },
      ],
      errors: [
        { symbol: "MISS", error: "Failed to fetch price for MISS: Not Found" },
        { symbol: "EMPTY", error: "No price data available for EMPTY" },
        { symbol: "NULLBODY", error: "No price data available for NULLBODY" },
        { symbol: "NODATE", error: "Cannot read properties of undefined (reading 'split')" },
        { symbol: "NULLDATE", error: "Cannot read properties of null (reading 'split')" },
        { symbol: "BADDATE", error: expect.stringMatching(/^\w+\.date\.split is not a function$/) },
        { symbol: "OBJ", error: "Cannot read properties of undefined (reading 'adjClose')" },
        { symbol: "NULLFIRST", error: "Cannot read properties of null (reading 'adjClose')" },
        { symbol: "LENGTHZERO", error: "No price data available for LENGTHZERO" },
        { symbol: "BROKE", error: "Failed to fetch price for BROKE: Internal Server Error" },
        { symbol: 5, error: notUpperCase },
        { symbol: 1.5, error: "Failed to fetch price for 1.5: Not Found" },
        { symbol: 1e21, error: "Failed to fetch price for 1e+21: Not Found" },
        { symbol: 1e-7, error: "Failed to fetch price for 1e-7: Not Found" },
        { symbol: 0, error: "Failed to fetch price for 0: Not Found" },
        { symbol: ["A", ["B", null]], error: "Failed to fetch price for A,B,: Not Found" },
        { symbol: null, error: "Cannot read properties of null (reading 'toUpperCase')" },
        { symbol: true, error: "Failed to fetch price for true: Not Found" },
        { symbol: { x: 1 }, error: notUpperCase },
        { symbol: "BRK B", error: "Failed to fetch price for BRK B: Not Found" },
        { symbol: "X?y=1", error: "Failed to fetch price for X?y=1: Not Found" },
        { symbol: "../x", error: "Failed to fetch price for ../x: Not Found" },
      ],
    });
    // Both servers build the same URL, without encoding the symbol first.
    expect([...tiingo.requests].sort()).toMatchSnapshot();
  });

  it("writes an infinite Tiingo price and an infinite symbol as null", async () => {
    const response = await client.request("/api/b/1/security-prices/tiingo", {
      method: "POST", headers: { "content-type": "application/json" }, body: '{"symbols":["OVER",1e400]}',
    });
    expect(await response.json()).toEqual({
      prices: [{ symbol: "OVER", price: null, date: "2026-07-02" }],
      errors: [{ symbol: null, error: "Failed to fetch price for Infinity: Not Found" }],
    });
    expect([...tiingo.requests].sort()).toEqual([
      `/tiingo/daily/Infinity/prices?token=${TIINGO_KEY}`,
      `/tiingo/daily/OVER/prices?token=${TIINGO_KEY}`,
    ]);
  });

  it("validates the Tiingo request", async () => {
    const path = "/api/b/1/security-prices/tiingo";
    for (const body of [null, [], "VTI", {}, { symbols: [] }, { symbols: "VTI" }, { symbols: null }]) {
      await expectError(client, path, json("POST", body), 400, "symbols must be a non-empty array");
    }
    await expectError(client, path, { method: "POST", body: "{" }, 500, "Failed to fetch prices from Tiingo");
    expect(tiingo.requests).toEqual([]);
  });

  it("lets viewers read prices and refuses them every price write", async () => {
    const owner = await createUser({ username: "owner" });
    const shared = await createBook({ name: "Shared", userId: owner.id });
    await addBookMember({ bookId: shared.id, userId: 1, role: "viewer" });
    const held = await createSecurity({ name: "Held", symbol: "HLD", securityType: "stock", bookId: shared.id });
    await createSecurityPrice({ securityId: held.id, priceDate: "2025-01-10", priceMicros: 5, bookId: shared.id });
    const readOnly = "You have read-only access to this book";

    expect(await ok(client, `/api/b/${shared.id}/securities/${held.id}/prices`)).toEqual({
      prices: [{ priceDate: "2025-01-10", priceMicros: 5, source: null }], totalCount: 1, hasMore: false,
    });
    expect(await ok(client, `/api/b/${shared.id}/securities/prices-due`)).toEqual({ dueDate: null, securities: [] });
    const pricePath = `/api/b/${shared.id}/securities/${held.id}/prices/2025-01-10`;
    await expectError(client, pricePath, json("PUT", { priceDate: "2025-01-10", priceMicros: 1 }), 403, readOnly);
    await expectError(client, pricePath, { method: "DELETE" }, 403, readOnly);
    await expectError(client, `/api/b/${shared.id}/security-prices/bulk`, { method: "POST", body: "{" }, 403, readOnly);
    await expectError(client, `/api/b/${shared.id}/security-prices/tiingo`, { method: "POST", body: "{" }, 403, readOnly);
    expect(await rows("SELECT * FROM security_prices WHERE book_id = $1", [shared.id])).toHaveLength(1);
    await expectError(client, "/api/b/999/securities/prices-due", {}, 404, "Book not found");
  });
});

describe("Tiingo route without an API key", () => {
  let baseUrl: string;
  let stop: () => Promise<void>;
  let client: Client;

  beforeAll(async () => {
    ({ baseUrl, stop } = await startHttpTestServer({ TIINGO_API_KEY: "", TIINGO_API_URL: "http://127.0.0.1:9" }));
  }, 120_000);
  beforeEach(async () => {
    await resetTestDatabase();
    client = await sessionHttpClient(baseUrl);
  });
  afterAll(async () => { await stop?.(); });

  it("reports the missing key before it reads the body", async () => {
    for (const init of [json("POST", { symbols: ["VTI"] }), { method: "POST", body: "{" }]) {
      await expectError(client, "/api/b/1/security-prices/tiingo", init, 500,
        "TIINGO_API_KEY environment variable not configured");
    }
  });
});
