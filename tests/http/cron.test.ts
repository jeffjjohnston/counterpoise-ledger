import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { toDateString } from "../../lib/formatters";
import type { PlaidToken, RecurringRule, SecurityPrice } from "../../types/db";
import {
  createAccount, createBook, createPlaidAccount, createPlaidToken, createRecurringRule, createSecurity,
  createSecurityPrice, resetTestDatabase, setupTestDatabase,
} from "../helpers/db-utils";
import { sessionHttpClient, startHttpTestServer } from "../helpers/http-parity";
import { count, row, rows } from "../helpers/sql";

type Client = Awaited<ReturnType<typeof sessionHttpClient>>;
type Reply = { status: number; body?: unknown; raw?: string };

const CRON_SECRET = "test-cron-secret";
const AUTHORIZED = { headers: { authorization: `Bearer ${CRON_SECRET}` } };
const TIINGO_KEY = "test-key";
const ROUTES = ["/api/cron/plaid-sync", "/api/cron/price-sync", "/api/cron/recurring"];

/** Empty values override any key that the test process inherits. */
const UNCONFIGURED = {
  CRON_SECRET, PLAID_CLIENT_ID: "", PLAID_SECRET: "", PLAID_ENV: "", TIINGO_API_KEY: "",
};

async function cron(client: Client, path: string) {
  const response = await client.anonymous(path, AUTHORIZED);
  expect(response.status, `GET ${path}`).toBe(200);
  return response.json();
}

/** A mock that answers each request path with its queued reply. The server may not call the real API. */
async function startMock(key: (path: string, body: string) => string) {
  const replies = new Map<string, Reply>();
  const requests: string[] = [];
  const gates = new Map<string, { arrived: () => void; released: Promise<void> }>();
  const server: Server = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk) => { text += chunk; });
    request.on("end", () => {
      const name = key(request.url ?? "/", text);
      requests.push(name);
      const gate = gates.get(name);
      gate?.arrived();
      void (gate?.released ?? Promise.resolve()).then(() => {
        const reply = replies.get(name) ?? {
          status: 404, body: { error_message: "unexpected request", error_code: "UNEXPECTED", detail: "Not found." },
        };
        response.writeHead(reply.status, { "content-type": "application/json" });
        response.end(reply.raw ?? JSON.stringify(reply.body));
      });
    });
  });
  await new Promise<void>((resolveReady) => server.listen(0, "127.0.0.1", () => resolveReady()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    server,
    requests,
    reply(name: string, reply: Reply) { replies.set(name, reply); },
    /**
     * Holds the replies to the requests of this name until `release()`.
     * `arrived` resolves when the first such request comes in.
     */
    hold(name: string) {
      let arrived = () => {};
      let release = () => {};
      const arrival = new Promise<void>((resolve) => { arrived = resolve; });
      const released = new Promise<void>((resolve) => { release = resolve; });
      gates.set(name, { arrived, released });
      return {
        arrived: arrival,
        release() {
          gates.delete(name);
          release();
        },
      };
    },
    reset() { replies.clear(); requests.length = 0; },
  };
}

type Mock = Awaited<ReturnType<typeof startMock>>;

/** The Plaid mock names a request by its access token. */
const plaidKey = (_path: string, body: string) => (JSON.parse(body) as { access_token: string }).access_token;

/** The Tiingo mock names a request by its decoded symbol, and refuses a wrong key. */
function tiingoKey(path: string) {
  const url = new URL(path, "http://mock");
  const match = /^\/tiingo\/daily\/([^/]*)\/prices$/.exec(url.pathname);
  return match && url.searchParams.get("token") === TIINGO_KEY ? decodeURIComponent(match[1]) : `bad:${path}`;
}

const emptyPage: Reply = {
  status: 200,
  body: { added: [], modified: [], removed: [], has_more: false, next_cursor: "cursor-next", request_id: "r" },
};

/** A connection with one Plaid account linked to a new account of this type. */
async function connection(accessToken: string, options: { type?: "asset" | "liability" | "expense"; bookId?: number; isDemo?: boolean; linked?: boolean } = {}) {
  const bookId = options.bookId ?? 1;
  const token = await createPlaidToken({
    financialInstitution: accessToken, itemId: `item-${accessToken}`, accessToken, bookId, isDemo: options.isDemo,
  });
  const account = await createAccount({ name: `Account ${accessToken}`, type: options.type ?? "asset", bookId });
  await createPlaidAccount({
    tokenId: token.id, plaidAccountId: `plaid-${accessToken}`, name: accessToken, type: "depository", bookId,
    counterpoiseAccountId: options.linked === false ? null : account.id,
  });
  return token;
}

