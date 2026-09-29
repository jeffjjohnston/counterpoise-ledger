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
