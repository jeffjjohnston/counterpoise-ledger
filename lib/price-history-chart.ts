import type { LineSeries } from "@/components/charts/types";
import { type ChartRange, RANGE_NAMES } from "@/lib/chart-range";
import { formatCurrency, formatDate } from "@/lib/wasm-client";

/** The fields of a price row that the chart uses. */
export type PriceHistoryChartRow = { priceDate: string; priceMicros: number };

export type PriceHistoryChartData = { series: LineSeries[]; ariaLabel: string };

const MICROS_PER_CENT = 10_000;

/**
 * One price line. `rows` are newest first, as the prices route gives them; the
 * line runs oldest first. Values are cents. Gives `null` for fewer than two
 * prices, because one point has no line.
 */
export function toPriceHistoryChart(rows: PriceHistoryChartRow[], range: ChartRange): PriceHistoryChartData | null {
  if (rows.length < 2) return null;
  const points = rows
    .map((row) => ({ date: row.priceDate, value: Math.round(row.priceMicros / MICROS_PER_CENT) }))
    .reverse();
  const first = points[0];
  const last = points[points.length - 1];
  return {
    series: [{ key: "price", label: "Price", color: "var(--chart-1)", points }],
    ariaLabel: `Price, ${RANGE_NAMES[range]}: from ${formatCurrency(first.value)} on ${formatDate(first.date)} `
      + `to ${formatCurrency(last.value)} on ${formatDate(last.date)}`,
  };
}
