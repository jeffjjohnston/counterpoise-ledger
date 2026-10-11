import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PlaidToken } from "../../types/db";
import type { PlaidLinkSession } from "../../types";
import {
  addBookMember, createAccount, createBook, createPlaidAccount, createPlaidReconciliation,
  createPlaidToken, createUser, resetTestDatabase, setupTestDatabase,
} from "../helpers/db-utils";
import { contract } from "../helpers/contract";
import { sessionHttpClient, startHttpTestServer } from "../helpers/http-parity";
import { count, exec, row, rows } from "../helpers/sql";

const sessionSchema = contract<PlaidLinkSession>("PlaidLinkSession");

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

type Client = Awaited<ReturnType<typeof sessionHttpClient>>;

const PLAID = { PLAID_CLIENT_ID: "client-id", PLAID_SECRET: "plaid-secret", PLAID_ENV: "sandbox" };
const FOUR_HOURS = 4 * 60 * 60 * 1000;

type Reply = { status: number; body: unknown };

/**
 * A Plaid mock with replies that each test sets. The server may not call the
 * real API. A request that has no reply gets a Plaid error.
 */
async function startPlaidMock() {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const replies = {
    /** The `expiration` of each new link token. */
    expiration: () => new Date(Date.now() + 24 * FOUR_HOURS).toISOString(),
    createError: null as Reply | null,
    /** By link token. Without an entry, the session is not started. */
    linkGet: {} as Record<string, Reply>,
    /** By public token. */
    exchange: {} as Record<string, Reply>,
    /** By access token. */
    accounts: {} as Record<string, Reply>,
  };
  let created = 0;
  /**
   * By path: the next `remaining` requests to it get their replies only when
   * the test releases the hold. A reply is chosen when its request arrives.
   */
  const holds: Record<string, { remaining: number; gate: Promise<void>; release: () => void }> = {};
  const unknown: Reply = { status: 400, body: { error_message: "unknown token", error_code: "INVALID_INPUT" } };
  const server = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk) => { text += chunk; });
    request.on("end", () => {
      const body = JSON.parse(text) as Record<string, string>;
      requests.push({ path: request.url ?? "", body });
      let reply: Reply;
      switch (request.url) {
        case "/link/token/create":
          created += 1;
          reply = replies.createError ?? {
            status: 200,
            body: {
              link_token: `link-sandbox-${created}`,
              hosted_link_url: `https://hosted.plaid.test/link/${created}`,
              expiration: replies.expiration(),
              request_id: "r",
            },
          };
          break;
        case "/link/token/get":
          reply = replies.linkGet[body.link_token] ?? { status: 200, body: { link_token: body.link_token, link_sessions: [] } };
          break;
        case "/item/public_token/exchange":
          reply = replies.exchange[body.public_token] ?? unknown;
          break;
        case "/accounts/get":
          reply = replies.accounts[body.access_token] ?? unknown;
          break;
        case "/item/remove":
          reply = { status: 200, body: { request_id: "r" } };
          break;
        default:
          reply = unknown;
      }
      const held = holds[request.url ?? ""];
      let gate = Promise.resolve();
      if (held && held.remaining > 0) {
        held.remaining -= 1;
        gate = held.gate;
      }
      void gate.then(() => {
        response.writeHead(reply.status, { "content-type": "application/json" });
        response.end(JSON.stringify(reply.body));
      });
    });
  });
  await new Promise<void>((resolveReady) => server.listen(0, "127.0.0.1", () => resolveReady()));
  const { port } = server.address() as AddressInfo;
  /**
   * Holds the replies to the next `count` requests to a path. The function
   * that it returns releases them.
   */
  const hold = (path: string, count: number) => {
    let release = () => {};
    const gate = new Promise<void>((resolveHold) => { release = resolveHold; });
    holds[path] = { remaining: count, gate, release };
    return () => {
      delete holds[path];
      release();
    };
  };
  /** Resolves when the mock has received `n` requests to a path. */
  const arrived = async (path: string, n: number) => {
    for (let tries = 0; tries < 500; tries += 1) {
      if (requests.filter((request) => request.path === path).length >= n) return;
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    throw new Error(`The mock did not receive ${n} requests to ${path}`);
  };
  /** Releases every hold, so that no request waits after its test. */
  const releaseAll = () => {
    for (const path of Object.keys(holds)) {
      holds[path].release();
      delete holds[path];
    }
  };
  const reset = () => {
    releaseAll();
    requests.length = 0;
    created = 0;
    replies.expiration = () => new Date(Date.now() + 24 * FOUR_HOURS).toISOString();
    replies.createError = null;
    replies.linkGet = {};
    replies.exchange = {};
    replies.accounts = {};
  };
  return { url: `http://127.0.0.1:${port}`, requests, replies, server, reset, hold, arrived, releaseAll };
}

/** A /link/token/get body of one finished session that added an Item. */
function itemAdded(publicToken: string, institution: string): Reply {
  return {
    status: 200,
    body: {
      link_sessions: [
        { link_session_id: "s1", started_at: "2026-10-09T10:00:00Z", finished_at: "2026-10-09T10:01:00Z", on_exit: { error: null } },
        {
          link_session_id: "s2", started_at: "2026-10-09T10:02:00Z", finished_at: "2026-10-09T10:04:00Z",
          results: { item_add_results: [{ public_token: publicToken, institution: { name: institution, institution_id: "ins_1" } }] },
        },
      ],
    },
  };
}

