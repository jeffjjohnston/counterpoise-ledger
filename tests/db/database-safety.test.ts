import { describe, expect, it } from "vitest";
import { assertTestDatabaseUrl, ensureTestDatabase, workerDatabaseUrl } from "../helpers/database-safety";

describe("destructive test destination", () => {
  const RUN = "1788980472_abcdef012345";
  const OTHER_RUN = "1788980472_0123456789ab";
  const env = { COUNTERPOISE_TEST_RUN_ID: RUN, VITEST_POOL_ID: "3" };

  it("derives this run's worker database", () => {
    expect(new URL(workerDatabaseUrl(env)).pathname).toBe(`/counterpoise_test_${RUN}_3`);
  });

  it("refuses to name a database when the run id is absent", () => {
    expect(() => workerDatabaseUrl({ VITEST_POOL_ID: "3" })).toThrow(/COUNTERPOISE_TEST_RUN_ID/);
  });

  it.each([
    "counterpoise",
    "counterpoise_dev",
    `counterpoise_test_${OTHER_RUN}_3`,
    `counterpoise_test_${RUN}_4`,
    "counterpoise_test_0_3",
    // The untimed name the first generated-id scheme built. It carries no
    // creation time, so the sweeper cannot age it and would never reclaim it.
    "counterpoise_test_abcdef012345_3",
  ])("refuses an inherited URL pointing at %s", (name) => {
    expect(() => workerDatabaseUrl({ ...env, DATABASE_URL: `postgresql://localhost/${name}` })).toThrow(/Refusing/);
  });

  it("accepts an explicit URL only for the allocated destination", () => {
    expect(workerDatabaseUrl({ ...env, DATABASE_URL: `postgresql://localhost/counterpoise_test_${RUN}_3` }))
      .toBe(`postgresql://localhost/counterpoise_test_${RUN}_3`);
  });

  it.each(["?database=counterpoise", "?options=-c%20search_path%3Dpublic", "#ignored"])(
    "refuses ambiguous connection options %s", (suffix) => {
      expect(() => assertTestDatabaseUrl(`postgresql://localhost/counterpoise_e2e${suffix}`, "counterpoise_e2e")).toThrow(/Refusing/);
    },
  );

  it("refuses a non-test expected name too", () => {
    expect(() => assertTestDatabaseUrl("postgresql://localhost/counterpoise", "counterpoise")).toThrow(/Refusing/);
  });

  it("refuses an empty expected name", () => {
    expect(() => assertTestDatabaseUrl("postgresql://localhost/", "")).toThrow(/Refusing/);
  });

  // The guard is a whole-string match, and the arms below are the ways a
  // partial one lets a production name through: a test name with the real
  // database appended, and the real database with a test name appended.
  it.each([
    `counterpoise_test_${RUN}_3_counterpoise`,
    `counterpoise_counterpoise_test_${RUN}_3`,
    `counterpoise_test_${RUN}_3x`,
    `counterpoise_test_${RUN.toUpperCase()}_3`,
  ])("refuses %s, which only a partial match would accept", (name) => {
    expect(() => assertTestDatabaseUrl(`postgresql://localhost/${name}`, name)).toThrow(/Refusing/);
  });

  it.each(["http:", "file:"])("refuses the %s scheme", (protocol) => {
    expect(() => assertTestDatabaseUrl(`${protocol}//localhost/counterpoise_e2e`, "counterpoise_e2e")).toThrow(/Refusing/);
  });

  it("still admits the e2e database, which carries no run dimension", () => {
    expect(() => assertTestDatabaseUrl("postgresql://localhost/counterpoise_e2e", "counterpoise_e2e")).not.toThrow();
  });

  it("rejects a malformed run id", () => {
    expect(() => workerDatabaseUrl({ ...env, COUNTERPOISE_TEST_RUN_ID: "../dev" })).toThrow(/run id/);
  });

  it("rejects a malformed worker id", () => {
    expect(() => workerDatabaseUrl({ ...env, VITEST_POOL_ID: "../dev" })).toThrow(/worker id/);
  });
});

describe("ensureTestDatabase proves the name it is about to interpolate", () => {
  const RUN = "1788980472_abcdef012345";

  /**
   * A PORT NOTHING LISTENS ON. The guard has to refuse before a connection is
   * opened, so a version that lost it fails these arms with a connection error
   * instead of reaching `CREATE DATABASE "<unproved string>"`. It also keeps
   * this file in the node project, where no cluster is expected.
   */
  const unreachable = (name: string) => `postgresql://localhost:1/${name}`;

  it("refuses a production name", async () => {
    // postgres.js has no placeholder for an identifier, so this call is the
    // whole distance between the caller's string and the SQL it is spliced
    // into. Nothing else exercised it: the line could be deleted and the suite
    // stayed green.
    await expect(ensureTestDatabase(unreachable("counterpoise"), "counterpoise")).rejects.toThrow(/Refusing/);
  });

  it("refuses a name the URL does not name", async () => {
    // THE ARM THAT SEES A RE-DERIVED EXPECTATION. Both strings are legal test
    // names, so a guard handed the URL's own database instead of the caller's
    // expectedName agrees with itself and passes — while the CREATE below still
    // interpolates the caller's string. Only a disagreement between the two can
    // catch that, and only this arm produces one.
    await expect(ensureTestDatabase(unreachable(`counterpoise_test_${RUN}_3`), `counterpoise_test_${RUN}_4`))
      .rejects.toThrow(/Refusing/);
  });
});