beforeAll(async () => {
  await setupTestDatabase();
}, 120_000);

describe("cron routes without Plaid or Tiingo", () => {
  let baseUrl: string;
  let stop: () => Promise<void>;
  let client: Client;
  let statusDir: string;

  beforeAll(async () => {
    statusDir = await mkdtemp(join(tmpdir(), "counterpoise-cron-status-"));
    ({ baseUrl, stop } = await startHttpTestServer({ ...UNCONFIGURED, STATUS_DIR: statusDir }));
  }, 120_000);
  beforeEach(async () => {
    await resetTestDatabase();
    client = await sessionHttpClient(baseUrl);
  });
  afterAll(async () => {
    await stop?.();
    if (statusDir) await rm(statusDir, { recursive: true, force: true });
  });

  it("skips the bank sync and the price sync", async () => {
    await connection("access-1");
    await createSecurity({ name: "Total Market", symbol: "VTI", securityType: "etf", fetchPrices: true });
    expect(await cron(client, "/api/cron/plaid-sync")).toEqual({
      success: true, skipped: true, reason: "Plaid not configured", missingSetting: "PLAID_CLIENT_ID",
    });
    expect(await cron(client, "/api/cron/price-sync")).toEqual({
      success: true, skipped: true, reason: "Tiingo not configured", missingSetting: "TIINGO_API_KEY",
    });
  });

  it("records a manual run as not configured, and the status route reports it", async () => {
    await cron(client, "/api/cron/plaid-sync");
    await cron(client, "/api/cron/price-sync");
    await cron(client, "/api/cron/recurring");
    const plaid = JSON.parse(await readFile(join(statusDir, "plaid-sync.json"), "utf8"));
    expect(plaid).toMatchObject({
      job: "plaid-sync", notConfigured: true, detail: "not configured: PLAID_CLIENT_ID is not set",
    });
    const recurring = JSON.parse(await readFile(join(statusDir, "recurring.json"), "utf8"));
    expect(recurring.lastOk).toBe(recurring.lastRun);
    expect(recurring.notConfigured).toBeUndefined();

    const status = await (await client.request("/api/system/status")).json();
    const states = Object.fromEntries(status.jobs.map((job: { job: string; state: string }) => [job.job, job.state]));
    expect(states).toMatchObject({ "plaid-sync": "not_configured", "price-sync": "not_configured", recurring: "ok" });
  });
});

