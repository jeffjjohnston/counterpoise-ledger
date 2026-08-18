import { describe, it, expect } from "vitest";
import { mergeTransactionsForDisplay } from "@/lib/merge-transactions";
import type { DisplayTransaction } from "@/types";

// Minimal transaction factory - only fields the merge function uses
function makeTx(
  overrides: Partial<DisplayTransaction> & { id: number; date: string }
): DisplayTransaction {
  return {
    bookId: 1,
    description: "",
    checkNumber: null,
    notes: null,
    payeeId: null,
    isReconciled: false,
    isFloating: false,
    recurringRuleId: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    payee: null,
    splits: [],
    investmentSplits: [],
    ...overrides,
  };
}

describe("mergeTransactionsForDisplay", () => {
  it("returns actual transactions unchanged when no projected", () => {
    const actual = [
      makeTx({ id: 3, date: "2026-02-28" }),
      makeTx({ id: 2, date: "2026-02-20" }),
      makeTx({ id: 1, date: "2026-02-10" }),
    ];
    const result = mergeTransactionsForDisplay([], actual);
    expect(result).toEqual(actual);
  });

  it("returns projected transactions when no actual", () => {
    const projected = [
      makeTx({ id: -30001, date: "2026-03-05", isProjected: true }),
      makeTx({ id: -10001, date: "2026-03-15", isProjected: true }),
    ];
    const result = mergeTransactionsForDisplay(projected, []);
    expect(result.map((t) => t.date)).toEqual(["2026-03-15", "2026-03-05"]);
  });

  it("interleaves projected and actual by date descending", () => {
    const projected = [
      makeTx({ id: -10001, date: "2026-03-05", isProjected: true }),
      makeTx({ id: -20001, date: "2026-03-10", isProjected: true }),
      makeTx({ id: -30001, date: "2026-03-15", isProjected: true }),
    ];
    const actual = [
      makeTx({ id: 100, date: "2026-03-08" }),
      makeTx({ id: 99, date: "2026-02-28" }),
      makeTx({ id: 98, date: "2026-02-20" }),
    ];
    const result = mergeTransactionsForDisplay(projected, actual);
    expect(result.map((t) => t.date)).toEqual([
      "2026-03-15",
      "2026-03-10",
      "2026-03-08", // actual future txn interleaved correctly
      "2026-03-05",
      "2026-02-28",
      "2026-02-20",
    ]);
  });

  it("sorts same-date transactions with actual before projected", () => {
    const projected = [
      makeTx({ id: -10001, date: "2026-03-01", isProjected: true }),
    ];
    const actual = [
      makeTx({ id: 50, date: "2026-03-01" }),
    ];
    const result = mergeTransactionsForDisplay(projected, actual);
    // Actual transactions appear first for same date (they're "real")
    expect(result.map((t) => t.id)).toEqual([50, -10001]);
  });

  it("sorts same-date actual transactions by id descending", () => {
    const actual = [
      makeTx({ id: 102, date: "2026-03-01" }),
      makeTx({ id: 100, date: "2026-03-01" }),
      makeTx({ id: 101, date: "2026-03-01" }),
    ];
    const result = mergeTransactionsForDisplay([], actual);
    expect(result.map((t) => t.id)).toEqual([102, 101, 100]);
  });

  it("does not mutate input arrays", () => {
    const projected = [
      makeTx({ id: -10001, date: "2026-03-05", isProjected: true }),
    ];
    const actual = [
      makeTx({ id: 50, date: "2026-02-28" }),
    ];
    const projectedCopy = [...projected];
    const actualCopy = [...actual];
    mergeTransactionsForDisplay(projected, actual);
    expect(projected).toEqual(projectedCopy);
    expect(actual).toEqual(actualCopy);
  });
});
