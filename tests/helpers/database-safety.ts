import postgres from "postgres";
import { TEST_DATABASE_NAME, testDatabaseName } from "../../db/test-db-name";

/** The one destructible database outside TEST_DATABASE_NAME. Playwright owns
 * it, it carries no run dimension, and tests/e2e/global-setup.ts leases it for
 * the whole browser run. */
const E2E_DATABASE = "counterpoise_e2e";

export function assertTestDatabaseUrl(url: string, expectedName: string): void {
  const parsed = new URL(url);
  if ((!TEST_DATABASE_NAME.test(expectedName) && expectedName !== E2E_DATABASE) ||
      !["postgres:", "postgresql:"].includes(parsed.protocol) ||
      decodeURIComponent(parsed.pathname.slice(1)) !== expectedName ||
      parsed.search !== "" || parsed.hash !== "") {
    throw new Error(`Refusing destructive test setup: expected database ${expectedName}`);
  }
}

/** The database this worker owns for this run. Throws when the run id is
 * absent rather than inventing one: vitest.config.ts generates exactly one per
 * run, and a generated fallback here would give every test FILE its own. */
export function workerDatabaseName(env: Record<string, string | undefined> = process.env): string {
  const runId = env.COUNTERPOISE_TEST_RUN_ID;
  if (!runId) {
    throw new Error("COUNTERPOISE_TEST_RUN_ID is unset; vitest.config.ts generates one for each run");
  }
  return testDatabaseName(runId, env.VITEST_POOL_ID ?? env.VITEST_WORKER_ID ?? "0");
}

export function workerDatabaseUrl(env: Record<string, string | undefined> = process.env): string {
  const name = workerDatabaseName(env);
  const url = env.DATABASE_URL ?? `postgresql://counterpoise:counterpoise@localhost:5432/${name}`;
  assertTestDatabaseUrl(url, name);
  return url;
}

/** `postgres`, which initdb always creates. CREATE DATABASE cannot be issued
 * from the database it creates, and issuing it from the app's own database
 * would put a test connection there. */
function maintenanceUrl(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = "/postgres";
  return parsed.toString();
}

const DATABASE_ALREADY_EXISTS = "42P04";

/**
 * Create this run's database if it is not there yet.
 *
 * The name is proved by `assertTestDatabaseUrl` BEFORE it reaches the SQL, so
 * what gets interpolated below has already been matched against
 * TEST_DATABASE_NAME and holds nothing but `[a-z0-9_]`. postgres.js has no
 * placeholder for an identifier, so the guard is what makes this safe.
 */
export async function ensureTestDatabase(url: string, expectedName: string): Promise<void> {
  assertTestDatabaseUrl(url, expectedName);
  const admin = postgres(maintenanceUrl(url), { max: 1, onnotice: () => {}, connect_timeout: 5 });
  try {
    // ASKED BEFORE IT IS ATTEMPTED, rather than creating and swallowing 42P04.
    // Every database test FILE calls setupTestDatabase and only the first in a
    // worker finds the database missing, so the unconditional form makes a
    // statement that is KNOWN to fail the normal path for every file after it.
    // (It is not a logging problem: measured 2026-09-09, a duplicate CREATE
    // returns the error to the client and this container writes nothing to its
    // log. The reason is that an expected error is a poor control flow, not
    // that it is noisy.)
    const [existing] = await admin`select 1 from pg_database where datname = ${expectedName}`;
    if (existing) return;
    await admin.unsafe(`CREATE DATABASE "${expectedName}"`);
  } catch (error) {
    // Still tolerated: the check above is not atomic with the create, and one
    // worker may lose that race to another. Nothing else claims this name, so
    // the loser is meeting its own database.
    if ((error as { code?: string })?.code !== DATABASE_ALREADY_EXISTS) throw error;
  } finally {
    await admin.end();
  }
}

/** Held for the entire test suite, including reset and teardown. PostgreSQL
 * releases it if the runner dies.
 *
 * A GENERATED RUN ID SHOULD MAKE THIS UNREACHABLE, which is the point of
 * keeping it: with names no longer assigned by hand, a second holder is no
 * longer routine contention between two agents given the same slot. It now
 * means two runs derived one name, and that is a defect in the naming rather
 * than a scheduling accident. Treat it as an alarm, not as a retry. */
export async function leaseTestDatabase(url: string, expectedName: string) {
  assertTestDatabaseUrl(url, expectedName);
  const connection = postgres(url, { max: 1, onnotice: () => {}, connect_timeout: 5 });
  try {
    const [row] = await connection`select pg_try_advisory_lock(941307, 1) as acquired`;
    if (!row.acquired) throw new Error(`Test database ${expectedName} is already in use; two runs derived one name`);
    return async () => { await connection.end(); };
  } catch (error) {
    await connection.end();
    throw error;
  }
}
