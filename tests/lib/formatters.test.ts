import { describe, it, expect } from "vitest";
import { formatCurrency, formatCurrencyCompact, toDateString } from "@/lib/formatters";

describe("formatCurrency", () => {
  it("formats positive amounts correctly", () => {
    expect(formatCurrency(12543)).toBe("$125.43");
  });

  it("formats zero correctly", () => {
    expect(formatCurrency(0)).toBe("$0.00");
  });

  it("formats negative amounts with a Unicode minus (U+2212)", () => {
    expect(formatCurrency(-5000)).toBe("−$50.00");
  });

  it("formats large amounts with commas", () => {
    expect(formatCurrency(1234567)).toBe("$12,345.67");
  });

  it("handles single cent", () => {
    expect(formatCurrency(1)).toBe("$0.01");
  });

  it("handles amounts without cents", () => {
    expect(formatCurrency(10000)).toBe("$100.00");
  });
});

describe("toDateString", () => {
  it("converts Date to YYYY-MM-DD string", () => {
    const date = new Date("2026-01-15T12:00:00Z");
    expect(toDateString(date)).toBe("2026-01-15");
  });

  it("pads single-digit months and days", () => {
    const date = new Date("2026-05-05T12:00:00Z");
    expect(toDateString(date)).toBe("2026-05-05");
  });

  it("handles year boundaries", () => {
    const date = new Date("2025-12-31T12:00:00Z");
    expect(toDateString(date)).toBe("2025-12-31");
  });

  it("uses local date components, not UTC", () => {
    // Construct a date with known local components (year, month, day)
    const date = new Date(2026, 3, 10); // April 10, 2026 at midnight local
    expect(toDateString(date)).toBe("2026-04-10");
  });

  it("returns the local date for a late local time", () => {
    // Use a late local time and verify the formatter still returns the local date.
    const date = new Date(2026, 3, 10, 23, 30, 0); // April 10, 2026 at 11:30 PM local
    expect(toDateString(date)).toBe("2026-04-10");
  });

  it("throws on invalid date", () => {
    expect(() => toDateString(new Date(NaN))).toThrow("Invalid date");
  });
});

describe("formatCurrencyCompact", () => {
  it.each([
    [0, "$0"],
    [-40, "$0"],
    [99_900, "$999"],
    [100_000, "$1k"],
    [120_000, "$1.2k"],
    [1_234_567, "$12k"],
    [99_949_900, "$999k"],
    [99_950_000, "$1M"],
    [120_000_000, "$1.2M"],
    [-120_000, "−$1.2k"],
  ])("formats %i cents as %s", (cents, expected) => {
    expect(formatCurrencyCompact(cents)).toBe(expected);
  });
});

describe("formatCurrencyCompact with decimals", () => {
  it.each([
    [29_150_000, 1, "$291.5k"],
    [29_125_000, 2, "$291.25k"],
    [29_100_000, 1, "$291k"],
    [1_030_000_00, 1, "$1M"],
    [1_250_000_00, 2, "$1.25M"],
    [-29_150_000, 1, "−$291.5k"],
    [12_300, 2, "$123"],
    [50, 1, "$0.5"],
    [150, 1, "$1.5"],
    [-150, 1, "−$1.5"],
    [1, 2, "$0.01"],
    [100_005_000, 5, "$1.00005M"],
  ])("formats %i cents with %i decimals as %s", (cents, decimals, expected) => {
    expect(formatCurrencyCompact(cents, decimals)).toBe(expected);
  });
});

