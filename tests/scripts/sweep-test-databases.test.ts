import { execFile } from "child_process";
import { randomBytes } from "crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { promisify } from "util";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabaseName } from "@/db/test-db-name";

const run = promisify(execFile);
const SCRIPT = resolve(process.cwd(), "scripts/scheduler/sweep-test-databases.sh");

/**
 * Every arm that decides a DROP runs against a REAL cluster, because what the
 * sweeper has to get right is which databases PostgreSQL will let it drop. A
 * stubbed psql would answer for the connection guard instead of the server, and
 * the server's refusal is the guarantee.
 *
 * Transport failures and malformed candidate output use a psql stub. These
 * cases judge the shell's handling of an error, a warning alongside exit 0,
 * or a row a widened query let through. They do not replace the real cluster
 * when judging whether a database may safely be dropped.
 *
 * SWEEP_PATTERN is narrowed to ONE WORKER ID of this suite's own key for every
 * test that drops. Two reasons: a concurrent vitest run's databases must stay
 * out of reach, and the counts this suite asserts must not move because an
 * earlier test in this file left a database behind.
 *
 * AGE IS SET BY THE NAME, so a test that needs an old database builds an old
 * name. Nothing here overrides SWEEP_MIN_AGE, which means every drop below is
 * decided by the twelve hours production uses.
 */
const ADMIN = "postgresql://counterpoise:counterpoise@localhost:5432/postgres";

/** Twelve hex characters, the same shape db/test-db-name.ts generates, so this
 * suite's databases cannot be confused with a concurrent run's. */
const SUITE_KEY = randomBytes(6).toString("hex");
const DAY_OLD = Math.floor(Date.now() / 1000) - 24 * 60 * 60;

/** A run id with a chosen creation time: `<ten digits>_<key>`, per
 * db/test-db-name.ts. testDatabaseName validates it, so a shape change there
 * fails this file rather than silently building names the sweeper ignores. */
function runIdAt(seconds: number): string {
  return `${String(seconds).padStart(10, "0")}_${SUITE_KEY}`;
}

/** Every name this suite builds carries SUITE_KEY, and each test claims one
 * worker id, so no two tests can see each other's databases. */
function patternFor(workerId: string): string {
  return `^counterpoise_test_[0-9]{10}_${SUITE_KEY}_${workerId}$`;
}

const created: string[] = [];
let statusDir = "";

async function admin<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(ADMIN, { max: 1, onnotice: () => {} });
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

async function makeDatabase(name: string): Promise<string> {
  await admin(async (sql) => {
    await sql.unsafe(`DROP DATABASE IF EXISTS "${name}"`);
    await sql.unsafe(`CREATE DATABASE "${name}"`);
  });
  created.push(name);
  return name;
}

async function exists(name: string): Promise<boolean> {
  return admin(async (sql) => {
    const rows = await sql`select 1 from pg_database where datname = ${name}`;
    return rows.length > 0;
  });
}

function urlFor(name: string): string {
  return `postgresql://counterpoise:counterpoise@localhost:5432/${name}`;
}

async function sweep(overrides: Record<string, string | undefined>) {
  // A MINIMAL ENVIRONMENT, not process.env with additions. tests/setup.ts
  // points this worker's DATABASE_URL at this worker's own database, and a
  // sweeper that inherited it would run against the wrong cluster entry.
  // NODE_ENV is declared required on this project's ProcessEnv, so it is
  // carried rather than omitted; the script does not read it.
  const env = { NODE_ENV: process.env.NODE_ENV ?? "test" } as NodeJS.ProcessEnv;
  if (process.env.PATH) env.PATH = process.env.PATH;
  env.STATUS_DIR = statusDir;
  env.SWEEP_DATABASE_URL = ADMIN;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const { stdout, stderr } = await run("sh", [SCRIPT], { env });
  return stdout + stderr;
}

/** The names one dry run listed.
 *
 * A substring match cannot do this job: `would drop counterpoise` is a prefix
 * of `would drop counterpoise_test_<run>_4`, so asserting that the production
 * database is absent passed while the line naming it was there. Compare whole
 * lines. */
function wouldDrop(out: string): string[] {
  return out
    .split("\n")
    .map((line) => /^\[test-db-sweep\] would drop (\S+)$/.exec(line.trim())?.[1])
    .filter((name): name is string => name !== undefined);
}

