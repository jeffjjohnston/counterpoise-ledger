import { drizzle, type PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { type PgDatabase } from "drizzle-orm/pg-core";
import postgres from "postgres";
import * as schema from "./schema";
import { MIGRATIONS_FOLDER } from "./create-book";

const connectionString =
  process.env.DATABASE_URL ||
  "postgresql://counterpoise:counterpoise@localhost:5432/counterpoise_dev";

declare global {
  var __counterpoiseSql: ReturnType<typeof postgres> | undefined;
  var __counterpoiseDrizzle: ReturnType<typeof drizzle<typeof schema>> | undefined;
  var __counterpoiseMigrated: boolean | undefined;
}

function shouldSuppressDbNotices() {
  return process.env.NODE_ENV === "test" && process.env.DB_VERBOSE !== "1";
}

function getSqlClient() {
  if (!globalThis.__counterpoiseSql) {
    globalThis.__counterpoiseSql = postgres(connectionString, {
      onnotice: shouldSuppressDbNotices() ? () => {} : undefined,
      connection: {
        // CURRENT_DATE is evaluated in the session's timezone, and the official
        // postgres image hardcodes `timezone = 'UTC'` in postgresql.conf — the
        // TZ environment variable sets the OS clock and log timestamps but not
        // this. Without pinning it, effectiveDateSql resolves "today" in UTC
        // while every JS path uses local time, so floating transactions move to
        // tomorrow in balances, reports and ordering between local evening and
        // UTC midnight, then correct themselves overnight.
        //
        // Derived from Intl rather than process.env.TZ because Intl reports the
        // zone `new Date()` actually uses, whether TZ is set explicitly (the
        // containers) or inherited from the OS (a developer machine, CI). The
        // requirement is not "a configured zone" but "the same zone as JS".
        TimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
    });
  }
  return globalThis.__counterpoiseSql;
}

export function getDb() {
  if (!globalThis.__counterpoiseDrizzle) {
    const sql = getSqlClient();
    globalThis.__counterpoiseDrizzle = drizzle(sql, { schema });
  }
  return globalThis.__counterpoiseDrizzle;
}

/**
 * Run pending migrations. Call in seed/test scripts.
 */
export async function runMigrations() {
  if (globalThis.__counterpoiseMigrated) return;
  const db = getDb();
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  globalThis.__counterpoiseMigrated = true;
}

/**
 * Get the raw postgres.js client for cases that need it (seed, tests).
 */
export function getSqlClient_raw() {
  return getSqlClient();
}

/** The postgres.js client type, including the reserved connections it hands out. */
export type PostgresClient = ReturnType<typeof getSqlClient>;
export type ReservedConnection = Awaited<ReturnType<PostgresClient["reserve"]>>;

/**
 * Give a reserved connection the transaction methods Drizzle expects.
 *
 * `db.transaction()` on the postgres-js driver is `this.client.begin(...)`, and
 * a nested transaction is `this.session.client.savepoint(...)`. postgres.js
 * defines neither on a reserved connection — `begin` belongs to the pool, whose
 * whole job there is to obtain a connection of its own to pin the transaction
 * to — so an ungrafted reserved connection fails every `db.transaction()` with
 * "this.client.begin is not a function". That is not a corner: auto-matching a
 * Plaid transaction claims each row in a transaction, so the gap disabled
 * auto-matching outright while leaving the rest of a sync working.
 *
 * A reserved connection already IS the single pinned session that `begin` goes
 * looking for, so issuing the transaction control statements on it directly is
 * equivalent, and the callback keeps running on that same connection. Both exit
 * paths must close the transaction before the connection can be released back
 * to the pool: one returned mid-transaction would fail every later borrower
 * with "current transaction is aborted". A savepoint is left in place on
 * success rather than released, matching what postgres.js itself does.
 */
function addTransactionSupport(connection: ReservedConnection) {
  let savepoints = 0;

  async function scope<T>(
    fn: (client: ReservedConnection) => Promise<T>,
    name?: string
  ): Promise<T> {
    await (name ? connection`savepoint ${connection(name)}` : connection`begin`);
    try {
      const result = await fn(connection);
      if (!name) await connection`commit`;
      return result;
    } catch (error) {
      await (name ? connection`rollback to ${connection(name)}` : connection`rollback`);
      throw error;
    }
  }

  Object.assign(connection, {
    begin: <T>(fn: (client: ReservedConnection) => Promise<T>) => scope(fn),
    // Named the way postgres.js names its own, so a nested transaction reads
    // the same in a query log whichever connection it ran on.
    savepoint: <T>(fn: (client: ReservedConnection) => Promise<T>) =>
      scope(fn, `s${savepoints++}`),
  });
}

/**
 * A Drizzle instance bound to ONE reserved connection rather than the pool.
 *
 * For code that has reserved a connection and must not reach back into the pool
 * while holding it — see lib/advisory-lock.ts, where doing so deadlocks. Every
 * query issued through the returned instance runs on `connection`.
 *
 * The grafts are required, not incidental: postgres.js reserved connections
 * expose only `types`, `typed`, `unsafe`, `notify`, `array`, `json`, `file` and
 * `release`. The Drizzle postgres-js driver registers its type parsers by
 * writing to `client.options.parsers` and `client.options.serializers`, so it
 * throws on a bare reserved connection; a reserved connection is drawn from this
 * pool and shares its configuration, so lending it the pool's own options object
 * is the correct binding rather than a substitute for one, and Drizzle's
 * registration is idempotent — the pool's instance has already written the same
 * parsers to the same object. See addTransactionSupport above for the rest.
 */
export function getDbForConnection(connection: ReservedConnection): AppDb {
  if (!("options" in connection)) {
    Object.assign(connection, { options: getSqlClient().options });
  }
  addTransactionSupport(connection);
  return drizzle(connection as unknown as PostgresClient, { schema });
}

/**
 * Close the database connection pool. Call on shutdown.
 */
export async function closeDb() {
  if (globalThis.__counterpoiseSql) {
    await globalThis.__counterpoiseSql.end();
    globalThis.__counterpoiseSql = undefined;
    globalThis.__counterpoiseDrizzle = undefined;
    globalThis.__counterpoiseMigrated = undefined;
  }
}

/**
 * The common capability surface shared by the top-level Drizzle instance
 * (`getDb()`) and the `tx` handed to `db.transaction(async (tx) => ...)`.
 *
 * `ReturnType<typeof getDb>` (`PostgresJsDatabase<schema> & { $client: Sql }`)
 * is NOT what `db.transaction()` passes to its callback — that's a
 * `PgTransaction<...>`, which lacks `$client`. Both extend the same
 * `PgDatabase<PostgresJsQueryResultHKT, typeof schema>` base (query builders,
 * `.query.*`, nested `.transaction()`), so functions that accept either a
 * top-level db or a transaction handle — e.g. everything in
 * `lib/lots-db.ts` — should type their parameter as `AppDb` rather than
 * `ReturnType<typeof getDb>`. Nothing in this codebase reads `.$client`, so
 * widening away from it costs nothing.
 */
export type AppDb = PgDatabase<PostgresJsQueryResultHKT, typeof schema>;
