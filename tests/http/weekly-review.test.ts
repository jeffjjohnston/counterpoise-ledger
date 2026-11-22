import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  addBookMember, createAccount, createBook, createPayee, createRecurringRule,
  createTransactionWithSplits, createUser, resetTestDatabase, setupTestDatabase,
} from "../helpers/db-utils";
import { sessionHttpClient, startHttpTestServer } from "../helpers/http-parity";
import { exec, rows, scalar } from "../helpers/sql";

type Client = Awaited<ReturnType<typeof sessionHttpClient>>;
type Reply = { status: number; body: unknown; delayMs?: number };

const SETTINGS = "/api/b/1/settings/weekly-review";
const REVIEW = "/api/b/1/weekly-review";
const CRON = "/api/cron/weekly-review";

function json(method: string, body?: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) };
}

/** A local date `offset` days from today (the servers run with TZ=UTC). */
function day(offset: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function answer(output: unknown, overrides: Record<string, unknown> = {}): Reply {
  return {
    status: 200,
    body: {
      id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5",
      content: [{ type: "text", text: JSON.stringify(output) }],
      stop_reason: "end_turn", usage: { input_tokens: 1200, output_tokens: 300 },
      ...overrides,
    },
  };
}

/** An Anthropic mock. Each test sets `next`. The server may not call the real API. */
async function startAnthropicMock() {
  const requests: Array<{ headers: IncomingMessage["headers"]; body: Record<string, unknown> }> = [];
  let next: Reply = answer({ summary: "A quiet week.", items: [] });
  let release: (() => void) | null = null;
  let gate: Promise<void> | null = null;
  const server = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk) => { text += chunk; });
    const answerRequest = async () => {
      requests.push({ headers: request.headers, body: JSON.parse(text) as Record<string, unknown> });
      const reply = next;
      if (gate) await gate;
      if (reply.delayMs) await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
      response.writeHead(reply.status, { "content-type": "application/json" });
      response.end(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body));
    };
    request.on("end", () => { void answerRequest(); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    reply(value: Reply) { next = value; },
    hold() { gate = new Promise<void>((resolve) => { release = resolve; }); },
    release() { release?.(); gate = null; release = null; },
    reset() { requests.length = 0; next = answer({ summary: "A quiet week.", items: [] }); gate = null; release = null; },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function settle(client: Client, path = REVIEW) {
  for (let i = 0; i < 100; i += 1) {
    const state = await (await client.request(path)).json();
    if (!state.running) return state;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("the review did not end");
}

async function enable(client: Client, path = SETTINGS) {
  const response = await client.request(path, json("PATCH", { enabled: true }));
  expect(response.status).toBe(200);
}

async function fixture() {
  const checking = await createAccount({ name: "Checking 12345678", type: "asset" });
  const groceries = await createAccount({ name: "Groceries", type: "expense" });
  const costco = await createPayee({ name: "Costco" });
  const first = await createTransactionWithSplits({
    date: day(-3), payeeId: costco.id, notes: "receipt to jo@example.com",
    splits: [{ accountId: groceries.id, amount: 14210 }, { accountId: checking.id, amount: -14210 }],
  });
  const second = await createTransactionWithSplits({
    date: day(-3), payeeId: costco.id,
    splits: [{ accountId: groceries.id, amount: 14210 }, { accountId: checking.id, amount: -14210 }],
  });
  const old = await createTransactionWithSplits({
    date: day(-40), payeeId: costco.id,
    splits: [{ accountId: groceries.id, amount: 9000 }, { accountId: checking.id, amount: -9000 }],
  });
  const rule = await createRecurringRule({
    name: "Rent", frequency: "monthly", startDate: day(-60), nextDate: day(20),
    templateSplits: [{ accountId: groceries.id, amount: 100 }, { accountId: checking.id, amount: -100 }],
  });
  return { checking, groceries, costco, first, second, old, rule };
}

describe("weekly review routes", () => {
  let baseUrl: string;
  let stop: () => Promise<void>;
  let client: Client;
  let mock: Awaited<ReturnType<typeof startAnthropicMock>>;
  let data: Awaited<ReturnType<typeof fixture>>;

  beforeAll(async () => {
    await setupTestDatabase();
    mock = await startAnthropicMock();
    ({ baseUrl, stop } = await startHttpTestServer({
      ANTHROPIC_API_KEY: " test-key ", ANTHROPIC_API_URL: mock.url, CRON_SECRET: "test-cron-secret", TZ: "UTC",
    }));
  }, 120_000);

  beforeEach(async () => {
    await resetTestDatabase();
    client = await sessionHttpClient(baseUrl);
    mock.reset();
    data = await fixture();
  });

  afterAll(async () => {
    await stop?.();
    await mock?.close();
  });

  it("starts off, and an editor turns it on and off", async () => {
    expect(await (await client.request(SETTINGS)).json()).toEqual({ enabled: false, revision: 0, configured: true });
    await enable(client);
    expect(await (await client.request(SETTINGS)).json()).toEqual({ enabled: true, revision: 1, configured: true });
    const off = await client.request(SETTINGS, json("PATCH", { enabled: false }));
    expect(await off.json()).toEqual({ enabled: false, revision: 2, configured: true });
    const bad = await client.request(SETTINGS, json("PATCH", { enabled: true, extra: 1 }));
    expect(bad.status).toBe(400);
  });

  it("completes a manual run, and sends the week with memos and account names, redacted", async () => {
    await enable(client);
    mock.reply(answer({
      summary: "Costco was entered twice.",
      items: [{
        kind: "check", category: "duplicate", title: "Costco $142.10 twice", detail: "Two equal rows on one day.",
        transactionIds: [data.second.id, data.first.id], recurringRuleId: null,
      }],
    }));
    const started = await client.request(`${REVIEW}/run`, json("POST"));
    expect(started.status).toBe(202);
    const { id } = await started.json();
    const state = await settle(client);
    expect(state.configured).toBe(true);
    expect(state.enabled).toBe(true);
    expect(state.lastFailure).toBeNull();
    expect(state.latest).toMatchObject({
      id, source: "manual", status: "complete", summary: "Costco was entered twice.",
      periodStart: day(-7), periodEnd: day(-1), model: "claude-opus-5-5", error: null,
      items: [{
        kind: "check", category: "duplicate", title: "Costco $142.10 twice",
        transactionIds: [data.first.id, data.second.id].sort((a, b) => a - b), recurringRuleId: null, dismissedAt: null,
        // The register account of each transaction, so a link can open it.
        transactions: [data.first.id, data.second.id].sort((a, b) => a - b).map((id) => ({ id, accountId: data.checking.id })),
      }],
    });

    expect(mock.requests).toHaveLength(1);
    const { headers, body } = mock.requests[0];
    expect(headers["x-api-key"]).toBe("test-key");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["anthropic-beta"]).toBe("server-side-fallback-2026-07-01");
    expect(body.model).toBe("claude-opus-5-5");
    expect(body.fallbacks).toBe("default");
    const document = JSON.parse((body.messages as Array<{ content: string }>)[0].content);
    expect(document.period).toEqual({ start: day(-7), end: day(-1) });
    expect(document.transactions.map((t: { id: number }) => t.id)).toEqual([data.first.id, data.second.id]);
    expect(document.transactions[0].memo).toBe("receipt to [email]");
    expect(document.accounts.map((a: { name: string }) => a.name)).toContain("Groceries");
    expect(JSON.stringify(document)).not.toMatch(/\d{7}/);
    expect(document.history.byPayee).toContainEqual({ month: day(-40).slice(0, 7), payee: "Costco", totalCents: 9000, count: 1 });
    expect(document.recurringRules[0]).toMatchObject({ id: data.rule.id, name: "Rent" });
  });

  it("completes with no transactions in the period", async () => {
    await exec("DELETE FROM transactions");
    await enable(client);
    // Check the start and the failure first, so that a failed run names its cause.
    const started = await client.request(`${REVIEW}/run`, json("POST"));
    expect(started.status, await started.clone().text()).toBe(202);
    const state = await settle(client);
    expect(state.lastFailure).toBeNull();
    expect(state.latest).toMatchObject({ status: "complete", summary: "A quiet week.", items: [] });
  });

  it("each read shows a started review as running or as ended, not as neither", async () => {
    await enable(client);
    // The save can commit between two reads of one request. Before the
    // reads used one snapshot, 1 to 3 rounds in 100 showed neither.
    const torn: number[] = [];
    for (let round = 0; round < 500; round += 1) {
      const started = await client.request(`${REVIEW}/run`, json("POST"));
      expect(started.status).toBe(202);
      const { id } = await started.json();
      for (;;) {
        const state = await (await client.request(REVIEW)).json();
        if (state.running?.id === id) continue;
        if (state.latest?.id !== id && state.lastFailure?.id !== id) torn.push(round);
        break;
      }
    }
    expect(torn).toEqual([]);
  });

  // The system clock can step back (a time sync does this). The review that
  // starts next then has an earlier started_at than the review before it.
  // The start order is the id order, and the reads must follow it. With the
  // order by started_at, each read after the step showed the old review, and
  // the test above saw a started review as "neither" for 9 rounds in a row.
  it("shows the review that started last when the clock stepped back", async () => {
    await enable(client);
    await client.request(`${REVIEW}/run`, json("POST"));
    const first = (await settle(client)).latest;
    // The same effect as a clock that steps back one day after the first review.
    await exec("UPDATE weekly_reviews SET started_at = datetime(started_at, '+1 day') || substr(started_at, 20) WHERE id = ?", [first.id]);

    mock.reply(answer({ summary: "The second review.", items: [] }));
    const started = await client.request(`${REVIEW}/run`, json("POST"));
    const { id } = await started.json();
    expect((await settle(client)).latest).toMatchObject({ id, summary: "The second review." });

    // A failure that started last also shows, although its started_at is earlier.
    mock.reply({ status: 500, body: { type: "error" } });
    const failed = await (await client.request(`${REVIEW}/run`, json("POST"))).json();
    expect((await settle(client)).lastFailure).toMatchObject({ id: failed.id });
  });

  it("removes IDs of another book, and drops a check item with no valid ID", async () => {
    await createUser({ username: "other" });
    await createBook({ name: "Other", userId: 2 });
    const foreignAccount = await createAccount({ name: "Theirs", type: "expense", bookId: 2 });
    const foreignCash = await createAccount({ name: "Their cash", type: "asset", bookId: 2 });
    const foreign = await createTransactionWithSplits({
      bookId: 2, date: day(-2),
      splits: [{ accountId: foreignAccount.id, amount: 5 }, { accountId: foreignCash.id, amount: -5 }],
    });
    await enable(client);
    mock.reply(answer({
      summary: "s",
      items: [
        { kind: "check", category: "duplicate", title: "Mixed", detail: "d", transactionIds: [data.first.id, foreign.id], recurringRuleId: null },
        { kind: "check", category: "duplicate", title: "Foreign only", detail: "d", transactionIds: [foreign.id], recurringRuleId: 999 },
        { kind: "insight", category: "spending_change", title: "Groceries up", detail: "d", transactionIds: [], recurringRuleId: null },
      ],
    }));
    await client.request(`${REVIEW}/run`, json("POST"));
    const state = await settle(client);
    expect(state.latest.items.map((item: { title: string; transactionIds: number[] }) => [item.title, item.transactionIds]))
      .toEqual([["Mixed", [data.first.id]], ["Groceries up", []]]);
  });

  it.each([
    ["refusal", answer({}, { stop_reason: "refusal", content: [] })],
    ["invalid_response", answer("not the schema")],
    ["invalid_response", answer({}, { stop_reason: "max_tokens" })],
    ["rate_limited", { status: 429, body: { type: "error" } }],
    ["invalid_api_key", { status: 401, body: { type: "error" } }],
    ["invalid_api_key", { status: 403, body: { type: "error" } }],
    ["provider_unavailable", { status: 500, body: { type: "error" } }],
    ["provider_unavailable", { status: 529, body: { type: "error" } }],
    ["provider_error", { status: 400, body: { type: "error" } }],
  ] as Array<[string, Reply]>)("stores %s as a failed review", async (code, reply) => {
    await enable(client);
    mock.reply(reply);
    await client.request(`${REVIEW}/run`, json("POST"));
    const state = await settle(client);
    expect(state.latest).toBeNull();
    expect(state.lastFailure).toMatchObject({ error: code });
  });

  it("answers 409 while a review runs, so two clicks make one call", async () => {
    await enable(client);
    mock.hold();
    expect((await client.request(`${REVIEW}/run`, json("POST"))).status).toBe(202);
    const again = await client.request(`${REVIEW}/run`, json("POST"));
    expect(again.status).toBe(409);
    expect((await (await client.request(REVIEW)).json()).running).toMatchObject({ periodStart: day(-7) });
    mock.release();
    await settle(client);
    expect(mock.requests).toHaveLength(1);
  });

  it("answers 409 when the book has not opted in", async () => {
    const response = await client.request(`${REVIEW}/run`, json("POST"));
    expect(response.status).toBe(409);
    expect(mock.requests).toHaveLength(0);
  });

  it("discards a result after the setting changed", async () => {
    await enable(client);
    mock.hold();
    await client.request(`${REVIEW}/run`, json("POST"));
    await client.request(SETTINGS, json("PATCH", { enabled: false }));
    mock.release();
    const state = await settle(client);
    expect(state.latest).toBeNull();
    expect(state.lastFailure).toMatchObject({ error: "discarded" });
    expect(await scalar("SELECT COUNT(*) FROM weekly_review_items")).toBe(0);
  });

  it("a clear during a run leaves nothing", async () => {
    await enable(client);
    mock.hold();
    await client.request(`${REVIEW}/run`, json("POST"));
    const cleared = await client.request(SETTINGS, json("DELETE"));
    expect(await cleared.json()).toMatchObject({ enabled: false });
    mock.release();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await scalar("SELECT COUNT(*) FROM weekly_reviews")).toBe(0);
  });

  it("a running row from before a restart does not block, after the restart", async () => {
    await enable(client);
    await exec(`INSERT INTO weekly_reviews (book_id, source, period_start, period_end, status, revision, started_at)
                VALUES (1, 'manual', '${day(-7)}', '${day(-1)}', 'running', 1, '2026-01-01 00:00:00')`);
    const second = await startHttpTestServer({ ANTHROPIC_API_KEY: "test-key", ANTHROPIC_API_URL: mock.url, TZ: "UTC" });
    try {
      const other = await sessionHttpClient(second.baseUrl);
      expect(await rows("SELECT status, error FROM weekly_reviews")).toEqual([{ status: "failed", error: "interrupted" }]);
      expect((await other.request(`${REVIEW}/run`, json("POST"))).status).toBe(202);
      await settle(other);
    } finally {
      await second.stop();
    }
  });

  it("a running row older than 15 minutes does not block, with no restart", async () => {
    await enable(client);
    const old = new Date(Date.now() - 60 * 60 * 1000).toISOString().replace("T", " ").slice(0, 19);
    await exec(`INSERT INTO weekly_reviews (book_id, source, period_start, period_end, status, revision, started_at)
                VALUES (1, 'manual', '${day(-7)}', '${day(-1)}', 'running', 1, '${old}')`);
    expect((await client.request(`${REVIEW}/run`, json("POST"))).status).toBe(202);
    await settle(client);
    expect(await rows("SELECT error FROM weekly_reviews WHERE started_at = $1", [old])).toEqual([{ error: "interrupted" }]);
  });

  it("a dismissed item stays dismissed after more than 12 reviews", async () => {
    await enable(client);
    const rent = { kind: "check", category: "missed_payment", title: "Rent not seen", detail: "d", transactionIds: [], recurringRuleId: data.rule.id };
    mock.reply(answer({ summary: "s", items: [rent] }));
    await client.request(`${REVIEW}/run`, json("POST"));
    const itemId = (await settle(client)).latest.items[0].id;
    await client.request(`${REVIEW}/items/${itemId}/dismiss`, json("POST"));
    for (let i = 0; i < 13; i += 1) {
      await client.request(`${REVIEW}/run`, json("POST"));
      await settle(client);
    }
    expect((await (await client.request(REVIEW)).json()).latest.items).toEqual([]);
  });

  it("dismisses and restores an item, and a dismissed item does not come back", async () => {
    await enable(client);
    const duplicate = { kind: "check", category: "duplicate", title: "Twice", detail: "d", transactionIds: [data.first.id, data.second.id], recurringRuleId: null };
    mock.reply(answer({ summary: "s", items: [duplicate] }));
    await client.request(`${REVIEW}/run`, json("POST"));
    const itemId = (await settle(client)).latest.items[0].id;

    const dismissed = await client.request(`${REVIEW}/items/${itemId}/dismiss`, json("POST"));
    expect(dismissed.status).toBe(200);
    expect((await dismissed.json()).dismissedAt).toEqual(expect.any(String));
    expect((await (await client.request(REVIEW)).json()).latest.items).toEqual([]);

    const restored = await client.request(`${REVIEW}/items/${itemId}/restore`, json("POST"));
    expect((await restored.json()).dismissedAt).toBeNull();
    await client.request(`${REVIEW}/items/${itemId}/dismiss`, json("POST"));

    mock.reply(answer({ summary: "again", items: [{ ...duplicate, transactionIds: [data.second.id, data.first.id] }] }));
    await client.request(`${REVIEW}/run`, json("POST"));
    expect((await settle(client)).latest).toMatchObject({ summary: "again", items: [] });

    expect((await client.request(`${REVIEW}/items/999999/dismiss`, json("POST"))).status).toBe(404);
  });

  it("keeps the newest 12 reviews of a book", async () => {
    await enable(client);
    for (let i = 0; i < 13; i += 1) {
      await client.request(`${REVIEW}/run`, json("POST"));
      await settle(client);
    }
    // The prune runs after the save commits, so that a failed prune does not
    // fail the review. settle() returns when the save commits: the count can
    // be 13 for a moment.
    await expect.poll(() => scalar("SELECT COUNT(*) FROM weekly_reviews WHERE book_id = 1")).toBe(12);
    // The 12 that stay are the 12 that started last.
    expect(await scalar("SELECT MIN(id) FROM weekly_reviews WHERE book_id = 1")).toBe(2);
  });

  it("the cron job reviews each book that opted in", async () => {
    await enable(client);
    expect((await client.anonymous(CRON)).status).toBe(401);
    const response = await client.anonymous(CRON, { headers: { authorization: "Bearer test-cron-secret" } });
    expect(await response.json()).toEqual({ success: true, booksReviewed: 1, booksFailed: 0, booksWithoutReview: 0 });
    expect(await rows("SELECT source, status FROM weekly_reviews")).toEqual([{ source: "schedule", status: "complete" }]);

    // A second run in the same week (a retried run) does not ask again.
    const calls = mock.requests.length;
    const again = await client.anonymous(CRON, { headers: { authorization: "Bearer test-cron-secret" } });
    expect(await again.json()).toEqual({ success: true, booksReviewed: 0, booksFailed: 0, booksWithoutReview: 0 });
    expect(mock.requests).toHaveLength(calls);
    expect(await rows("SELECT source, status FROM weekly_reviews")).toEqual([{ source: "schedule", status: "complete" }]);
  });

  it("the cron job counts a failed review as failed", async () => {
    await enable(client);
    mock.reply({ status: 500, body: { type: "error" } });
    const response = await client.anonymous(CRON, { headers: { authorization: "Bearer test-cron-secret" } });
    expect(await response.json()).toEqual({ success: true, booksReviewed: 0, booksFailed: 1, booksWithoutReview: 1 });
  });

  /** The record of the job that the status page reads. */
  async function jobRun() {
    return rows<{ lastOkAt: Date | null; detail: string | null }>(
      "SELECT last_ok_at, detail FROM job_runs WHERE job = 'weekly-review'",
    );
  }
  const NO_REVIEW = "1 book that opted in has no review of this week";

  it("a later run of the week tries a failed scheduled review again", async () => {
    await enable(client);
    const cron = () => client.anonymous(CRON, { headers: { authorization: "Bearer test-cron-secret" } });
    mock.reply({ status: 500, body: { type: "error" } });
    expect(await (await cron()).json()).toEqual({ success: true, booksReviewed: 0, booksFailed: 1, booksWithoutReview: 1 });
    // The status page shows that a book has no review.
    expect(await jobRun()).toEqual([{ lastOkAt: null, detail: NO_REVIEW }]);

    // The failed review does not count as the review of the week.
    mock.reply(answer({ summary: "A quiet week.", items: [] }));
    expect(await (await cron()).json()).toEqual({ success: true, booksReviewed: 1, booksFailed: 0, booksWithoutReview: 0 });
    expect(await rows("SELECT source, status FROM weekly_reviews ORDER BY id")).toEqual([
      { source: "schedule", status: "failed" }, { source: "schedule", status: "complete" },
    ]);
    const [run] = await jobRun();
    expect(run.lastOkAt).not.toBeNull();
    expect(run.detail).toBeNull();
  });

  it("the cron job stops after three failed scheduled reviews of a week", async () => {
    await enable(client);
    const cron = () => client.anonymous(CRON, { headers: { authorization: "Bearer test-cron-secret" } });
    mock.reply({ status: 500, body: { type: "error" } });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(await (await cron()).json()).toEqual({ success: true, booksReviewed: 0, booksFailed: 1, booksWithoutReview: 1 });
    }
    expect(mock.requests).toHaveLength(3);
    // The fourth run does not ask Claude, and the job stays failed.
    expect(await (await cron()).json()).toEqual({ success: true, booksReviewed: 0, booksFailed: 0, booksWithoutReview: 1 });
    expect(mock.requests).toHaveLength(3);
    expect(await scalar("SELECT COUNT(*) FROM weekly_reviews WHERE status = 'failed'")).toBe(3);
    expect(await jobRun()).toEqual([{ lastOkAt: null, detail: NO_REVIEW }]);
  });

  it("a stale running scheduled review counts as an attempt of the week", async () => {
    await enable(client);
    // Two failed scheduled reviews, and a third whose save was lost: it is
    // still `running` after more than 15 minutes, with no restart.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await exec(`INSERT INTO weekly_reviews (book_id, source, period_start, period_end, status, error, revision, started_at)
                  VALUES (1, 'schedule', '${day(-7)}', '${day(-1)}', 'failed', 'timeout', 1, '2026-01-01 0${attempt}:00:00')`);
    }
    const old = new Date(Date.now() - 60 * 60 * 1000).toISOString().replace("T", " ").slice(0, 19);
    await exec(`INSERT INTO weekly_reviews (book_id, source, period_start, period_end, status, revision, started_at)
                VALUES (1, 'schedule', '${day(-7)}', '${day(-1)}', 'running', 1, '${old}')`);
    const response = await client.anonymous(CRON, { headers: { authorization: "Bearer test-cron-secret" } });
    // The stale review becomes the third failure. The run starts no fourth
    // review and makes no paid call.
    expect(await response.json()).toEqual({ success: true, booksReviewed: 0, booksFailed: 0, booksWithoutReview: 1 });
    expect(mock.requests).toHaveLength(0);
    expect(await rows("SELECT status FROM weekly_reviews ORDER BY id")).toEqual([
      { status: "failed" }, { status: "failed" }, { status: "failed" },
    ]);
    expect(await jobRun()).toEqual([{ lastOkAt: null, detail: NO_REVIEW }]);
  });

  it("a review that a restart stopped does not count as the review of the week", async () => {
    await enable(client);
    // The scheduled review of this week, as `mark_interrupted` leaves it.
    await exec(`INSERT INTO weekly_reviews (book_id, source, period_start, period_end, status, error, revision, started_at)
                VALUES (1, 'schedule', '${day(-7)}', '${day(-1)}', 'failed', 'interrupted', 1, '2026-01-01 00:00:00')`);
    const response = await client.anonymous(CRON, { headers: { authorization: "Bearer test-cron-secret" } });
    expect(await response.json()).toEqual({ success: true, booksReviewed: 1, booksFailed: 0, booksWithoutReview: 0 });
  });

  it("a manual review that runs does not make the book miss its scheduled review", async () => {
    await enable(client);
    const cron = () => client.anonymous(CRON, { headers: { authorization: "Bearer test-cron-secret" } });
    mock.hold();
    expect((await client.request(`${REVIEW}/run`, json("POST"))).status).toBe(202);
    // The scheduled run cannot start a second review of the book. It
    // reports the book, so the status page shows it.
    expect(await (await cron()).json()).toEqual({ success: true, booksReviewed: 0, booksFailed: 0, booksWithoutReview: 1 });
    expect(await jobRun()).toEqual([{ lastOkAt: null, detail: NO_REVIEW }]);
    mock.release();
    await settle(client);
    // A later run of the week reviews the book.
    expect(await (await cron()).json()).toEqual({ success: true, booksReviewed: 1, booksFailed: 0, booksWithoutReview: 0 });
    expect((await jobRun())[0].lastOkAt).not.toBeNull();
  });

  it("a failed retention cleanup does not turn a complete review into a failure", async () => {
    await enable(client);
    // Manual reviews: a scheduled one of this week would stop the job.
    for (let i = 0; i < 12; i += 1) {
      await exec(`INSERT INTO weekly_reviews (book_id, source, period_start, period_end, status, revision, started_at)
                  VALUES (1, 'manual', '${day(-7)}', '${day(-1)}', 'complete', 1, '2026-01-0${(i % 9) + 1} 05:00:00')`);
    }
    await exec("CREATE TRIGGER weekly_reviews_no_delete BEFORE DELETE ON weekly_reviews BEGIN SELECT RAISE(ABORT, 'no delete'); END");
    try {
      const response = await client.anonymous(CRON, { headers: { authorization: "Bearer test-cron-secret" } });
      expect(await response.json()).toEqual({ success: true, booksReviewed: 1, booksFailed: 0, booksWithoutReview: 0 });
    } finally {
      await exec("DROP TRIGGER weekly_reviews_no_delete");
    }
  });

  it("refuses a viewer, and an item of another book", async () => {
    await createUser({ username: "owner2" });
    await createBook({ name: "Shared", userId: 2 });
    await addBookMember({ bookId: 2, userId: 1, role: "viewer" });
    expect((await client.request("/api/b/2/weekly-review")).status).toBe(200);
    expect((await client.request("/api/b/2/settings/weekly-review", json("PATCH", { enabled: true }))).status).toBe(403);
    expect((await client.request("/api/b/2/weekly-review/run", json("POST"))).status).toBe(403);

    await enable(client);
    mock.reply(answer({ summary: "s", items: [{ kind: "insight", category: "other", title: "t", detail: "d", transactionIds: [], recurringRuleId: null }] }));
    await client.request(`${REVIEW}/run`, json("POST"));
    const itemId = (await settle(client)).latest.items[0].id;
    expect((await client.request(`/api/b/2/weekly-review/items/${itemId}/dismiss`, json("POST"))).status).toBe(403);
    // With write access to book 2, an item of book 1 is still not found there.
    await exec("UPDATE book_members SET role = 'editor' WHERE book_id = 2 AND user_id = 1");
    expect((await client.request(`/api/b/2/weekly-review/items/${itemId}/dismiss`, json("POST"))).status).toBe(404);
  });
  it("does not report a review stuck in running for more than 15 minutes, so Review now works", async () => {
    await enable(client);
    const old = new Date(Date.now() - 20 * 60 * 1000).toISOString().replace("T", " ").slice(0, 23);
    await exec(
      `INSERT INTO weekly_reviews (book_id, source, period_start, period_end, status, revision, started_at)
       VALUES (1, 'manual', $1, $2, 'running', 1, $3)`, [day(-7), day(-1), old],
    );
    expect((await (await client.request(REVIEW)).json()).running).toBeNull();
    expect((await client.request(`${REVIEW}/run`, json("POST"))).status).toBe(202);
    expect((await settle(client)).latest).toMatchObject({ status: "complete" });
  });
});

describe("weekly review without an API key", () => {
  let baseUrl: string;
  let stop: () => Promise<void>;

  beforeAll(async () => {
    await setupTestDatabase();
    ({ baseUrl, stop } = await startHttpTestServer({ ANTHROPIC_API_KEY: "", CRON_SECRET: "test-cron-secret", TZ: "UTC" }));
  }, 120_000);
  beforeEach(async () => { await resetTestDatabase(); });
  afterAll(async () => { await stop?.(); });

  it("is not configured, cannot be enabled, and the cron job reports the missing key", async () => {
    const client = await sessionHttpClient(baseUrl);
    expect(await (await client.request(SETTINGS)).json()).toEqual({ enabled: false, revision: 0, configured: false });
    expect((await client.request(SETTINGS, json("PATCH", { enabled: true }))).status).toBe(409);
    expect((await client.request(REVIEW)).status).toBe(200);
    expect(await (await client.request(REVIEW)).json()).toMatchObject({ configured: false, latest: null });
    expect((await client.anonymous(CRON)).status).toBe(401);
    const cron = await client.anonymous(CRON, { headers: { authorization: "Bearer test-cron-secret" } });
    expect(await cron.json()).toEqual({ success: true, skipped: true, missingSetting: "ANTHROPIC_API_KEY" });
  });

});
