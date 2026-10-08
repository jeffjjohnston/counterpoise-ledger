import { describe, expect, it } from "vitest";
import { toCategoryChart, toMonthlyChart } from "@/lib/income-statement-chart";
import type { ReportAccount, ReportSplit } from "@/lib/reports";

function split(date: string, amount: number, accountType: "income" | "expense"): ReportSplit {
  return {
    splitId: 1, transactionId: 1, date, amount, accountId: 1, accountName: "A",
    accountType, accountParentId: null, payeeId: null, payeeName: null,
  };
}

describe("toMonthlyChart", () => {
  it("gives one group per month with income, expense and net bars", () => {
    const two = toMonthlyChart([
      split("2026-01-05", -300_000, "income"),
      split("2026-01-10", 100_000, "expense"),
      split("2026-01-20", 50_000, "expense"),
      split("2026-02-01", 20_000, "expense"),
    ])!;
    expect(two.series.map((s) => [s.key, s.color])).toEqual([
      ["income", "var(--chart-3)"], ["expense", "var(--chart-7)"], ["net", "var(--chart-1)"],
    ]);
    const january = two.groups[0];
    expect(january.label).toBe("January 2026");
    const values = (g: typeof january) => g.bars.map((b) => [b.key, b.segments[0].value]);
    expect(values(january)).toEqual([["income", 300_000], ["expense", 150_000], ["net", 150_000]]);
    // A loss month: net is below zero.
    expect(values(two.groups[1])).toEqual([["income", 0], ["expense", 20_000], ["net", -20_000]]);
  });

  it("adds a zero group for a month without splits, oldest first", () => {
    const data = toMonthlyChart([
      split("2026-03-02", 5_000, "expense"),
      split("2025-12-30", -9_000, "income"),
    ])!;
    expect(data.groups.map((g) => g.key)).toEqual(["2025-12", "2026-01", "2026-02", "2026-03"]);
    expect(data.groups[1].bars.map((b) => b.segments[0].value)).toEqual([0, 0, 0]);
  });

  it("keeps one group per month for a range of 24 months", () => {
    const data = toMonthlyChart([
      split("2025-01-15", 1_000, "expense"),
      split("2026-12-15", 2_000, "expense"),
    ])!;
    expect(data.unit).toBe("month");
    expect(data.groups).toHaveLength(24);
    expect(data.ariaLabel).toMatch(/^Income and expense by month, January 2025 to December 2026: /);
  });

  it("gives one group per year, gap years included, for a range of more than 24 months", () => {
    // December 2022 to January 2025 is 26 months.
    const data = toMonthlyChart([
      split("2022-12-20", -50_000, "income"),
      split("2022-12-21", 10_000, "expense"),
      split("2025-01-03", 30_000, "expense"),
      split("2025-06-30", -20_000, "income"),
    ])!;
    expect(data.unit).toBe("year");
    expect(data.groups.map((g) => [g.key, g.label])).toEqual([
      ["2022", "2022"], ["2023", "2023"], ["2024", "2024"], ["2025", "2025"],
    ]);
    const values = (g: (typeof data.groups)[number]) => g.bars.map((b) => b.segments[0].value);
    expect(values(data.groups[0])).toEqual([50_000, 10_000, 40_000]);
    expect(values(data.groups[1])).toEqual([0, 0, 0]);
    expect(values(data.groups[3])).toEqual([20_000, 30_000, -10_000]);
    expect(data.ariaLabel).toBe(
      "Income and expense by year, 2022 to 2025: Income $700.00, Expense $400.00, Net $300.00",
    );
  });

  it("gives null for fewer than 2 months", () => {
    expect(toMonthlyChart([])).toBeNull();
    expect(toMonthlyChart([split("2026-01-05", 100, "expense"), split("2026-01-09", 100, "expense")])).toBeNull();
  });
});

const accounts: ReportAccount[] = [
  { id: 1, name: "Housing", type: "expense", parentId: null },
  { id: 2, name: "Rent", type: "expense", parentId: 1 },
  { id: 3, name: "Utilities", type: "expense", parentId: 1 },
  { id: 4, name: "Food", type: "expense", parentId: null },
];

describe("toCategoryChart", () => {
  it("rolls children up to the top account and counts each balance once", () => {
    // Each row holds the own balance of its account. The parent row has its own 5_000.
    const data = toCategoryChart(
      [
        { accountId: 1, balance: 5_000 },
        { accountId: 2, balance: 100_000 },
        { accountId: 3, balance: 20_000 },
        { accountId: 4, balance: 30_000 },
      ],
      accounts,
      "all time",
    )!;
    expect(data.orientation).toBe("horizontal");
    expect(data.groups.map((g) => [g.label, g.bars[0].segments[0].value])).toEqual([
      ["Housing", 125_000], ["Food", 30_000],
    ]);
  });

  it("keeps the 10 largest and puts the rest in Other", () => {
    const many: ReportAccount[] = Array.from({ length: 12 }, (_, i) => ({
      id: i + 1, name: `C${i + 1}`, type: "expense", parentId: null,
    }));
    const data = toCategoryChart(many.map((a) => ({ accountId: a.id, balance: a.id * 1_000 })), many, "all time")!;
    expect(data.groups).toHaveLength(11);
    expect(data.groups[0].label).toBe("C12");
    const other = data.groups[10];
    expect(other.label).toBe("Other");
    expect(other.bars[0].segments[0]).toEqual({ seriesKey: "other", value: 3_000 }); // C1 + C2
    expect(data.series.map((s) => s.color)).toEqual(["var(--chart-1)", "var(--chart-8)"]);
  });

  it("gives null with no expense", () => {
    expect(toCategoryChart([{ accountId: 4, balance: 0 }], accounts, "all time")).toBeNull();
    expect(toCategoryChart([], accounts, "all time")).toBeNull();
  });

  it("drops a category with a negative total and names the period", () => {
    const data = toCategoryChart(
      [{ accountId: 1, balance: -4_000 }, { accountId: 4, balance: 30_000 }],
      accounts,
      "2026-01-01 to 2026-12-31",
    )!;
    expect(data.groups.map((g) => g.label)).toEqual(["Food"]);
    expect(data.ariaLabel).toContain("2026-01-01 to 2026-12-31");
    expect(toCategoryChart([{ accountId: 1, balance: -4_000 }], accounts, "all time")).toBeNull();
  });
});
