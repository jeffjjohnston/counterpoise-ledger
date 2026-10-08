import type { LineSeries } from "@/components/charts/types";
import { type ChartRange, RANGE_NAMES } from "@/lib/chart-range";
import { formatCurrency, formatDate, getDisplayBalance } from "@/lib/wasm-client";

/** One point of the `balance-history` route. `balanceCents` has the ledger sign. */
export type AccountBalancePoint = { date: string; balanceCents: number };

export type AccountBalanceChartData = { series: LineSeries[]; ariaLabel: string };

/**
 * One balance line, with the display sign of the account type: a liability
 * that is owed is positive. Gives `null` for fewer than two points, because
 * one point has no line.
 */
export function toAccountBalanceChart(
  points: AccountBalancePoint[],
  accountType: string,
  range: ChartRange,
): AccountBalanceChartData | null {
  if (points.length < 2) return null;
  const line = points.map((point) => ({ date: point.date, value: getDisplayBalance(point.balanceCents, accountType) }));
  const first = line[0];
  const last = line[line.length - 1];
  return {
    series: [{ key: "balance", label: "Balance", color: "var(--chart-1)", points: line }],
    ariaLabel: `Balance, ${RANGE_NAMES[range]}: from ${formatCurrency(first.value)} on ${formatDate(first.date)} `
      + `to ${formatCurrency(last.value)} on ${formatDate(last.date)}`,
  };
}
