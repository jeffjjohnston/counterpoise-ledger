import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = resolve(process.cwd(), "scripts/scheduler/record-status.sh");
let dir: string;

function run(args: string[]) {
  return execFileSync("sh", [SCRIPT, ...args], {
    env: { ...process.env, STATUS_DIR: dir },
    encoding: "utf8",
  });
}

function read(job: string) {
  return JSON.parse(readFileSync(join(dir, `${job}.json`), "utf8"));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cp-status-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("record-status.sh", () => {
  it("writes valid JSON for a successful run", () => {
    run(["backup", "ok", "", "1841234", "true"]);

    const entry = read("backup");
    expect(entry.job).toBe("backup");
    expect(entry.verified).toBe(true);
    expect(entry.bytes).toBe(1841234);
    expect(entry.lastOk).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(entry.lastRun).toBe(entry.lastOk);
  });

  it("leaves lastOk unset on failure but records the run", () => {
    run(["backup", "fail", "pg_dump exited 1", "", "false"]);

    const entry = read("backup");
    expect(entry.lastOk).toBeNull();
    expect(entry.lastRun).not.toBeNull();
    expect(entry.detail).toBe("pg_dump exited 1");
    expect(entry.verified).toBe(false);
  });

  it("emits null rather than empty strings for absent fields", () => {
    run(["reindex", "ok"]);

    const entry = read("reindex");
    expect(entry.detail).toBeNull();
    expect(entry.bytes).toBeNull();
    expect(entry.verified).toBeNull();
  });

  it("escapes quotes and backslashes in detail so output stays parseable", () => {
    run(["plaid-sync", "fail", 'bad "quote" and \\slash']);

    expect(read("plaid-sync").detail).toBe('bad "quote" and \\slash');
  });

  it("keeps both entries when two jobs write at the same instant", () => {
    // recurring and backup both fire at minute 0, sixteen times a day.
    execFileSync(
      "sh",
      ["-c", `"${SCRIPT}" backup ok & "${SCRIPT}" recurring ok & wait`],
      { env: { ...process.env, STATUS_DIR: dir } }
    );

    expect(readdirSync(dir).sort()).toEqual(["backup.json", "recurring.json"]);
    expect(read("backup").job).toBe("backup");
    expect(read("recurring").job).toBe("recurring");
  });

  it("exits 0 even when the status directory cannot be written", () => {
    const result = execFileSync(
      "sh",
      ["-c", `"${SCRIPT}" backup ok; echo "exit=$?"`],
      {
        env: { ...process.env, STATUS_DIR: "/proc/nonexistent/status" },
        encoding: "utf8",
      }
    );

    expect(result).toContain("exit=0");
  });
});
