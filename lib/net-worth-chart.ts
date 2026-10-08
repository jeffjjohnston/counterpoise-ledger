import type { LineSeries } from "@/components/charts/types";
import { OTHER_KEY } from "@/lib/report-chart";
import { formatCurrency, formatDate } from "@/lib/wasm-client";

/** The number of groups that the chart shows. The rest go into "Other". */
export const TOP_GROUPS = 7;

/** A top-level account of the `net-worth-history?groupBy=account` response. */
export type NetWorthGroup = { accountId: number; name: string };

/** One point of that response. `groups` has one value for each group, in the order of the groups. */
export type GroupedNetWorthPoint = {
  date: string;
  netWorthCents: number;
  groups: { accountId: number; valueCents: number }[];
};

export type NetWorthGroupChart = { series: LineSeries[]; total: LineSeries; ariaLabel: string };

/** The value of one group at one point, or 0. */
function valueOf(point: GroupedNetWorthPoint, accountId: number): number {
  return point.groups.find((group) => group.accountId === accountId)?.valueCents ?? 0;
}

/**
 * The stacked areas of the net worth by group: the 7 groups with the largest
 * absolute value at the last point, then "Other" for the rest. A liability
 * is negative, so it stacks below zero. The total is the net worth line.
 * Gives `null` for fewer than two points.
 */
export function toNetWorthGroupChart(groups: NetWorthGroup[], points: GroupedNetWorthPoint[]): NetWorthGroupChart | null {
  if (points.length < 2) return null;
  const first = points[0];
  const last = points[points.length - 1];
  // The sort is stable, so groups with the same value keep the name order of the response.
  const ranked = [...groups].sort((a, b) => Math.abs(valueOf(last, b.accountId)) - Math.abs(valueOf(last, a.accountId)));
  const shown = ranked.slice(0, TOP_GROUPS);
  const rest = ranked.slice(TOP_GROUPS);
  const series: LineSeries[] = shown.map((group, index) => ({
    key: `account:${group.accountId}`,
    label: group.name,
    color: `var(--chart-${index + 1})`,
    points: points.map((point) => ({ date: point.date, value: valueOf(point, group.accountId) })),
  }));
  if (rest.length > 0) {
    series.push({
      key: OTHER_KEY,
      label: "Other",
      color: "var(--chart-8)",
      points: points.map((point) => ({
        date: point.date,
        value: rest.reduce((sum, group) => sum + valueOf(point, group.accountId), 0),
      })),
    });
  }
  const total: LineSeries = {
    key: "netWorth",
    label: "Net worth",
    color: "var(--fg-primary)",
    points: points.map((point) => ({ date: point.date, value: point.netWorthCents })),
  };
  const lastValues = series.map((item) => `${item.label} ${formatCurrency(item.points[item.points.length - 1].value)}`);
  return {
    series,
    total,
    ariaLabel: `Net worth by group from ${formatDate(first.date)} to ${formatDate(last.date)}: `
      + `${formatCurrency(first.netWorthCents)} to ${formatCurrency(last.netWorthCents)}. `
      + `On ${formatDate(last.date)}: ${lastValues.join(", ")}`,
  };
}
