import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createAccount, createPayee, createTransactionWithSplits, resetTestDatabase, setupTestDatabase,
} from "../helpers/db-utils";
import { sessionHttpClient, startHttpTestServer } from "../helpers/http-parity";
import { exec, scalar } from "../helpers/sql";
import { typesafeReply } from "../helpers/typesafe";

type Client = Awaited<ReturnType<typeof sessionHttpClient>>;
type Reply = (inner: Record<string, unknown>) => { status: number; body: unknown };

/** The Cloudflare API mock. It records each request and answers from a queue, or picks the first option. */
async function startClefMock() {
  const requests: { url?: string; body: string; authorization?: string }[] = [];
  const replies: Reply[] = [];
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      requests.push({ url: request.url, body, authorization: request.headers.authorization });
      void typesafeReply({ body }).json().then((answered: { result: Record<string, unknown> }) => {
        const inner = answered.result;
        const reply = replies.shift()
          ?? ((result) => ({ status: 200, body: { result, success: true, errors: [], messages: [] } }));
        const { status, body: out } = reply(inner);
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(out));
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
    reset() { requests.length = 0; replies.length = 0; },
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

const SUGGEST = "/api/b/1/entry-suggestion";
const SETTINGS = "/api/b/1/settings/typesafe";

/** An opted-in book with a payee that has two entry patterns, so one question is asked. */
async function fixture() {
  await exec("UPDATE books SET typesafe_entry_enabled = 1, typesafe_revision = 3 WHERE id = 1");
  const checking = await createAccount({ name: "Checking", type: "asset", subtype: "bank", bookId: 1 });
  const groceries = await createAccount({ name: "Groceries", type: "expense", bookId: 1 });
  const household = await createAccount({ name: "Household", type: "expense", bookId: 1 });
  const costco = await createPayee({ name: "Costco", bookId: 1 });
  const spend = (date: string, to: number, amount: number) =>
    createTransactionWithSplits({
      date, payeeId: costco.id, bookId: 1,
      splits: [{ accountId: to, amount }, { accountId: checking.id, amount: -amount }],
    });
  await spend(day(-30), groceries.id, 4210);
  await spend(day(-20), household.id, 9000);
  await spend(day(-10), groceries.id, 4210);
  return { accountId: checking.id, payeeId: costco.id, date: day(0), amount: null };
}

describe("the request to Clef", () => {
  let baseUrl: string;
  let stop: () => Promise<void>;
  let client: Client;
  let mock: Awaited<ReturnType<typeof startClefMock>>;

  beforeAll(async () => {
    await setupTestDatabase();
    mock = await startClefMock();
    ({ baseUrl, stop } = await startHttpTestServer({
      TYPESAFE_ENABLED: "true", TYPESAFE_CLEF_ACCOUNT_ID: "abc123",
      TYPESAFE_CLEF_API_TOKEN: " test-cf-token ", TYPESAFE_CLEF_API_URL: mock.url, TZ: "UTC",
    }));
  }, 120_000);
  beforeEach(async () => {
    await resetTestDatabase();
    client = await sessionHttpClient(baseUrl);
    mock.reset();
  });
  afterAll(async () => { await stop?.(); await mock?.close(); });

  it("sends the request to the Workers AI route of the account and reads the answer from the envelope", async () => {
    const body = await fixture();
    const answer = await (await client.request(SUGGEST, json("POST", body))).json();
    expect(answer).toMatchObject({ status: "ready", confidence: 1 });
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0].url).toBe("/client/v4/accounts/abc123/ai/run/@cf/cloudflare/clef");
    expect(mock.requests[0].authorization).toBe("Bearer test-cf-token");
    const sent = JSON.parse(mock.requests[0].body);
    expect(sent.model).toBe("clef");
    expect(sent.state.model).toBeUndefined();
    expect(sent.questions.pattern.type).toBe("choice");
    expect(await scalar("SELECT status FROM typesafe_entry_evaluations")).toBe("ready");
  });

  it.each<[string, Reply, string]>([
    ["an answer of another model", (result) => ({ status: 200, body: { result: { ...result, model: "jev-1.13.0" }, success: true } }), "invalid_response_model"],
    ["an answer of the other Clef model", (result) => ({ status: 200, body: { result: { ...result, model: "clef-flash" }, success: true } }), "invalid_response_model"],
    ["an answer without the envelope", (result) => ({ status: 200, body: result }), "provider_error"],
    ["an envelope that reports a failure", (result) => ({ status: 200, body: { result, success: false, errors: [{ code: 1 }] } }), "provider_error"],
    ["an envelope without a result", () => ({ status: 200, body: { success: true } }), "invalid_response_schema"],
    ["a rate limit", () => ({ status: 429, body: {} }), "rate_limited"],
  ])("refuses %s", async (_name, reply, code) => {
    const body = await fixture();
    mock.replies.push(reply);
    const answer = await (await client.request(SUGGEST, json("POST", body))).json();
    expect(answer).toMatchObject({ status: "failed", error: code });
    expect(await scalar("SELECT error_code FROM typesafe_entry_evaluations")).toBe(code);
  });

  it("reports the integration as configured", async () => {
    const settings = await (await client.request(SETTINGS)).json();
    expect(settings.configured).toBe(true);
  });
});

describe("settings without a usable account or token", () => {
  it.each([
    ["no account", { TYPESAFE_CLEF_ACCOUNT_ID: "" }],
    ["an account that is not letters and digits", { TYPESAFE_CLEF_ACCOUNT_ID: "abc/../x" }],
    ["no token", { TYPESAFE_CLEF_API_TOKEN: " " }],
    // The key of the provider that the server no longer has does not count.
    ["only the old TypeSafe key", { TYPESAFE_CLEF_ACCOUNT_ID: "", TYPESAFE_CLEF_API_TOKEN: "", TYPESAFE_API_KEY: "test-typesafe-key" }],
  ])("%s leaves the integration not configured", async (_name, settings) => {
    await setupTestDatabase();
    await resetTestDatabase();
    const { baseUrl, stop } = await startHttpTestServer({
      TYPESAFE_ENABLED: "true",
      TYPESAFE_CLEF_ACCOUNT_ID: "abc123", TYPESAFE_CLEF_API_TOKEN: "test-cf-token",
      TZ: "UTC", ...settings,
    });
    try {
      const client = await sessionHttpClient(baseUrl);
      expect((await (await client.request(SETTINGS)).json()).configured).toBe(false);
    } finally {
      await stop();
    }
  }, 120_000);
});
