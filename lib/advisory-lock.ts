import { getDbForConnection, getSqlClient_raw, type AppDb } from "@/db";

/**
 * Namespace for the two-int4 form of pg_advisory_lock, which keys a lock on
 * (namespace, id). rebuildLots in lib/lots-db.ts uses the same form with
 * (accountId, securityId) — real row ids, which are small — so a namespace far
 * above any plausible account id cannot collide with it.
 */
export const PLAID_SYNC_LOCK_NAMESPACE = 1_000_001;

export type AdvisoryLockResult<T> =
  | { acquired: true; value: T }
  | { acquired: false };

/**
 * Run `fn` while holding a SESSION-scoped advisory lock, or report that
 * someone else holds it. Never waits: a caller that cannot have the lock is
 * told immediately rather than queued, because the work these locks guard is
 * "refresh from an upstream API", and running it again the moment the first
 * run finishes is precisely the duplicate work the lock exists to avoid.
 *
 * Session-scoped, not transaction-scoped (pg_advisory_xact_lock, which
 * lib/lots-db.ts uses), because the guarded work spans HTTP calls to a third
 * party. A transaction-scoped lock would mean holding a database transaction
 * open across those calls, which blocks vacuum and pins a connection for the
 * duration of somebody else's outage.
 *
 * The lock therefore needs a connection of its own for its whole life: a
 * session lock belongs to the session that took it, and postgres.js hands out
 * pooled connections per statement, so an unreserved release could easily run
 * on a different connection and silently fail to release anything. `reserve()`
 * pins one connection until `release()`.
 *
 * `fn` receives a Drizzle instance bound to that reserved connection and MUST
 * use it rather than the shared pool. Reaching back into the pool while holding
 * a reserved connection needs two connections per holder, so enough concurrent
 * holders reserve every connection in the pool and then wait forever for the
 * second one they still need — verified as a hard deadlock at 12 holders
 * against a pool of 10, from which the process could not even shut down.
 * Running the work on the reserved connection caps each holder at one
 * connection, so exceeding the pool size merely queues.
 *
 * Locks are scoped to the current database, so per-worker test databases do not
 * contend with each other, and a crashed process drops its connection, which
 * releases the lock — there is no stale lock to clean up.
 */
export async function withAdvisoryLock<T>(
  namespace: number,
  key: number,
  fn: (db: AppDb) => Promise<T>
): Promise<AdvisoryLockResult<T>> {
  const connection = await getSqlClient_raw().reserve();
  try {
    const [row] = await connection<[{ locked: boolean }]>`
      select pg_try_advisory_lock(${namespace}, ${key}) as locked
    `;
    if (!row.locked) return { acquired: false };

    try {
      return { acquired: true, value: await fn(getDbForConnection(connection)) };
    } finally {
      await connection`select pg_advisory_unlock(${namespace}, ${key})`;
    }
  } finally {
    connection.release();
  }
}
