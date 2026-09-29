import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { plaidAccounts, plaidTokens, plaidTransactionReconciliation } from "../../db/schema";
import {
  addBookMember, createAccount, createBook, createPlaidAccount, createPlaidReconciliation,
  createPlaidToken, createUser, db, resetTestDatabase, setupTestDatabase,
} from "../helpers/db-utils";
import { sessionHttpClient, startHttpTestServer } from "../helpers/http-parity";

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

type Client = Awaited<ReturnType<typeof sessionHttpClient>>;

async function expectError(client: Client, path: string, init: RequestInit, status: number, error: string) {
  const response = await client.request(path, init);
  expect(response.status, `${init.method ?? "GET"} ${path} ${String(init.body)}`).toBe(status);
  expect(await response.json()).toEqual({ error });
}

async function ok(client: Client, path: string, init?: RequestInit) {
  const response = await client.request(path, init);
  expect(response.status, `${init?.method ?? "GET"} ${path}`).toBe(200);
  return response.json();
}

const PLAID = { PLAID_CLIENT_ID: "client-id", PLAID_SECRET: "plaid-secret", PLAID_ENV: "sandbox" };

/**
 * The replies of the Plaid mock to /accounts/get, by access token. An unknown
 * token is a Plaid error. The server may not call the real API.
 */
const ACCOUNTS_REPLIES: Record<string, { status: number; body?: unknown; raw?: string }> = {
  "access-refresh": {
    status: 200,
    body: {
      accounts: [
        { account_id: "keep", name: "Checking Updated", official_name: null, mask: "1111", type: "depository", subtype: "checking" },
        { account_id: "new", name: "Savings", official_name: "Plaid Savings", mask: 22, type: "depository" },
      ],
      item: { item_id: "item-refresh" },
    },
  },
  "access-empty": { status: 200, body: { accounts: [] } },
  "access-plaid-error": {
    status: 400,
    body: { error_message: "invalid access token", error_code: "INVALID_ACCESS_TOKEN", error_type: "INVALID_INPUT" },
  },
  "access-no-message": { status: 500, body: { error_code: "INTERNAL_SERVER_ERROR" } },
  "access-not-json": { status: 503, raw: "Service Unavailable" },
  "access-bad-payload": { status: 200, body: { accounts: "none" } },
  "access-null-body": { status: 200, body: null },
  "access-null-account": { status: 200, body: { accounts: [null] } },
};

async function startPlaidMock(): Promise<{ url: string; requests: unknown[]; server: Server }> {
  const requests: unknown[] = [];
  const server = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk) => { text += chunk; });
    request.on("end", () => {
      const body = JSON.parse(text) as { access_token?: string };
      requests.push({ path: request.url, body });
      const reply = request.url === "/accounts/get" && body.access_token
        ? ACCOUNTS_REPLIES[body.access_token]
        : undefined;
      const { status, body: replyBody, raw } = reply ?? {
        status: 400,
        body: { error_message: "unknown access token", error_code: "INVALID_ACCESS_TOKEN" },
      };
      response.writeHead(status, { "content-type": "application/json" });
      response.end(raw ?? JSON.stringify(replyBody));
    });
  });
  await new Promise<void>((resolveReady) => server.listen(0, "127.0.0.1", () => resolveReady()));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, requests, server };
}

/** A book that user 1 can read or edit but does not own. */
async function sharedBook(role: "editor" | "viewer") {
  const owner = await createUser({ username: `owner-${role}` });
  // createBook makes the owner a member.
  const book = await createBook({ name: `Shared ${role}`, userId: owner.id });
  await addBookMember({ bookId: book.id, userId: 1, role });
  return book;
}

beforeAll(async () => {
  await setupTestDatabase();
}, 120_000);

