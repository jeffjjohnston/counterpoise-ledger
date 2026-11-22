import { describe, expect, it } from "vitest";
import { rustCoverageSummary, testExecutables } from "../../scripts/rust-coverage.mjs";

const lines = (covered: number, count: number) => ({ lines: { covered, count, percent: count ? (100 * covered) / count : 0 } });
const file = (filename: string, covered: number, count: number) => ({ filename, summary: lines(covered, count) });

/** The shape of `llvm-cov export -summary-only`. */
const exported = {
  data: [{
    files: [
      file("/repo/rust-api/core/src/lots.rs", 180, 200),
      file("/repo/rust-api/core/src/accounting.rs", 300, 300),
      file("/repo/rust-api/server/src/routes/reconcile.rs", 700, 1000),
      file("/repo/rust-api/server/src/routes/sync.rs", 450, 500),
      file("/repo/rust-api/db/src/lots.rs", 95, 100),
    ],
    totals: lines(1725, 2100),
  }],
};

describe("rust-coverage.mjs", () => {
  it("gives the total and one row for each crate, in the order of the names", () => {
    const text = rustCoverageSummary(exported, "/repo");
    expect(text).toContain("| All crates | 82.1% (1725/2100) |");
    const crates = text.split("\n").filter((line) => /^\| `rust-api\/\w+` \|/.test(line));
    expect(crates).toEqual([
      "| `rust-api/core` | 96.0% (480/500) |",
      "| `rust-api/db` | 95.0% (95/100) |",
      "| `rust-api/server` | 76.7% (1150/1500) |",
    ]);
  });

  it("lists files by the lines that no test ran, not by percentage", () => {
    const text = rustCoverageSummary(exported, "/repo", 3);
    const rows = text.split("\n").filter((line) => line.startsWith("| `rust-api/") && line.includes(".rs"));
    // 300 lines not run, then 50, then 20. The count stops the list at 3,
    // and the file with every line run is never in it.
    expect(rows).toEqual([
      "| `rust-api/server/src/routes/reconcile.rs` | 300 | 70.0% (700/1000) |",
      "| `rust-api/server/src/routes/sync.rs` | 50 | 90.0% (450/500) |",
      "| `rust-api/core/src/lots.rs` | 20 | 90.0% (180/200) |",
    ]);
  });

  it("says so when every line ran", () => {
    const all = { data: [{ files: [file("/repo/rust-api/core/src/a.rs", 10, 10)], totals: lines(10, 10) }] };
    expect(rustCoverageSummary(all, "/repo")).toContain("Every line ran.");
  });

  it("finds the test executables in the messages of cargo", () => {
    const messages = [
      JSON.stringify({ reason: "compiler-artifact", executable: "/t/debug/deps/ledger_core-1a2b", profile: { test: true }, target: { kind: ["lib"] } }),
      JSON.stringify({ reason: "compiler-artifact", executable: null, profile: { test: false }, target: { kind: ["lib"] } }),
      JSON.stringify({ reason: "compiler-artifact", executable: "/t/debug/deps/fixtures-3c4d", profile: { test: true }, target: { kind: ["test"] } }),
      // A binary that is built for a test run, and not a test itself.
      JSON.stringify({ reason: "compiler-artifact", executable: "/t/debug/ledger-cli", profile: { test: false }, target: { kind: ["bin"] } }),
      JSON.stringify({ reason: "build-finished", success: true }),
      "not JSON: a line that a build script printed",
    ].join("\n");
    expect(testExecutables(messages)).toEqual(["/t/debug/deps/ledger_core-1a2b", "/t/debug/deps/fixtures-3c4d"]);
  });
});
