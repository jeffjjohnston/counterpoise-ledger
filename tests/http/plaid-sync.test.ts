import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getSqlClient_raw } from "../../db";
import { plaidTokens, plaidTransactionReconciliation, transactions } from "../../db/schema";
import { toDateString } from "../../lib/formatters";
import {
  addBookMember, createAccount, createBook, createPayee, createPlaidAccount, createPlaidReconciliation,
  createPlaidToken, createTransactionWithSplits, createUser, db, resetTestDatabase, setupTestDatabase,
} from "../helpers/db-utils";
import { sessionHttpClient, startHttpTestServer } from "../helpers/http-parity";

type Client = Awaited<ReturnType<typeof sessionHttpClient>>;
type Reply = { status: number; body?: unknown; raw?: string };

async function expectError(client: Client, path: string, init: RequestInit, status: number, error: string) {
  const response = await client.request(path, init);
  expect(response.status, `${init.method ?? "GET"} ${path}`).toBe(status);
  expect(await response.json()).toEqual({ error });
}

/** The local calendar date this many days before today. */
function daysAgo(days: number) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return toDateString(date);
}

/** A Plaid transaction with the fields in the order Plaid sends them. */
function plaidItem(fields: Record<string, unknown>) {
  return {
    account_id: "plaid-checking",
    account_owner: null,
    amount: 12.34,
    authorized_date: null,
    category: null,
    date: daysAgo(1),
    iso_currency_code: "USD",
    merchant_name: null,
    name: "Transaction",
    original_description: null,
    pending: false,
    pending_transaction_id: null,
    personal_finance_category: null,
    transaction_id: "txn",
    unofficial_currency_code: null,
    ...fields,
  };
}

function page(fields: { added?: unknown[]; modified?: unknown[]; removed?: unknown[]; has_more?: boolean; next_cursor?: string | null }): Reply {
  return { status: 200, body: { added: [], modified: [], removed: [], has_more: false, next_cursor: "cursor-next", request_id: "r", ...fields } };
}

/**
 * The Plaid mock. Each (access token, cursor) key has a list of replies; the
 * last reply repeats. The server may not call the real API.
 */