/**
 * A psql that answers the candidate query with a chosen stdout and stderr, and
 * records every DROP it is asked for instead of issuing one.
 *
 * THE REAL CLUSTER CANNOT PRODUCE THE INPUT THESE ARMS NEED. What has to be
 * proved is what the shell loop does with a candidate list that did not come
 * out of the candidate SQL — a warning psql wrote on the success path, or a row
 * a widened pattern let through. The server never volunteers either, so the
 * only way to put one in front of the loop is to be the psql that returns it.
 *
 * IT DISPATCHES ON THE SQL, NOT ON THE FLAGS. A `case "$*"` glob still matches
 * when a narrowing flag is added later, so a stub keyed on the argument line
 * would keep answering after the script stopped asking what the test thinks it
 * asks.
 */
function stubPsql(candidates: string[], warning: string, exitCode = 0) {
  const dir = mkdtempSync(join(tmpdir(), "sweep-psql-"));
  const path = join(dir, "psql");
  writeFileSync(join(dir, "stdout.txt"), candidates.map((name) => `${name}\n`).join(""));
  writeFileSync(join(dir, "stderr.txt"), warning === "" ? "" : `${warning}\n`);
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      'DIR=$(dirname "$0")',
      'for ARG in "$@"; do',
      '  case "$ARG" in',
      '    "DROP DATABASE "*)',
      '      printf \'%s\\n\' "$ARG" >> "$DIR/dropped.log"',
      "      exit 0",
      "      ;;",
      "  esac",
      "done",
      'cat "$DIR/stdout.txt"',
      'cat "$DIR/stderr.txt" >&2',
      `exit ${exitCode}`,
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
  return {
    path,
    dropped(): string[] {
      const log = join(dir, "dropped.log");
      if (!existsSync(log)) return [];
      return readFileSync(log, "utf8").split("\n").filter((line) => line !== "");
    },
  };
}

function status(): { job: string; lastOk: string | null; detail: string | null } {
  return JSON.parse(readFileSync(join(statusDir, "test-db-sweep.json"), "utf8"));
}

beforeAll(() => {
  statusDir = mkdtempSync(join(tmpdir(), "sweep-status-"));
});

afterAll(async () => {
  await admin(async (sql) => {
    for (const name of created) {
      // A database this suite marked as a template refuses DROP until the flag
      // is cleared, and the ALTER itself errors on a name already gone.
      await sql.unsafe(`ALTER DATABASE "${name}" WITH IS_TEMPLATE false`).catch(() => {});
      await sql.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    }
  });
});

