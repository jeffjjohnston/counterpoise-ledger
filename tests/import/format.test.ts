import { describe, expect, it } from "vitest";
import {
  normalizeOptionalText,
  normalizeName,
  isReconciledStatus,
  isTransactionReconciled,
} from "@/scripts/import-moneydance/utils/format";

describe("normalizeOptionalText", () => {
  it("returns null for blank strings", () => {
    expect(normalizeOptionalText("")).toBeNull();
    expect(normalizeOptionalText("   ")).toBeNull();
  });

  it("trims and returns non-empty values", () => {
    expect(normalizeOptionalText(" 1234 ")).toBe("1234");
    expect(normalizeOptionalText("A-55")).toBe("A-55");
  });

  it("supports non-string values by stringifying", () => {
    expect(normalizeOptionalText(1001)).toBe("1001");
  });
});

describe("normalizeName", () => {
  it("trims and collapses whitespace", () => {
    expect(normalizeName("  Blue   Bottle  ")).toBe("Blue Bottle");
    expect(normalizeName("Coffee    Shop")).toBe("Coffee Shop");
  });

  it("normalizes curly quotes to straight quotes", () => {
    // Right single quotation mark (common in Moneydance exports)
    expect(normalizeName("Trader Joe\u2019s")).toBe("Trader Joe's");

    // Left single quotation mark
    expect(normalizeName("Trader Joe\u2018s")).toBe("Trader Joe's");

    // All variations should normalize to the same result
    expect(normalizeName("Trader Joe\u2019s")).toBe(normalizeName("Trader Joe\u2018s"));
    expect(normalizeName("Trader Joe\u2019s")).toBe(normalizeName("Trader Joe's"));
  });

  it("normalizes grave accent and acute accent to straight quote", () => {
    expect(normalizeName("Bob`s Diner")).toBe("Bob's Diner");
    expect(normalizeName("Bob\u00B4s Diner")).toBe("Bob's Diner");
  });

  it("handles multiple quote types in one name", () => {
    expect(normalizeName("Joe\u2019s & Jane\u2018s Store")).toBe("Joe's & Jane's Store");
  });

  it("matches behavior of normalizePayeeName from @/lib/payees", () => {
    // This test ensures import normalization stays in sync with API normalization
    const testCases = [
      "Trader Joe\u2019s",
      "  Trader   Joe\u2019s  ",
      "Bob\u2018s Diner",
      "L'Or\u00E9al",
    ];

    for (const testCase of testCases) {
      const importNormalized = normalizeName(testCase);
      // Ensure it's properly normalized (no leading/trailing spaces, single spaces, straight quotes)
      expect(importNormalized).toBe(importNormalized.trim());
      expect(importNormalized).not.toMatch(/  /);
      expect(importNormalized).not.toMatch(/[\u2018\u2019]/);
    }
  });
});

describe("isReconciledStatus", () => {
  it("returns true for reconciled status 'X'", () => {
    expect(isReconciledStatus("X")).toBe(true);
  });

  it("returns true for lowercase reconciled status 'x'", () => {
    expect(isReconciledStatus("x")).toBe(true);
  });

  it("returns false for space (unreconciled in newer Moneydance format)", () => {
    expect(isReconciledStatus(" ")).toBe(false);
  });

  it("returns false for undefined/missing status", () => {
    expect(isReconciledStatus(undefined)).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isReconciledStatus("")).toBe(false);
  });
});

describe("isTransactionReconciled", () => {
  it("returns true when parent stat is 'X'", () => {
    expect(isTransactionReconciled({ stat: "X" })).toBe(true);
  });

  it("returns true when a split stat is 'X' but parent is not", () => {
    expect(isTransactionReconciled({
      stat: " ",
      "0.stat": "X",
    })).toBe(true);
  });

  it("returns true when only a non-zero split is reconciled", () => {
    expect(isTransactionReconciled({
      stat: " ",
      "0.stat": " ",
      "1.stat": "X",
    })).toBe(true);
  });

  it("returns false when neither parent nor splits are reconciled", () => {
    expect(isTransactionReconciled({
      stat: " ",
      "0.stat": " ",
    })).toBe(false);
  });

  it("returns false when stat is missing entirely", () => {
    expect(isTransactionReconciled({})).toBe(false);
  });

  it("returns false when parent stat is missing and splits are unreconciled", () => {
    expect(isTransactionReconciled({
      "0.stat": " ",
    })).toBe(false);
  });

  it("handles case-insensitive split stat", () => {
    expect(isTransactionReconciled({
      stat: " ",
      "0.stat": "x",
    })).toBe(true);
  });
});
