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
