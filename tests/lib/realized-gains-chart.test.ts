import { describe, expect, it } from "vitest";
import { type RealizedGainChartRow, toRealizedGainsChart } from "@/lib/realized-gains-chart";

function row(sellDate: string, term: RealizedGainChartRow["term"], gainCents: number | null): RealizedGainChartRow {
  return { sellDate, term, gainCents };
}

/** The value of each segment, by group: { "2026-01": { short: 100 } }. */
function values(data: NonNullable<ReturnType<typeof toRealizedGainsChart>>) {
  return Object.fromEntries(data.groups.map((group) => [
    group.key,
    Object.fromEntries(group.bars[0].segments.map((segment) => [segment.seriesKey, segment.value])),
  ]));
}

describe("toRealizedGainsChart", () => {
  it("gives no chart without a known gain", () => {
    expect(toRealizedGainsChart([], { startDate: "2026-01-01", endDate: "2026-12-31" })).toBeNull();
    expect(toRealizedGainsChart([row("2026-03-02", "unknown", null)], { startDate: "2026-01-01", endDate: "2026-12-31" }))
      .toBeNull();
    expect(toRealizedGainsChart([row("2024-09-01", "long", 5_000)], { startDate: "2026-01-01", endDate: "2026-12-31" }))
      .toBeNull();
  });

  it("gives one group for each month of the range, empty months included, with short and long term stacked", () => {
    const data = toRealizedGainsChart([
      row("2026-01-15", "short", 10_000),
      row("2026-01-20", "long", 25_000),
      row("2026-03-02", "short", -4_000),
      row("2026-03-09", "unknown", null),
    ], { startDate: "2026-01-01", endDate: "2026-04-10" })!;

    expect(data.groups.map((group) => group.label)).toEqual(["Jan", "Feb", "Mar", "Apr"]);
    expect(values(data)).toEqual({
      "2026-01": { short: 10_000, long: 25_000 },
      "2026-02": { short: 0, long: 0 },
      "2026-03": { short: -4_000, long: 0 },
      "2026-04": { short: 0, long: 0 },
    });
    expect(data.series.map((item) => item.label)).toEqual(["Short term", "Long term"]);
    expect(data.ariaLabel).toBe(
      "Realized gains by month, January 2026 to April 2026: short term $60.00, long term $250.00",
    );
  });

  it("adds the year to the month labels when the range crosses a year", () => {
    const data = toRealizedGainsChart([row("2025-12-15", "long", 1_000)], { startDate: "2025-11-01", endDate: "2026-01-31" })!;
    expect(data.groups.map((group) => group.label)).toEqual(["Nov 2025", "Dec 2025", "Jan 2026"]);
  });

  it("groups by year when the range is longer than 24 months", () => {
    const data = toRealizedGainsChart([
      row("2023-05-01", "short", 1_000),
      row("2025-02-01", "long", 2_000),
      row("2025-08-01", "long", 3_000),
    ], { startDate: "2023-01-01", endDate: "2025-12-31" })!;

    expect(data.groups.map((group) => group.label)).toEqual(["2023", "2024", "2025"]);
    expect(values(data)["2025"]).toEqual({ short: 0, long: 5_000 });
    expect(data.ariaLabel).toMatch(/^Realized gains by year, 2023 to 2025:/);
  });

  it("leaves out a row outside the range, also from the totals in the label", () => {
    const data = toRealizedGainsChart([
      row("2026-02-10", "short", 1_000),
      row("2024-09-01", "long", 9_000),
    ], { startDate: "2026-01-01", endDate: "2026-03-15" })!;
    expect(data.ariaLabel).toBe("Realized gains by month, January 2026 to March 2026: short term $10.00, long term $0.00");
  });

  it("leaves out a sale in the first or last month that is outside the range", () => {
    const data = toRealizedGainsChart([
      row("2026-01-10", "short", 1_000),
      row("2026-01-20", "short", 2_000),
      row("2026-01-28", "long", 4_000),
    ], { startDate: "2026-01-15", endDate: "2026-01-25" })!;
    expect(values(data)).toEqual({ "2026-01": { short: 2_000, long: 0 } });
  });

  it("leaves out a sale in the first or last year that is outside the range", () => {
    const data = toRealizedGainsChart([
      row("2023-03-01", "short", 1_000),
      row("2023-07-01", "short", 2_000),
      row("2026-02-01", "long", 4_000),
      row("2026-06-01", "long", 8_000),
    ], { startDate: "2023-06-01", endDate: "2026-03-31" })!;
    expect(values(data)["2023"]).toEqual({ short: 2_000, long: 0 });
    expect(values(data)["2026"]).toEqual({ short: 0, long: 4_000 });
  });

  it("stops at the last month of year 9999", () => {
    const data = toRealizedGainsChart([row("9999-11-01", "long", 1_000)], { startDate: "9999-10-01", endDate: "9999-12-31" })!;
    expect(data.groups.map((group) => group.key)).toEqual(["9999-10", "9999-11", "9999-12"]);
  });

  it("uses the dates of the rows when the range has no start or end", () => {
    const data = toRealizedGainsChart([
      row("2026-02-10", "short", 1_000),
      row("2026-04-01", "long", 2_000),
    ], { startDate: "", endDate: "" })!;
    expect(data.groups.map((group) => group.key)).toEqual(["2026-02", "2026-03", "2026-04"]);
  });
});
