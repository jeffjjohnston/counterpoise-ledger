import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetTestDatabase, setupTestDatabase } from "../helpers/db-utils";
import { sessionHttpClient, startHttpTestServer } from "../helpers/http-parity";

/**
 * The seam test. record-status.sh and the job evaluator were each unit-tested
 * against fixtures, and both passed while the pipeline between them was broken:
 * the script wrote `lastOk: null` for a corrupt dump, and the evaluator returned
 * "missing" before it ever looked at `verified`, making "unverified" unreachable
 * for the exact case it exists to detect.
 *
 * These tests feed the script's REAL output to the Rust server's
 * /api/system/status. No hand-written entries.
 */

const SCRIPT = resolve(process.cwd(), "scripts/scheduler/record-status.sh");
const root = mkdtempSync(join(tmpdir(), "cp-pipeline-"));
const dir = join(root, "status");
let baseUrl: string;
let stop: () => Promise<void>;

type Status = { overall: string; jobs: { job: string; state: string; detail?: string | null }[] };

function record(args: string[]) {
  execFileSync("sh", [SCRIPT, ...args], {
    env: { ...process.env, STATUS_DIR: dir },
  });
}

async function evaluate(): Promise<Status> {
  const client = await sessionHttpClient(baseUrl);
  return (await client.request("/api/system/status")).json() as Promise<Status>;
}

function stateOf(result: Status, job: string) {
  return result.jobs.find((j) => j.job === job)?.state;
}

beforeAll(async () => {
  await setupTestDatabase();
  ({ baseUrl, stop } = await startHttpTestServer({ STATUS_DIR: dir }));
}, 120_000);

beforeEach(async () => {
  await resetTestDatabase();
  rmSync(dir, { recursive: true, force: true });
});

afterAll(async () => {
  await stop?.();
  rmSync(root, { recursive: true, force: true });
});

describe("record-status.sh -> /api/system/status", () => {
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
