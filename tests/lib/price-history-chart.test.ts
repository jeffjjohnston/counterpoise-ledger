import { describe, expect, it } from "vitest";
import { toPriceHistoryChart } from "@/lib/price-history-chart";

describe("toPriceHistoryChart", () => {
  it("gives no chart for fewer than two prices", () => {
    expect(toPriceHistoryChart([], "1Y")).toBeNull();
    expect(toPriceHistoryChart([{ priceDate: "2026-01-02", priceMicros: 5_000_000 }], "All")).toBeNull();
  });

  it("turns newest-first rows into one line, oldest first, with values in cents", () => {
    const data = toPriceHistoryChart([
      { priceDate: "2026-03-02", priceMicros: 12_340_000 },
      { priceDate: "2026-02-02", priceMicros: 11_005_000 },
      { priceDate: "2026-01-02", priceMicros: 10_000_000 },
    ], "5Y")!;

    expect(data.series).toHaveLength(1);
    expect(data.series[0].color).toBe("var(--chart-1)");
    // 12.34 -> 1234 cents. 11.005 -> 1100.5, which rounds up to 1101.
    expect(data.series[0].points).toEqual([
      { date: "2026-01-02", value: 1000 },
      { date: "2026-02-02", value: 1101 },
      { date: "2026-03-02", value: 1234 },
    ]);
  });

  it("rounds a price below one cent per share to the nearest cent", () => {
    const data = toPriceHistoryChart([
      { priceDate: "2026-01-03", priceMicros: 14_999 },
      { priceDate: "2026-01-02", priceMicros: 4_999 },
    ], "1Y")!;
    expect(data.series[0].points.map((point) => point.value)).toEqual([0, 1]);
  });

  it("names the range and the first and last prices in the label", () => {
    const rows = [
      { priceDate: "2026-03-02", priceMicros: 12_340_000 },
      { priceDate: "2026-01-02", priceMicros: 10_000_000 },
    ];
    expect(toPriceHistoryChart(rows, "1Y")!.ariaLabel)
      .toBe("Price, last year: from $10.00 on Jan 2, 2026 to $12.34 on Mar 2, 2026");
    expect(toPriceHistoryChart(rows, "5Y")!.ariaLabel).toContain("last 5 years");
    expect(toPriceHistoryChart(rows, "All")!.ariaLabel).toContain("all history");
  });
});
