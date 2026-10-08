import { describe, expect, it } from "vitest";
import { type AllocationSecurity, toAllocationChart } from "@/lib/allocation-chart";
import { OTHER_KEY } from "@/lib/report-chart";

function security(id: number, symbol: string, marketValueCents: number | null): AllocationSecurity {
  return { id, symbol, name: `${symbol} fund`, marketValueCents };
}

describe("toAllocationChart", () => {
  it("gives no chart for fewer than two securities with a value", () => {
    expect(toAllocationChart([])).toBeNull();
    expect(toAllocationChart([security(1, "VTI", 100_000), security(2, "BND", null), security(3, "AGG", 0)])).toBeNull();
  });

  it("ranks the securities by market value, with the share of the total in each segment", () => {
    const data = toAllocationChart([
      security(1, "BND", 25_000),
      security(2, "VTI", 75_000),
      security(3, "XYZ", null),
    ])!;

    expect(data.groups.map((group) => group.label)).toEqual(["VTI", "BND"]);
    expect(data.groups[0].bars[0].segments).toEqual([{ seriesKey: "value", value: 75_000, detail: "75.0%" }]);
    expect(data.groups[1].bars[0].segments).toEqual([{ seriesKey: "value", value: 25_000, detail: "25.0%" }]);
    expect(data.series).toEqual([{ key: "value", label: "Value", color: "var(--chart-1)" }]);
    expect(data.ariaLabel).toBe("Market value by security, largest VTI at $750.00 (75.0%), all $1,000.00");
  });

  it("keeps the 10 largest and adds the rest as Other", () => {
    const data = toAllocationChart(
      Array.from({ length: 12 }, (_, index) => security(index + 1, `S${index + 1}`, (index + 1) * 1_000)),
    )!;

    expect(data.groups).toHaveLength(11);
    expect(data.groups[0].label).toBe("S12");
    const other = data.groups[10];
    expect(other.label).toBe("Other");
    // S1 and S2: 3,000 of 78,000.
    expect(other.bars[0].segments).toEqual([{ seriesKey: OTHER_KEY, value: 3_000, detail: "3.8%" }]);
    expect(data.series.map((item) => item.key)).toEqual(["value", OTHER_KEY]);
  });
});
