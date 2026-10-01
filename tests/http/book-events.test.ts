import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAccount, createBook, createPayee, resetTestDatabase, setupTestDatabase } from "../helpers/db-utils";
import { count, exec, script, transaction } from "../helpers/sql";
import { sessionHttpClient, startHttpTestServer } from "../helpers/http-parity";
import { changeFrame, changeTables, frameReader, settle } from "../helpers/sse-frames";

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

// Triggers count the row changes of each book and table, and the server
// polls the counts while a stream is open. So a write from any connection
// sends a hint: the server's, and this process's node:sqlite writes too.
describe("book events HTTP parity", () => {
  let baseUrl: string;
  let stop: () => Promise<void>;
  let client: Awaited<ReturnType<typeof sessionHttpClient>>;

  beforeAll(async () => {
    await setupTestDatabase();
    ({ baseUrl, stop } = await startHttpTestServer());
  }, 120_000);

  beforeEach(async () => {
    await resetTestDatabase();
    client = await sessionHttpClient(baseUrl);
  });

  afterAll(async () => { await stop?.(); });

  async function ok(path: string, init: RequestInit) {
    const response = await client.request(path, init);
    expect(response.status, `${init.method} ${path}`).toBe(200);
    return response.json();
  }

  /** Opens the stream of a book and reads `ready`. Then waits until the hints of earlier writes have arrived. */
  async function listen(bookId: number) {
    const response = await client.request(`/api/b/${bookId}/events`);
    expect(response.status).toBe(200);
    const frames = frameReader(response);
    expect(await frames.next()).toEqual({ event: "ready", data: "{}" });
    await settle(frames);
    return frames;
  }

  async function spendFixture() {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const food = await createAccount({ name: "Food", type: "expense" });
    return (amount: number, payeeName: string) => ({
      date: "2025-03-01", payeeName,
      splits: [{ accountId: checking.id, amount: -amount }, { accountId: food.id, amount }],
    });
  }

  it("enforces read membership and rejects invalid book IDs before streaming", async () => {
    const other = await createBook({ name: "Other" });
    await exec("DELETE FROM book_members WHERE book_id = $1", [other.id]);
    for (const [path, status, body] of [
      [`/api/b/${other.id}/events`, 404, { error: "Book not found" }],
      ["/api/b/999999/events", 404, { error: "Book not found" }],
      ["/api/b/invalid/events", 400, { error: "Invalid book ID" }],
    ] as const) {
      const response = await client.request(path);
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual(body);
    }
    expect((await client.anonymous("/api/b/1/events")).status).toBe(401);
  });

  it("streams ready, then windowed hints for this book only", async () => {
    const other = await createBook({ name: "Other" });
    const spend = await spendFixture();
    const response = await client.request("/api/b/1/events");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-cache, no-store, no-transform");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    const frames = frameReader(response);
    try {
      expect(await frames.next()).toEqual({ event: "ready", data: "{}" });
      await settle(frames);
      const otherFrames = await listen(other.id);
      try {
        // A write to another book goes to the stream of that book only. It
        // uses a table that the write to book 1 does not touch, so a leak
        // into this stream cannot hide in the same frame.
        await ok(`/api/b/${other.id}/accounts`, json("POST", { name: "Elsewhere", type: "asset" }));
        // One commit writes a payee, a transaction and two splits: one
        // frame, with each table once.
        await ok("/api/b/1/transactions", json("POST", spend(500, "Grocer")));
        expect(changeTables(await frames.next())).toEqual({
          event: "change", tables: ["payees", "transaction_splits", "transactions"],
        });
        expect(await otherFrames.next()).toEqual(changeFrame("accounts"));
      } finally {
        await otherFrames.cancel();
      }

      // Two commits in quick succession fall in one window: one frame.
      await createPayee({ name: "Direct" });
      await createAccount({ name: "Direct", type: "asset" });
      expect(changeTables(await frames.next())).toEqual({ event: "change", tables: ["accounts", "payees"] });

      // The window closes after it sends its frame. The next write opens a new one.
      await ok("/api/b/1/payees", json("POST", { name: "Later" }));
      expect(await frames.next()).toEqual(changeFrame("payees"));
    } finally {
      await frames.cancel();
    }
  });

  it("sends nothing for a write that rolls back", async () => {
    const spend = await spendFixture();
    const frames = await listen(1);
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

      // A hint of a rolled-back write would come before this frame or in it.
      await ok("/api/b/1/accounts", json("POST", { name: "After", type: "asset" }));
      expect(await frames.next()).toEqual(changeFrame("accounts"));
    } finally {
      await script("DROP TRIGGER IF EXISTS fail_split");
      await frames.cancel();
    }
  });

  it("sends each hint to every stream of the book", async () => {
    const first = await listen(1);
    const second = await listen(1);
    try {
      await ok("/api/b/1/payees", json("POST", { name: "Both" }));
      expect(await first.next()).toEqual(changeFrame("payees"));
      expect(await second.next()).toEqual(changeFrame("payees"));
    } finally {
      await first.cancel();
      await second.cancel();
    }
  });
});
