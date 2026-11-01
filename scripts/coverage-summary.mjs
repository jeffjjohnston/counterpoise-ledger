// Usage: node scripts/coverage-summary.mjs [coverage/coverage-summary.json] [count]
//
// Writes a Markdown summary of a Vitest coverage run: the totals, then the
// files with the most lines that no test ran. CI appends it to the job
// summary, next to the HTML report it uploads.
//
// THE LIST IS SORTED BY UNCOVERED LINES, NOT BY PERCENTAGE. A 10-line helper
// at 50% is a smaller gap than a 400-line component at 90%. Coverage shows
// where no test runs; it does not show that a test checks the right thing,
// and there is no percentage that a change must reach.
import { readFileSync } from "node:fs";
import { relative } from "node:path";

const METRICS = ["lines", "statements", "functions", "branches"];

/** The Markdown for one coverage-summary.json object. */
export function coverageSummary(summary, root, count = 15) {
  const rows = [
    "### Unit and integration test coverage",
    "",
    "| | Lines | Statements | Functions | Branches |",
    "| --- | --- | --- | --- | --- |",
    `| All files | ${METRICS.map((metric) => pct(summary.total[metric])).join(" | ")} |`,
    "",
  ];
  const files = Object.entries(summary)
    .filter(([name]) => name !== "total")
    .map(([name, data]) => ({
      name: relative(root, name),
      uncovered: data.lines.total - data.lines.covered,
      lines: data.lines,
    }))
    .filter((file) => file.uncovered > 0)
    .sort((a, b) => b.uncovered - a.uncovered || a.name.localeCompare(b.name))
    .slice(0, count);
  if (files.length === 0) return `${rows.join("\n")}Every line ran.\n`;
  rows.push(
    `The ${files.length} files with the most lines that no test ran:`,
    "",
    "| File | Lines not run | Lines |",
    "| --- | --- | --- |",
    ...files.map((file) => `| \`${file.name}\` | ${file.uncovered} | ${pct(file.lines)} |`),
    "",
    "Download the `coverage-report` artifact of this run for the line-by-line HTML report.",
  );
  return `${rows.join("\n")}\n`;
}

function pct(metric) {
  return metric.total === 0 ? "—" : `${metric.pct.toFixed(1)}% (${metric.covered}/${metric.total})`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const path = process.argv[2] ?? "coverage/coverage-summary.json";
  const count = Number(process.argv[3] ?? 15);
  process.stdout.write(coverageSummary(JSON.parse(readFileSync(path, "utf8")), process.cwd(), count));
}
