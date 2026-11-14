import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  addBookMember, createAccount, createBook, createPayee, createTransactionWithSplits, createUser,
  resetTestDatabase, setupTestDatabase,
} from "../helpers/db-utils";
import { sessionHttpClient, startHttpTestServer } from "../helpers/http-parity";
import { exec, insert, rows, scalar } from "../helpers/sql";
import { typesafeReply } from "../helpers/typesafe";

type Client = Awaited<ReturnType<typeof sessionHttpClient>>;
type Picks = Parameters<typeof typesafeReply>[1];
type Reply = (body: string) => { status: number; body: string } | Promise<{ status: number; body: string }>;

/** The TypeSafe mock. It records each request and answers from a queue, or picks an option. */
async function startTypeSafeMock() {
  const requests: { body: string }[] = [];
  const replies: Reply[] = [];
  let picks: Picks = {};
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      requests.push({ body });
      const reply = replies.shift() ?? ((text: string) =>
        typesafeReply({ body: text }, picks).text().then((out) => ({ status: 200, body: out })));
      void Promise.resolve(reply(body)).then(({ status, body: out }) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(out);
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No mock port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    replies,
    pick(next: Picks) { picks = next; },
    reset() { requests.length = 0; replies.length = 0; picks = {}; },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

/** A local date `offset` days from today (the server runs with TZ=UTC). */
function day(offset: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

describe("entry suggestion routes", () => {
  let baseUrl: string;
  let stop: () => Promise<void>;
  let client: Client;
  let mock: Awaited<ReturnType<typeof startTypeSafeMock>>;

  beforeAll(async () => {
    await setupTestDatabase();
    mock = await startTypeSafeMock();
    ({ baseUrl, stop } = await startHttpTestServer({
      TYPESAFE_ENABLED: "true", TYPESAFE_CLEF_ACCOUNT_ID: "abc123", TYPESAFE_CLEF_API_TOKEN: "test-token", TYPESAFE_CLEF_API_URL: mock.url, TZ: "UTC",
    }));
  }, 120_000);
  beforeEach(async () => {
    await resetTestDatabase();
    client = await sessionHttpClient(baseUrl);
    mock.reset();
  });
  afterAll(async () => { await stop?.(); await mock?.close(); });

  const SUGGEST = (bookId = 1) => `/api/b/${bookId}/entry-suggestion`;

  async function fixture({ opted = true, bookId = 1 } = {}) {
    if (opted) await exec("UPDATE books SET typesafe_entry_enabled = 1, typesafe_revision = 3 WHERE id = $1", [bookId]);
    const checking = await createAccount({ name: "Checking 12345678", type: "asset", subtype: "bank", bookId });
    const groceries = await createAccount({ name: "Groceries", type: "expense", bookId });
    const household = await createAccount({ name: "Household jo@example.com", type: "expense", bookId });
    const costco = await createPayee({ name: "Costco 9876543", bookId });
    const spend = (date: string, to: number, amount: number) =>
      createTransactionWithSplits({
        date, payeeId: costco.id, notes: "secret memo", bookId,
        splits: [{ accountId: to, amount }, { accountId: checking.id, amount: -amount }],
      });
    await spend(day(-30), groceries.id, 4210);
    await spend(day(-20), household.id, 9000);
    await spend(day(-10), groceries.id, 4210);
    const body = { accountId: checking.id, payeeId: costco.id, date: day(0), amount: null };
    return { checking, groceries, household, costco, spend, body };
  }

  it("asks TypeSafe and returns the chosen pattern key", async () => {
    const f = await fixture();
    mock.pick({ pattern: "P2" });
    const response = await client.request(SUGGEST(), json("POST", f.body));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ready", evaluationId: expect.any(Number), choice: `${f.household.id}:in`, confidence: 1,
    });
    expect(mock.requests).toHaveLength(1);
    const sent = mock.requests[0].body;
    expect(Object.keys(JSON.parse(sent).questions)).toEqual(["pattern"]);
    expect(sent).toContain("Costco [reference]");
    expect(sent).toContain("Household [email]");
    expect(sent).not.toContain("secret memo");
    expect(sent).not.toContain("Checking");
    expect(sent).not.toContain("9876543");
    expect(await scalar("SELECT status FROM typesafe_entry_evaluations")).toBe("ready");
  });

  it("reuses the stored answer for the same input", async () => {
    const f = await fixture();
    await client.request(SUGGEST(), json("POST", f.body));
    const again = await (await client.request(SUGGEST(), json("POST", f.body))).json();
    expect(again.status).toBe("ready");
    expect(mock.requests).toHaveLength(1);
  });

  it("skips with fewer than 2 patterns and makes no call", async () => {
    const f = await fixture();
    await exec(`DELETE FROM transactions WHERE id IN
      (SELECT transaction_id FROM transaction_splits WHERE account_id = $1)`, [f.household.id]);
    const answer = await (await client.request(SUGGEST(), json("POST", f.body))).json();
    expect(answer).toEqual({ status: "skipped", evaluationId: expect.any(Number) });
    expect(mock.requests).toHaveLength(0);
  });

  it("answers 409 when the book has not opted in", async () => {
    const f = await fixture({ opted: false });
    expect((await client.request(SUGGEST(), json("POST", f.body))).status).toBe(409);
    expect(mock.requests).toHaveLength(0);
  });

  it("refuses an unknown field, a bad date or amount, and an account of another book", async () => {
    const f = await fixture();
    expect((await client.request(SUGGEST(), json("POST", { ...f.body, bookId: 2 }))).status).toBe(400);
    expect((await client.request(SUGGEST(), json("POST", { ...f.body, date: "2026-13-01" }))).status).toBe(400);
    expect((await client.request(SUGGEST(), json("POST", { ...f.body, amount: "5" }))).status).toBe(400);
    await createUser({ username: "owner2" });
    await createBook({ name: "Other", userId: 2 });
    const other = await createAccount({ name: "Elsewhere", type: "asset", bookId: 2 });
    expect((await client.request(SUGGEST(), json("POST", { ...f.body, accountId: other.id }))).status).toBe(404);
  });

  it("stores a TypeSafe failure and returns failed", async () => {
    const f = await fixture();
    mock.replies.push(() => ({ status: 500, body: "{}" }));
    const answer = await (await client.request(SUGGEST(), json("POST", f.body))).json();
    expect(answer).toMatchObject({ status: "failed", error: "provider_error" });
    expect(await scalar("SELECT error_code FROM typesafe_entry_evaluations")).toBe("provider_error");
  });

  it("a settings change during the call makes the answer stale", async () => {
    const f = await fixture();
    mock.replies.push(async (text) => {
      await exec("UPDATE books SET typesafe_revision = typesafe_revision + 1 WHERE id = 1");
      return { status: 200, body: await typesafeReply({ body: text }).text() };
    });
    const answer = await (await client.request(SUGGEST(), json("POST", f.body))).json();
    expect(answer).toEqual({ status: "stale" });
    expect(await scalar("SELECT status FROM typesafe_entry_evaluations")).toBe("stale");
  });

  it("stops at the daily quota", async () => {
    const f = await fixture();
    const today = new Date().toISOString().slice(0, 10);
    await insert("typesafe_quotas", { bookId: 1, day: today, attempts: 100 });
    expect(await (await client.request(SUGGEST(), json("POST", f.body))).json()).toEqual({ status: "limited" });
    expect(mock.requests).toHaveLength(0);
  });

  it("refuses a viewer", async () => {
    await createUser({ username: "owner2" });
    await createBook({ name: "Shared", userId: 2 });
    await addBookMember({ bookId: 2, userId: 1, role: "viewer" });
    const f = await fixture({ bookId: 2 });
    expect((await client.request(SUGGEST(2), json("POST", f.body))).status).toBe(403);
    expect(await rows("SELECT id FROM typesafe_entry_evaluations")).toEqual([]);
  });

  const OUTCOME = "/api/b/1/entry-suggestion/outcome";
  const outcome = (over: Record<string, unknown> = {}) => ({
    evaluationId: null, outcome: "kept", source: "history", chipVisible: true, pickedIndex: null, transactionId: null, ...over,
  });

  it("records an outcome", async () => {
    const f = await fixture();
    const { evaluationId } = await (await client.request(SUGGEST(), json("POST", f.body))).json();
    const response = await client.request(OUTCOME, json("POST", outcome({
      evaluationId, source: "typesafe", outcome: "picked_other", pickedIndex: 1,
    })));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(await rows(`SELECT evaluation_id AS e, outcome AS o, source AS s, chip_visible AS c, picked_index AS p
                       FROM typesafe_entry_outcomes`))
      .toEqual([{ e: evaluationId, o: "picked_other", s: "typesafe", c: 1, p: 1 }]);
  });

  it("refuses a bad outcome, an unknown field, and IDs of another book", async () => {
    await fixture();
    for (const bad of [
      outcome({ outcome: "ignored" }), outcome({ source: "guess" }), { ...outcome(), bookId: 1 },
      outcome({ chipVisible: 1 }), outcome({ pickedIndex: -1 }), outcome({ evaluationId: "1" }),
    ]) {
      expect((await client.request(OUTCOME, json("POST", bad))).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await client.request(OUTCOME, json("POST", outcome({ evaluationId: 999 })))).status).toBe(404);
    expect((await client.request(OUTCOME, json("POST", outcome({ transactionId: 999 })))).status).toBe(404);
    expect(await rows("SELECT id FROM typesafe_entry_outcomes")).toEqual([]);
  });

  it("answers 409 for an outcome when the book has not opted in", async () => {
    await fixture({ opted: false });
    expect((await client.request(OUTCOME, json("POST", outcome()))).status).toBe(409);
  });

  it("answers busy while another entry evaluation of the book is in flight", async () => {
    const f = await fixture();
    await insert("typesafe_entry_evaluations", {
      bookId: 1, accountId: f.checking.id, payeeId: f.costco.id, revision: 3, fingerprint: "other", attempt: "x",
      snapshot: {}, status: "pending", baselineKey: "k", startedAt: new Date(),
    });
    expect(await (await client.request(SUGGEST(), json("POST", f.body))).json()).toEqual({ status: "busy" });
    expect(mock.requests).toHaveLength(0);
  });

  it("sends a typed amount with its direction", async () => {
    const f = await fixture();
    await client.request(SUGGEST(), json("POST", { ...f.body, amount: -5000 }));
    expect(JSON.parse(mock.requests[0].body).state.entry.amount).toEqual({ cents: 5000, direction: "out" });
  });

  it("stores the answer as stale when the user turns the setting off during the call", async () => {
    const f = await fixture();
    mock.replies.push(async (text) => {
      const off = await client.request("/api/b/1/settings/typesafe", json("PATCH", { entrySuggestionsEnabled: false }));
      expect(off.status).toBe(200);
      return { status: 200, body: await typesafeReply({ body: text }).text() };
    });
    expect(await (await client.request(SUGGEST(), json("POST", f.body))).json()).toEqual({ status: "stale" });
    expect(await scalar("SELECT status FROM typesafe_entry_evaluations")).toBe("stale");
  });
});

describe("entry patterns in a time zone ahead of UTC", () => {
  let baseUrl: string;
  let stop: () => Promise<void>;
  let client: Client;
  const TZ = "Pacific/Kiritimati"; // UTC+14: its date is often a day after the UTC date

  beforeAll(async () => {
    await setupTestDatabase();
    ({ baseUrl, stop } = await startHttpTestServer({ TZ }));
  }, 120_000);
  beforeEach(async () => {
    await resetTestDatabase();
    client = await sessionHttpClient(baseUrl);
  });
  afterAll(async () => { await stop?.(); });

  it("counts a transaction dated today in the app's time zone", async () => {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
    const checking = await createAccount({ name: "Checking", type: "asset", subtype: "bank" });
    const groceries = await createAccount({ name: "Groceries", type: "expense" });
    const costco = await createPayee({ name: "Costco" });
    await createTransactionWithSplits({
      date: today, payeeId: costco.id,
      splits: [{ accountId: groceries.id, amount: 100 }, { accountId: checking.id, amount: -100 }],
    });
    const response = await client.request(`/api/b/1/payees/${costco.id}/entry-patterns?accountId=${checking.id}`);
    expect((await response.json()).patterns).toMatchObject([{ lastDate: today, count: 1 }]);
  });
});
