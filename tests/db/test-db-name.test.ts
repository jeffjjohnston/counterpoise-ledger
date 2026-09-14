import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, it, expect } from "vitest";
import { TEST_DATABASE_NAME, newTestRunId, testDatabaseName } from "@/db/test-db-name";

/** A well-formed run id: ten digits, an underscore, twelve lowercase hex. */
const RUN = "1788980472_abcdef012345";
const OTHER_RUN = "1788980472_0123456789ab";

describe("testDatabaseName", () => {
  it("rejects a malformed run id", () => {
    expect(() => testDatabaseName("../dev", "1")).toThrow(/run id/);
  });

  it("rejects a run id of the wrong length, which a truncated value has", () => {
    expect(() => testDatabaseName("abc", "1")).toThrow(/run id/);
  });

  it("rejects an uppercase run id, so one name never has two spellings", () => {
    expect(() => testDatabaseName(RUN.toUpperCase(), "1")).toThrow(/run id/);
  });

  it("rejects a run id carrying no creation time, which the sweeper reads", () => {
    // The key alone was the whole run id before the sweeper needed an age.
    expect(() => testDatabaseName("abcdef012345", "1")).toThrow(/run id/);
  });

  it("rejects a creation time of the wrong width", () => {
    // Ten digits is what TEST_DATABASE_NAME and the sweeper's pattern are
    // anchored on. Nine or eleven would build a name neither one matches, and
    // the sweeper would then never reclaim it.
    expect(() => testDatabaseName("178898047_abcdef012345", "1")).toThrow(/run id/);
    expect(() => testDatabaseName("17889804720_abcdef012345", "1")).toThrow(/run id/);
  });

  it("rejects a malformed worker id", () => {
    expect(() => testDatabaseName(RUN, "unsafe")).toThrow(/worker id/);
  });

  it("includes both the run id and the worker id", () => {
    expect(testDatabaseName(RUN, "5")).toBe("counterpoise_test_1788980472_abcdef012345_5");
  });

  it("gives two runs different names for the same worker id", () => {
    expect(testDatabaseName(RUN, "1")).not.toBe(testDatabaseName(OTHER_RUN, "1"));
  });

  it("matches every name it builds against the shared pattern", () => {
    expect(TEST_DATABASE_NAME.test(testDatabaseName(RUN, "0"))).toBe(true);
  });

  it("does not match the old slot-derived name, which nothing produces now", () => {
    expect(TEST_DATABASE_NAME.test("counterpoise_test_0_3")).toBe(false);
  });

  it("does not match the earlier untimed name, which the sweeper cannot age", () => {
    expect(TEST_DATABASE_NAME.test("counterpoise_test_abcdef012345_3")).toBe(false);
  });

  it("does not match a name that merely starts with one it builds", () => {
    expect(TEST_DATABASE_NAME.test(`counterpoise_test_${RUN}_0_extra`)).toBe(false);
  });
});

describe("newTestRunId", () => {
  it("builds an id testDatabaseName accepts", () => {
    expect(() => testDatabaseName(newTestRunId(), "0")).not.toThrow();
  });

  it("does not repeat itself", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newTestRunId()));
    expect(ids.size).toBe(200);
  });

  it("records the current time, which is the age the sweeper reads", () => {
    // The whole point of the timestamp. A run id whose seconds are stale by
    // more than the sweep's minimum age names a database the sweeper may
    // reclaim while the run is still using it.
    const seconds = Number(newTestRunId().split("_")[0]);
    expect(Math.abs(seconds - Date.now() / 1000)).toBeLessThan(60);
  });
});

describe("the sweeper's copy of this pattern", () => {
  /**
   * DECLARED IN TWO PLACES, so it has to move in two places.
   * scripts/scheduler/sweep-test-databases.sh cannot import TypeScript, and
   * what it drops is decided by its own POSIX pattern. A sweeper pattern wider
   * than this one reclaims databases nothing here built — the slot-derived
   * names an older worktree still uses are one prefix away. `[0-9]+` rather
   * than `\d+` above so the two are the same string and this can say so.
   */
  const SCRIPT = resolve(process.cwd(), "scripts/scheduler/sweep-test-databases.sh");

  function scriptLines(): string[] {
    return readFileSync(SCRIPT, "utf8").split("\n");
  }

  /** Anchored at the end of the line and on a character that cannot be part of
   * a variable name, so a second variable whose NAME ENDS IN `PATTERN` — the
   * script has one — is never read as this one. It cannot be anchored at the
   * start: the script assigns its default through `[ -n ... ] || NAME='...'`,
   * for the reason that line's own comment gives. */
  function shellPattern(name: string): string {
    const found = scriptLines()
      .map((line) => new RegExp(`(?:^|[^A-Z_])${name}='([^']+)'$`).exec(line)?.[1])
      .filter((value): value is string => value !== undefined);
    expect(found, `the sweeper declares no single default ${name}`).toHaveLength(1);
    return found[0];
  }

  it("is the same string this module matches names against", () => {
    expect(shellPattern("SWEEP_PATTERN")).toBe(TEST_DATABASE_NAME.source);
  });

  it("matches a name this module builds", () => {
    expect(new RegExp(shellPattern("SWEEP_PATTERN")).test(testDatabaseName(newTestRunId(), "2"))).toBe(true);
  });

  it("reads the creation time out of the same position this module writes it", () => {
    // The sweeper extracts the age with its own fixed pattern rather than with
    // SWEEP_PATTERN, which is overridable. If the two ever disagree about
    // where the seconds sit, every name becomes unageable and the sweep
    // silently reclaims nothing.
    const agePattern = new RegExp(shellPattern("SWEEP_AGE_PATTERN"));
    const runId = newTestRunId();
    const extracted = agePattern.exec(testDatabaseName(runId, "2"))?.[1];
    expect(extracted).toBe(runId.split("_")[0]);
  });

  it("reads no creation time out of a name from either older scheme", () => {
    const agePattern = new RegExp(shellPattern("SWEEP_AGE_PATTERN"));
    expect(agePattern.test("counterpoise_test_0_3")).toBe(false);
    expect(agePattern.test("counterpoise_test_abcdef012345_3")).toBe(false);
  });

  it("proves the same prefix in its shell loop that this module builds", () => {
    // A THIRD COPY OF THE PREFIX, and the one that fails most quietly. The
    // loop proves it in the shell as well as in the SQL, so a prefix that
    // stopped matching what testDatabaseName builds would refuse every
    // legitimate candidate, reclaim nothing, and still record ok.
    const prefix = shellPattern("SWEEP_NAME_PREFIX");
    expect(testDatabaseName(newTestRunId(), "2").startsWith(prefix)).toBe(true);
    expect(TEST_DATABASE_NAME.source.startsWith(`^${prefix}`)).toBe(true);
  });
});
