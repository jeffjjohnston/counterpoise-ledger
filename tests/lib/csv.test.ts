import { afterEach, describe, it, expect, vi } from "vitest";
import { csvEscape, datedCsvFilename } from "@/lib/csv";

describe("csvEscape", () => {
  it("returns an empty string for null", () => {
    expect(csvEscape(null)).toBe("");
  });

  it("passes through plain text unchanged", () => {
    expect(csvEscape("Salary")).toBe("Salary");
  });

  it("passes through plain numbers, including negatives", () => {
    expect(csvEscape(125.43)).toBe("125.43");
    expect(csvEscape("-123.45")).toBe("-123.45");
    expect(csvEscape(0)).toBe("0");
  });

  it("quotes values containing commas", () => {
    expect(csvEscape("Smith, John")).toBe('"Smith, John"');
  });

  it("quotes and doubles embedded quotes", () => {
    expect(csvEscape('He said "hi"')).toBe('"He said ""hi"""');
  });

  it("quotes values containing newlines", () => {
    expect(csvEscape("line1\nline2")).toBe('"line1\nline2"');
  });

  it("neutralizes formula injection on non-numeric values", () => {
    expect(csvEscape("=SUM(A1:A2)")).toBe("'=SUM(A1:A2)");
    expect(csvEscape("+1+1")).toBe("'+1+1");
    expect(csvEscape("@cmd")).toBe("'@cmd");
    expect(csvEscape("-import")).toBe("'-import");
  });

  it("neutralizes formula injection preceded by leading whitespace", () => {
    // Some spreadsheet apps trim leading whitespace before evaluating, so a
    // leading space must not let a formula slip through unquoted.
    expect(csvEscape(" =SUM(A1:A2)")).toBe("' =SUM(A1:A2)");
    expect(csvEscape("   +1+1")).toBe("'   +1+1");
  });

  it("escapes a name that is both a formula and contains a comma", () => {
    // The leading '-' triggers the formula-injection guard (prefix with '),
    // and the comma then forces the whole cell to be quoted.
    expect(csvEscape("-A, B")).toBe(`"'-A, B"`);
  });
});

describe("datedCsvFilename", () => {
  const originalTz = process.env.TZ;

  afterEach(() => {
    // Assigning undefined would set TZ to the literal string "undefined" and
    // leak an invalid zone into every later test in this worker. CI runs with
    // TZ unset, so that is the normal case, not the edge case.
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
    vi.useRealTimers();
  });

  it("dates the file in local time, not UTC", () => {
    // Pinned rather than left to the runner's clock: CI runs in UTC, where
    // local and UTC dates never diverge, so an unpinned test would pass here
    // while the exported file kept the wrong date on the user's machine.
    process.env.TZ = "America/New_York";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-10T01:00:00Z")); // 9pm ET on the 9th

    expect(datedCsvFilename("active-securities")).toBe("active-securities-2026-08-09.csv");
  });

  it("agrees with UTC when the two do not diverge", () => {
    process.env.TZ = "America/New_York";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-09T16:00:00Z")); // noon ET on the 9th

    expect(datedCsvFilename("income-statement")).toBe("income-statement-2026-08-09.csv");
  });
});
