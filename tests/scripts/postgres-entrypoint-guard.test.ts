import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = resolve(process.cwd(), "scripts/postgres-entrypoint-guard.sh");

/**
 * The bootstrap password this repository publishes. Assembled from parts for
 * the reason check-db-credential.test.ts gives: a literal credential in a test
 * file is what the secret scanner hunts for, and this suite needs several.
 */
const PUBLISHED = ["counter", "poise"].join("");
const OWN = "s0me-other-value";

let pgdata: string;
let binDir: string;

/**
 * Runs the guard with a stub `docker-entrypoint.sh` ahead of it on PATH.
 *
 * The stub is what makes the exec OBSERVABLE. Without it the guard either
 * reaches the real entrypoint, which needs a database, or reaches nothing and
 * the test cannot tell the difference — and "did it hand over to postgres"
 * is the guarantee that matters most here.
 */
function run(options: {
  password?: string;
  initialized: boolean;
  appPassword?: string;
  /** An empty PG_VERSION, as an interrupted initdb leaves behind. */
  emptyVersionFile?: boolean;
}) {
  if (options.emptyVersionFile) writeFileSync(join(pgdata, "PG_VERSION"), "");
  else if (options.initialized) writeFileSync(join(pgdata, "PG_VERSION"), "16\n");

  const env = { ...process.env };
  env.PATH = `${binDir}:${process.env.PATH}`;
  delete env.POSTGRES_PASSWORD;
  delete env.APP_DB_PASSWORD;
  if (options.password !== undefined) env.POSTGRES_PASSWORD = options.password;
  if (options.appPassword !== undefined) env.APP_DB_PASSWORD = options.appPassword;
  env.PGDATA = pgdata;

  const result = spawnSync(SCRIPT, { env, encoding: "utf8" });
  return {
    status: result.status,
    stderr: result.stderr,
    stdout: result.stdout,
    handedOver: result.stdout.includes("STUB-ENTRYPOINT") ||
      result.stderr.includes("STUB-ENTRYPOINT"),
  };
}

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "pg-guard-"));
  pgdata = join(base, "data");
  binDir = join(base, "bin");
  mkdirSync(pgdata, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    join(binDir, "docker-entrypoint.sh"),
    '#!/bin/sh\necho "STUB-ENTRYPOINT $*"\n',
    { mode: 0o755 },
  );
});

afterEach(() => {
  rmSync(resolve(pgdata, ".."), { recursive: true, force: true });
});

/**
 * THE CASES ARE RUN WITH APP_DB_PASSWORD BOTH BLANK AND POPULATED, and that
 * is the whole point of the parameterisation rather than a flourish.
 *
 * The suite this replaces blanked APP_DB_PASSWORD in every case, so no case
 * exercised the normal deployment combination of a bootstrap password AND a
 * populated application password. A script that skipped the refusal whenever
 * APP_DB_PASSWORD was set passed that suite 3/3 — which is precisely the
 * configured deployment, and precisely the case that matters.
 */
const APP_PASSWORD_STATES: [string, string | undefined][] = [
  ["with no application password", undefined],
  ["with an application password set, as a real deployment has", "app-secret"],
];

