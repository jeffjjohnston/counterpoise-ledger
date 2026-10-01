import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { summarizeTypeSafe } from "../../lib/typesafe/report";
import type { MatchSnapshot } from "../../lib/typesafe/types";
import type { TypeSafeDecision, TypeSafeEvaluation } from "../../types/db";
import {
  addBookMember, createBook, createUser, resetTestDatabase, setupTestDatabase,
} from "../helpers/db-utils";
import { sessionHttpClient, startHttpTestServer } from "../helpers/http-parity";
import { insert, insertRows, rows, scalar } from "../helpers/sql";

type Client = Awaited<ReturnType<typeof sessionHttpClient>>;
const SETTINGS = "/api/b/1/settings/typesafe";
const CLEANUP = "/api/cron/typesafe-cleanup";
const DAY = 86_400_000;

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) };
}

async function expectError(client: Client, path: string, init: RequestInit, status: number, error: string) {
  const response = await client.request(path, init);
  expect(response.status, `${init.method ?? "GET"} ${path} ${String(init.body)}`).toBe(status);
  expect(await response.json()).toEqual({ error });
}

const pick = (choice: string) => ({ choice, probabilities: { [choice]: 1 }, confidence: 1 });

function snapshot(overrides: Partial<MatchSnapshot> = {}): MatchSnapshot {
  return {
    bookId: 1,
    linkId: 1,
    reconciliationId: 1,
    revision: 0,
    mappedAccountId: 1,
    effectiveDay: "2026-08-01",
    model: "jev-1.13.0",
    promptVersion: "plaid-match-v3",
    merchantSeenBefore: false,
    bank: { merchant: "Example", name: "Example", amountCents: -100, authorizedDate: null, postedDate: "2026-08-01", currency: "USD" },
    baselineIds: [],
    candidates: [],
    ...overrides,
  };
}

const proposalSnapshot = snapshot({
  payeeOptions: [{ label: "payee_1", payeeId: 3, name: "X", source: "existing" }],
  categoryOptions: [{ label: "category_1", accountId: 7, name: "Food", kind: "expense" }],
  baselineCategoryId: 7,
});
const matchSnapshot = snapshot({
  merchantSeenBefore: true,
  baselineIds: [41, 42],
  candidates: [
    { label: "candidate_1", transactionId: 42, payee: "X", date: "2026-08-01", amountCents: -100, counterpartAccounts: [] },
    { label: "candidate_2", transactionId: 43, payee: "Y", date: "2026-08-02", amountCents: -100, counterpartAccounts: [] },
  ],
});

let sequence = 0;
async function evaluation(values: Partial<TypeSafeEvaluation>) {
  sequence += 1;
  return insert<TypeSafeEvaluation>("typesafe_evaluations", {
    bookId: 1,
    reconciliationId: sequence,
    linkId: 1,
    revision: 0,
    fingerprint: `f${sequence}`,
    attempt: `a${sequence}`,
    snapshot: snapshot(),
    status: "ready",
    startedAt: new Date(Date.now() - 40 * DAY),
    ...values,
  });
}

async function decision(evaluationId: number, values: Partial<TypeSafeDecision>) {
  await insert("typesafe_decisions", {
    bookId: 1,
    reconciliationId: 1,
    evaluationId,
    action: "create",
    suggestionVisible: true,
    decidedAt: new Date(Date.now() - 39 * DAY),
    ...values,
  });
}

