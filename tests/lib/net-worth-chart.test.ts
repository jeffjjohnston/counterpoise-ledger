import { describe, expect, it } from "vitest";
import { type GroupedNetWorthPoint, type NetWorthGroup, toNetWorthGroupChart } from "@/lib/net-worth-chart";
import { OTHER_KEY } from "@/lib/report-chart";

/** Groups 1 to `count`, named "A1", "A2", … */
function groupList(count: number): NetWorthGroup[] {
  return Array.from({ length: count }, (_, index) => ({ accountId: index + 1, name: `A${index + 1}` }));
}

/** One point with a value for each group, in group order. */
function point(date: string, values: number[]): GroupedNetWorthPoint {
  return {
    date,
    netWorthCents: values.reduce((sum, value) => sum + value, 0),
    groups: values.map((valueCents, index) => ({ accountId: index + 1, valueCents })),
  };
}

describe("toNetWorthGroupChart", () => {
  it("gives no chart for fewer than two points", () => {
    expect(toNetWorthGroupChart(groupList(1), [])).toBeNull();
    expect(toNetWorthGroupChart(groupList(1), [point("2026-01-31", [100])])).toBeNull();
  });

  it("keeps each group when there are 7 or fewer, ranked by the absolute value at the last point", () => {
    // A3 is a liability: its -900 is the largest absolute value at the last point.
    const data = toNetWorthGroupChart(groupList(3), [
      point("2026-01-31", [500, 100, -100]),
      point("2026-02-28", [300, 600, -900]),
    ])!;
    expect(data.series.map((item) => [item.key, item.label, item.color])).toEqual([
      ["account:3", "A3", "var(--chart-1)"],
      ["account:2", "A2", "var(--chart-2)"],
      ["account:1", "A1", "var(--chart-3)"],
    ]);
    expect(data.series[0].points).toEqual([
      { date: "2026-01-31", value: -100 },
      { date: "2026-02-28", value: -900 },
    ]);
  });

  it("keeps the 7 largest groups and adds the rest into Other on each date", () => {
    // At the last point, A1 (10) and A2 (-20) are the two smallest. A1 is large at the first point.
    const data = toNetWorthGroupChart(groupList(9), [
      point("2026-01-31", [5000, 7, 100, 200, 300, 400, 500, 600, 700]),
      point("2026-02-28", [10, -20, 100, 200, 300, 400, 500, 600, -700]),
    ])!;
    expect(data.series.map((item) => item.key)).toEqual([
      "account:9", "account:8", "account:7", "account:6", "account:5", "account:4", "account:3", OTHER_KEY,
    ]);
    const other = data.series[7];
    expect(other.label).toBe("Other");
    expect(other.color).toBe("var(--chart-8)");
    expect(other.points).toEqual([
      { date: "2026-01-31", value: 5007 },
      { date: "2026-02-28", value: -10 },
    ]);
    expect(data.series.slice(0, 7).map((item) => item.color)).toEqual(
      [1, 2, 3, 4, 5, 6, 7].map((index) => `var(--chart-${index})`));
  });

  it("gives the net worth as the total line, equal to the sum of the series on each date", () => {
    const points = [
      point("2026-01-31", [5000, 7, 100, 200, 300, 400, 500, 600, 700]),
      point("2026-02-28", [10, -20, 100, 200, 300, 400, 500, 600, -700]),
    ];
    const data = toNetWorthGroupChart(groupList(9), points)!;
    expect(data.total).toEqual({
      key: "netWorth",
      label: "Net worth",
      color: "var(--fg-primary)",
      points: [{ date: "2026-01-31", value: 7807 }, { date: "2026-02-28", value: 1390 }],
    });
    data.total.points.forEach((total, index) => {
      expect(data.series.reduce((sum, item) => sum + item.points[index].value, 0)).toBe(total.value);
    });
  });

  it("names the range, the net worth and each shown group at the last point in the label", () => {
    const data = toNetWorthGroupChart(
      [{ accountId: 1, name: "Bank" }, { accountId: 2, name: "Card" }],
      [
        { date: "2026-01-31", netWorthCents: 100_000, groups: [{ accountId: 1, valueCents: 120_000 }, { accountId: 2, valueCents: -20_000 }] },
        { date: "2026-02-28", netWorthCents: 150_000, groups: [{ accountId: 1, valueCents: 180_000 }, { accountId: 2, valueCents: -30_000 }] },
      ],
    )!;
    expect(data.ariaLabel).toBe(
      "Net worth by group from Jan 31, 2026 to Feb 28, 2026: $1,000.00 to $1,500.00. "
      + "On Feb 28, 2026: Bank $1,800.00, Card −$300.00",
    );
  });
});