describe("Plaid connection HTTP parity", () => {
  let baseUrl: string;
  let stop: () => Promise<void>;
  let client: Client;
  let plaid: Awaited<ReturnType<typeof startPlaidMock>>;

  beforeAll(async () => {
    plaid = await startPlaidMock();
    ({ baseUrl, stop } = await startHttpTestServer({ ...PLAID, PLAID_API_URL: plaid.url }));
  }, 120_000);
  beforeEach(async () => {
    await resetTestDatabase();
    client = await sessionHttpClient(baseUrl);
    plaid.requests.length = 0;
  });
  afterAll(async () => {
    await stop?.();
    await new Promise((resolveClosed) => plaid?.server.close(resolveClosed));
  });

  it("lists the connections of the book with masked tokens and account counts", async () => {
    const zeta = await createPlaidToken({ financialInstitution: "Zeta Bank", itemId: "item-z", accessToken: "access-sandbox-123456789" });
    const alphaB = await createPlaidToken({ financialInstitution: "Alpha", itemId: "item-b", accessToken: "short" });
    const alphaA = await createPlaidToken({ financialInstitution: "Alpha", itemId: "item-a", accessToken: "123456789" });
    const stranger = await createUser({ username: "stranger" });
    const other = await createBook({ name: "Other", userId: stranger.id });
    const foreign = await createPlaidToken({ financialInstitution: "Foreign", itemId: "item-f", accessToken: "foreign-token", bookId: other.id });
    await createPlaidAccount({ tokenId: foreign.id, plaidAccountId: "foreign", name: "F", type: "depository", bookId: other.id });
    const checking = await createAccount({ name: "Checking", type: "asset" });
    await createPlaidAccount({ tokenId: zeta.id, plaidAccountId: "z1", name: "Z1", type: "depository", counterpoiseAccountId: checking.id });
    await createPlaidAccount({ tokenId: zeta.id, plaidAccountId: "z2", name: "Z2", type: "depository" });

    const item = (token: typeof zeta, masked: string, total: number, mapped: number) => ({
      id: token.id, financialInstitution: token.financialInstitution, itemId: token.itemId,
      accessTokenMasked: masked, createdAt: token.createdAt.toISOString(),
      updatedAt: token.updatedAt.toISOString(), totalAccountCount: total, mappedAccountCount: mapped,
    });
    expect(await ok(client, "/api/b/1/sync/tokens")).toEqual([
      item(alphaA, "1234********6789", 0, 0),
      item(alphaB, "*****", 0, 0),
      item(zeta, "acce****************6789", 2, 1),
    ]);
    await expectError(client, `/api/b/${other.id}/sync/tokens`, {}, 404, "Book not found");
  });

  it("creates a connection and refuses a duplicate or malformed one", async () => {
    const created = await ok(client, "/api/b/1/sync/tokens", json("POST", {
      financialInstitution: "  Chase ", itemId: "\titem-1\n", accessToken: " access-sandbox-123456789 ", bookId: 7,
    }));
    const [stored] = await db.select().from(plaidTokens);
    expect(stored).toMatchObject({ bookId: 1, financialInstitution: "Chase", itemId: "item-1", accessToken: "access-sandbox-123456789", isDemo: false });
    expect(created).toEqual({
      id: stored.id, financialInstitution: "Chase", itemId: "item-1",
      accessTokenMasked: "acce****************6789",
      createdAt: stored.createdAt.toISOString(), updatedAt: stored.updatedAt.toISOString(),
    });
    expect(Math.abs(Date.parse(created.createdAt) - Date.now())).toBeLessThan(60_000);

    const post = (body: unknown) => json("POST", body);
    await expectError(client, "/api/b/1/sync/tokens", post({ financialInstitution: "Other", itemId: "item-1", accessToken: "t" }), 409, "A token with this itemId already exists");
    // Item IDs are unique across books; the check covers only this book.
    const other = await createBook({ name: "Other" });
    await createPlaidToken({ financialInstitution: "Elsewhere", itemId: "item-elsewhere", accessToken: "t", bookId: other.id });
    await expectError(client, "/api/b/1/sync/tokens", post({ financialInstitution: "X", itemId: "item-elsewhere", accessToken: "t" }), 500, "Failed to create sync token");

    const required = "financialInstitution, itemId, and accessToken are required";
    for (const body of [
      null, [], "abc", 5, true, {},
      { financialInstitution: "Chase", itemId: "item-2" },
      { financialInstitution: "", itemId: "item-2", accessToken: "t" },
      { financialInstitution: "Chase", itemId: "  ﻿", accessToken: "t" },
      { financialInstitution: "Chase", itemId: 5, accessToken: "t" },
      { financialInstitution: ["Chase"], itemId: "item-2", accessToken: "t" },
    ]) {
      await expectError(client, "/api/b/1/sync/tokens", post(body), 400, required);
    }
    await expectError(client, "/api/b/1/sync/tokens", { method: "POST", body: "{" }, 500, "Failed to create sync token");
    expect(await db.select().from(plaidTokens).where(eq(plaidTokens.bookId, 1))).toHaveLength(1);
  });

  it("updates a connection and keeps the access token unless a new one is sent", async () => {
    const token = await createPlaidToken({ financialInstitution: "Old Bank", itemId: "item-old", accessToken: "old-access-token" });
    await createPlaidToken({ financialInstitution: "B", itemId: "item-b", accessToken: "token-b" });
    const path = `/api/b/1/sync/tokens/${token.id}`;

    const kept = await ok(client, path, json("PUT", { financialInstitution: " New Bank ", itemId: "item-new", accessToken: "  " }));
    let [stored] = await db.select().from(plaidTokens).where(eq(plaidTokens.id, token.id));
    expect(stored).toMatchObject({ financialInstitution: "New Bank", itemId: "item-new", accessToken: "old-access-token" });
    expect(kept).toEqual({
      id: token.id, financialInstitution: "New Bank", itemId: "item-new", accessTokenMasked: "old-********oken",
      createdAt: token.createdAt.toISOString(), updatedAt: stored.updatedAt.toISOString(),
    });
    expect(stored.updatedAt.getTime()).toBeGreaterThanOrEqual(token.updatedAt.getTime());

    for (const accessToken of [5, null, ""]) {
      await ok(client, path, json("PUT", { financialInstitution: "New Bank", itemId: "item-new", accessToken }));
    }
    await ok(client, path, json("PUT", { financialInstitution: "New Bank", itemId: "item-new", accessToken: " replaced-token " }));
    [stored] = await db.select().from(plaidTokens).where(eq(plaidTokens.id, token.id));
    expect(stored.accessToken).toBe("replaced-token");

    await expectError(client, path, json("PUT", { financialInstitution: "A", itemId: "item-b" }), 409, "A token with this itemId already exists");
    const required = "financialInstitution and itemId are required";
    for (const body of [null, [], "x", {}, { financialInstitution: "A" }, { financialInstitution: "A", itemId: " " }]) {
      await expectError(client, path, json("PUT", body), 400, required);
    }
    await expectError(client, path, { method: "PUT", body: "not json" }, 500, "Failed to update sync token");

    const other = await createBook({ name: "Other" });
    const foreign = await createPlaidToken({ financialInstitution: "F", itemId: "item-f", accessToken: "t", bookId: other.id });
    const valid = json("PUT", { financialInstitution: "A", itemId: "item-a" });
    await expectError(client, `/api/b/1/sync/tokens/${foreign.id}`, valid, 404, "Token not found");
    await expectError(client, "/api/b/1/sync/tokens/abc", valid, 400, "Invalid token id");
    // The ID is checked first, the body second, and the int4 range only when
    // a query binds the ID.
    await expectError(client, "/api/b/1/sync/tokens/abc", json("PUT", {}), 400, "Invalid token id");
    await expectError(client, "/api/b/1/sync/tokens/3000000000", json("PUT", {}), 400, required);
    await expectError(client, "/api/b/1/sync/tokens/3000000000", valid, 500, "Failed to update sync token");
    await expectError(client, `/api/b/1/sync/tokens/${"9".repeat(400)}`, valid, 400, "Invalid token id");
  });

  it("deletes a connection with its account mappings", async () => {
    const token = await createPlaidToken({ financialInstitution: "AmEx", itemId: "item-456", accessToken: "access-token" });
    const link = await createPlaidAccount({ tokenId: token.id, plaidAccountId: "pa-1", name: "Card", type: "credit" });
    await createPlaidReconciliation({ plaidAccountLinkId: link.id, plaidTransactionId: "t1", date: "2025-01-01", amountCents: 1, name: "X" });
    const path = `/api/b/1/sync/tokens/${token.id}`;
    expect(await ok(client, path, { method: "DELETE" })).toEqual({ success: true });
    expect(await db.select().from(plaidAccounts)).toEqual([]);
    expect(await db.select().from(plaidTransactionReconciliation)).toEqual([]);
    await expectError(client, path, { method: "DELETE" }, 404, "Token not found");
    await expectError(client, "/api/b/1/sync/tokens/x1", { method: "DELETE" }, 400, "Invalid token id");
    await expectError(client, "/api/b/1/sync/tokens/-3000000000", { method: "DELETE" }, 500, "Failed to delete sync token");
  });

  it("allows only an owner to change connections", async () => {
    for (const role of ["editor", "viewer"] as const) {
      const book = await sharedBook(role);
      const token = await createPlaidToken({ financialInstitution: "Bank", itemId: `item-${role}`, accessToken: "access-token", bookId: book.id });
      const base = `/api/b/${book.id}/sync/tokens`;
      const owner = "Only an owner can do this";
      await expectError(client, base, json("POST", { financialInstitution: "A", itemId: "b", accessToken: "c" }), 403, owner);
      await expectError(client, `${base}/${token.id}`, json("PUT", { financialInstitution: "A", itemId: "b" }), 403, owner);
      await expectError(client, `${base}/${token.id}`, { method: "DELETE" }, 403, owner);
      await expectError(client, `${base}/${token.id}/accounts`, json("PUT", { assignments: [] }), 403, owner);
      expect(await ok(client, base)).toHaveLength(1);
      expect(await ok(client, `${base}/${token.id}/accounts`)).toEqual([]);
    }
    await expectError(client, "/api/b/999999/sync/tokens", {}, 404, "Book not found");
    expect((await client.anonymous("/api/b/1/sync/tokens")).status).toBe(401);
  });

  it("lists the accounts of a connection and refreshes them from Plaid", async () => {
    const token = await createPlaidToken({ financialInstitution: "Chase", itemId: "item-refresh", accessToken: "access-refresh" });
    const checking = await createAccount({ name: "Checking", type: "asset" });
    await createPlaidAccount({ tokenId: token.id, plaidAccountId: "remove", name: "Old Savings", type: "depository", subtype: "savings" });
    await createPlaidAccount({ tokenId: token.id, plaidAccountId: "keep", name: "Checking", type: "depository", subtype: "checking", mask: "0000", counterpoiseAccountId: checking.id });
    const path = `/api/b/1/sync/tokens/${token.id}/accounts`;

    const cached = [
      { plaidAccountId: "keep", name: "Checking", officialName: null, mask: "0000", type: "depository", subtype: "checking", counterpoiseAccountId: checking.id },
      { plaidAccountId: "remove", name: "Old Savings", officialName: null, mask: null, type: "depository", subtype: "savings", counterpoiseAccountId: null },
    ];
    expect(await ok(client, path)).toEqual(cached);
    expect(await ok(client, `${path}?refresh=TRUE&refresh=true`)).toEqual(cached);
    expect(plaid.requests).toEqual([]);

    expect(await ok(client, `${path}?refresh=true`)).toEqual([
      { plaidAccountId: "keep", name: "Checking Updated", officialName: null, mask: "1111", type: "depository", subtype: "checking", counterpoiseAccountId: checking.id },
      { plaidAccountId: "new", name: "Savings", officialName: "Plaid Savings", mask: "22", type: "depository", subtype: null, counterpoiseAccountId: null },
    ]);
    expect(plaid.requests).toEqual([{
      path: "/accounts/get",
      body: { client_id: "client-id", secret: "plaid-secret", access_token: "access-refresh" },
    }]);
    const stored = await db.select().from(plaidAccounts).orderBy(asc(plaidAccounts.plaidAccountId));
    expect(stored.map((row) => [row.plaidAccountId, row.bookId, row.tokenId])).toEqual([["keep", 1, token.id], ["new", 1, token.id]]);

    await db.update(plaidTokens).set({ accessToken: "access-empty" }).where(eq(plaidTokens.id, token.id));
    expect(await ok(client, `${path}?refresh=true`)).toEqual([]);

    const other = await createBook({ name: "Other" });
    const foreign = await createPlaidToken({ financialInstitution: "F", itemId: "item-f", accessToken: "access-refresh", bookId: other.id });
    await expectError(client, `/api/b/1/sync/tokens/${foreign.id}/accounts?refresh=true`, {}, 404, "Token not found");
    await expectError(client, "/api/b/1/sync/tokens/none/accounts", {}, 400, "Invalid token id");
    await expectError(client, "/api/b/1/sync/tokens/3000000000/accounts", {}, 500, "Failed to fetch token Plaid accounts");
  });

  it("reports a failed refresh as Plaid's and keeps the stored accounts", async () => {
    const token = await createPlaidToken({ financialInstitution: "Chase", itemId: "item-fail", accessToken: "access-plaid-error" });
    await createPlaidAccount({ tokenId: token.id, plaidAccountId: "stays", name: "Checking", type: "depository" });
    const path = `/api/b/1/sync/tokens/${token.id}/accounts?refresh=true`;
    for (const [accessToken, error] of [
      ["access-plaid-error", "Plaid /accounts/get request failed: invalid access token (INVALID_ACCESS_TOKEN)"],
      ["access-no-message", "Plaid /accounts/get request failed"],
      ["access-not-json", "Plaid /accounts/get request failed"],
      ["access-bad-payload", "Plaid /accounts/get returned an invalid accounts payload"],
      ["access-null-body", "Cannot read properties of null (reading 'accounts')"],
      ["access-null-account", "Cannot read properties of null (reading 'account_id')"],
    ]) {
      await db.update(plaidTokens).set({ accessToken }).where(eq(plaidTokens.id, token.id));
      await expectError(client, path, {}, 502, error);
    }
    expect((await db.select().from(plaidAccounts)).map((row) => row.plaidAccountId)).toEqual(["stays"]);
  });

  it("maps the accounts of a connection, swaps two mappings, and clears one", async () => {
    const token = await createPlaidToken({ financialInstitution: "Chase", itemId: "item-map", accessToken: "t" });
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const card = await createAccount({ name: "Card", type: "liability" });
    await createPlaidAccount({ tokenId: token.id, plaidAccountId: "pa-checking", name: "B Checking", type: "depository" });
    await createPlaidAccount({ tokenId: token.id, plaidAccountId: "pa-card", name: "A Card", type: "credit" });
    await createPlaidAccount({ tokenId: token.id, plaidAccountId: "pa-other", name: "C Other", type: "depository", counterpoiseAccountId: null });
    const path = `/api/b/1/sync/tokens/${token.id}/accounts`;
    const row = (plaidAccountId: string, name: string, type: string, counterpoiseAccountId: number | null) => ({
      plaidAccountId, name, officialName: null, mask: null, type, subtype: null, counterpoiseAccountId,
    });

    expect(await ok(client, path, json("PUT", { assignments: [
      { plaidAccountId: " pa-checking ", counterpoiseAccountId: checking.id, extra: true },
      { plaidAccountId: "pa-card", counterpoiseAccountId: card.id },
    ] }))).toEqual([
      row("pa-card", "A Card", "credit", card.id),
      row("pa-checking", "B Checking", "depository", checking.id),
      row("pa-other", "C Other", "depository", null),
    ]);
    // A swap collides with the unique index unless every touched mapping is
    // cleared first.
    expect(await ok(client, path, json("PUT", { assignments: [
      { plaidAccountId: "pa-checking", counterpoiseAccountId: card.id },
      { plaidAccountId: "pa-card", counterpoiseAccountId: checking.id },
    ] }))).toEqual([
      row("pa-card", "A Card", "credit", checking.id),
      row("pa-checking", "B Checking", "depository", card.id),
      row("pa-other", "C Other", "depository", null),
    ]);
    expect(await ok(client, path, json("PUT", { assignments: [{ plaidAccountId: "pa-card", counterpoiseAccountId: null }] }))).toEqual([
      row("pa-card", "A Card", "credit", null),
      row("pa-checking", "B Checking", "depository", card.id),
      row("pa-other", "C Other", "depository", null),
    ]);
    expect(await ok(client, path, json("PUT", { assignments: [] }))).toHaveLength(3);
  });

  it("refuses an assignment with the Node message and writes nothing", async () => {
    const token = await createPlaidToken({ financialInstitution: "Chase", itemId: "item-refuse", accessToken: "t" });
    const otherToken = await createPlaidToken({ financialInstitution: "Other", itemId: "item-other", accessToken: "t" });
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const mapped = await createAccount({ name: "Mapped", type: "asset" });
    const food = await createAccount({ name: "Food", type: "expense" });
    const otherBook = await createBook({ name: "Other" });
    const foreign = await createAccount({ name: "Foreign", type: "asset", bookId: otherBook.id });
    const link = await createPlaidAccount({ tokenId: token.id, plaidAccountId: "pa-1", name: "Checking", type: "depository" });
    await createPlaidAccount({ tokenId: token.id, plaidAccountId: "pa-2", name: "Savings", type: "depository" });
    await createPlaidAccount({ tokenId: otherToken.id, plaidAccountId: "pa-x", name: "X", type: "depository", counterpoiseAccountId: mapped.id });
    const path = `/api/b/1/sync/tokens/${token.id}/accounts`;
    const put = (assignments: unknown) => json("PUT", { assignments });

    for (const [body, error] of [
      [null, "assignments must be an array"],
      [[], "assignments must be an array"],
      [{}, "assignments must be an array"],
      [{ assignments: "not-an-array" }, "assignments must be an array"],
      [{ assignments: [null] }, "Each assignment must include plaidAccountId"],
      [{ assignments: ["pa-1"] }, "Each assignment must include plaidAccountId"],
      [{ assignments: [{ plaidAccountId: "  ", counterpoiseAccountId: null }] }, "Each assignment must include plaidAccountId"],
      [{ assignments: [{ plaidAccountId: 5, counterpoiseAccountId: 1 }] }, "Each assignment must include plaidAccountId"],
      [{ assignments: [{ plaidAccountId: "pa-1" }] }, "counterpoiseAccountId must be a positive integer or null"],
      [{ assignments: [{ plaidAccountId: "pa-1", counterpoiseAccountId: "1" }] }, "counterpoiseAccountId must be a positive integer or null"],
      [{ assignments: [{ plaidAccountId: "pa-1", counterpoiseAccountId: 0 }] }, "counterpoiseAccountId must be a positive integer or null"],
      [{ assignments: [{ plaidAccountId: "pa-1", counterpoiseAccountId: 1.5 }] }, "counterpoiseAccountId must be a positive integer or null"],
      [{ assignments: [{ plaidAccountId: "pa-1", counterpoiseAccountId: 2 ** 53 }] }, "counterpoiseAccountId must be a positive integer or null"],
      [{ assignments: [{ plaidAccountId: "pa-1", counterpoiseAccountId: 1 }, { plaidAccountId: "", counterpoiseAccountId: 1 }] }, "Each assignment must include plaidAccountId"],
      [{ assignments: [{ plaidAccountId: "pa-1", counterpoiseAccountId: 1 }, { plaidAccountId: "pa-1 ", counterpoiseAccountId: 2 }] }, "Duplicate plaidAccountId in assignments"],
      [{ assignments: [{ plaidAccountId: "pa-1", counterpoiseAccountId: 1 }, { plaidAccountId: "pa-2", counterpoiseAccountId: 1 }] }, "A Counterpoise account cannot be assigned to more than one Plaid account"],
    ] as const) {
      await expectError(client, path, json("PUT", body), 400, error);
    }
    for (const [assignments, error] of [
      [[{ plaidAccountId: "pa-missing", counterpoiseAccountId: 999999 }], "Unknown plaidAccountId for token: pa-missing"],
      [[{ plaidAccountId: "pa-x", counterpoiseAccountId: null }], "Unknown plaidAccountId for token: pa-x"],
      [[{ plaidAccountId: "pa-1", counterpoiseAccountId: 999999 }], "One or more counterpoiseAccountId values are invalid"],
      [[{ plaidAccountId: "pa-1", counterpoiseAccountId: foreign.id }], "One or more counterpoiseAccountId values are invalid"],
      [[{ plaidAccountId: "pa-1", counterpoiseAccountId: checking.id }, { plaidAccountId: "pa-2", counterpoiseAccountId: food.id }], "Only asset or liability Counterpoise accounts can be synchronized with Plaid"],
      [[{ plaidAccountId: "pa-1", counterpoiseAccountId: mapped.id }], "One or more Counterpoise accounts are already mapped to another Plaid account"],
    ] as const) {
      await expectError(client, path, put(assignments), 400, error);
    }
    await expectError(client, path, put([{ plaidAccountId: "pa-1", counterpoiseAccountId: 3_000_000_000 }]), 500, "Failed to save Plaid account assignments");
    await expectError(client, path, { method: "PUT", body: "[" }, 500, "Failed to save Plaid account assignments");
    // The body is checked before the connection is looked up.
    await expectError(client, `/api/b/1/sync/tokens/${token.id + 100}/accounts`, put("x"), 400, "assignments must be an array");
    await expectError(client, `/api/b/1/sync/tokens/${token.id + 100}/accounts`, put([]), 404, "Token not found");
    await expectError(client, "/api/b/1/sync/tokens/nope/accounts", put("x"), 400, "Invalid token id");
    const [stored] = await db.select().from(plaidAccounts).where(eq(plaidAccounts.id, link.id));
    expect(stored.counterpoiseAccountId).toBeNull();
  });

  it("clears the staged rows and the cursor of one connection", async () => {
    const token = await createPlaidToken({ financialInstitution: "Chase", itemId: "item-clear", accessToken: "t", syncCursor: "cursor-1", lastSyncedAt: new Date("2025-01-02T03:04:05.678Z") });
    await db.update(plaidTokens).set({ lastError: "previous failure" }).where(eq(plaidTokens.id, token.id));
    const otherToken = await createPlaidToken({ financialInstitution: "Other", itemId: "item-other", accessToken: "t", syncCursor: "cursor-2" });
    const link = await createPlaidAccount({ tokenId: token.id, plaidAccountId: "pa-1", name: "Checking", type: "depository" });
    const otherLink = await createPlaidAccount({ tokenId: otherToken.id, plaidAccountId: "pa-2", name: "Other", type: "depository" });
    for (const [linkId, id, status] of [
      [link.id, "pending", "pending"], [link.id, "matched", "matched"], [link.id, "ignored", "ignored"],
      [otherLink.id, "other-pending", "pending"],
    ] as const) {
      await createPlaidReconciliation({ plaidAccountLinkId: linkId, plaidTransactionId: id, date: "2025-01-01", amountCents: 1, name: id, resolutionStatus: status });
    }
    const path = `/api/b/1/sync/tokens/${token.id}/sync`;
    expect(await ok(client, path, { method: "DELETE" })).toEqual({ success: true });
    const staged = await db.select().from(plaidTransactionReconciliation).orderBy(asc(plaidTransactionReconciliation.plaidTransactionId));
    expect(staged.map((row) => row.plaidTransactionId)).toEqual(["ignored", "matched", "other-pending"]);
    const tokens = await db.select().from(plaidTokens).orderBy(asc(plaidTokens.id));
    expect(tokens.map(({ syncCursor, lastSyncedAt, lastError }) => ({ syncCursor, lastSyncedAt, lastError }))).toEqual([
      { syncCursor: null, lastSyncedAt: null, lastError: null },
      { syncCursor: "cursor-2", lastSyncedAt: null, lastError: null },
    ]);

    // A connection without accounts resets too.
    const bare = await createPlaidToken({ financialInstitution: "Bare", itemId: "item-bare", accessToken: "t", syncCursor: "c" });
    expect(await ok(client, `/api/b/1/sync/tokens/${bare.id}/sync`, { method: "DELETE" })).toEqual({ success: true });

    const other = await createBook({ name: "Other" });
    const foreign = await createPlaidToken({ financialInstitution: "F", itemId: "item-f", accessToken: "t", bookId: other.id });
    await expectError(client, `/api/b/1/sync/tokens/${foreign.id}/sync`, { method: "DELETE" }, 404, "Token not found");
    await expectError(client, "/api/b/1/sync/tokens/zz/sync", { method: "DELETE" }, 400, "Invalid token id");
    const viewerBook = await sharedBook("viewer");
    const viewerToken = await createPlaidToken({ financialInstitution: "V", itemId: "item-v", accessToken: "t", bookId: viewerBook.id });
    await expectError(client, `/api/b/${viewerBook.id}/sync/tokens/${viewerToken.id}/sync`, { method: "DELETE" }, 403, "You have read-only access to this book");
    const editorBook = await sharedBook("editor");
    const editorToken = await createPlaidToken({ financialInstitution: "E", itemId: "item-e", accessToken: "t", bookId: editorBook.id });
    expect(await ok(client, `/api/b/${editorBook.id}/sync/tokens/${editorToken.id}/sync`, { method: "DELETE" })).toEqual({ success: true });
  });
});

describe("Plaid account refresh without a usable Plaid", () => {
  it.each([
    [{ ...PLAID, PLAID_CLIENT_ID: "" }, 500, "PLAID_CLIENT_ID environment variable not configured"],
    [{ ...PLAID, PLAID_SECRET: "" }, 500, "PLAID_SECRET environment variable not configured"],
    [{ ...PLAID, PLAID_ENV: "development" }, 500, "PLAID_ENV environment variable must be one of sandbox or production"],
    // Nothing listens on the discard port of the loopback address.
    [{ ...PLAID, PLAID_API_URL: "http://127.0.0.1:9" }, 502, "fetch failed"],
  ])("reports %j as %i", async (env, status, error) => {
    const { baseUrl, stop } = await startHttpTestServer({ PLAID_API_URL: "http://127.0.0.1:9", ...env });
    try {
      await resetTestDatabase();
      const client = await sessionHttpClient(baseUrl);
      const token = await createPlaidToken({ financialInstitution: "Chase", itemId: "item-env", accessToken: "t" });
      await expectError(client, `/api/b/1/sync/tokens/${token.id}/accounts?refresh=true`, {}, status, error);
    } finally {
      await stop();
    }
  }, 120_000);
});
