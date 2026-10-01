import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

/**
 * The SQLite files of the tests. Each Vitest run has a directory of its own
 * under the system temporary directory, named by the run id that
 * vitest.config.ts generates, and each worker has one file in it. Two runs,
 * in one checkout or in two worktrees, never share a file.
 */
export const TEST_DATABASE_ROOT = join(tmpdir(), "counterpoise_tests");

/**
 * A run id is a creation time and a random key: `<epoch seconds>_<12 hex>`.
 *
 * The run id is GENERATED, NOT ASSIGNED. An assigned slot needs an arbiter,
 * and two agents that got the same slot destroyed each other's data. A run
 * that names its own directory needs no arbiter and cannot collide.
 *
 * The key, not the time, makes the id unique. Two runs that start in the same
 * second are ordinary, and six random bytes separate them. The time tells an
 * operator how old a directory is that a stopped run left behind.
 *
 * Ten digits is a fixed width until 2286-11-20, when epoch seconds reach
 * eleven. The pattern is anchored on that width, so a run after that date is
 * refused rather than named wrongly.
 */
export const RUN_ID = /^[0-9]{10}_[0-9a-f]{12}$/;

/** A new run id. vitest.config.ts makes one for each run. */
export function newTestRunId(): string {
  const seconds = Math.floor(Date.now() / 1000);
  return `${String(seconds).padStart(10, "0")}_${randomBytes(6).toString("hex")}`;
}

/** The directory of one run. */
export function runDirectory(runId: string): string {
  if (!RUN_ID.test(runId)) {
    throw new Error("Test run id must be ten digits, an underscore, and twelve lowercase hex characters");
  }
  return join(TEST_DATABASE_ROOT, runId);
}

/** The database file of this Vitest worker in this run. */
export function workerDatabasePath(env: Record<string, string | undefined> = process.env): string {
  const runId = env.COUNTERPOISE_TEST_RUN_ID;
  if (!runId) {
    throw new Error("COUNTERPOISE_TEST_RUN_ID is unset; vitest.config.ts generates one for each run");
  }
  const worker = env.VITEST_POOL_ID ?? env.VITEST_WORKER_ID ?? "0";
  if (!/^\d+$/.test(worker)) throw new Error("Test worker id must be a non-negative integer");
  return join(runDirectory(runId), `worker-${worker}.db`);
}

/** Refuses a destructive step on a file outside the test directory. */
export function assertTestDatabasePath(path: string): void {
  const absolute = resolve(path);
  if (!absolute.startsWith(TEST_DATABASE_ROOT + sep) && !absolute.startsWith(resolve(".e2e") + sep)) {
    throw new Error(`Refusing destructive test setup outside ${TEST_DATABASE_ROOT}: ${absolute}`);
  }
}

/** Deletes a test database file and its WAL and lock files. */
export function removeDatabase(path: string): void {
  assertTestDatabasePath(path);
  for (const suffix of ["", "-wal", "-shm", ".lock", ".locks"]) {
    rmSync(`${path}${suffix}`, { force: true, recursive: true });
  }
}

export const LEDGER_CLI = resolve("rust-api/target/debug/ledger-cli");

/** Runs `ledger-cli` on the database at `path`. Throws with its output when it fails. */
export function ledgerCli(args: string[], path: string, env: Record<string, string> = {}): string {
  const result = spawnSync(LEDGER_CLI, args, {
    encoding: "utf8",
    env: { ...process.env, DATABASE_PATH: path, DATABASE_URL: "", ...env },
  });
  if (result.status !== 0) {
    throw new Error(`ledger-cli ${args.join(" ")} failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

/** Creates a new database at `path` from the migrations. */
export function createDatabase(path: string): void {
  removeDatabase(path);
  mkdirSync(join(path, ".."), { recursive: true });
  ledgerCli(["migrate"], path);
}