describe("TypeSafe settings and cleanup HTTP parity", () => {
  let baseUrl: string;
  let stop: () => Promise<void>;
  let client: Client;

  beforeAll(async () => {
    await setupTestDatabase();
    ({ baseUrl, stop } = await startHttpTestServer({
      TYPESAFE_ENABLED: "true", TYPESAFE_API_KEY: "test-key", CRON_SECRET: "test-cron-secret",
    }));
  }, 120_000);

  beforeEach(async () => {
    await resetTestDatabase();
    client = await sessionHttpClient(baseUrl);
    sequence = 0;
  });

  afterAll(async () => { await stop?.(); });

  it("reads, turns on and off, and clears the book's settings", async () => {
    const read = await client.request(SETTINGS);
    expect(read.status).toBe(200);
    expect(read.headers.get("cache-control")).toBe("no-store");
    expect(await read.text()).toBe('{"enabled":false,"revision":0,"configured":true}');

    const pending = await evaluation({ status: "pending", startedAt: new Date() });
    const on = await client.request(SETTINGS, json("PATCH", { enabled: true }));
    expect(await on.json()).toEqual({ enabled: true, revision: 1, configured: true });
    expect(await scalar("SELECT status FROM typesafe_evaluations WHERE id = $1", [pending.id])).toBe("stale");
    // No change of state: the revision stays.
    expect(await (await client.request(SETTINGS, json("PATCH", { enabled: true }))).json())
      .toEqual({ enabled: true, revision: 1, configured: true });
    expect(await (await client.request(SETTINGS, json("PATCH", { enabled: false }))).json())
      .toEqual({ enabled: false, revision: 2, configured: true });

    const kept = await evaluation({ startedAt: new Date() });
    await decision(kept.id, {});
    await insert("typesafe_aggregates", { bookId: 1, counts: { evaluations: 3 } });
    const today = new Date().toISOString().slice(0, 10);
    await insert("typesafe_quotas", { bookId: 1, day: today, attempts: 4 });
    const other = await createBook({ name: "Other" });
    await evaluation({ bookId: other.id });

    const cleared = await client.request(SETTINGS, { method: "DELETE" });
    expect(await cleared.json()).toEqual({ enabled: false, revision: 3, configured: true });
    expect(await rows("SELECT * FROM typesafe_evaluations ORDER BY id")).toMatchObject([{ bookId: other.id }]);
    expect(await rows("SELECT * FROM typesafe_decisions ORDER BY id")).toEqual([]);
    expect(await rows("SELECT * FROM typesafe_aggregates ORDER BY book_id")).toEqual([]);
    expect(await rows("SELECT * FROM typesafe_quotas ORDER BY book_id, day")).toMatchObject([{ bookId: 1, day: today, attempts: 4 }]);
  });

  it("validates the ID and the body, and enforces the access level", async () => {
    for (const id of ["0", "01", "abc", "1.5"]) {
      await expectError(client, `/api/b/${id}/settings/typesafe`, {}, 400, "Invalid book ID");
    }
    await expectError(client, "/api/b/99999999999/settings/typesafe", {}, 503, "TypeSafe is temporarily unavailable");
    await expectError(client, SETTINGS, json("PATCH", "{"), 400, "Invalid JSON");
    for (const body of [{ enabled: "yes" }, { enabled: true, extra: 1 }, {}, null, [true]]) {
      await expectError(client, SETTINGS, json("PATCH", body), 400, "Expected enabled: true or false");
    }
    expect(await scalar("SELECT typesafe_revision FROM books WHERE id = $1", [1])).toBe(0);

    await expectError(client, "/api/b/999999/settings/typesafe", {}, 404, "Book not found");
    const owner = await createUser({ username: "owner" });
    const shared = await createBook({ name: "Shared", userId: owner.id });
    await addBookMember({ bookId: shared.id, userId: 1, role: "viewer" });
    const path = `/api/b/${shared.id}/settings/typesafe`;
    expect((await client.request(path)).status).toBe(200);
    await expectError(client, path, json("PATCH", { enabled: true }), 403, "You have read-only access to this book");
    await expectError(client, path, { method: "DELETE" }, 403, "You have read-only access to this book");
    expect((await client.anonymous(SETTINGS)).status).toBe(401);
  });

  it("refuses to turn on an installation without a key", async () => {
    const plain = await startHttpTestServer({ TYPESAFE_ENABLED: "false", TYPESAFE_API_KEY: "" });
    try {
      const unconfigured = await sessionHttpClient(plain.baseUrl);
      expect(await (await unconfigured.request(SETTINGS)).json()).toEqual({ enabled: false, revision: 0, configured: false });
      await expectError(unconfigured, SETTINGS, json("PATCH", { enabled: true }), 409, "TypeSafe is unavailable on this installation");
      expect(await (await unconfigured.request(SETTINGS, json("PATCH", { enabled: false }))).json())
        .toEqual({ enabled: false, revision: 0, configured: false });
    } finally {
      await plain.stop();
    }
  }, 120_000);

  it("requires the cron secret before it deletes anything", async () => {
    await evaluation({});
    for (const headers of [{}, { authorization: "Bearer wrong" }, { authorization: "bearer test-cron-secret" }] as Record<string, string>[]) {
      const response = await client.anonymous(CLEANUP, { headers });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "Unauthorized" });
    }
    expect(await rows("SELECT * FROM typesafe_evaluations ORDER BY id")).toHaveLength(1);
  });

  it("archives the counts of expired evaluations per book, then deletes them and old quotas", async () => {
    const other = await createBook({ name: "Other" });
    // Proposals with each kind of outcome, as in the report tests.
    const oneClick = await evaluation({ snapshot: proposalSnapshot, answers: { payee: pick("payee_1"), category: pick("category_1") }, displayedAt: new Date(Date.now() - 40 * DAY), latencyMs: 900 });
    await decision(oneClick.id, { acceptedSuggestion: true, proposalPayeeKept: true, proposalCategoryKept: true, activeReviewMs: 1200 });
    const edited = await evaluation({ snapshot: proposalSnapshot, answers: { payee: pick("payee_1"), category: pick("category_1") } });
    await decision(edited.id, { proposalPayeeKept: false, proposalCategoryKept: false });
    const ignored = await evaluation({ snapshot: { ...proposalSnapshot, baselineCategoryId: 8 }, answers: { payee: pick("payee_1"), category: pick("category_1") } });
    await decision(ignored.id, { action: "ignore" });
    // Matches: Jev agrees with the user, then an unlink; the user picks outside the candidates after none.
    const agreed = await evaluation({ snapshot: matchSnapshot, choice: "candidate_1", answers: { match: pick("candidate_1") }, usage: { input_tokens: 120, output_tokens: 8 } });
    await decision(agreed.id, { action: "match", transactionId: 42 });
    await decision(agreed.id, { action: "unlink", transactionId: 42, suggestionVisible: false, decidedAt: new Date(Date.now() - 38 * DAY) });
    const none = await evaluation({ snapshot: matchSnapshot, choice: "none", answers: { match: pick("none") } });
    await decision(none.id, { action: "match", transactionId: 99, suggestionVisible: false });
    await evaluation({ status: "error", errorCode: "timeout", latencyMs: 5000 });
    await evaluation({ status: "skipped", snapshot: matchSnapshot });
    const elsewhere = await evaluation({ bookId: other.id, snapshot: matchSnapshot, choice: "candidate_2", answers: { match: pick("candidate_2") } });
    await decision(elsewhere.id, { bookId: other.id, action: "match", transactionId: 41 });
    const recent = await evaluation({ startedAt: new Date() });
    await insert("typesafe_aggregates", { bookId: 1, counts: { evaluations: 5, ui_decisions: 2, legacy_key: 1 } });
    const oldDay = new Date(Date.now() - 31 * DAY).toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    await insertRows("typesafe_quotas", [
      { bookId: 1, day: oldDay, attempts: 2 },
      { bookId: 1, day: today, attempts: 3 },
    ]);

    // The TypeScript summary of the same rows is the expected result.
    const expired = await rows<TypeSafeEvaluation>("SELECT * FROM typesafe_evaluations ORDER BY id");
    const decisions = await rows<TypeSafeDecision>("SELECT * FROM typesafe_decisions ORDER BY id");
    const expected = (bookId: number, archived: Record<string, number>) => {
      const rows = expired.filter((row) => row.bookId === bookId && row.id !== recent.id);
      const counts = { ...archived };
      for (const [key, value] of Object.entries(summarizeTypeSafe(rows, decisions))) counts[key] = (counts[key] ?? 0) + value;
      return counts;
    };
    const book1 = expected(1, { evaluations: 5, ui_decisions: 2, legacy_key: 1 });
    const book2 = expected(other.id, {});
    expect(book1).toMatchObject({ proposal_one_click_creates: 1, jev_agrees_with_user: 1, none_followed_by_manual_match: 1, status_error: 1 });

    const response = await client.anonymous(CLEANUP, { headers: { authorization: "Bearer test-cron-secret" } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: 8, batchLimit: 1000 });
    const aggregates = await rows("SELECT * FROM typesafe_aggregates ORDER BY book_id");
    expect(aggregates).toEqual([{ bookId: 1, counts: book1 }, { bookId: other.id, counts: book2 }]);
    expect(await rows("SELECT id FROM typesafe_evaluations ORDER BY id")).toEqual([{ id: recent.id }]);
    expect(await rows("SELECT * FROM typesafe_decisions ORDER BY id")).toEqual([]);
    expect(await rows("SELECT * FROM typesafe_quotas ORDER BY book_id, day")).toMatchObject([{ bookId: 1, day: today, attempts: 3 }]);

    // A second run finds nothing more to archive.
    const again = await client.anonymous(CLEANUP, { headers: { authorization: "Bearer test-cron-secret" } });
    expect(await again.json()).toEqual({ deleted: 0, batchLimit: 1000 });
  });
});
