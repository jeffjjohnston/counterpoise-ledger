import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { accounts, payees } from "../../db/schema";
import { createBook, createPayee, db, resetTestDatabase, setupTestDatabase } from "../helpers/db-utils";
import { sessionHttpClient, startHttpTestServer } from "../helpers/http-parity";

type Frame = { event?: string; data?: string; comment?: string };

/** Reads SSE frames from a real response body, one blank-line block at a time. */
function frameReader(response: Response) {
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffered = "";
  return {
    async next(timeoutMs = 5000): Promise<Frame | undefined> {
      const deadline = Date.now() + timeoutMs;
      while (!buffered.includes("\n\n")) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error(`No SSE frame within ${timeoutMs} ms; buffered ${JSON.stringify(buffered)}`);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const chunk = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("SSE read timed out")), remaining); }),
        ]).finally(() => clearTimeout(timer));
        if (chunk.done) return undefined;
        buffered += chunk.value;
      }
      const end = buffered.indexOf("\n\n");
      const block = buffered.slice(0, end);
      buffered = buffered.slice(end + 2);
      const frame: Frame = {};
      for (const line of block.split("\n")) {
        if (line.startsWith(":")) frame.comment = line.slice(1).trim();
        else if (line.startsWith("event: ")) frame.event = line.slice(7);
        else if (line.startsWith("data: ")) frame.data = line.slice(6);
      }
      return frame;
    },
    cancel: () => reader.cancel(),
  };
}

async function listenerPids(): Promise<number[]> {
  const rows = await db.execute<{ pid: number }>(sql`
    SELECT pid FROM pg_stat_activity
    WHERE datname = current_database() AND lower(query) = 'listen "counterpoise_changes"'
  `);
  return rows.map((row) => row.pid);
}

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

  it("enforces read membership and rejects invalid book IDs before streaming", async () => {
    const other = await createBook({ name: "Other" });
    await db.execute(sql`DELETE FROM book_members WHERE book_id = ${other.id}`);
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

  it("streams ready, then windowed hints for this book only, then reset after a lost listener", async () => {
    const other = await createBook({ name: "Other" });
    const response = await client.request("/api/b/1/events");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-cache, no-store, no-transform");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    const frames = frameReader(response);
    try {
      expect(await frames.next()).toEqual({ event: "ready", data: "{}" });

      // Hints for another book never reach this stream. Hints that arrive
      // inside one window make one frame, with each table once, in first-seen order.
      await db.transaction(async (tx) => {
        await tx.insert(payees).values({ bookId: other.id, name: "Elsewhere" });
        await tx.insert(accounts).values({ bookId: 1, name: "Checking", type: "asset" });
        await tx.insert(payees).values({ bookId: 1, name: "Grocer" });
        await tx.insert(accounts).values({ bookId: 1, name: "Savings", type: "asset" });
      });
      expect(await frames.next()).toEqual({ event: "change", data: '{"tables":["accounts","payees"]}' });

      // Losing the LISTEN connection loses the hints of the gap, so the
      // server must send reset once it listens again.
      const [pid] = await listenerPids();
      expect(pid).toEqual(expect.any(Number));
      await db.execute(sql`SELECT pg_terminate_backend(${pid})`);
      let frame = await frames.next(15_000);
      // A hint can arrive in the same window as the termination.
      while (frame?.event === "change") frame = await frames.next(15_000);
      expect(frame).toEqual({ event: "reset", data: '{"tables":[]}' });
      await expect.poll(listenerPids, { timeout: 10_000 }).toHaveLength(1);
      await createPayee({ name: "After reconnect" });
      expect(await frames.next()).toEqual({ event: "change", data: '{"tables":["payees"]}' });
    } finally {
      await frames.cancel();
    }
  }, 60_000);

  it("shares one LISTEN connection between streams", async () => {
    const first = frameReader(await client.request("/api/b/1/events"));
    const second = frameReader(await client.request("/api/b/1/events"));
    try {
      expect((await first.next())?.event).toBe("ready");
      expect((await second.next())?.event).toBe("ready");
      expect(await listenerPids()).toHaveLength(1);
      await createPayee({ name: "Both" });
      expect(await first.next()).toEqual({ event: "change", data: '{"tables":["payees"]}' });
      expect(await second.next()).toEqual({ event: "change", data: '{"tables":["payees"]}' });
    } finally {
      await first.cancel();
      await second.cancel();
    }
  });
});