describe("cron routes HTTP parity", () => {
  let baseUrl: string;
  let stop: () => Promise<void>;
  let client: Client;
  let plaid: Mock;
  let tiingo: Mock;

  beforeAll(async () => {
    plaid = await startMock(plaidKey);
    tiingo = await startMock(tiingoKey);
    ({ baseUrl, stop } = await startHttpTestServer({
      ...UNCONFIGURED,
      PLAID_CLIENT_ID: "client-id", PLAID_SECRET: "plaid-secret", PLAID_ENV: "sandbox", PLAID_API_URL: plaid.url,
      TIINGO_API_KEY: TIINGO_KEY, TIINGO_API_URL: tiingo.url,
    }));
  }, 120_000);
  beforeEach(async () => {
    await resetTestDatabase();
    client = await sessionHttpClient(baseUrl);
    plaid.reset();
    tiingo.reset();
  });
  afterAll(async () => {
    await stop?.();
    await Promise.all([plaid, tiingo].map((mock) => new Promise((resolveClosed) => mock?.server.close(resolveClosed))));
  });

  it("requires the cron secret before it runs a job", async () => {
    await connection("access-1");
    plaid.reply("access-1", emptyPage);
    await createSecurity({ name: "Total Market", symbol: "VTI", securityType: "etf", fetchPrices: true });
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const rent = await createAccount({ name: "Rent", type: "expense" });
    await createRecurringRule({
      name: "Rent", frequency: "monthly", startDate: toDateString(new Date()), nextDate: toDateString(new Date()),
      templateSplits: [{ accountId: rent.id, amount: 100 }, { accountId: checking.id, amount: -100 }],
    });

    const denied = [{}, { authorization: "Bearer wrong" }, { authorization: `bearer ${CRON_SECRET}` }, { authorization: CRON_SECRET }];
    for (const path of ROUTES) {
      for (const headers of denied as Record<string, string>[]) {
        const response = await client.anonymous(path, { headers });
        expect(response.status, `${path} ${JSON.stringify(headers)}`).toBe(401);
        expect(await response.json()).toEqual({ error: "Unauthorized" });
      }
      // A session is not the cron secret.
      const session = await client.request(path);
      expect(session.status, `${path} with a session`).toBe(401);
    }
    expect(plaid.requests).toEqual([]);
    expect(tiingo.requests).toEqual([]);
    expect(await count("transactions")).toBe(0);
  });

  it("syncs each linked connection and reports an overlap and a failure", async () => {
    const other = await createBook({ name: "Other" });
    const synced = await connection("access-synced");
    const failing = await connection("access-failing", { type: "liability", bookId: other.id });
    const busy = await connection("access-busy");
    await connection("access-demo", { isDemo: true });
    await connection("access-expense", { type: "expense" });
    await connection("access-unlinked", { linked: false });
    plaid.reply("access-synced", emptyPage);
    plaid.reply("access-failing", { status: 400, body: { error_message: "login required", error_code: "ITEM_LOGIN_REQUIRED" } });

    plaid.reply("access-busy", emptyPage);

    // A manual sync of the busy connection holds the sync lock while it
    // waits for Plaid. The mock keeps that request open until the cron ends.
    const gate = plaid.hold("access-busy");
    let body: unknown;
    let manual: Promise<Response> | undefined;
    try {
      manual = client.request(`/api/b/1/sync/tokens/${busy.id}/sync`, { method: "POST" });
      await gate.arrived;
      body = await cron(client, "/api/cron/plaid-sync");
      // The cron skipped the busy connection and wrote nothing to it.
      expect(await row("SELECT sync_cursor, last_error FROM plaid_tokens WHERE id = $1", [busy.id]))
        .toEqual({ syncCursor: null, lastError: null });
    } finally {
      gate.release();
    }
    expect((await manual).status).toBe(200);

    expect(body).toEqual({
      success: true, tokensFound: 3, tokensSynced: 1, tokensSkipped: 1, tokensFailed: 1,
      errors: [{
        tokenId: failing.id, bookId: other.id,
        error: "Plaid /transactions/sync request failed: login required (ITEM_LOGIN_REQUIRED)",
      }],
    });
    // The one request for the busy connection is the manual sync's.
    expect([...plaid.requests].sort()).toEqual(["access-busy", "access-failing", "access-synced"]);
    const stored = await rows<Pick<PlaidToken, "id" | "syncCursor" | "lastError">>(
      "SELECT id, sync_cursor, last_error FROM plaid_tokens ORDER BY id",
    );
    expect(stored.find((token) => token.id === synced.id)).toEqual({ id: synced.id, syncCursor: "cursor-next", lastError: null });
    // The manual sync finished after the cron, and it saved the cursor.
    expect(stored.find((token) => token.id === busy.id)).toMatchObject({ syncCursor: "cursor-next", lastError: null });
    expect(stored.find((token) => token.id === failing.id)?.lastError).toBe(
      "Plaid /transactions/sync request failed: login required (ITEM_LOGIN_REQUIRED)",
    );
  });

  it("reports no connections without calling Plaid", async () => {
    await connection("access-demo", { isDemo: true });
    expect(await cron(client, "/api/cron/plaid-sync")).toEqual({
      success: true, tokensFound: 0, tokensSynced: 0, tokensSkipped: 0, tokensFailed: 0,
    });
    expect(plaid.requests).toEqual([]);
  });

  it("adds new prices once per symbol and keeps a stored price", async () => {
    const other = await createBook({ name: "Other" });
    const kept = await createSecurity({ name: "Total Market", symbol: "VTI", securityType: "etf", fetchPrices: true });
    const added = await createSecurity({ name: "Total Market", symbol: "vti", securityType: "etf", fetchPrices: true, bookId: other.id });
    const text = await createSecurity({ name: "Text", symbol: "TEXT", securityType: "stock", fetchPrices: true });
    const manual = await createSecurity({ name: "Bonds", symbol: "BND", securityType: "etf", fetchPrices: false });
    const fixed = await createSecurity({ name: "Money Market", symbol: "MM", securityType: "mutual_fund", fetchPrices: true, fixedPriceMicros: 1_000_000 });
    await createSecurity({ name: "Missing", symbol: "MISSING", securityType: "stock", fetchPrices: true });
    await createSecurityPrice({ securityId: kept.id, priceDate: "2026-07-02", priceMicros: 5, source: "manual" });
    tiingo.reply("VTI", { status: 200, body: [{ ticker: "VTI", date: "2026-07-02T00:00:00.000Z", close: 300.1, adjClose: 299.123456 }] });
    tiingo.reply("TEXT", { status: 200, body: [{ date: "2026-07-01", adjClose: "12.5" }] });
    tiingo.reply("BND", { status: 200, body: [{ date: "2026-07-02", adjClose: 73 }] });
    tiingo.reply("MM", { status: 200, body: [{ date: "2026-07-02", adjClose: 1 }] });

    expect(await cron(client, "/api/cron/price-sync")).toEqual({
      success: true, securitiesFound: 4, pricesInserted: 2, pricesSkipped: 1,
      errors: [{ symbol: "MISSING", error: "Failed to fetch price for MISSING: Not Found" }],
    });
    expect([...tiingo.requests].sort()).toEqual(["MISSING", "TEXT", "VTI"]);
    const prices = await rows<SecurityPrice>("SELECT * FROM security_prices ORDER BY security_id, price_date");
    expect(prices).toEqual([
      { securityId: kept.id, bookId: 1, priceDate: "2026-07-02", priceMicros: 5, source: "manual" },
      { securityId: added.id, bookId: other.id, priceDate: "2026-07-02", priceMicros: 299_123_456, source: "tiingo" },
      { securityId: text.id, bookId: 1, priceDate: "2026-07-01", priceMicros: 12_500_000, source: "tiingo" },
    ]);
    expect(prices.some((price) => price.securityId === manual.id || price.securityId === fixed.id)).toBe(false);

    // Tiingo sends the same close again after a holiday.
    tiingo.requests.length = 0;
    expect(await cron(client, "/api/cron/price-sync")).toMatchObject({ pricesInserted: 0, pricesSkipped: 3 });
  });

  it("reports no securities without calling Tiingo", async () => {
    await createSecurity({ name: "Bonds", symbol: "BND", securityType: "etf", fetchPrices: false });
    expect(await cron(client, "/api/cron/price-sync")).toEqual({
      success: true, securitiesFound: 0, pricesInserted: 0, pricesSkipped: 0,
    });
    expect(tiingo.requests).toEqual([]);
  });

  it("stores no price when one close is not a number", async () => {
    await createSecurity({ name: "Total Market", symbol: "VTI", securityType: "etf", fetchPrices: true });
    await createSecurity({ name: "Broken", symbol: "BROKEN", securityType: "stock", fetchPrices: true });
    tiingo.reply("VTI", { status: 200, body: [{ date: "2026-07-02", adjClose: 1 }] });
    for (const reply of [
      { status: 200, body: [{ date: "2026-07-02", adjClose: "abc" }] },
      { status: 200, body: [{ date: "2026-07-02" }] },
      // Beyond the double range, so JSON.parse reads Infinity.
      { status: 200, raw: '[{"date":"2026-07-02","adjClose":1e400}]' },
    ]) {
      tiingo.reply("BROKEN", reply);
      const response = await client.anonymous("/api/cron/price-sync", AUTHORIZED);
      expect(response.status, JSON.stringify(reply)).toBe(500);
      expect(await response.json()).toEqual({ error: "Failed to run price sync cron" });
    }
    expect(await rows("SELECT * FROM security_prices ORDER BY security_id, price_date")).toEqual([]);
  });

  it("creates the due recurring transactions of every book", async () => {
    const today = toDateString(new Date());
    const other = await createBook({ name: "Other" });
    const rules = [];
    for (const bookId of [1, other.id]) {
      const checking = await createAccount({ name: "Checking", type: "asset", bookId });
      const rent = await createAccount({ name: "Rent", type: "expense", bookId });
      const splits = [{ accountId: rent.id, amount: 100 }, { accountId: checking.id, amount: -100 }];
      rules.push(await createRecurringRule({ name: "Rent", frequency: "monthly", startDate: today, nextDate: today, bookId, templateSplits: splits }));
      await createRecurringRule({ name: "Stopped", frequency: "daily", startDate: today, nextDate: today, bookId, isActive: false, templateSplits: splits });
      await createRecurringRule({ name: "Later", frequency: "daily", startDate: "2999-01-01", nextDate: "2999-01-01", bookId, templateSplits: splits });
    }

    const body = await cron(client, "/api/cron/recurring");
    const created = await rows<{ id: number; bookId: number; date: string; recurringRuleId: number | null }>(
      "SELECT id, book_id, date, recurring_rule_id FROM transactions ORDER BY id",
    );
    expect(created).toEqual([
      { id: created[0].id, bookId: 1, date: today, recurringRuleId: rules[0].id },
      { id: created[1].id, bookId: other.id, date: today, recurringRuleId: rules[1].id },
    ]);
    expect(body).toEqual({
      success: true, booksProcessed: 2, transactionsCreated: 2, transactionIds: created.map((txn) => txn.id),
    });
    const advanced = await row<RecurringRule>("SELECT * FROM recurring_rules WHERE id = $1", [rules[0].id]);
    expect(advanced.nextDate > today).toBe(true);

    // Nothing is due on the second run.
    expect(await cron(client, "/api/cron/recurring")).toEqual({
      success: true, booksProcessed: 2, transactionsCreated: 0, transactionIds: [],
    });
  });
});
