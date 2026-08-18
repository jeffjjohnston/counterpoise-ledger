import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evaluateJobHealth } from "@/lib/job-health";
import { readJobEntries } from "@/lib/job-status-store";

/**
 * The seam test. record-status.sh and evaluateJobHealth were each unit-tested
 * against fixtures, and both passed while the pipeline between them was broken:
 * the script wrote `lastOk: null` for a corrupt dump, and the evaluator returned
 * "missing" before it ever looked at `verified`, making "unverified" unreachable
 * for the exact case it exists to detect.
 *
 * These tests feed the script's REAL output into the evaluator. No hand-written
 * entries.
 */

const SCRIPT = resolve(process.cwd(), "scripts/scheduler/record-status.sh");
let dir: string;

function record(args: string[]) {
  execFileSync("sh", [SCRIPT, ...args], {
    env: { ...process.env, STATUS_DIR: dir },
  });
}

async function evaluate() {
  return evaluateJobHealth(await readJobEntries(), new Date());
}

function stateOf(result: Awaited<ReturnType<typeof evaluate>>, job: string) {
  return result.jobs.find((j) => j.job === job)?.state;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cp-pipeline-"));
  process.env.STATUS_DIR = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.STATUS_DIR;
});

describe("record-status.sh -> evaluateJobHealth", () => {
  it("reports ok for a verified backup", async () => {
    record(["backup", "ok", "", "1874345", "true"]);

    expect(stateOf(await evaluate(), "backup")).toBe("ok");
  });

  it("reports unverified when pg_dump succeeded but the dump is unreadable", async () => {
    // Exactly what the crontab runs when pg_restore --list rejects the file:
    // the run completed, the artifact is bad.
    record(["backup", "ok", "dump unreadable by pg_restore", "512", "false"]);

    expect(stateOf(await evaluate(), "backup")).toBe("unverified");
  });

  it("reports failed when the job itself errored", async () => {
    record(["backup", "fail", "pg_dump failed"]);

    const result = await evaluate();
    expect(stateOf(result, "backup")).toBe("failed");
    expect(result.jobs.find((j) => j.job === "backup")?.detail).toBe(
      "pg_dump failed"
    );
  });

  it("distinguishes a job that failed from one that never ran", async () => {
    record(["backup", "fail", "pg_dump failed"]);

    const result = await evaluate();
    expect(stateOf(result, "backup")).toBe("failed");
    expect(stateOf(result, "reindex")).toBe("missing");
  });

  it("surfaces every failure mode as overall attention", async () => {
    record(["backup", "ok", "dump unreadable by pg_restore", "512", "false"]);

    expect((await evaluate()).overall).toBe("attention");
  });

  it("survives a detail string containing newlines and quotes", async () => {
    record(["plaid-sync", "fail", 'line one\nline "two"\\three']);

    const result = await evaluate();
    // If escaping were wrong the file would be unparseable, the entry skipped,
    // and this would read "missing" instead of "failed".
    expect(stateOf(result, "plaid-sync")).toBe("failed");
    // Control characters are flattened to spaces, not escaped — see esc() in
    // record-status.sh. Quotes and backslashes still round-trip.
    expect(result.jobs.find((j) => j.job === "plaid-sync")?.detail).toBe(
      'line one line "two"\\three'
    );
  });
});