describe("sweep-test-databases", () => {
  it("drops a database of its own shape that nothing is connected to", async () => {
    const name = await makeDatabase(testDatabaseName(runIdAt(DAY_OLD), "1"));
    const out = await sweep({ SWEEP_PATTERN: patternFor("1") });

    expect(out).toContain(`dropped ${name}`);
    expect(await exists(name)).toBe(false);
    expect(status().detail).toBe("dropped 1, skipped 0");
    expect(status().lastOk).not.toBeNull();
  });

  it("leaves a database a session is connected to, and still reports ok", async () => {
    const name = await makeDatabase(testDatabaseName(runIdAt(DAY_OLD), "2"));
    // A held connection is a running suite between two of its test files.
    const holder = postgres(urlFor(name), { max: 1, onnotice: () => {} });
    try {
      await holder`select 1`;
      const out = await sweep({ SWEEP_PATTERN: patternFor("2") });

      expect(await exists(name), "a live suite's database was dropped under it").toBe(true);
      expect(out).not.toContain(`dropped ${name}`);
      // NEVER A CANDIDATE, not merely a DROP that failed. The counts are what
      // separates the two, and only the counts: with the pg_stat_activity
      // filter removed the database survives anyway, because PostgreSQL
      // refuses the DROP, and every other assertion here still passes. That
      // redundancy is deliberate, and it is what makes the exact string below
      // the assertion carrying this one — "dropped 0, skipped 1" would mean
      // the sweeper reached a live database and was turned back at the server.
      expect(status().detail).toBe("dropped 0, skipped 0");
      expect(status().lastOk).not.toBeNull();
    } finally {
      await holder.end();
    }
  });

  it("leaves a database whose name says it was made seconds ago", async () => {
    // THE AGE THE NAME CARRIES IS THE ONE THAT COUNTS. This database is created
    // at the same instant as the one in the first test; only its name differs,
    // and that is the whole input to the age filter.
    const name = await makeDatabase(testDatabaseName(runIdAt(Math.floor(Date.now() / 1000)), "3"));
    const out = await sweep({ SWEEP_PATTERN: patternFor("3") });

    expect(await exists(name), "a database named seconds ago was old enough to drop").toBe(true);
    expect(out).toContain("dropped 0, skipped 0");
  });

  it("selects only its own shape under the pattern production runs", async () => {
    const mine = await makeDatabase(testDatabaseName(runIdAt(DAY_OLD), "4"));
    // The name the assigned-slot scheme built, and the untimed name the first
    // generated-id scheme built. A checkout from before either change still
    // uses one, so the sweeper must not reach them.
    const slotted = await makeDatabase("counterpoise_test_9_9");
    const untimed = await makeDatabase(`counterpoise_test_${SUITE_KEY}_9`);

    // Dry run, under the production pattern and the production age. Another
    // agent's finished run may well be listed alongside this one's; nothing is
    // dropped, and the assertions below name their subjects exactly.
    const out = await sweep({ SWEEP_DRY_RUN: "1" });

    const listed = wouldDrop(out);
    expect(listed).toContain(mine);
    for (const spared of [slotted, untimed, "counterpoise", "counterpoise_dev", "counterpoise_e2e"]) {
      expect(listed, `${spared} is a candidate`).not.toContain(spared);
    }
    expect(await exists(slotted)).toBe(true);
    expect(await exists(untimed)).toBe(true);
    expect(await exists(mine)).toBe(true);
    // A dry run must not record a drop count as though it had done the work.
    expect(status().detail).toBe(`dry run, ${listed.length} would be dropped, skipped 0`);
  });

  it("refuses a name outside the identifier characters it will quote", async () => {
    // The pattern is overridable, so it cannot be the only thing deciding what
    // reaches a quoted identifier. This name carries a legal creation time and
    // a hyphen, so it passes the age filter and is stopped by the second check
    // — which is the only test that reaches that branch.
    const name = await makeDatabase(`counterpoise_test_${runIdAt(DAY_OLD)}_0-refused`);
    const out = await sweep({ SWEEP_PATTERN: `^counterpoise_test_[0-9]{10}_${SUITE_KEY}_0-refused$` });

    expect(out).toContain("refusing an unexpected database name");
    expect(await exists(name)).toBe(true);
    expect(status().detail).toBe("dropped 0, skipped 1");
    expect(status().lastOk).not.toBeNull();
  });

  it("counts a drop the server refuses as skipped, not as a failure", async () => {
    // THE SERVER IS THE LAST GUARD, and this is the arm that proves the script
    // survives being turned back by it. A template database is a legal
    // identifier, is old enough, and has no session connected, so it passes
    // every filter and reaches DROP — where PostgreSQL refuses it. The
    // connected-database test cannot reach here: its candidate is excluded
    // before the drop.
    const name = await makeDatabase(testDatabaseName(runIdAt(DAY_OLD), "6"));
    await admin((sql) => sql.unsafe(`ALTER DATABASE "${name}" WITH IS_TEMPLATE true`));

    const out = await sweep({ SWEEP_PATTERN: patternFor("6") });

    expect(out).toContain(`skipped ${name}`);
    expect(await exists(name)).toBe(true);
    expect(status().detail).toBe("dropped 0, skipped 1");
    expect(status().lastOk, "a refusal was recorded as a failed run").not.toBeNull();
  });

  it("never asks PostgreSQL to force a drop past a connected session", () => {
    /**
     * A TEXT ASSERTION, BECAUSE THE BEHAVIOURAL ARM IS UNREACHABLE FROM HERE.
     * WITH (FORCE) terminates the sessions and then drops, so it destroys a
     * running suite's schema. The connected-database test above cannot see it:
     * the candidate query excludes a connected database, so a forced DROP is
     * never reached and every assertion there passes with FORCE added. The
     * hazard is the gap between that query and the drop — a session that
     * connects inside it is one the filter has already cleared and FORCE would
     * then kill.
     *
     * Measured on 2026-09-09: adding WITH (FORCE) left this file green.
     *
     * COMMENT LINES ARE STRIPPED FIRST. The script says in prose that it must
     * never force a drop, and a whole-file match is satisfied by that sentence
     * — it failed on the rule written down rather than on the rule broken.
     */
    const commands = readFileSync(SCRIPT, "utf8")
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");
    expect(commands).not.toMatch(/DROP\s+DATABASE[^\n]*FORCE/i);
    expect(commands, "the drop this guards is gone").toMatch(/DROP\s+DATABASE/i);
  });

  it("uses SWEEP_DATABASE_URL, not the scheduler's DATABASE_URL", async () => {
    // NOT INTERCHANGEABLE, AND THAT IS THE POINT. An application DATABASE_URL
    // is `counterpoise_app`, which owns none of these databases, so every DROP
    // is refused under it. SWEEP_DATABASE_URL is what carries the bootstrap
    // role, so it has to win when both are set.
    const name = await makeDatabase(testDatabaseName(runIdAt(DAY_OLD), "5"));
    const out = await sweep({
      DATABASE_URL: "postgresql://counterpoise:counterpoise@localhost:5432/counterpoise_no_such_database",
      SWEEP_PATTERN: patternFor("5"),
    });
    expect(out).toContain(`dropped ${name}`);
    expect(await exists(name)).toBe(false);
  });

  it("fails, and records the failure, rather than falling back to DATABASE_URL", async () => {
    // THE FAILURE MODE THIS REPLACES IS A SILENT NO-OP. A fallback would give a
    // job that connects as the app role, lists candidates, is refused every
    // drop, and reports ok with a skip count — a sweep that never reclaims
    // anything and never says so. Whoever runs it without SWEEP_DATABASE_URL
    // set must see a failure instead. In the shipped deployment that variable
    // is set in docker-compose.dev.yml, where the sweep runs beside the dev
    // database; production schedules no test-database cleanup at all.
    await expect(sweep({ SWEEP_DATABASE_URL: undefined, DATABASE_URL: ADMIN })).rejects.toThrow();
    expect(status().lastOk).toBeNull();
    expect(status().detail).toBe("SWEEP_DATABASE_URL is unset");
  });

  it("reports the candidate query error text and stops before any drop", async () => {
    const candidate = testDatabaseName(runIdAt(DAY_OLD), "9");
    const message = "ERROR: candidate query refused by fixture";
    // stdout may contain a partial result when psql fails; it grants no DROP.
    const psql = stubPsql([candidate], message, 2);

    await expect(sweep({ PSQL: psql.path })).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining(`[test-db-sweep] cannot list candidates: ${message}`),
    });
    expect(status().lastOk).toBeNull();
    expect(status().detail).toBe("cannot list candidates");
    expect(psql.dropped()).toEqual([]);
  });

  it("reports a warning psql wrote while listing, and never treats its words as candidates", async () => {
    // THE SUCCESS PATH IS THE HAZARD. psql exits 0 and still writes to stderr,
    // so merging the two streams into the candidate variable turns every
    // whitespace-separated word of a warning into a database name the loop then
    // iterates. "there", "no", "transaction" and "progress" are all identifier
    // shaped, so the character-class check passes them.
    const keep = testDatabaseName(runIdAt(DAY_OLD), "7");
    const psql = stubPsql([keep], "WARNING:  there is no transaction in progress");

    const out = await sweep({ PSQL: psql.path });

    expect(psql.dropped()).toEqual([`DROP DATABASE "${keep}"`]);
    expect(status().detail).toBe("dropped 1, skipped 0");
    // Separated, not discarded: an operator still has to be able to see it.
    expect(out).toContain("there is no transaction in progress");
  });

  it("refuses a candidate outside the counterpoise_test_ prefix, whatever the query returned", async () => {
    // DEFENCE IN DEPTH, AND THE SECOND HALF OF IT. The prefix is enforced in the
    // candidate SQL, which is exactly the half a widened SWEEP_PATTERN or a
    // later edit to that statement moves. Both names below are legal
    // identifiers and would reach DROP DATABASE on the character class alone.
    const keep = testDatabaseName(runIdAt(DAY_OLD), "8");
    const psql = stubPsql([keep, "counterpoise", "postgres"], "");

    const out = await sweep({ PSQL: psql.path });

    expect(psql.dropped()).toEqual([`DROP DATABASE "${keep}"`]);
    expect(status().detail).toBe("dropped 1, skipped 2");
    expect(out).toContain("outside the counterpoise_test_ prefix");
  });

  it("keeps the default age at twelve hours, decided by the age and not by how long the test took", async () => {
    // AN ASSERTION ABOUT THE AGE. Both databases are created in the same
    // instant and differ only in the creation time their names carry, so
    // nothing here depends on a sleep being long enough. The five-minute margin
    // is what makes this a threshold test: it fails for any default below
    // 11h55m or above 12h05m, which is what "about thirty seconds" would be.
    const TWELVE_HOURS = 12 * 60 * 60;
    const MARGIN = 5 * 60;
    const now = Math.floor(Date.now() / 1000);
    const older = await makeDatabase(testDatabaseName(runIdAt(now - TWELVE_HOURS - MARGIN), "10"));
    const younger = await makeDatabase(testDatabaseName(runIdAt(now - TWELVE_HOURS + MARGIN), "10"));

    // SWEEP_MIN_AGE is deliberately not overridden: the default is the subject.
    const out = await sweep({ SWEEP_DRY_RUN: "1", SWEEP_PATTERN: patternFor("10") });

    expect(wouldDrop(out), `${younger} is younger than the default age`).toEqual([older]);
    expect(status().detail).toBe("dry run, 1 would be dropped, skipped 0");
  });
});
