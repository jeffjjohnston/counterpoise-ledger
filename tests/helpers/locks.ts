import { sql } from "drizzle-orm";
import type { AppDb } from "../../db";

/** Observe the actual contested insert, rather than guessing how long it takes. */
export async function waitForBlockedInsert(db: AppDb, table: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await db.execute<{ blocked: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND query ILIKE ${`insert into "${table}"%`}
      ) AS blocked`);
    if (rows[0].blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for a blocked insert into ${table}`);
}

/**
 * Wait until at least `count` sessions wait for a lock in a query that matches
 * `queryPattern` (an ILIKE pattern). The test then knows those transactions are open.
 */
export async function waitForBlockedQueries(
  db: AppDb,
  queryPattern: string,
  count = 1,
  timeoutMs = 10_000
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await db.execute<{ blocked: number }>(sql`
      SELECT count(*)::int AS blocked FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'
        AND query ILIKE ${queryPattern}`);
    if (rows[0].blocked >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${count} blocked queries that match ${queryPattern}`);
}

type HeldTransaction = Parameters<Parameters<AppDb["transaction"]>[0]>[0];

/**
 * Run `work` in a transaction, then keep that transaction open. The locks that
 * `work` takes stay held until the test calls `release()`. Call `release()` in
 * a `finally` block, then await `done`.
 */
export async function holdTransaction(
  db: AppDb,
  work: (tx: HeldTransaction) => Promise<unknown>
): Promise<{ release: () => void; done: Promise<void> }> {
  let release = () => {};
  const mayCommit = new Promise<void>((resolve) => {
    release = resolve;
  });
  let markHeld = () => {};
  const held = new Promise<void>((resolve) => {
    markHeld = resolve;
  });
  const done = db.transaction(async (tx) => {
    await work(tx);
    markHeld();
    await mayCommit;
  });
  // If `work` fails, `done` rejects and the race gives that error.
  await Promise.race([held, done]);
  return { release, done };
}
