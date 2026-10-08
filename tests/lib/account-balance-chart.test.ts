import { describe, expect, it } from "vitest";
import { toAccountBalanceChart } from "@/lib/account-balance-chart";

const points = [
  { date: "2026-01-31", balanceCents: 38_000 },
  { date: "2026-02-28", balanceCents: -1_250 },
  { date: "2026-03-20", balanceCents: 41_000 },
];

describe("toAccountBalanceChart", () => {
  it("gives no chart for fewer than two points", () => {
    expect(toAccountBalanceChart([], "asset", "1Y")).toBeNull();
    expect(toAccountBalanceChart([points[0]], "asset", "All")).toBeNull();
  });

  it("draws an asset with the ledger sign", () => {
    const data = toAccountBalanceChart(points, "asset", "1Y")!;
    expect(data.series).toHaveLength(1);
    expect(data.series[0].color).toBe("var(--chart-1)");
    expect(data.series[0].points).toEqual([
      { date: "2026-01-31", value: 38_000 },
      { date: "2026-02-28", value: -1_250 },
      { date: "2026-03-20", value: 41_000 },
    ]);
  });

  it("turns the credit balance of a liability into a positive amount owed", () => {
    // A card that owes 500.00 has the ledger balance -50,000.
    const data = toAccountBalanceChart([
      { date: "2026-01-31", balanceCents: -50_000 },
      { date: "2026-02-28", balanceCents: 2_000 },
    ], "liability", "5Y")!;
    expect(data.series[0].points.map((point) => point.value)).toEqual([50_000, -2_000]);
  });

  it("names the range and the first and last balances in the label", () => {
    expect(toAccountBalanceChart(points, "asset", "1Y")!.ariaLabel)
      .toBe("Balance, last year: from $380.00 on Jan 31, 2026 to $410.00 on Mar 20, 2026");
    expect(toAccountBalanceChart(points, "asset", "5Y")!.ariaLabel).toContain("last 5 years");
    expect(toAccountBalanceChart(points, "asset", "All")!.ariaLabel).toContain("all history");
  });
});
