import { createServer, type Server } from "node:http";
import { asc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  books, payees, plaidTransactionReconciliation, transactions, transactionSplits, typesafeDecisions,
  typesafeEvaluations, typesafeQuotas,
} from "../../db/schema";
import {
  addBookMember, createAccount, createBook, createPayee, createPlaidAccount, createPlaidReconciliation,
  createPlaidToken, createTransactionWithSplits, createUser, db, resetTestDatabase, setupTestDatabase,
} from "../helpers/db-utils";
import { sessionHttpClient, startHttpTestServer } from "../helpers/http-parity";
import { typesafeReply } from "../helpers/typesafe";

type Client = Awaited<ReturnType<typeof sessionHttpClient>>;
type Picks = Parameters<typeof typesafeReply>[1];
type Reply = (body: string) => { status: number; body: string } | Promise<{ status: number; body: string }>;

/** The TypeSafe mock. It records each request and answers from a queue, or picks the first option. */
async function startTypeSafeMock() {
  const requests: { body: string; authorization?: string; contentType?: string }[] = [];
  const replies: Reply[] = [];
  let picks: Picks = {};
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      requests.push({ body, authorization: request.headers.authorization, contentType: request.headers["content-type"] });
      const reply = replies.shift() ?? ((text: string) => {
        const answered = typesafeReply({ body: text }, picks);
        return answered.text().then((out) => ({ status: 200, body: out }));
      });
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
  return { method, headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) };
}

async function expectError(client: Client, path: string, init: RequestInit, status: number, error: string) {
  const response = await client.request(path, init);
  expect(response.status, `${init.method} ${path} ${String(init.body)}`).toBe(status);
  expect(await response.json()).toEqual({ error });
}

/**
 * A book with TypeSafe on, a checking account linked to Plaid, candidates
 * around the bank dates, and a merchant that an earlier match already used.
 * Every date is fixed, so the request bodies are the same on each run.
 */
async function fixture() {
  await db.update(books).set({ typesafeReconciliationEnabled: true, typesafeRevision: 2 }).where(eq(books.id, 1));
  const checking = await createAccount({ name: "Checking", type: "asset", subtype: "bank" });
  const food = await createAccount({ name: "Food", type: "expense" });
  const dining = await createAccount({ name: "Food:Dining", type: "expense" });
  const salary = await createAccount({ name: "Salary", type: "income" });
  await createAccount({ name: "Old Hobby", type: "expense", isActive: false });
  const coffee = await createPayee({ name: "Blue Bottle" });
  await createPayee({ name: "Bottle Shop" });
  await createPayee({ name: "Landlord" });
  const token = await createPlaidToken({ financialInstitution: "Bank", itemId: "item-1", accessToken: "access-1" });
  const link = await createPlaidAccount({ tokenId: token.id, plaidAccountId: "pa-1", name: "Checking", type: "depository", counterpoiseAccountId: checking.id });
  const spend = (date: string, amount: number, payeeId: number | null, counter: number) =>
    createTransactionWithSplits({ date, payeeId, splits: [{ accountId: checking.id, amount: -amount }, { accountId: counter, amount }] });
  const earlier = await spend("2025-02-01", 430, coffee.id, dining.id);
  await createPlaidReconciliation({
    plaidAccountLinkId: link.id, plaidTransactionId: "old", date: "2025-02-01", amountCents: 430,
    name: "SQ *BLUE BOTTLE", merchantName: "SQ *BLUE  BOTTLE", resolutionStatus: "matched", matchedTransactionId: earlier.id,
  });
  const exact = await spend("2025-03-09", 450, coffee.id, food.id);
  const close = await spend("2025-03-12", 460, coffee.id, food.id);
  await createTransactionWithSplits({ date: "2025-03-01", splits: [{ accountId: checking.id, amount: 90000 }, { accountId: salary.id, amount: -90000 }] });
  const matchRow = await createPlaidReconciliation({
    plaidAccountLinkId: link.id, plaidTransactionId: "t-match", date: "2025-03-10", authorizedDate: "2025-03-09",
    amountCents: 450, name: "SQ *BLUE BOTTLE 1234 5678 90", merchantName: "SQ *BLUE BOTTLE",
  });
  const newRow = await createPlaidReconciliation({
    plaidAccountLinkId: link.id, plaidTransactionId: "t-new", date: "2025-06-15",
    amountCents: 2500, name: "Zelle to jane@example.com CONF 99887766",
  });
  const reviewRow = await createPlaidReconciliation({
    plaidAccountLinkId: link.id, plaidTransactionId: "t-review", date: "2025-06-15",
    amountCents: 100, name: "Changed", reviewReason: "plaid_modified",
  });
  return { checking, food, dining, coffee, link, exact, close, matchRow, newRow, reviewRow };
}