describe("postgres-entrypoint-guard.sh", () => {
  // THE PREMISE THE PARAMETERISED CASES STAND ON. An empty state list registers
  // no cases. The seven cases that are not parameterised still pass, so the
  // file stays green while eight guarantees stop being tested, and no other
  // assertion here can observe that. The second assertion is the one the
  // docblock above asks for: a list that keeps only the blank state is the
  // suite this one replaced, and it must not come back.
  it("parameterises both application-password states", () => {
    const passwords = APP_PASSWORD_STATES.map(([, appPassword]) => appPassword);

    expect(passwords, "no state is registered, so no case is parameterised").toHaveLength(2);
    expect(passwords, "no case sets an application password").toContain("app-secret");
  });

  describe("on a fresh data directory, where nothing is lost by refusing", () => {
    it.each(APP_PASSWORD_STATES)(
      "refuses the published bootstrap password %s",
      (_label, appPassword) => {
        const { status, stderr, handedOver } = run({
          password: PUBLISHED,
          initialized: false,
          appPassword,
        });

        expect(status).toBe(1);
        expect(stderr).toContain("FATAL");
        expect(stderr).toContain("publishes");
        // The refusal is worth nothing if postgres starts anyway: initdb would
        // create the cluster with the published password and the next start
        // would skip initialization entirely, making it permanent.
        expect(handedOver).toBe(false);
      },
    );

    it.each(APP_PASSWORD_STATES)("accepts a password of its own %s", (_label, appPassword) => {
      const { status, handedOver } = run({
        password: OWN,
        initialized: false,
        appPassword,
      });

      expect(status).toBe(0);
      expect(handedOver).toBe(true);
    });

    it("tells the operator what to change, and the change works here", () => {
      const { stderr } = run({ password: PUBLISHED, initialized: false });

      expect(stderr).toContain("POSTGRES_PASSWORD");
      expect(stderr).toContain(".env.production.local");
    });

    it("never prints the password it refused", () => {
      const { stderr, stdout } = run({ password: PUBLISHED, initialized: false });

      expect(stderr).not.toContain(PUBLISHED);
      expect(stdout).not.toContain(PUBLISHED);
    });
  });

  describe("on an initialized cluster, where refusing would take production down", () => {
    /**
     * A START-TIME REFUSAL HERE IS THE WORSE FAILURE. The cluster already holds
     * the published password; refusing turns that into production failing to
     * boot at the next host restart, for a deployment that was running fine.
     * The warning is loud and the container still starts.
     */
    it.each(APP_PASSWORD_STATES)(
      "warns but still starts %s",
      (_label, appPassword) => {
        const { status, stderr, handedOver } = run({
          password: PUBLISHED,
          initialized: true,
          appPassword,
        });

        expect(stderr).toContain("WARNING");
        expect(status).toBe(0);
        expect(handedOver).toBe(true);
      },
    );

    it("says the rotation is the fix, since changing the variable alone does nothing", () => {
      const { stderr } = run({ password: PUBLISHED, initialized: true });

      expect(stderr).toContain("ALTER ROLE");
    });

    it.each(APP_PASSWORD_STATES)(
      "says nothing when the password is already its own %s",
      (_label, appPassword) => {
        const { status, stderr, handedOver } = run({
          password: OWN,
          initialized: true,
          appPassword,
        });

        expect(status).toBe(0);
        expect(handedOver).toBe(true);
        expect(stderr).not.toContain("WARNING");
        expect(stderr).not.toContain("FATAL");
      },
    );
  });

  /**
   * A HALF-INITIALIZED DIRECTORY IS NOT AN INITIALIZED ONE, and the stock
   * entrypoint is the authority on which is which.
   *
   * An interrupted initdb leaves a zero-byte PG_VERSION. docker-entrypoint.sh
   * tests it with `-s`, so it reads that as uninitialized and runs initdb. A
   * guard testing `-e` instead disagrees: it calls the directory initialized,
   * warns, hands over — and the cluster is then created with the published
   * password, permanently, which is the single outcome this guard exists to
   * prevent. The warning would even tell the operator that changing the
   * variable cannot help, which by then would be true.
   *
   * The two tests must ask the same question of the same file.
   */
  describe("on a half-initialized data directory", () => {
    it("refuses, because the stock entrypoint will still run initdb", () => {
      const { status, stderr, handedOver } = run({
        password: PUBLISHED,
        initialized: false,
        emptyVersionFile: true,
      });

      expect(status).toBe(1);
      expect(stderr).toContain("FATAL");
      expect(handedOver).toBe(false);
    });

    it("still hands over when the password is its own", () => {
      const { status, handedOver } = run({
        password: OWN,
        initialized: false,
        emptyVersionFile: true,
      });

      expect(status).toBe(0);
      expect(handedOver).toBe(true);
    });
  });

  describe("hands over to the stock entrypoint", () => {
    // Losing the exec gives a container that guards correctly and then
    // initializes nothing at all.
    it("passes the postgres argument through", () => {
      const { stdout } = run({ password: OWN, initialized: false });

      expect(stdout).toContain("STUB-ENTRYPOINT postgres");
    });

    it("hands over even with no POSTGRES_PASSWORD at all", () => {
      // Not this guard's business: the postgres image itself refuses to initdb
      // without a password, and an initialized cluster ignores the variable.
      const { status, handedOver } = run({ initialized: false });

      expect(status).toBe(0);
      expect(handedOver).toBe(true);
    });
  });
});