function accounts(...list: Array<{ id: string; name: string }>): Reply {
  return {
    status: 200,
    body: {
      accounts: list.map((account) => ({
        account_id: account.id, name: account.name, official_name: null, mask: "0000", type: "depository", subtype: "checking",
      })),
    },
  };
}

async function sharedBook(role: "editor" | "viewer") {
  const owner = await createUser({ username: `owner-${role}` });
  const book = await createBook({ name: `Shared ${role}`, userId: owner.id });
  await addBookMember({ bookId: book.id, userId: 1, role });
  return book;
}

beforeAll(async () => {
  await setupTestDatabase();
}, 120_000);

describe("Plaid Hosted Link sessions", () => {
  let baseUrl: string;
  let stop: () => Promise<void>;
  let client: Client;
  let plaid: Awaited<ReturnType<typeof startPlaidMock>>;

  beforeAll(async () => {
    plaid = await startPlaidMock();
    // A zone far from UTC: the stored timestamps must still be UTC.
    ({ baseUrl, stop } = await startHttpTestServer({ ...PLAID, PLAID_API_URL: plaid.url, TZ: "America/New_York" }));
  }, 120_000);
  beforeEach(async () => {
    await resetTestDatabase();
    client = await sessionHttpClient(baseUrl);
    plaid.reset();
  });
  /** The requests that a test starts and does not await at once. */
  const inFlight: Array<Promise<unknown>> = [];
  // A failed test can leave a request that waits for a hold. It must end
  // before the next test resets the database.
  afterEach(async () => {
    plaid.releaseAll();
    await Promise.allSettled(inFlight.splice(0));
  });
  afterAll(async () => {
    await stop?.();
    await new Promise((resolveClosed) => plaid?.server.close(resolveClosed));
  });

  /** A 200 body as text, so that a test can prove what it does not contain. */
  async function post(path: string, body?: unknown): Promise<{ session: PlaidLinkSession; text: string }> {
    const response = await client.request(path, body === undefined ? { method: "POST" } : json("POST", body));
    const text = await response.text();
    expect(response.status, `${path}: ${text}`).toBe(200);
    return { session: sessionSchema.parse(JSON.parse(text)), text };
  }

  async function expectError(path: string, init: RequestInit, status: number, error: string) {
    const response = await client.request(path, init);
    expect(response.status, `${path} ${String(init.body)}`).toBe(status);
    expect(await response.json()).toEqual({ error });
  }

  const paths = (name: string) => plaid.requests.filter((request) => request.path === name);

  it("connects a new bank: pending, then complete, with one exchange and no token in a response", async () => {
    const before = Date.now();
    const started = await post("/api/b/1/sync/link-sessions", {});
    const after = Date.now();
    expect(started.session).toMatchObject({
      mode: "create", status: "pending", tokenId: null, financialInstitution: null,
      hostedLinkUrl: "https://hosted.plaid.test/link/1", error: null,
    });
    const expiresAt = Date.parse(started.session.expiresAt);
    expect(expiresAt).toBeGreaterThanOrEqual(before + FOUR_HOURS - 1);
    expect(expiresAt).toBeLessThanOrEqual(after + FOUR_HOURS + 1);
    expect(started.text).not.toContain("link-sandbox-1");

    const [create] = paths("/link/token/create");
    expect(create.body).toMatchObject({
      client_id: "client-id", secret: "plaid-secret", products: ["transactions"], hosted_link: {},
      user: { client_user_id: "counterpoise-user-1" },
    });
    expect(create.body).not.toHaveProperty("access_token");
    expect(create.body).not.toHaveProperty("update");
    const stored = await row<{ linkToken: string; status: string; tokenId: number | null; expiresAt: Date }>(
      "SELECT link_token, status, token_id, expires_at FROM plaid_link_sessions WHERE id = $1", [started.session.id]
    );
    expect(stored).toMatchObject({ linkToken: "link-sandbox-1", status: "pending", tokenId: null });
    // UTC text, read back as UTC.
    expect(stored.expiresAt.toISOString()).toBe(started.session.expiresAt);

    const check = `/api/b/1/sync/link-sessions/${started.session.id}/check`;
    // Started, not finished.
    plaid.replies.linkGet["link-sandbox-1"] = {
      status: 200,
      body: { link_sessions: [{ link_session_id: "s1", started_at: "2026-10-09T10:00:00Z", finished_at: null }] },
    };
    expect((await post(check)).session).toMatchObject({ status: "pending", tokenId: null });
    expect(paths("/item/public_token/exchange")).toHaveLength(0);

    plaid.replies.linkGet["link-sandbox-1"] = itemAdded("public-sandbox-new", "First Platypus Bank");
    plaid.replies.exchange["public-sandbox-new"] = {
      status: 200, body: { access_token: "access-sandbox-new-secret", item_id: "item-new", request_id: "r" },
    };
    plaid.replies.accounts["access-sandbox-new-secret"] = accounts({ id: "acc-1", name: "Plaid Checking" }, { id: "acc-2", name: "Plaid Saving" });
    const done = await post(check);
    const [token] = await rows<PlaidToken>("SELECT * FROM plaid_tokens");
    expect(token).toMatchObject({
      bookId: 1, financialInstitution: "First Platypus Bank", itemId: "item-new", accessToken: "access-sandbox-new-secret",
    });
    expect(done.session).toMatchObject({
      status: "complete", tokenId: token.id, financialInstitution: "First Platypus Bank", hostedLinkUrl: null, error: null,
    });
    for (const secret of ["access-sandbox-new-secret", "public-sandbox-new", "link-sandbox-1"]) {
      expect(done.text).not.toContain(secret);
    }
    expect(paths("/item/public_token/exchange").map((request) => request.body.public_token)).toEqual(["public-sandbox-new"]);
    expect(await rows("SELECT plaid_account_id, counterpoise_account_id FROM plaid_accounts WHERE token_id = $1 ORDER BY plaid_account_id", [token.id]))
      .toEqual([{ plaidAccountId: "acc-1", counterpoiseAccountId: null }, { plaidAccountId: "acc-2", counterpoiseAccountId: null }]);

    // A complete session answers its stored state, with no Plaid call.
    const calls = plaid.requests.length;
    expect((await post(check)).session).toEqual(done.session);
    expect(plaid.requests).toHaveLength(calls);

    const list = await client.request("/api/b/1/sync/tokens");
    expect(await list.text()).not.toContain("access-sandbox-new-secret");
  });

  it("expires a session after four hours, or when its link token expires first", async () => {
    const expiration = new Date(Date.now() + 30 * 60 * 1000);
    plaid.replies.expiration = () => expiration.toISOString();
    const { session } = await post("/api/b/1/sync/link-sessions", { tokenId: null });
    expect(Date.parse(session.expiresAt)).toBe(expiration.getTime());

    // Past its expiry, a session with no result gets one Plaid call and
    // becomes expired. A later check makes no call.
    await exec("UPDATE plaid_link_sessions SET expires_at = $1 WHERE id = $2", [new Date(Date.now() - 1000), session.id]);
    const calls = plaid.requests.length;
    const expired = await post(`/api/b/1/sync/link-sessions/${session.id}/check`);
    expect(expired.session).toMatchObject({ status: "expired", hostedLinkUrl: null, tokenId: null });
    expect(plaid.requests.slice(calls).map((request) => request.path)).toEqual(["/link/token/get"]);
    expect((await post(`/api/b/1/sync/link-sessions/${session.id}/check`)).session).toMatchObject({ status: "expired" });
    expect(plaid.requests).toHaveLength(calls + 1);
    expect(await count("plaid_tokens")).toBe(0);

    // A new session deletes the sessions that expired more than one day ago.
    await exec("UPDATE plaid_link_sessions SET expires_at = $1 WHERE id = $2", [new Date(Date.now() - 25 * 60 * 60 * 1000), session.id]);
    await post("/api/b/1/sync/link-sessions", {});
    expect(await rows("SELECT id FROM plaid_link_sessions")).toEqual([{ id: session.id + 1 }]);
  });

  // The owner finished at Plaid just before the expiry and came back after
  // it. Plaid keeps the result and the public token still works, so the
  // connection is saved, not made again at Plaid.
  it("saves a result that the user finished before the session expired", async () => {
    const { session } = await post("/api/b/1/sync/link-sessions", {});
    await exec("UPDATE plaid_link_sessions SET expires_at = $1 WHERE id = $2", [new Date(Date.now() - 1000), session.id]);
    plaid.replies.linkGet["link-sandbox-1"] = itemAdded("public-late", "Late Bank");
    plaid.replies.exchange["public-late"] = { status: 200, body: { access_token: "access-late", item_id: "item-late", request_id: "r" } };
    plaid.replies.accounts["access-late"] = accounts({ id: "acc-late", name: "Late Checking" });

    // Reopening the modal finds the session past its expiry and completes it,
    // with no new link token.
    const reopened = await post("/api/b/1/sync/link-sessions", {});
    expect(reopened.session).toMatchObject({ id: session.id, status: "complete", financialInstitution: "Late Bank" });
    expect(paths("/link/token/create")).toHaveLength(1);
    expect(await count("plaid_tokens")).toBe(1);
  });

  it("expires a late session whose public token no longer works, with one exchange", async () => {
    const { session } = await post("/api/b/1/sync/link-sessions", {});
    await exec("UPDATE plaid_link_sessions SET expires_at = $1 WHERE id = $2", [new Date(Date.now() - 1000), session.id]);
    plaid.replies.linkGet["link-sandbox-1"] = itemAdded("public-stale", "Late Bank");
    plaid.replies.exchange["public-stale"] = {
      status: 400, body: { error_message: "public token expired", error_code: "INVALID_PUBLIC_TOKEN" },
    };
    const check = `/api/b/1/sync/link-sessions/${session.id}/check`;
    expect((await post(check)).session).toMatchObject({ status: "expired", tokenId: null });
    expect((await post(check)).session).toMatchObject({ status: "expired" });
    expect(paths("/link/token/get")).toHaveLength(1);
    expect(paths("/item/public_token/exchange")).toHaveLength(1);
    expect(await count("plaid_tokens")).toBe(0);
  });

  // A transient Plaid failure is not an answer: a late session stays as it
  // is, and the next check recovers the connection.
  it("recovers a late session after a transient Plaid failure of the lookup or the exchange", async () => {
    const { session } = await post("/api/b/1/sync/link-sessions", {});
    await exec("UPDATE plaid_link_sessions SET expires_at = $1 WHERE id = $2", [new Date(Date.now() - 1000), session.id]);
    const check = `/api/b/1/sync/link-sessions/${session.id}/check`;
    const serverError = { status: 500, body: { error_message: "internal error", error_code: "INTERNAL_SERVER_ERROR" } };

    plaid.replies.linkGet["link-sandbox-1"] = serverError;
    expect((await client.request(check, { method: "POST" })).status).toBe(502);
    expect(await row("SELECT status FROM plaid_link_sessions WHERE id = $1", [session.id])).toEqual({ status: "pending" });

    plaid.replies.linkGet["link-sandbox-1"] = itemAdded("public-retry", "Retry Bank");
    plaid.replies.exchange["public-retry"] = serverError;
    expect((await client.request(check, { method: "POST" })).status).toBe(502);
    expect(await row("SELECT status FROM plaid_link_sessions WHERE id = $1", [session.id])).toEqual({ status: "pending" });

    plaid.replies.exchange["public-retry"] = {
      status: 200, body: { access_token: "access-retry", item_id: "item-retry", request_id: "r" },
    };
    plaid.replies.accounts["access-retry"] = accounts({ id: "acc-retry", name: "Retry Checking" });
    expect((await post(check)).session).toMatchObject({ status: "complete", financialInstitution: "Retry Bank" });
    expect(await count("plaid_tokens")).toBe(1);
  });

  // Item IDs are unique across the installation. An Item that another book
  // stores is a duplicate: the server must not end it at Plaid.
  it("does not remove an Item that another book stores", async () => {
    const stranger = await createUser({ username: "other-owner" });
    const other = await createBook({ name: "Other", userId: stranger.id });
    await createPlaidToken({ financialInstitution: "Shared Bank", itemId: "item-shared", accessToken: "access-other", bookId: other.id });
    const { session } = await post("/api/b/1/sync/link-sessions", {});
    plaid.replies.linkGet["link-sandbox-1"] = itemAdded("public-shared", "Shared Bank");
    plaid.replies.exchange["public-shared"] = {
      status: 200, body: { access_token: "access-new", item_id: "item-shared", request_id: "r" },
    };
    await expectError(`/api/b/1/sync/link-sessions/${session.id}/check`, { method: "POST" }, 409,
      "A token with this itemId already exists");
    expect(paths("/item/remove")).toHaveLength(0);
    expect(await rows("SELECT book_id, access_token FROM plaid_tokens")).toEqual([{ bookId: other.id, accessToken: "access-other" }]);
  });

  // A late session that a failure ended (here a duplicate Item) is not open
  // any more, so opening the modal again starts a new session.
  it("starts a new session after a late session ended with a failure", async () => {
    const stranger = await createUser({ username: "late-owner" });
    const other = await createBook({ name: "Late Other", userId: stranger.id });
    await createPlaidToken({ financialInstitution: "Shared Bank", itemId: "item-late-shared", accessToken: "access-o", bookId: other.id });
    const { session } = await post("/api/b/1/sync/link-sessions", {});
    await exec("UPDATE plaid_link_sessions SET expires_at = $1 WHERE id = $2", [new Date(Date.now() - 1000), session.id]);
    plaid.replies.linkGet["link-sandbox-1"] = itemAdded("public-late-shared", "Shared Bank");
    plaid.replies.exchange["public-late-shared"] = {
      status: 200, body: { access_token: "access-dup", item_id: "item-late-shared", request_id: "r" },
    };
    const reopened = await post("/api/b/1/sync/link-sessions", {});
    expect(reopened.session).toMatchObject({ status: "pending" });
    expect(reopened.session.id).not.toBe(session.id);
    expect(await row("SELECT status FROM plaid_link_sessions WHERE id = $1", [session.id])).toEqual({ status: "failed" });
  });

  // A late session that a transient failure left open can still hold a
  // finished connection, so opening the modal again does not start a second
  // session next to it.
  it("does not start a replacement while a late session cannot be checked", async () => {
    const { session } = await post("/api/b/1/sync/link-sessions", {});
    await exec("UPDATE plaid_link_sessions SET expires_at = $1 WHERE id = $2", [new Date(Date.now() - 1000), session.id]);
    plaid.replies.linkGet["link-sandbox-1"] = {
      status: 500, body: { error_message: "internal error", error_code: "INTERNAL_SERVER_ERROR" },
    };
    const reopened = await client.request("/api/b/1/sync/link-sessions", json("POST", {}));
    expect(reopened.status).toBe(502);
    expect(paths("/link/token/create")).toHaveLength(1);
    expect(await count("plaid_link_sessions")).toBe(1);
    // A restart is the owner's choice: it starts a new session.
    expect((await post("/api/b/1/sync/link-sessions", { restart: true })).session).toMatchObject({ status: "pending" });
    expect(paths("/link/token/create")).toHaveLength(2);
  });

  // After the exchange, the access token is the only one. When the save
  // fails on every try, the server ends the Item at Plaid, so that no
  // connection is left there that the book cannot use or remove.
  it("removes the new Item at Plaid when the connection cannot be saved", async () => {
    const { session } = await post("/api/b/1/sync/link-sessions", {});
    plaid.replies.linkGet["link-sandbox-1"] = itemAdded("public-unsaved", "Locked Bank");
    plaid.replies.exchange["public-unsaved"] = {
      status: 200, body: { access_token: "access-unsaved", item_id: "item-unsaved", request_id: "r" },
    };
    await exec(`CREATE TRIGGER test_refuse_plaid_tokens BEFORE INSERT ON plaid_tokens
                BEGIN SELECT RAISE(ABORT, 'test: the database refuses the save'); END`);
    try {
      await expectError(`/api/b/1/sync/link-sessions/${session.id}/check`, { method: "POST" }, 500,
        "The bank connection could not be saved. The server log has the cause.");
    } finally {
      await exec("DROP TRIGGER test_refuse_plaid_tokens");
    }
    expect(paths("/item/public_token/exchange")).toHaveLength(1);
    expect(paths("/item/remove").map((request) => request.body.access_token)).toEqual(["access-unsaved"]);
    expect(await count("plaid_tokens")).toBe(0);
    expect(await row("SELECT status FROM plaid_link_sessions WHERE id = $1", [session.id])).toEqual({ status: "failed" });
  });

  it("reconnects in update mode and keeps the token id, the account links and the history", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset", subtype: "bank" });
    const token = await createPlaidToken({ financialInstitution: "Tartan Bank", itemId: "item-tartan", accessToken: "access-sandbox-existing", syncCursor: "cursor-7" });
    await exec("UPDATE plaid_tokens SET last_error = $1 WHERE id = $2", ["ITEM_LOGIN_REQUIRED", token.id]);
    const kept = await createPlaidAccount({ tokenId: token.id, plaidAccountId: "keep", name: "Checking", type: "depository", counterpoiseAccountId: checking.id });
    // Plaid no longer reports this account. The reconnect must not delete it.
    const dropped = await createPlaidAccount({ tokenId: token.id, plaidAccountId: "dropped", name: "Old Saving", type: "depository" });
    await createPlaidReconciliation({ plaidAccountLinkId: kept.id, plaidTransactionId: "tx-1", date: "2026-10-01", amountCents: 500, name: "Coffee" });
    await createPlaidReconciliation({ plaidAccountLinkId: dropped.id, plaidTransactionId: "tx-2", date: "2026-10-01", amountCents: 700, name: "Lunch" });

    const started = await post("/api/b/1/sync/link-sessions", { tokenId: token.id, bookId: 99 });
    expect(started.session).toMatchObject({
      mode: "update", status: "pending", tokenId: token.id, financialInstitution: "Tartan Bank",
    });
    expect(started.text).not.toContain("access-sandbox-existing");
    const [create] = paths("/link/token/create");
    expect(create.body).toMatchObject({
      access_token: "access-sandbox-existing", update: { account_selection_enabled: true }, hosted_link: {},
    });
    expect(create.body).not.toHaveProperty("products");
    expect(await scalarBook(started.session.id)).toBe(1);

    // Update mode finishes without a public token.
    plaid.replies.linkGet["link-sandbox-1"] = {
      status: 200,
      body: { link_sessions: [{ link_session_id: "s1", started_at: "2026-10-09T10:00:00Z", finished_at: "2026-10-09T10:03:00Z" }] },
    };
    plaid.replies.accounts["access-sandbox-existing"] = accounts({ id: "keep", name: "Checking" }, { id: "added", name: "New Card" });
    const done = await post(`/api/b/1/sync/link-sessions/${started.session.id}/check`);
    expect(done.session).toMatchObject({ mode: "update", status: "complete", tokenId: token.id, financialInstitution: "Tartan Bank" });
    expect(done.text).not.toContain("access-sandbox-existing");
    expect(paths("/item/public_token/exchange")).toHaveLength(0);

    const [stored] = await rows<PlaidToken & { lastError: string | null }>("SELECT * FROM plaid_tokens");
    expect(stored).toMatchObject({ id: token.id, accessToken: "access-sandbox-existing", itemId: "item-tartan", syncCursor: "cursor-7", lastError: null });
    expect(await rows("SELECT id, plaid_account_id, counterpoise_account_id FROM plaid_accounts ORDER BY plaid_account_id")).toEqual([
      { id: expect.any(Number), plaidAccountId: "added", counterpoiseAccountId: null },
      { id: dropped.id, plaidAccountId: "dropped", counterpoiseAccountId: null },
      { id: kept.id, plaidAccountId: "keep", counterpoiseAccountId: checking.id },
    ]);
    expect(await count("plaid_transaction_reconciliation")).toBe(2);
  });

  it("refuses a caller that is not an owner, a connection of another book, a demo connection and a bad body", async () => {
    const shared = { editor: await sharedBook("editor"), viewer: await sharedBook("viewer") };
    for (const book of Object.values(shared)) {
      await expectError(`/api/b/${book.id}/sync/link-sessions`, json("POST", {}), 403, "Only an owner can do this");
    }
    const stranger = await createUser({ username: "stranger" });
    const other = await createBook({ name: "Other", userId: stranger.id });
    const foreign = await createPlaidToken({ financialInstitution: "Foreign", itemId: "item-f", accessToken: "foreign-token", bookId: other.id });
    await expectError("/api/b/1/sync/link-sessions", json("POST", { tokenId: foreign.id }), 404, "Token not found");
    await expectError(`/api/b/${other.id}/sync/link-sessions`, json("POST", {}), 404, "Book not found");
    const demo = await createPlaidToken({ financialInstitution: "Demo", itemId: "item-demo", accessToken: "demo-token", isDemo: true });
    await expectError("/api/b/1/sync/link-sessions", json("POST", { tokenId: demo.id }), 400, "A demo connection cannot be reconnected");
    for (const tokenId of ["1", 0, -2, 1.5, true]) {
      await expectError("/api/b/1/sync/link-sessions", json("POST", { tokenId }), 400, "tokenId must be a positive integer or null");
    }
    await expectError("/api/b/1/sync/link-sessions", json("POST", []), 400, "The request body must be a JSON object");
    expect(paths("/link/token/create")).toHaveLength(0);

    // A session of another book is not found, also for its owner's id.
    const { session } = await post("/api/b/1/sync/link-sessions", {});
    await addBookMember({ bookId: other.id, userId: 1, role: "owner" });
    await expectError(`/api/b/${other.id}/sync/link-sessions/${session.id}/check`, { method: "POST" }, 404, "Link session not found");
    await expectError("/api/b/1/sync/link-sessions/abc/check", { method: "POST" }, 400, "Invalid link session id");
    await expectError(`/api/b/${shared.viewer.id}/sync/link-sessions/${session.id}/check`, { method: "POST" }, 403, "Only an owner can do this");
  });

  it("reports Plaid failures: a failed create, a failed exchange that stays pending, and a duplicate Item", async () => {
    plaid.replies.createError = { status: 400, body: { error_message: "hosted link is not enabled", error_code: "INVALID_PRODUCT" } };
    await expectError("/api/b/1/sync/link-sessions", json("POST", {}), 502,
      "Plaid /link/token/create request failed: hosted link is not enabled (INVALID_PRODUCT)");
    expect(await count("plaid_link_sessions")).toBe(0);
    plaid.replies.createError = null;

    const { session } = await post("/api/b/1/sync/link-sessions", {});
    const check = `/api/b/1/sync/link-sessions/${session.id}/check`;
    plaid.replies.linkGet["link-sandbox-2"] = itemAdded("public-bad", "Bad Bank");
    plaid.replies.exchange["public-bad"] = { status: 400, body: { error_message: "public token expired", error_code: "INVALID_PUBLIC_TOKEN" } };
    await expectError(check, { method: "POST" }, 502,
      "Plaid /item/public_token/exchange request failed: public token expired (INVALID_PUBLIC_TOKEN)");
    expect(await row("SELECT status FROM plaid_link_sessions WHERE id = $1", [session.id])).toEqual({ status: "pending" });

    // A later check tries again. The Item is one that the book has.
    await createPlaidToken({ financialInstitution: "Same Bank", itemId: "item-same", accessToken: "access-old" });
    plaid.replies.exchange["public-bad"] = { status: 200, body: { access_token: "access-dup-secret", item_id: "item-same" } };
    await expectError(check, { method: "POST" }, 409, "A token with this itemId already exists");
    const failed = await post(check);
    expect(failed.session).toMatchObject({ status: "failed", error: "A token with this itemId already exists", hostedLinkUrl: null });
    expect(failed.text).not.toContain("access-dup-secret");
    expect(await rows("SELECT access_token FROM plaid_tokens")).toEqual([{ accessToken: "access-old" }]);
    expect(paths("/item/public_token/exchange")).toHaveLength(2);
  });

  it("continues the open session of the same connection in place of a new one", async () => {
    const first = await post("/api/b/1/sync/link-sessions", {});
    const again = await post("/api/b/1/sync/link-sessions", { tokenId: null });
    expect(again.session).toEqual(first.session);
    expect(paths("/link/token/create")).toHaveLength(1);
    // The second create asked Plaid for the result of the open session.
    expect(paths("/link/token/get").map((request) => request.body.link_token)).toEqual(["link-sandbox-1"]);

    // A session of another connection is not continued: NULL matches only NULL.
    const token = await createPlaidToken({ financialInstitution: "Tartan Bank", itemId: "item-tartan", accessToken: "access-tartan" });
    const update = await post("/api/b/1/sync/link-sessions", { tokenId: token.id });
    expect(update.session).toMatchObject({ mode: "update", tokenId: token.id, hostedLinkUrl: "https://hosted.plaid.test/link/2" });
    expect(update.session.id).not.toBe(first.session.id);
    expect((await post("/api/b/1/sync/link-sessions", {})).session.id).toBe(first.session.id);
    expect((await post("/api/b/1/sync/link-sessions", { tokenId: token.id })).session.id).toBe(update.session.id);
    expect(paths("/link/token/create")).toHaveLength(2);

    // A Plaid failure for the open session does not fail the create. The
    // session stays as it is.
    plaid.replies.linkGet["link-sandbox-1"] = { status: 500, body: { error_message: "internal", error_code: "INTERNAL_SERVER_ERROR" } };
    expect((await post("/api/b/1/sync/link-sessions", {})).session).toEqual(first.session);
    expect(paths("/link/token/create")).toHaveLength(2);
  });

  it("answers the saved connection when the user finished the open session at Plaid", async () => {
    const first = await post("/api/b/1/sync/link-sessions", {});
    plaid.replies.linkGet["link-sandbox-1"] = itemAdded("public-resumed", "Resumed Bank");
    plaid.replies.exchange["public-resumed"] = { status: 200, body: { access_token: "access-resumed-secret", item_id: "item-resumed" } };
    plaid.replies.accounts["access-resumed-secret"] = accounts({ id: "acc-r", name: "Resumed Checking" });

    const resumed = await post("/api/b/1/sync/link-sessions", {});
    const [token] = await rows<PlaidToken>("SELECT * FROM plaid_tokens");
    expect(token).toMatchObject({ financialInstitution: "Resumed Bank", itemId: "item-resumed" });
    expect(resumed.session).toMatchObject({
      id: first.session.id, status: "complete", tokenId: token.id, financialInstitution: "Resumed Bank", hostedLinkUrl: null,
    });
    expect(resumed.text).not.toContain("access-resumed-secret");
    expect(resumed.text).not.toContain("public-resumed");
    expect(paths("/item/public_token/exchange")).toHaveLength(1);
    expect(paths("/link/token/create")).toHaveLength(1);

    // The complete session is not open, so the next create starts a new one.
    const next = await post("/api/b/1/sync/link-sessions", {});
    expect(next.session).toMatchObject({ status: "pending", hostedLinkUrl: "https://hosted.plaid.test/link/2" });
    expect(paths("/item/public_token/exchange")).toHaveLength(1);
    expect(await count("plaid_tokens")).toBe(1);
  });

  it("starts a new session on restart and expires the open one", async () => {
    const first = await post("/api/b/1/sync/link-sessions", {});

    // When Plaid refuses the new session, the open session stays open.
    plaid.replies.createError = { status: 400, body: { error_message: "rate limit", error_code: "RATE_LIMIT_EXCEEDED" } };
    await expectError("/api/b/1/sync/link-sessions", json("POST", { restart: true }), 502,
      "Plaid /link/token/create request failed: rate limit (RATE_LIMIT_EXCEEDED)");
    expect(await row("SELECT status FROM plaid_link_sessions WHERE id = $1", [first.session.id])).toEqual({ status: "pending" });
    plaid.replies.createError = null;

    const restarted = await post("/api/b/1/sync/link-sessions", { restart: true });
    expect(restarted.session.id).not.toBe(first.session.id);
    expect(restarted.session).toMatchObject({ status: "pending", hostedLinkUrl: "https://hosted.plaid.test/link/3" });
    expect(await rows("SELECT id, status FROM plaid_link_sessions ORDER BY id")).toEqual([
      { id: first.session.id, status: "expired" },
      { id: restarted.session.id, status: "pending" },
    ]);
    expect(paths("/link/token/create")).toHaveLength(3);
    expect((await post(`/api/b/1/sync/link-sessions/${first.session.id}/check`)).session).toMatchObject({ status: "expired" });
  });

  it("takes a stale claim again, and leaves a fresh claim to its request", async () => {
    const stale = await post("/api/b/1/sync/link-sessions", {});
    // The server exited after it took the claim: the claim is 11 minutes old.
    await exec("UPDATE plaid_link_sessions SET status = 'completing', updated_at = $1 WHERE id = $2",
      [new Date(Date.now() - 11 * 60 * 1000), stale.session.id]);
    plaid.replies.linkGet["link-sandbox-1"] = itemAdded("public-stale", "Stale Bank");
    plaid.replies.exchange["public-stale"] = { status: 200, body: { access_token: "access-stale", item_id: "item-stale" } };
    plaid.replies.accounts["access-stale"] = accounts({ id: "acc-s", name: "Stale Checking" });
    const done = await post(`/api/b/1/sync/link-sessions/${stale.session.id}/check`);
    expect(done.session).toMatchObject({ status: "complete", financialInstitution: "Stale Bank" });
    expect(paths("/item/public_token/exchange")).toHaveLength(1);

    const fresh = await post("/api/b/1/sync/link-sessions", {});
    await exec("UPDATE plaid_link_sessions SET status = 'completing', updated_at = $1 WHERE id = $2",
      [new Date(Date.now() - 60 * 1000), fresh.session.id]);
    plaid.replies.linkGet["link-sandbox-2"] = itemAdded("public-fresh", "Fresh Bank");
    plaid.replies.exchange["public-fresh"] = { status: 200, body: { access_token: "access-fresh", item_id: "item-fresh" } };
    const calls = plaid.requests.length;
    // The client sees a claim as pending, and no request goes to Plaid.
    const checked = await post(`/api/b/1/sync/link-sessions/${fresh.session.id}/check`);
    expect(checked.session).toEqual(fresh.session);
    expect((await post("/api/b/1/sync/link-sessions", {})).session).toEqual(fresh.session);
    expect(plaid.requests).toHaveLength(calls);
    expect(await row("SELECT status FROM plaid_link_sessions WHERE id = $1", [fresh.session.id])).toEqual({ status: "completing" });
  });

  it("refuses a restart that is not a boolean", async () => {
    for (const restart of [null, "true", 1, {}]) {
      await expectError("/api/b/1/sync/link-sessions", json("POST", { restart }), 400, "restart must be a boolean");
    }
    expect(paths("/link/token/create")).toHaveLength(0);
    expect(await count("plaid_link_sessions")).toBe(0);
  });

  it("continues one session when two creates for one connection run at the same time", async () => {
    // Both requests find no open session, and both wait for Plaid.
    const release = plaid.hold("/link/token/create", 2);
    const first = post("/api/b/1/sync/link-sessions", {});
    const second = post("/api/b/1/sync/link-sessions", {});
    inFlight.push(first, second);
    await plaid.arrived("/link/token/create", 2);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(b.session).toEqual(a.session);
    expect(a.session.status).toBe("pending");
    // The second link token is not used. No session holds it.
    expect(await rows("SELECT id, status FROM plaid_link_sessions")).toEqual([{ id: a.session.id, status: "pending" }]);
    expect(paths("/link/token/create")).toHaveLength(2);
  });

  it("does not expire a live claim on restart: the claimed session completes", async () => {
    const started = await post("/api/b/1/sync/link-sessions", {});
    plaid.replies.linkGet["link-sandbox-1"] = itemAdded("public-live", "Live Bank");
    plaid.replies.exchange["public-live"] = { status: 200, body: { access_token: "access-live", item_id: "item-live" } };
    plaid.replies.accounts["access-live"] = accounts({ id: "acc-l", name: "Live Checking" });

    // A check claims the session and waits for the exchange.
    const release = plaid.hold("/item/public_token/exchange", 1);
    const checking = post(`/api/b/1/sync/link-sessions/${started.session.id}/check`);
    inFlight.push(checking);
    await plaid.arrived("/item/public_token/exchange", 1);
    expect(await row("SELECT status FROM plaid_link_sessions WHERE id = $1", [started.session.id])).toEqual({ status: "completing" });

    // The restart answers the live claim, which the client sees as pending.
    const restarted = await post("/api/b/1/sync/link-sessions", { restart: true });
    expect(restarted.session).toMatchObject({ id: started.session.id, status: "pending" });
    expect(paths("/link/token/create")).toHaveLength(2);

    // A check after the session expired does not expire the live claim.
    await exec("UPDATE plaid_link_sessions SET expires_at = $1 WHERE id = $2", [new Date(Date.now() - 1000), started.session.id]);
    expect((await post(`/api/b/1/sync/link-sessions/${started.session.id}/check`)).session).toMatchObject({ status: "pending" });
    expect(await row("SELECT status FROM plaid_link_sessions WHERE id = $1", [started.session.id])).toEqual({ status: "completing" });

    // A restart after the session expired also answers the live claim, and
    // starts no second session next to it.
    const late = await post("/api/b/1/sync/link-sessions", { restart: true });
    expect(late.session).toMatchObject({ id: started.session.id, status: "pending" });

    release();
    const done = await checking;
    const [token] = await rows<PlaidToken>("SELECT * FROM plaid_tokens");
    expect(token).toMatchObject({ itemId: "item-live", accessToken: "access-live" });
    expect(done.session).toMatchObject({ id: started.session.id, status: "complete", tokenId: token.id });
    expect(await rows("SELECT id, status FROM plaid_link_sessions")).toEqual([{ id: started.session.id, status: "complete" }]);
    expect(paths("/item/public_token/exchange")).toHaveLength(1);
  });

  it("saves the connection of a stale claim that a restart expired, and keeps the session expired", async () => {
    const started = await post("/api/b/1/sync/link-sessions", {});
    plaid.replies.linkGet["link-sandbox-1"] = itemAdded("public-slow", "Slow Bank");
    plaid.replies.exchange["public-slow"] = { status: 200, body: { access_token: "access-slow", item_id: "item-slow" } };
    plaid.replies.accounts["access-slow"] = accounts({ id: "acc-slow", name: "Slow Checking" });

    const release = plaid.hold("/item/public_token/exchange", 1);
    const checking = post(`/api/b/1/sync/link-sessions/${started.session.id}/check`);
    inFlight.push(checking);
    await plaid.arrived("/item/public_token/exchange", 1);
    // The exchange takes longer than the lease, so the claim is stale. Plaid
    // refuses a second exchange of the public token.
    await exec("UPDATE plaid_link_sessions SET updated_at = $1 WHERE id = $2",
      [new Date(Date.now() - 11 * 60 * 1000), started.session.id]);
    plaid.replies.exchange["public-slow"] = { status: 400, body: { error_message: "used", error_code: "INVALID_PUBLIC_TOKEN" } };

    // The restart takes the stale claim, fails the exchange, gives the claim
    // back, expires the session and starts a new one.
    const restarted = await post("/api/b/1/sync/link-sessions", { restart: true });
    expect(restarted.session).toMatchObject({ status: "pending", hostedLinkUrl: "https://hosted.plaid.test/link/2" });
    expect(restarted.session.id).not.toBe(started.session.id);
    expect(paths("/item/public_token/exchange")).toHaveLength(2);
    expect(await count("plaid_tokens")).toBe(0);

    // The first exchange gave an access token: the connection is saved.
    release();
    const done = await checking;
    expect(await rows("SELECT item_id, access_token FROM plaid_tokens")).toEqual([{ itemId: "item-slow", accessToken: "access-slow" }]);
    expect(done.session).toMatchObject({ id: started.session.id, status: "expired" });
    expect(await rows("SELECT id, status, result_token_id FROM plaid_link_sessions ORDER BY id")).toEqual([
      { id: started.session.id, status: "expired", resultTokenId: null },
      { id: restarted.session.id, status: "pending", resultTokenId: null },
    ]);
  });

  /** The book of a session. */
  async function scalarBook(id: number) {
    return (await row<{ bookId: number }>("SELECT book_id FROM plaid_link_sessions WHERE id = $1", [id])).bookId;
  }
});
