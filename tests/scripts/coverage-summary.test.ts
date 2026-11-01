import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { coverageSummary } from "../../scripts/coverage-summary.mjs";

const metric = (covered: number, total: number) => ({ covered, total, skipped: 0, pct: total ? (100 * covered) / total : 100 });
const entry = (covered: number, total: number) => ({
  lines: metric(covered, total), statements: metric(covered, total),
  functions: metric(1, 1), branches: metric(0, 0),
});

const summary = {
  total: entry(560, 600),
  "/repo/lib/small.ts": entry(5, 10),
  "/repo/components/Big.tsx": entry(380, 400),
  "/repo/lib/done.ts": entry(50, 50),
  "/repo/lib/mid.ts": entry(125, 140),
};

let scratch: string | undefined;
afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

describe("coverage-summary.mjs", () => {
  it("gives the totals, and lists files by the lines no test ran", () => {
    const text = coverageSummary(summary, "/repo");

    expect(text).toContain("| All files | 93.3% (560/600) | 93.3% (560/600) | 100.0% (1/1) | — |");
    const rows = text.split("\n").filter((line) => line.startsWith("| `"));
    // 20 lines not run, then 15, then 5. The fully covered file is left out.
    expect(rows).toEqual([
      "| `components/Big.tsx` | 20 | 95.0% (380/400) |",
      "| `lib/mid.ts` | 15 | 89.3% (125/140) |",
      "| `lib/small.ts` | 5 | 50.0% (5/10) |",
    ]);
  });

  it("stops at the requested count", () => {
    const rows = coverageSummary(summary, "/repo", 1).split("\n").filter((line) => line.startsWith("| `"));
    expect(rows).toEqual(["| `components/Big.tsx` | 20 | 95.0% (380/400) |"]);
  });

  it("says so when every line ran", () => {
    const text = coverageSummary({ total: entry(50, 50), "/repo/lib/done.ts": entry(50, 50) }, "/repo");
    expect(text).toContain("Every line ran.");
    expect(text).not.toContain("| `");
  });

  it("reads the file that it is given when run as a command", () => {
    scratch = mkdtempSync(join(tmpdir(), "cp-coverage-summary-"));
    const path = join(scratch, "coverage-summary.json");
    writeFileSync(path, JSON.stringify(summary));

    const output = execFileSync(process.execPath, [resolve("scripts/coverage-summary.mjs"), path, "2"], {
      cwd: scratch, encoding: "utf8",
    });

    expect(output).toContain("| All files | 93.3% (560/600)");
    expect(output.split("\n").filter((line) => line.startsWith("| `"))).toHaveLength(2);
  });
});
