import type { BarGroup, ChartSeries } from "@/components/charts/types";
import { OTHER_KEY, TOP_ITEMS } from "@/lib/report-chart";
import { formatCurrency } from "@/lib/wasm-client";

/** The fields of a security that the chart uses. */
export type AllocationSecurity = {
  id: number;
  symbol: string;
  name: string;
  marketValueCents: number | null;
};

export type AllocationChartData = {
  groups: BarGroup[];
  series: ChartSeries[];
  ariaLabel: string;
};

function share(value: number, total: number): string {
  return `${((value / total) * 100).toFixed(1)}%`;
}

/**
 * One horizontal bar for each security, by market value, largest first. The
 * 10 largest get a bar, and the rest go into "Other". Each segment holds its
 * share of the total for the tooltip. A security with no price, or with a
 * value of zero or less, has no bar. Fewer than two bars give no chart.
 */
export function toAllocationChart(securities: AllocationSecurity[]): AllocationChartData | null {
  const valued = securities
    .filter((security): security is AllocationSecurity & { marketValueCents: number } =>
      security.marketValueCents !== null && security.marketValueCents > 0)
    .sort((a, b) => b.marketValueCents - a.marketValueCents);
  if (valued.length < 2) return null;

  const total = valued.reduce((sum, security) => sum + security.marketValueCents, 0);
  const shown = valued.slice(0, TOP_ITEMS);
  const rest = valued.slice(TOP_ITEMS);

  const groups: BarGroup[] = shown.map((security) => ({
    key: `security:${security.id}`,
    label: security.symbol,
    bars: [{
      key: "value",
      label: security.symbol,
      segments: [{ seriesKey: "value", value: security.marketValueCents, detail: share(security.marketValueCents, total) }],
    }],
  }));
  const series: ChartSeries[] = [{ key: "value", label: "Value", color: "var(--chart-1)" }];
  if (rest.length > 0) {
    const value = rest.reduce((sum, security) => sum + security.marketValueCents, 0);
    groups.push({
      key: OTHER_KEY,
      label: "Other",
      bars: [{ key: "value", label: "Other", segments: [{ seriesKey: OTHER_KEY, value, detail: share(value, total) }] }],
    });
    series.push({ key: OTHER_KEY, label: "Other", color: "var(--chart-8)" });
  }

  const largest = shown[0];
  return {
    groups,
    series,
    ariaLabel: `Market value by security, largest ${largest.symbol} at ${formatCurrency(largest.marketValueCents)} (${share(largest.marketValueCents, total)}), all ${formatCurrency(total)}`,
  };
}
