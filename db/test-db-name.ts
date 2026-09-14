import { randomBytes } from "crypto";

/**
 * The database one vitest worker uses.
 *
 * ONE GENERATED PREFIX PER RUN, plus the pool id. `workerId` separates the pool
 * slots inside ONE run. `runId` separates concurrent RUNS, which the pool id
 * cannot do: two agents in different worktrees both start at pool 1, and the
 * setup drops and rebuilds that schema under the other agent. Git isolation is
 * not database isolation.
 *
 * The run id is GENERATED, NOT ASSIGNED. An assigned slot needs an arbiter, and
 * the arbiter was a human: two agents given the same number destroyed each
 * other's schema, and no run could tell that it had been the victim. A run that
 * names its own database needs no arbiter and cannot collide.
 *
 * The databases this leaves behind are reclaimed by the scheduler's
 * `test-db-sweep` job, not by the next run. See
 * scripts/scheduler/sweep-test-databases.sh.
 */

/**
 * Every test database name this module builds, and nothing else.
 *
 * SHARED WITH THE SWEEPER, which declares the same shape as a POSIX regex in
 * scripts/scheduler/sweep-test-databases.sh. The two must move together;
 * tests/db/test-db-name.test.ts holds them to it. A sweeper pattern wider than
 * this one drops databases nothing here created.
 */
export const TEST_DATABASE_NAME = /^counterpoise_test_[0-9]{10}_[0-9a-f]{12}_[0-9]+$/;

/**
 * A run id is a creation time and a random key: `<epoch seconds>_<12 hex>`.
 *
 * THE TIME IS IN THE NAME SO THE SWEEPER NEEDS NO PRIVILEGE TO READ IT. The
 * first sweeper read a database's age from `pg_stat_file`, which PostgreSQL
 * restricts to superusers. An unprivileged application role is refused it, and
 * granting the privilege would widen a long-running process to superuser to
 * learn one timestamp. A name the sweeper can already read removes the need
 * instead of escalating to meet it.
 *
 * TEN DIGITS IS A FIXED WIDTH UNTIL 2286-11-20, when epoch seconds reach
 * eleven. The pattern above is anchored on that width, so a run after that date
 * is refused here rather than named wrongly. `padStart` covers the other end.
 *
 * THE KEY, NOT THE TIME, IS WHAT MAKES THE NAME UNIQUE. Two runs that start in
 * the same second are ordinary, and six random bytes are what separate them.
 * The time carries no uniqueness and is read only as an age.
 */
const RUN_ID = /^[0-9]{10}_[0-9a-f]{12}$/;

export function newTestRunId(): string {
  const seconds = Math.floor(Date.now() / 1000);
  return `${String(seconds).padStart(10, "0")}_${randomBytes(6).toString("hex")}`;
}

export function testDatabaseName(runId: string, workerId: string): string {
  if (!RUN_ID.test(runId)) {
    throw new Error("Test run id must be ten digits, an underscore, and twelve lowercase hex characters");
  }
  if (!/^\d+$/.test(workerId)) {
    throw new Error("Test worker id must be a non-negative integer");
  }
  return `counterpoise_test_${runId}_${workerId}`;
}
