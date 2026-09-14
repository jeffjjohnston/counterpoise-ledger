import { execFile } from "child_process";
import { promisify } from "util";
import { expect, it } from "vitest";

const run = promisify(execFile);

/**
 * TWO RUNS AT ONCE, WHICH IS WHAT THE OLD SCHEME COULD NOT DO.
 *
 * A slot was assigned by hand, so two agents given the same number reached one
 * database and the second one's setup dropped the first one's schema mid-suite.
 * The victim saw a failure in a suite that passed when run alone, and nothing
 * linked the two runs.
 *
 * TWO CASES, AND THEY PROVE DIFFERENT HALVES. The first drives the mechanism
 * directly and is deterministic. The second starts two real suites together
 * and asks only whether both survived — which is the end-to-end statement, but
 * depends on the two overlapping in time.
 */
const PROBE = "tests/db/database-lease.test.ts";

/**
 * A child process, with this worker's own destination cleared.
 *
 * tests/setup.ts pointed DATABASE_URL at this worker's database, and the run
 * id came in through vitest's `env`. A child that inherited either would be
 * refused by the very guard under test — correctly, and before it could prove
 * anything. Each child mints its own.
 */
function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.DATABASE_URL;
  delete env.COUNTERPOISE_TEST_RUN_ID;
  return env;
}

/**
 * NOTHING HERE CLEANS UP AFTER THE CHILDREN, DELIBERATELY.
 *
 * This test cannot tell which databases its children made. A diff of
 * pg_database across the run picks up the full suite this test is running
 * inside, and any other agent's suite running at the same time — and a
 * cleanup built on that diff would drop a live run's database, which is the
 * exact defect per-run databases were introduced to end. An earlier version of
 * this file did precisely that, with WITH (FORCE) on top.
 *
 * The children's databases are ordinary leavings and the scheduler's
 * test-db-sweep job reclaims them, which is what that job is for.
 */

it("mints a different run id in every process that loads the config", async () => {
  // THE MECHANISM, WITHOUT THE TIMING. vitest.config.ts is evaluated once per
  // process and writes the id it generated to process.env; a config that
  // returned a constant — which is what an assigned slot was — makes these two
  // equal. Loading it twice in THIS process could not see that, because the
  // module cache would return the first evaluation either way.
  const read = () =>
    run("npx", ["tsx", "-e", 'import("./vitest.config.ts").then(() => console.log("RUN_ID=" + process.env.COUNTERPOISE_TEST_RUN_ID))'],
      { cwd: process.cwd(), env: childEnv() });
  const [a, b] = await Promise.all([read(), read()]);
  // The whole run id: ten digits of creation time, then the twelve-hex key.
  // Matching the key alone would still pass here and would stop matching the
  // moment the time moved to the other end of the id.
  const idOf = (out: string) => /RUN_ID=([0-9]{10}_[0-9a-f]{12})\b/.exec(out)?.[1];

  const first = idOf(a.stdout);
  const second = idOf(b.stdout);
  expect(first, `no run id in: ${a.stdout}`).toBeDefined();
  expect(second, `no run id in: ${b.stdout}`).toBeDefined();
  expect(first, "two processes loading the config got one run id").not.toBe(second);
}, 120_000);

it("lets two concurrent runs each hold their own database through a whole suite", async () => {
  // BOTH PASSING IS THE ASSERTION. The probe suite drops and rebuilds every
  // schema it owns and holds the advisory lease for its whole run, so two runs
  // that reached one database cannot both finish: the second is refused by the
  // lease. Measured on 2026-09-09 by making vitest.config.ts return a constant
  // id — one of the two failed with "already in use".
  const spawn = () => run("npx", ["vitest", "run", PROBE, "--project", "database"], { cwd: process.cwd(), env: childEnv() });

  // execFile rejects on a non-zero exit, so reaching the assertions means both
  // suites passed. They are stated anyway so a future --passWithNoTests or a
  // silently empty run cannot read as success.
  const [first, second] = await Promise.all([spawn(), spawn()]);
  expect(first.stdout + first.stderr).toContain("1 passed");
  expect(second.stdout + second.stderr).toContain("1 passed");
}, 180_000);
