import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  addBookMember, createAccount, createBook, createPayee, createUser, resetTestDatabase, setupTestDatabase,
} from "../helpers/db-utils";
import { count, exec, insert, script, transaction } from "../helpers/sql";
import { generateApiKey, hashApiKey } from "../helpers/api-keys";
import { onWorker, sessionHttpClient, startHttpTestServer } from "../helpers/http-parity";
import { changeHint, openSocket, sortedHint } from "../helpers/book-socket";

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

/**
 * How long a close that the server starts may take. workerd sends the close
 * frame at once but leaves the connection for the client to end, and Node's
 * WebSocket reports the close only when its 10-second wait for that ends.
 */
const SERVER_CLOSE_MS = onWorker ? 15_000 : 5000;

// Triggers count the row changes of each book and table, and the server
// polls the counts while a socket is open. So a write from any connection
// sends a hint: the server's, and this process's node:sqlite writes too.
describe("book socket HTTP parity", () => {
  let baseUrl: string;
  let stop: () => Promise<void>;
  let client: Awaited<ReturnType<typeof sessionHttpClient>>;
  const sockets: ReturnType<typeof openSocket>[] = [];

  beforeAll(async () => {
    await setupTestDatabase();
    ({ baseUrl, stop } = await startHttpTestServer());
  }, 120_000);

  beforeEach(async () => {
    while (sockets.length) sockets.pop()!.close();
    await resetTestDatabase();
    client = await sessionHttpClient(baseUrl);
  });

  afterAll(async () => {
    while (sockets.length) sockets.pop()!.close();
    await stop?.();
  });

  /** Opens the socket of a book, reads `ready`, then the hints of earlier writes. */
  async function listen(bookId: number, headers: Record<string, string> = { cookie: client.cookie }) {
    const socket = openSocket(`${baseUrl.replace(/^http/, "ws")}/api/b/${bookId}/socket`, headers);
    sockets.push(socket);
    expect(await socket.next()).toEqual({ type: "ready" });
    await socket.settle();
    return socket;
  }

  async function ok(path: string, init: RequestInit) {
    const response = await client.request(path, init);
    expect(response.status, `${init.method} ${path}`).toBe(200);
    return response.json();
  }

  async function spendFixture() {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const food = await createAccount({ name: "Food", type: "expense" });
    return (amount: number, payeeName: string) => ({
      date: "2025-03-01", payeeName,
      splits: [{ accountId: checking.id, amount: -amount }, { accountId: food.id, amount }],
    });
  }

  it("authenticates before it upgrades", async () => {
    const other = await createBook({ name: "Other" });
    await exec("DELETE FROM book_members WHERE book_id = $1", [other.id]);
    for (const [path, status, body] of [
      [`/api/b/${other.id}/socket`, 404, { error: "Book not found" }],
      ["/api/b/999999/socket", 404, { error: "Book not found" }],
      ["/api/b/invalid/socket", 400, { error: "Invalid book ID" }],
    ] as const) {
      const response = await client.request(path);
      expect(response.status, path).toBe(status);
      expect(await response.json()).toEqual(body);
    }
    expect((await client.anonymous("/api/b/1/socket")).status).toBe(401);
    // An allowed request that is not an upgrade.
    const plain = await client.request("/api/b/1/socket");
    expect([plain.status, await plain.text()]).toEqual([400, "Connection header did not include 'upgrade'"]);
  });

  it("refuses a cookie sent from another site", async () => {
    const response = await client.request("/api/b/1/socket", { headers: { "sec-fetch-site": "cross-site" } });
    expect([response.status, await response.json()]).toEqual([403, { error: "Cross-origin request rejected" }]);
    const origin = await client.request("/api/b/1/socket", { headers: { origin: "https://elsewhere.example" } });
    expect(origin.status).toBe(403);
  });

  it("sends ready, then a hint for each write to the book", async () => {
    const socket = await listen(1);
    const response = await client.request("/api/b/1/payees", json("POST", { name: "Grocer" }));
    expect(response.status).toBe(200);
    expect(await socket.next()).toEqual({ type: "change", tables: ["payees"] });
    // The server answers a client's close: 1006 would be an abnormal end.
    socket.close(1000);
    expect((await socket.closed()).code).toBe(1000);
  });

  it("lets a viewer listen", async () => {
    const viewer = await createUser({ username: "viewer" });
    await addBookMember({ bookId: 1, userId: viewer.id, role: "viewer" });
    const asViewer = await sessionHttpClient(baseUrl, viewer.id);
    const socket = await listen(1, { cookie: asViewer.cookie });
    await client.request("/api/b/1/accounts", json("POST", { name: "Seen", type: "asset" }));
    expect(await socket.next()).toEqual({ type: "change", tables: ["accounts"] });
  });

  it("closes the socket of a deleted API key", async () => {
    const key = generateApiKey();
    await insert("api_keys", { userId: 1, name: "Phone", keyHash: await hashApiKey(key), keyPrefix: key.slice(0, 8) });
    const [{ id }] = await (await client.request("/api/auth/api-keys")).json() as { id: number }[];
    const socket = await listen(1, { authorization: `Bearer ${key}` });
    const deleted = await client.request(`/api/auth/api-keys/${id}`, { method: "DELETE" });
    expect(await deleted.json()).toEqual({ success: true });
    expect(await socket.closed(SERVER_CLOSE_MS)).toEqual({ code: 4401, reason: "Not authenticated" });
  });

  it("closes the socket of a session that logs out", async () => {
    const socket = await listen(1);
    const logout = await client.request("/api/auth/logout", { method: "POST" });
    expect(await logout.json()).toEqual({ success: true });
    expect(await socket.closed(SERVER_CLOSE_MS)).toEqual({ code: 4401, reason: "Not authenticated" });
  });

  it("closes the socket of a user who leaves the book", async () => {
    const viewer = await createUser({ username: "viewer" });
    await addBookMember({ bookId: 1, userId: viewer.id, role: "viewer" });
    const asViewer = await sessionHttpClient(baseUrl, viewer.id);
    const socket = await listen(1, { cookie: asViewer.cookie });
    // Another connection removes the member: the hint names book_members.
    await exec("DELETE FROM book_members WHERE book_id = 1 AND user_id = $1", [viewer.id]);
    // The Worker's object checks its sockets after each of its events, and
    // on Cloudflare every write is one. This write went to its file, so a
    // request makes the event.
    if (onWorker) await client.request("/api/health");
    const closed = await socket.closed(SERVER_CLOSE_MS);
    expect(closed).toEqual({ code: 4404, reason: "Book not found" });
  });

  // The writes of this process reach the Worker's object only through its
  // requests, so these run against the native server.
  it.skipIf(onWorker)("sends windowed hints for this book only", async () => {
    const other = await createBook({ name: "Other" });
    const spend = await spendFixture();
    const socket = await listen(1);
    const otherSocket = await listen(other.id);
    // A write to another book goes to the socket of that book only. It uses
    // a table that the write to book 1 does not touch, so a leak into this
    // socket cannot hide in the same hint.
    await ok(`/api/b/${other.id}/accounts`, json("POST", { name: "Elsewhere", type: "asset" }));
    // One commit writes a payee, a transaction and two splits: one hint,
    // with each table once.
    await ok("/api/b/1/transactions", json("POST", spend(500, "Grocer")));
    expect(sortedHint(await socket.next())).toEqual(changeHint("payees", "transaction_splits", "transactions"));
    expect(await otherSocket.next()).toEqual(changeHint("accounts"));

    // Two commits in quick succession fall in one window: one hint.
    await createPayee({ name: "Direct" });
    await createAccount({ name: "Direct", type: "asset" });
    expect(sortedHint(await socket.next())).toEqual(changeHint("accounts", "payees"));

    // The window closes after it sends its hint. The next write opens a new one.
    await ok("/api/b/1/payees", json("POST", { name: "Later" }));
    expect(await socket.next()).toEqual(changeHint("payees"));
  });

  it("names the investment tables when a security, a price or a trade changes", async () => {
    const brokerage = await createAccount({ name: "Brokerage", type: "asset", subtype: "investment" });
    const checking = await createAccount({ name: "Checking", type: "asset", subtype: "bank" });
    const socket = await listen(1);
    const security = await ok("/api/b/1/securities", json("POST", { name: "Total Market", symbol: "VTI", securityType: "etf" }));
    expect(await socket.next()).toEqual(changeHint("securities"));

    await ok("/api/b/1/security-prices/bulk", json("POST", {
      priceUpdates: [{ securityId: security.id, priceMicros: 5_000_000, priceDate: "2025-01-10" }],
    }));
    expect(await socket.next()).toEqual(changeHint("security_prices"));

    // The write path rebuilds the lots in the same commit as the trade.
    await ok("/api/b/1/transactions", json("POST", {
      date: "2025-01-11",
      splits: [{ accountId: brokerage.id, amount: 5_000 }, { accountId: checking.id, amount: -5_000 }],
      investmentSplits: [{ securityId: security.id, action: "buy", sharesMicros: 1_000_000, priceMicros: 5_000_000 }],
    }));
    expect(sortedHint(await socket.next())).toEqual(
      changeHint("investment_lots", "investment_splits", "transaction_splits", "transactions"),
    );
  });

  it.skipIf(onWorker)("sends nothing for a write that rolls back", async () => {
    const spend = await spendFixture();
    const socket = await listen(1);
    // The splits come after the payee and the transaction. Make them fail,
    // so that the server rolls back rows that it already wrote.
    await script(`CREATE TRIGGER fail_split BEFORE INSERT ON transaction_splits
      WHEN NEW.amount = 777 BEGIN SELECT RAISE(ABORT, 'split refused'); END;`);
    try {
      const failed = await client.request("/api/b/1/transactions", json("POST", spend(777, "Rolled Back")));
      expect(failed.status).toBe(500);
      expect(await count("transactions")).toBe(0);
      expect(await count("payees")).toBe(0);
      // A rollback on another connection is silent too.
      await expect(transaction(async (tx) => {
        await tx.insert("securities", { bookId: 1, name: "Gone", symbol: "GONE", securityType: "etf" });
        throw new Error("roll back");
      })).rejects.toThrow("roll back");

      // A hint of a rolled-back write would come before this one or in it.
      await ok("/api/b/1/accounts", json("POST", { name: "After", type: "asset" }));
      expect(await socket.next()).toEqual(changeHint("accounts"));
    } finally {
      await script("DROP TRIGGER IF EXISTS fail_split");
    }
  });

  it("sends each hint to every socket of the book", async () => {
    const first = await listen(1);
    const second = await listen(1);
    await ok("/api/b/1/payees", json("POST", { name: "Both" }));
    expect(await first.next()).toEqual(changeHint("payees"));
    expect(await second.next()).toEqual(changeHint("payees"));
  });
});