async function startPlaidMock() {
  const replies = new Map<string, Reply[]>();
  const requests: Record<string, unknown>[] = [];
  const server: Server = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk) => { text += chunk; });
    request.on("end", () => {
      const body = JSON.parse(text) as { access_token: string; cursor?: string };
      requests.push(body);
      const queue = replies.get(`${body.access_token}|${body.cursor ?? ""}`);
      const reply = (queue && (queue.length > 1 ? queue.shift() : queue[0])) ?? {
        status: 400, body: { error_message: "unexpected request", error_code: "UNEXPECTED" },
      };
      response.writeHead(reply.status, { "content-type": "application/json" });
      response.end(reply.raw ?? JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolveReady) => server.listen(0, "127.0.0.1", () => resolveReady()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    server,
    requests,
    reply(accessToken: string, cursor: string | null, ...queue: Reply[]) {
      replies.set(`${accessToken}|${cursor ?? ""}`, queue);
    },
    reset() {
      replies.clear();
      requests.length = 0;
    },
  };
}

async function stagedRows() {
  const rows = await db.select().from(plaidTransactionReconciliation).orderBy(asc(plaidTransactionReconciliation.id));
  // The timestamps are the sync's own; the row only reports whether it is resolved.
  const volatile = new Set(["createdAt", "updatedAt", "firstSeenAt", "lastSeenAt", "resolvedAt"]);
  type Stable = Omit<(typeof rows)[number], "createdAt" | "updatedAt" | "firstSeenAt" | "lastSeenAt" | "resolvedAt">;
  return rows.map((row) => ({
    ...(Object.fromEntries(Object.entries(row).filter(([key]) => !volatile.has(key))) as Stable),
    resolved: row.resolvedAt !== null,
  }));
}

beforeAll(async () => {
  await setupTestDatabase();
}, 120_000);

describe("Plaid sync HTTP parity", () => {
  let baseUrl: string;
  let stop: () => Promise<void>;
  let client: Client;
  let plaid: Awaited<ReturnType<typeof startPlaidMock>>;

  beforeAll(async () => {
    plaid = await startPlaidMock();
    ({ baseUrl, stop } = await startHttpTestServer({
      PLAID_CLIENT_ID: "client-id", PLAID_SECRET: "plaid-secret", PLAID_ENV: "sandbox", PLAID_API_URL: plaid.url,
    }));
  }, 120_000);
  beforeEach(async () => {
    await resetTestDatabase();
    client = await sessionHttpClient(baseUrl);
    plaid.reset();
  });
  afterAll(async () => {
    await stop?.();
    await new Promise((resolveClosed) => plaid?.server.close(resolveClosed));
  });

  async function connection(options: { syncCursor?: string | null; accessToken?: string } = {}) {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const card = await createAccount({ name: "Card", type: "liability" });
    const token = await createPlaidToken({
      financialInstitution: "Chase", itemId: "item-1", accessToken: options.accessToken ?? "access-1",
      syncCursor: options.syncCursor ?? null,
    });
    const checkingLink = await createPlaidAccount({ tokenId: token.id, plaidAccountId: "plaid-checking", name: "Checking", type: "depository", counterpoiseAccountId: checking.id });
    const cardLink = await createPlaidAccount({ tokenId: token.id, plaidAccountId: "plaid-card", name: "Card", type: "credit", counterpoiseAccountId: card.id });
    await createPlaidAccount({ tokenId: token.id, plaidAccountId: "plaid-unmapped", name: "Unmapped", type: "depository" });
    return { checking, card, token, checkingLink, cardLink, path: `/api/b/1/sync/tokens/${token.id}/sync` };
  }

  async function sync(path: string) {
    const response = await client.request(path, { method: "POST" });
    expect(response.status, `POST ${path}`).toBe(200);
    return response.json();
  }

  it("stages the first sync by account, drops pending and old items, and saves the cursor", async () => {
    const { token, checkingLink, cardLink, path } = await connection();
    const items = [
      plaidItem({ transaction_id: "card-1", account_id: "plaid-card", amount: -0.125, name: "Refund", merchant_name: "Shop", personal_finance_category: { primary: "GENERAL_MERCHANDISE", detailed: "GENERAL_MERCHANDISE_OTHER", confidence_level: "HIGH" } }),
      plaidItem({ transaction_id: "chk-1", amount: 12.345, name: "Coffee", category: ["Food and Drink", "Coffee Shop"], authorized_date: daysAgo(2), original_description: "SQ *COFFEE" }),
      plaidItem({ transaction_id: "chk-pending", pending: true }),
      plaidItem({ transaction_id: "chk-old", date: daysAgo(8) }),
      plaidItem({ transaction_id: "chk-cutoff", date: daysAgo(7), amount: 1e-3, merchant_name: "Edge" }),
      plaidItem({ transaction_id: "unmapped", account_id: "plaid-unmapped" }),
      plaidItem({ transaction_id: "unknown", account_id: "plaid-unknown" }),
      { transaction_id: "not-an-item", account_id: "plaid-checking" },
    ];
    plaid.reply("access-1", null, page({ added: items, next_cursor: "cursor-1" }));

    const result = await sync(path);
    const [stored] = await db.select().from(plaidTokens).where(eq(plaidTokens.id, token.id));
    expect(result).toEqual({
      synced: { added: 3, modified: 0, removed: 0 }, autoMatched: 0,
      lastSyncedAt: stored.lastSyncedAt!.toISOString(), pendingCount: 3, reviewCount: 0,
    });
    expect(stored).toMatchObject({ syncCursor: "cursor-1", lastError: null });
    expect(plaid.requests).toEqual([{
      client_id: "client-id", secret: "plaid-secret", access_token: "access-1", options: { days_requested: 7 }, count: 250,
    }]);
    const base = {
      bookId: 1, pending: false, pendingTransactionId: null, isoCurrencyCode: "USD", unofficialCurrencyCode: null,
      resolutionStatus: "pending", reviewReason: null, reviewMetadataJson: null, matchedTransactionId: null, resolved: false,
    };
    expect(await stagedRows()).toEqual([
      {
        ...base, id: 1, plaidAccountLinkId: cardLink.id, plaidTransactionId: "card-1", date: daysAgo(1), authorizedDate: null,
        amountCents: -12, name: "Refund", merchantName: "Shop", originalDescription: null,
        categoryPrimary: "GENERAL_MERCHANDISE", categoryDetailed: "GENERAL_MERCHANDISE_OTHER", rawJson: JSON.stringify(items[0]),
      },
      {
        ...base, id: 2, plaidAccountLinkId: checkingLink.id, plaidTransactionId: "chk-1", date: daysAgo(1), authorizedDate: daysAgo(2),
        amountCents: 1235, name: "Coffee", merchantName: null, originalDescription: "SQ *COFFEE",
        categoryPrimary: "Food and Drink", categoryDetailed: "Coffee Shop", rawJson: JSON.stringify(items[1]),
      },
      {
        ...base, id: 3, plaidAccountLinkId: checkingLink.id, plaidTransactionId: "chk-cutoff", date: daysAgo(7), authorizedDate: null,
        amountCents: 0, name: "Transaction", merchantName: "Edge", originalDescription: null,
        categoryPrimary: null, categoryDetailed: null, rawJson: JSON.stringify(items[4]),
      },
    ]);
  });

  it("pages from the stored cursor and flags changes to resolved rows", async () => {
    const { checking, checkingLink, cardLink, path } = await connection({ syncCursor: "cursor-0" });
    const food = await createAccount({ name: "Food", type: "expense" });
    const local = await createTransactionWithSplits({ date: "2025-01-02", splits: [{ accountId: checking.id, amount: -500 }, { accountId: food.id, amount: 500 }] });
    const staged = async (plaidTransactionId: string, status: "pending" | "matched" | "created" | "ignored", extra: Record<string, unknown> = {}) =>
      createPlaidReconciliation({
        plaidAccountLinkId: checkingLink.id, plaidTransactionId, date: "2025-01-02", amountCents: 500, name: `Old ${plaidTransactionId}`,
        merchantName: "Old Merchant", categoryPrimary: "OLD", resolutionStatus: status, ...extra,
      });
    await staged("matched", "matched", { matchedTransactionId: local.id });
    await staged("pending-mod", "pending");
    await staged("ignored-rm", "ignored");
    await staged("pending-rm", "pending");
    await staged("created", "created", { reviewReason: "plaid_removed" });
    await staged("readd", "matched", { reviewReason: "plaid_modified" });
    await db.update(plaidTransactionReconciliation).set({ reviewMetadataJson: "{\"kept\":true}", resolvedAt: new Date("2025-01-03T00:00:00Z") })
      .where(eq(plaidTransactionReconciliation.plaidTransactionId, "created"));
    await db.update(plaidTransactionReconciliation).set({ reviewMetadataJson: "{\"stale\":true}" })
      .where(eq(plaidTransactionReconciliation.plaidTransactionId, "pending-mod"));

    plaid.reply("access-1", "cursor-0", page({
      added: [plaidItem({ transaction_id: "readd", amount: 5, name: "Readded", date: "2025-01-02" })],
      modified: [plaidItem({ transaction_id: "brand-new", account_id: "plaid-card", amount: 2, date: "2025-01-05" })],
      has_more: true, next_cursor: "cursor-1",
    }));
    plaid.reply("access-1", "cursor-1", page({
      modified: [
        plaidItem({ transaction_id: "matched", amount: 6.5, name: "New name", merchant_name: "New Merchant", date: "2025-01-04", personal_finance_category: { primary: "NEW", detailed: "NEW_DETAIL" } }),
        plaidItem({ transaction_id: "pending-mod", amount: 7, date: "2025-01-06" }),
        plaidItem({ transaction_id: "created", amount: 8, date: "2025-01-07" }),
        plaidItem({ transaction_id: "pending-mod", pending: true }),
      ],
      removed: [{ transaction_id: "ignored-rm" }, { transaction_id: "pending-rm" }, { transaction_id: "unknown-rm" }, { bad: true }, { transaction_id: "pending-rm" }],
      next_cursor: "cursor-2",
    }));

    const result = await sync(path);
    expect(result).toMatchObject({ synced: { added: 1, modified: 4, removed: 4 }, autoMatched: 0, pendingCount: 2, reviewCount: 3 });
    expect(plaid.requests.map((body) => [body.cursor, body.options])).toEqual([["cursor-0", undefined], ["cursor-1", undefined]]);
    const rows = Object.fromEntries((await stagedRows()).map((row) => [row.plaidTransactionId, row]));
    expect(rows.matched).toMatchObject({
      resolutionStatus: "matched", reviewReason: "plaid_modified", amountCents: 650, name: "New name",
      reviewMetadataJson: JSON.stringify({
        event: "modified",
        previous: { date: "2025-01-02", amountCents: 500, name: "Old matched", merchantName: "Old Merchant", originalDescription: null, categoryPrimary: "OLD", categoryDetailed: null },
        incoming: { date: "2025-01-04", amountCents: 650, name: "New name", merchantName: "New Merchant", originalDescription: null, categoryPrimary: "NEW", categoryDetailed: "NEW_DETAIL" },
      }),
    });
    expect(rows["pending-mod"]).toMatchObject({ resolutionStatus: "pending", reviewReason: null, reviewMetadataJson: "{\"stale\":true}", amountCents: 700, date: "2025-01-06" });
    expect(rows.created).toMatchObject({ resolutionStatus: "created", reviewReason: "plaid_modified", resolved: true, amountCents: 800 });
    expect(rows["ignored-rm"]).toMatchObject({ resolutionStatus: "ignored", reviewReason: null });
    expect(rows["pending-rm"]).toMatchObject({
      resolutionStatus: "pending", reviewReason: "plaid_removed",
      reviewMetadataJson: JSON.stringify({ event: "removed", removedTransactionId: "pending-rm" }),
    });
    expect(rows.readd).toMatchObject({ resolutionStatus: "matched", reviewReason: null, reviewMetadataJson: null, name: "Readded", amountCents: 500 });
    expect(rows["brand-new"]).toMatchObject({ plaidAccountLinkId: cardLink.id, resolutionStatus: "pending", amountCents: 200 });
    const [token] = await db.select().from(plaidTokens);
    expect(token.syncCursor).toBe("cursor-2");
  });

  it("keeps a stored field that Plaid leaves out, and leaves its key out of the review", async () => {
    const { checking, checkingLink, path } = await connection({ syncCursor: "cursor-0" });
    const food = await createAccount({ name: "Food", type: "expense" });
    const local = await createTransactionWithSplits({ date: "2025-01-02", splits: [{ accountId: checking.id, amount: -500 }, { accountId: food.id, amount: 500 }] });
    for (const [plaidTransactionId, status] of [["matched", "matched"], ["readded", "pending"]] as const) {
      await createPlaidReconciliation({
        plaidAccountLinkId: checkingLink.id, plaidTransactionId, date: "2025-01-02", authorizedDate: "2025-01-01", amountCents: 500,
        name: "Old", merchantName: "Old Merchant", originalDescription: "OLD DESCRIPTION", resolutionStatus: status,
        matchedTransactionId: status === "matched" ? local.id : null,
      });
    }
    // Plaid sends original_description only when it is asked for, and
    // the server does not ask for it.
    const without = (fields: Record<string, unknown>, ...keys: string[]) => {
      const item: Record<string, unknown> = plaidItem(fields);
      for (const key of keys) delete item[key];
      return item;
    };
    plaid.reply("access-1", "cursor-0", page({
      added: [
        without({ transaction_id: "readded", amount: 6, date: "2025-01-03" }, "original_description", "authorized_date", "iso_currency_code"),
        without({ transaction_id: "fresh", amount: 1, date: "2025-01-03" }, "original_description", "merchant_name"),
      ],
      modified: [without({ transaction_id: "matched", amount: 7, date: "2025-01-04", merchant_name: null }, "original_description", "authorized_date")],
    }));
    await sync(path);
    const rows = Object.fromEntries((await stagedRows()).map((row) => [row.plaidTransactionId, row]));
    expect(rows.matched).toMatchObject({
      amountCents: 700, merchantName: null, originalDescription: "OLD DESCRIPTION", authorizedDate: "2025-01-01", isoCurrencyCode: "USD",
      reviewMetadataJson: JSON.stringify({
        event: "modified",
        previous: { date: "2025-01-02", amountCents: 500, name: "Old", merchantName: "Old Merchant", originalDescription: "OLD DESCRIPTION", categoryPrimary: null, categoryDetailed: null },
        incoming: { date: "2025-01-04", amountCents: 700, name: "Transaction", merchantName: null, categoryPrimary: null, categoryDetailed: null },
      }),
    });
    expect(rows.readded).toMatchObject({ amountCents: 600, originalDescription: "OLD DESCRIPTION", authorizedDate: "2025-01-01", isoCurrencyCode: "USD", merchantName: null });
    expect(rows.fresh).toMatchObject({ originalDescription: null, merchantName: null, isoCurrencyCode: "USD" });
  });

  it("restarts from the stored cursor after a mutation during pagination, at most twice", async () => {
    const { token, path } = await connection({ syncCursor: "cursor-0" });
    const mutation: Reply = { status: 400, body: { error_message: "mutated", error_code: "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" } };
    plaid.reply("access-1", "cursor-0", page({ has_more: true, next_cursor: "cursor-mid" }));
    plaid.reply("access-1", "cursor-mid", mutation, page({ next_cursor: "cursor-end" }));
    expect((await sync(path)).synced).toEqual({ added: 0, modified: 0, removed: 0 });
    expect(plaid.requests.map((body) => body.cursor)).toEqual(["cursor-0", "cursor-mid", "cursor-0", "cursor-mid"]);
    expect((await db.select().from(plaidTokens))[0].syncCursor).toBe("cursor-end");

    plaid.reset();
    await db.update(plaidTokens).set({ syncCursor: "cursor-0" }).where(eq(plaidTokens.id, token.id));
    plaid.reply("access-1", "cursor-0", page({ has_more: true, next_cursor: "cursor-mid" }));
    plaid.reply("access-1", "cursor-mid", mutation);
    const message = "Plaid /transactions/sync request failed: mutated (TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION)";
    await expectError(client, path, { method: "POST" }, 502, message);
    expect(plaid.requests).toHaveLength(6);
    expect((await db.select().from(plaidTokens))[0]).toMatchObject({ syncCursor: "cursor-0", lastError: message });
  });

  it("records a failed sync on the connection and reports it as Plaid's", async () => {
    const { token, path } = await connection({ syncCursor: "cursor-0" });
    for (const [reply, error] of [
      [{ status: 400, body: { error_message: "bad token", error_code: "INVALID_ACCESS_TOKEN" } }, "Plaid /transactions/sync request failed: bad token (INVALID_ACCESS_TOKEN)"],
      [{ status: 500, raw: "oops" }, "Plaid /transactions/sync request failed"],
      [{ status: 200, body: null }, "Cannot read properties of null (reading 'added')"],
      [{ status: 200, body: { added: [], has_more: "no", next_cursor: "c" } }, "Plaid /transactions/sync returned invalid has_more"],
      [{ status: 200, body: { added: [], has_more: false } }, "Plaid /transactions/sync returned invalid next_cursor"],
      [{ status: 200, body: { has_more: false, next_cursor: 5 } }, "Plaid /transactions/sync returned invalid next_cursor"],
    ] as const) {
      plaid.reply("access-1", "cursor-0", reply as Reply);
      await expectError(client, path, { method: "POST" }, 502, error);
      const [stored] = await db.select().from(plaidTokens).where(eq(plaidTokens.id, token.id));
      expect(stored).toMatchObject({ lastError: error, syncCursor: "cursor-0", lastSyncedAt: null });
    }
    // A later sync clears the error.
    plaid.reply("access-1", "cursor-0", page({ next_cursor: null }));
    expect(await sync(path)).toMatchObject({ synced: { added: 0, modified: 0, removed: 0 } });
    expect((await db.select().from(plaidTokens))[0]).toMatchObject({ lastError: null, syncCursor: null });
  });

  it("refuses a connection that cannot sync", async () => {
    const food = await createAccount({ name: "Food", type: "expense" });
    const bare = await createPlaidToken({ financialInstitution: "Bare", itemId: "item-bare", accessToken: "t" });
    await createPlaidAccount({ tokenId: bare.id, plaidAccountId: "bare-unmapped", name: "U", type: "depository" });
    const expense = await createPlaidToken({ financialInstitution: "Expense", itemId: "item-expense", accessToken: "t" });
    await createPlaidAccount({ tokenId: expense.id, plaidAccountId: "expense", name: "E", type: "depository", counterpoiseAccountId: food.id });
    const demo = await createPlaidToken({ financialInstitution: "Demo", itemId: "item-demo", accessToken: "t", isDemo: true });
    for (const [id, status, error] of [
      [bare.id, 400, "No linked accounts found for this token"],
      [expense.id, 400, "Only asset or liability Counterpoise accounts can be synchronized with Plaid"],
      [demo.id, 400, "This is a demo connection and cannot sync with Plaid"],
    ] as const) {
      await expectError(client, `/api/b/1/sync/tokens/${id}/sync`, { method: "POST" }, status, error);
    }
    const errors = await db.select({ id: plaidTokens.id, lastError: plaidTokens.lastError }).from(plaidTokens).orderBy(asc(plaidTokens.id));
    expect(errors).toEqual([
      { id: bare.id, lastError: "No linked accounts found for this token" },
      { id: expense.id, lastError: "Only asset or liability Counterpoise accounts can be synchronized with Plaid" },
      { id: demo.id, lastError: null },
    ]);
    const stranger = await createUser({ username: "stranger" });
    const other = await createBook({ name: "Other", userId: stranger.id });
    const foreign = await createPlaidToken({ financialInstitution: "F", itemId: "item-f", accessToken: "t", bookId: other.id });
    await expectError(client, `/api/b/1/sync/tokens/${foreign.id}/sync`, { method: "POST" }, 404, "Token not found");
    await expectError(client, "/api/b/1/sync/tokens/x/sync", { method: "POST" }, 400, "Invalid token id");
    await expectError(client, "/api/b/1/sync/tokens/3000000000/sync", { method: "POST" }, 502, 'value "3000000000" is out of range for type integer');
    const viewerBook = await createBook({ name: "Shared", userId: stranger.id });
    await addBookMember({ bookId: viewerBook.id, userId: 1, role: "viewer" });
    await expectError(client, `/api/b/${viewerBook.id}/sync/tokens/${foreign.id}/sync`, { method: "POST" }, 403, "You have read-only access to this book");
    expect(plaid.requests).toEqual([]);
  });

  it("refuses a second sync of a connection while one runs", async () => {
    const { token, path } = await connection();
    const held = await getSqlClient_raw().reserve();
    try {
      await held`select pg_advisory_lock(1000001, ${token.id})`;
      await expectError(client, path, { method: "POST" }, 409, "A sync is already running for this connection");
      await held`select pg_advisory_unlock(1000001, ${token.id})`;
    } finally {
      held.release();
    }
    expect((await db.select().from(plaidTokens))[0].lastError).toBeNull();
  });

  it("matches pending rows to transactions through the payees of earlier matches", async () => {
    const { checking, card, checkingLink, cardLink, path } = await connection({ syncCursor: "cursor-0" });
    const food = await createAccount({ name: "Food", type: "expense" });
    const coffee = await createPayee({ name: "Blue Bottle" });
    const grocer = await createPayee({ name: "Grocer" });
    const spend = (accountId: number, date: string, amount: number, payeeId: number, options: { isFloating?: boolean } = {}) =>
      createTransactionWithSplits({ date, payeeId, ...options, splits: [{ accountId, amount: -amount }, { accountId: food.id, amount }] });
    // The learned history: earlier bank rows matched to transactions with a payee.
    const earlier = await spend(checking.id, "2024-12-01", 300, coffee.id);
    await createPlaidReconciliation({ plaidAccountLinkId: checkingLink.id, plaidTransactionId: "h1", date: "2024-12-01", amountCents: 300, name: "SQ *BLUE BOTTLE", merchantName: "Blue  Bottle", resolutionStatus: "matched", matchedTransactionId: earlier.id });
    const earlierGrocer = await spend(card.id, "2024-12-02", 100, grocer.id);
    await createPlaidReconciliation({ plaidAccountLinkId: cardLink.id, plaidTransactionId: "h2", date: "2024-12-02", amountCents: 100, name: "GROCER #12", resolutionStatus: "matched", matchedTransactionId: earlierGrocer.id });

    // Posted nine days after authorization: the posted date is stamped, and
    // the candidate nearest it wins.
    await spend(checking.id, "2025-02-01", 450, coffee.id);
    const postedDay = await spend(checking.id, "2025-02-11", 450, coffee.id);
    // A floating transaction is settled with the authorization date.
    const floating = await spend(checking.id, "2025-01-01", 725, coffee.id, { isFloating: true });
    const grocery = await spend(card.id, "2025-03-04", 1999, grocer.id);
    const tooFar = await spend(checking.id, "2025-03-01", 800, coffee.id);
    plaid.reply("access-1", "cursor-0", page({ added: [
      plaidItem({ transaction_id: "delayed", merchant_name: "BLUE BOTTLE", amount: 4.5, authorized_date: "2025-02-01", date: "2025-02-10" }),
      plaidItem({ transaction_id: "floating", merchant_name: "blue bottle", amount: 7.25, authorized_date: daysAgo(1), date: daysAgo(0) }),
      plaidItem({ transaction_id: "grocery", account_id: "plaid-card", name: "Grocer #12", amount: 19.99, date: "2025-03-05" }),
      plaidItem({ transaction_id: "far", merchant_name: "Blue Bottle", amount: 8, date: "2025-03-03" }),
      plaidItem({ transaction_id: "stranger", merchant_name: "Nobody", amount: 4.5, date: "2025-02-10" }),
    ] }));

    const result = await sync(path);
    expect(result).toMatchObject({ synced: { added: 5, modified: 0, removed: 0 }, autoMatched: 3, pendingCount: 2, reviewCount: 0 });
    const rows = Object.fromEntries((await stagedRows()).map((row) => [row.plaidTransactionId, row]));
    expect(rows.delayed).toMatchObject({ resolutionStatus: "matched", matchedTransactionId: postedDay.id, resolved: true });
    expect(rows.floating).toMatchObject({ resolutionStatus: "matched", matchedTransactionId: floating.id });
    expect(rows.grocery).toMatchObject({ resolutionStatus: "matched", matchedTransactionId: grocery.id });
    expect(rows.far).toMatchObject({ resolutionStatus: "pending", matchedTransactionId: null });
    expect(rows.stranger).toMatchObject({ resolutionStatus: "pending" });
    const local = Object.fromEntries((await db.select().from(transactions)).map((row) => [row.id, row]));
    expect(local[postedDay.id]).toMatchObject({ isReconciled: true, isFloating: false, date: "2025-02-10" });
    expect(local[floating.id]).toMatchObject({ isReconciled: true, isFloating: false, date: daysAgo(1) });
    expect(local[grocery.id]).toMatchObject({ isReconciled: true, date: "2025-03-05" });
    expect(local[tooFar.id]).toMatchObject({ isReconciled: false, date: "2025-03-01" });
  });
});