describe("TypeSafe suggestion HTTP parity", () => {
  let baseUrl: string;
  let stop: () => Promise<void>;
  let client: Client;
  let mock: Awaited<ReturnType<typeof startTypeSafeMock>>;
  let data: Awaited<ReturnType<typeof fixture>>;
  const path = () => `/api/b/1/sync/accounts/${data.link.id}/reconcile/suggestion`;

  beforeAll(async () => {
    await setupTestDatabase();
    mock = await startTypeSafeMock();
    ({ baseUrl, stop } = await startHttpTestServer({
      TYPESAFE_ENABLED: "true", TYPESAFE_API_KEY: " test-key ", TYPESAFE_API_URL: mock.url, TZ: "UTC",
    }));
  }, 120_000);

  beforeEach(async () => {
    await resetTestDatabase();
    client = await sessionHttpClient(baseUrl);
    mock.reset();
    data = await fixture();
    // The TypeScript library in this process is the reference.
    vi.stubEnv("TYPESAFE_ENABLED", "true");
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    vi.stubEnv("TYPESAFE_API_URL", mock.url);
  });

  afterEach(() => { vi.unstubAllEnvs(); });

  afterAll(async () => {
    await stop?.();
    await mock?.close();
  });

  it("asks once, sends the Node request body, and gives a result that the Node fingerprint accepts", async () => {
    const response = await client.request(path(), json("POST", { reconciliationId: data.matchRow.id }));
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toEqual({ status: "ready", evaluationId: expect.any(Number), revision: 2, transactionId: data.exact.id, proposal: null });
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0].authorization).toBe("Bearer test-key");
    expect(mock.requests[0].contentType).toBe("application/json");
    expect(mock.requests[0].body).toMatchSnapshot();

    const [stored] = await db.select().from(typesafeEvaluations);
    expect(stored).toMatchObject({
      status: "ready", choice: "candidate_1", errorCode: null, revision: 2, reconciliationId: data.matchRow.id,
      confidence: 1, usage: { input_tokens: 100, output_tokens: 3 },
      probabilities: { candidate_1: 1, none: 0 },
      answers: { match: { choice: "candidate_1", probabilities: { candidate_1: 1, none: 0 }, confidence: 1 } },
    });
    expect(stored.latencyMs).toEqual(expect.any(Number));
    expect(stored.snapshot).toMatchSnapshot({ effectiveDay: expect.any(String) });
    const [quota] = await db.select().from(typesafeQuotas);
    expect(quota.attempts).toBe(1);

    // The same input answers from the store, without a second request.
    expect(await (await client.request(path(), json("POST", { reconciliationId: data.matchRow.id }))).json()).toEqual(result);
    expect(mock.requests).toHaveLength(1);

    // The display recomputes the snapshot and must find the same fingerprint.
    const shown = await client.request(path(), json("PATCH", { evaluationId: result.evaluationId }));
    expect(shown.status).toBe(200);
    expect(await shown.json()).toEqual(result);
  });

  it("confirms a proposal as a new transaction", async () => {
    mock.pick({ payee: "new_from_merchant", category: "Food:Dining" });
    const made = await (await client.request(path(), json("POST", { reconciliationId: data.newRow.id }))).json();
    expect(made).toMatchObject({ status: "ready", transactionId: null, proposal: { payee: { name: "Zelle to jane@example.com CONF 99887766", payeeId: null }, category: { accountId: data.dining.id, name: "Food:Dining" } } });
    expect(mock.requests[0].body).toMatchSnapshot();
    const evaluationId = (made as { evaluationId: number }).evaluationId;

    const shown = await client.request(path(), json("PATCH", { evaluationId }));
    expect(shown.status).toBe(200);
    expect(await shown.json()).toEqual(made);
    const [displayed] = await db.select().from(typesafeEvaluations);
    expect(displayed.displayedAt).toBeInstanceOf(Date);

    const confirmed = await client.request(path(), json("PUT", { evaluationId, kind: "create", activeReviewMs: 4200 }));
    expect(confirmed.status).toBe(200);
    const item = await confirmed.json();
    expect(item).toMatchObject({ id: data.newRow.id, resolutionStatus: "created", matchedTransactionId: expect.any(Number) });
    const created = await db.select().from(transactions).where(eq(transactions.id, item.matchedTransactionId));
    const [payee] = await db.select().from(payees).where(eq(payees.id, created[0].payeeId!));
    expect(payee.name).toBe("Zelle to jane@example.com CONF 99887766");
    const splits = await db.select().from(transactionSplits).where(eq(transactionSplits.transactionId, item.matchedTransactionId)).orderBy(asc(transactionSplits.accountId));
    expect(splits.map((s) => [s.accountId, s.amount])).toEqual([[data.checking.id, -2500], [data.dining.id, 2500]]);
    expect(await db.select().from(typesafeDecisions)).toMatchObject([{
      action: "create", evaluationId, reconciliationId: data.newRow.id, transactionId: item.matchedTransactionId,
      suggestionVisible: true, acceptedSuggestion: true, proposalPayeeKept: true, proposalCategoryKept: true, activeReviewMs: 4200,
    }]);
  });

  it("confirms a match, recording the display time from the click", async () => {
    const { evaluationId } = await (await client.request(path(), json("POST", { reconciliationId: data.matchRow.id }))).json();
    const confirmed = await client.request(path(), json("PUT", { evaluationId }));
    expect(confirmed.status).toBe(200);
    expect(await confirmed.json()).toMatchObject({ id: data.matchRow.id, resolutionStatus: "matched", matchedTransactionId: data.exact.id });
    const [evaluation] = await db.select().from(typesafeEvaluations);
    expect(evaluation.displayedAt).toBeInstanceOf(Date);
    expect(await db.select().from(typesafeDecisions)).toMatchObject([{
      action: "match", transactionId: data.exact.id, suggestionVisible: true, acceptedSuggestion: true,
      proposalPayeeKept: null, proposalCategoryKept: null, activeReviewMs: null,
    }]);
    // The row is resolved now: the evaluation is stale.
    await expectError(client, path(), json("PUT", { evaluationId }), 409, "This TypeSafe suggestion is stale. Refresh and review the transaction again.");
  });

  it("stores provider failures, waits before a retry, and never acts on a bad response", async () => {
    mock.replies.push(() => ({ status: 429, body: "{}" }));
    const limited = await (await client.request(path(), json("POST", { reconciliationId: data.matchRow.id }))).json();
    expect(limited).toEqual({ status: "unavailable", evaluationId: expect.any(Number) });
    expect(await client.request(path(), json("POST", { reconciliationId: data.matchRow.id })).then((r) => r.json()))
      .toEqual(limited);
    expect(mock.requests).toHaveLength(1);
    const [row] = await db.select().from(typesafeEvaluations);
    expect(row).toMatchObject({ status: "error", errorCode: "rate_limited", choice: null, answers: null, usage: null });

    for (const [reply, code] of [
      [() => ({ status: 200, body: JSON.stringify({ model: "other", answers: {} }) }), "invalid_response"],
      [() => ({ status: 200, body: "not json" }), "invalid_response"],
      [() => ({ status: 500, body: "{}" }), "provider_error"],
      [(text: string) => typesafeReply({ body: text }).text().then((body) => ({ status: 200, body: body.replace('"none":0', '"none":0.5') })), "invalid_response"],
    ] as [Reply, string][]) {
      await db.update(typesafeEvaluations).set({ startedAt: new Date(Date.now() - 61_000) });
      mock.replies.push(reply);
      const result = await (await client.request(path(), json("POST", { reconciliationId: data.matchRow.id }))).json();
      expect(result).toEqual({ status: "unavailable", evaluationId: row.id });
      const [again] = await db.select().from(typesafeEvaluations);
      expect(again, code).toMatchObject({ status: "error", errorCode: code, answers: null });
    }
  });

  it("answers skipped, disabled, busy and limited without a request", async () => {
    const ask = async (reconciliationId: number) =>
      (await client.request(path(), json("POST", { reconciliationId }))).json();
    expect(await ask(data.reviewRow.id)).toEqual({ status: "skipped" });
    await db.insert(typesafeEvaluations).values({
      bookId: 1, reconciliationId: data.newRow.id, linkId: data.link.id, revision: 2, fingerprint: "other",
      attempt: "a", snapshot: {} as never, status: "pending", startedAt: new Date(),
    });
    expect(await ask(data.matchRow.id)).toEqual({ status: "busy" });
    await db.delete(typesafeEvaluations);
    await db.insert(typesafeQuotas).values({ bookId: 1, day: new Date().toISOString().slice(0, 10), attempts: 100 });
    expect(await ask(data.matchRow.id)).toEqual({ status: "limited" });
    await db.update(books).set({ typesafeReconciliationEnabled: false }).where(eq(books.id, 1));
    expect(await ask(data.matchRow.id)).toEqual({ status: "disabled" });
    expect(mock.requests).toHaveLength(0);
  });

  it("validates IDs, bodies and access, and refuses stale or unknown evaluations", async () => {
    for (const [p, message] of [
      ["/api/b/0/sync/accounts/1/reconcile/suggestion", "Invalid book or link ID"],
      ["/api/b/1/sync/accounts/01/reconcile/suggestion", "Invalid book or link ID"],
    ]) {
      await expectError(client, p, json("POST", { reconciliationId: 1 }), 400, message);
    }
    await expectError(client, path(), json("POST", "{"), 400, "Invalid JSON");
    for (const body of [{}, { reconciliationId: 0 }, { reconciliationId: 1.5 }, { reconciliationId: 1, extra: true }, [1], null]) {
      await expectError(client, path(), json("POST", body), 400, "Invalid reconciliation ID");
    }
    for (const body of [{}, { evaluationId: -1 }, { evaluationId: 1, kind: "match" }]) {
      await expectError(client, path(), json("PATCH", body), 400, "Invalid evaluation ID");
    }
    for (const body of [{ evaluationId: 1, kind: "ignore" }, { evaluationId: 1, activeReviewMs: 3_600_001 }, { evaluationId: 1, other: 1 }]) {
      await expectError(client, path(), json("PUT", body), 400, "Invalid evaluation ID");
    }
    await expectError(client, path(), json("POST", { reconciliationId: 999999 }), 404, "Reconciliation row not found");
    await expectError(client, "/api/b/1/sync/accounts/999999/reconcile/suggestion", json("POST", { reconciliationId: data.matchRow.id }), 404, "Linked sync account not found");
    await expectError(client, "/api/b/1/sync/accounts/99999999999/reconcile/suggestion", json("POST", { reconciliationId: data.matchRow.id }), 503, "TypeSafe is temporarily unavailable");
    await expectError(client, path(), json("PATCH", { evaluationId: 999999 }), 409, "This TypeSafe suggestion is stale. Refresh and review the transaction again.");
    await expectError(client, path(), json("PUT", { evaluationId: 999999 }), 409, "This TypeSafe suggestion is stale. Refresh and review again.");

    // A match evaluation has no proposal to create; a changed row makes it stale.
    const { evaluationId } = await (await client.request(path(), json("POST", { reconciliationId: data.matchRow.id }))).json();
    await expectError(client, path(), json("PUT", { evaluationId, kind: "create" }), 409, "This TypeSafe suggestion has no new transaction to create.");
    await db.update(plaidTransactionReconciliation).set({ name: "Changed name" }).where(eq(plaidTransactionReconciliation.id, data.matchRow.id));
    await expectError(client, path(), json("PATCH", { evaluationId }), 409, "This TypeSafe suggestion is stale. Refresh and review the transaction again.");

    const owner = await createUser({ username: "owner" });
    const shared = await createBook({ name: "Shared", userId: owner.id });
    await addBookMember({ bookId: shared.id, userId: 1, role: "viewer" });
    await expectError(client, `/api/b/${shared.id}/sync/accounts/1/reconcile/suggestion`, json("POST", { reconciliationId: 1 }), 403, "You have read-only access to this book");
    await expectError(client, "/api/b/999999/sync/accounts/1/reconcile/suggestion", json("POST", { reconciliationId: 1 }), 404, "Book not found");
  });
});
