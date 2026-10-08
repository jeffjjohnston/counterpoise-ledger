import type { BarGroup, BarSegment, ChartSeries } from "@/components/charts/types";
import type { GroupDimension, ReportGroupNode, ReportSplit } from "@/lib/reports";
import { formatCurrency, getDisplayBalance } from "@/lib/wasm-client";

export const TOP_ACCOUNTS = 7;
export const TOP_ITEMS = 10;
export const OTHER_KEY = "other";

const TIME_DIMENSIONS: GroupDimension[] = ["week", "month", "year"];
const TYPE_ORDER = ["income", "expense", "asset", "liability", "equity"];
const TYPE_LABELS: Record<string, string> = {
  income: "Income", expense: "Expense", asset: "Asset", liability: "Liability", equity: "Equity",
};
const OTHER_COLOR = "var(--chart-8)";

export type ReportChartData = {
  orientation: "vertical" | "horizontal";
  groups: BarGroup[];
  series: ChartSeries[];
  ariaLabel: string;
};

/** The color of the series at an index. --chart-8 is kept for "Other". */
function color(index: number): string {
  return `var(--chart-${(index % 7) + 1})`;
}

/** The total that the table shows: income and expense both positive. */
function displayTotal(splits: ReportSplit[]): number {
  return splits.reduce((sum, split) => sum + getDisplayBalance(split.amount, split.accountType), 0);
}

/** The display total of the splits of one account type. */
function typeTotal(splits: ReportSplit[], type: string): number {
  return displayTotal(splits.filter((split) => split.accountType === type));
}

/**
 * The ranking amount: the sum of the absolute type totals. Income and expense do not cancel.
 * For splits of one type, it is the absolute display total.
 */
function weight(splits: ReportSplit[], types: string[]): number {
  return types.reduce((sum, type) => sum + Math.abs(typeTotal(splits, type)), 0);
}

/** The last part of a node key: "2026-01/account:4" gives "account:4". */
function leafKey(node: ReportGroupNode): string {
  return node.key.slice(node.key.lastIndexOf("/") + 1);
}

/**
 * The chart for the report tree. The first grouping level sets the form:
 * a time level gives vertical bars by period, payee or account gives
 * horizontal bars by amount. No grouping gives no chart.
 */
export function toChartData(grouped: ReportGroupNode[], dimensions: GroupDimension[]): ReportChartData | null {
  if (grouped.length === 0 || dimensions.length === 0) return null;
  return TIME_DIMENSIONS.includes(dimensions[0])
    ? timeChart(grouped, dimensions)
    : rankedChart(grouped, dimensions[0]);
}

function timeChart(grouped: ReportGroupNode[], dimensions: GroupDimension[]): ReportChartData {
  const present = new Set(grouped.flatMap((node) => node.splits.map((split) => split.accountType)));
  const types = TYPE_ORDER.filter((type) => present.has(type));
  const byAccount = dimensions[1] === "account";
  const series = byAccount
    ? accountSeries(grouped, types)
    : types.map((type, index) => ({ key: type, label: TYPE_LABELS[type], color: color(index) }));
  const named = new Set(series.map((item) => item.key));
  const groups = grouped.map((node) => ({
    key: node.key,
    label: node.label,
    bars: types.map((type) => ({
      key: type,
      label: TYPE_LABELS[type],
      segments: byAccount
        ? accountSegments(node, type, named)
        : [{ seriesKey: type, value: typeTotal(node.splits, type) }],
    })),
  }));

  // Compute totals by type across all periods for aria-label
  const typeTotals = types.map((type) => {
    const sum = typeTotal(grouped.flatMap((node) => node.splits), type);
    return `${TYPE_LABELS[type]} ${formatCurrency(sum)}`;
  });

  return {
    orientation: "vertical",
    groups,
    series,
    ariaLabel: `Totals by ${dimensions[0]}, ${grouped[0].label} to ${grouped[grouped.length - 1].label}: ${typeTotals.join(", ")}`,
  };
}

/** The 7 accounts with the largest weights in all periods, then "Other". */
function accountSeries(grouped: ReportGroupNode[], types: string[]): ChartSeries[] {
  const totals = new Map<string, { label: string; total: number }>();
  for (const node of grouped) {
    for (const child of node.children) {
      const key = leafKey(child);
      const entry = totals.get(key) ?? { label: child.label, total: 0 };
      entry.total += weight(child.splits, types);
      totals.set(key, entry);
    }
  }
  const ranked = [...totals.entries()].sort((a, b) => b[1].total - a[1].total);
  const series = ranked.slice(0, TOP_ACCOUNTS).map(([key, entry], index) => ({ key, label: entry.label, color: color(index) }));
  if (ranked.length > TOP_ACCOUNTS) series.push({ key: OTHER_KEY, label: "Other", color: OTHER_COLOR });
  return series;
}

/**
 * The segments of one period and account type. An account outside the named series goes into "Other".
 * With collapseToParent, a parent account node holds the splits of its child accounts, which can have
 * other types. Thus each child gives only the display total of its splits of this type.
 */
function accountSegments(node: ReportGroupNode, type: string, named: Set<string>): BarSegment[] {
  const segments = new Map<string, number>();
  for (const child of node.children) {
    if (!child.splits.some((split) => split.accountType === type)) continue;
    const key = named.has(leafKey(child)) ? leafKey(child) : OTHER_KEY;
    segments.set(key, (segments.get(key) ?? 0) + typeTotal(child.splits, type));
  }
  return [...segments].map(([seriesKey, value]) => ({ seriesKey, value }));
}

/** The account types that the splits of the nodes use, in the fixed order. */
function typesOf(nodes: ReportGroupNode[]): string[] {
  const present = new Set(nodes.flatMap((node) => node.splits.map((split) => split.accountType)));
  return TYPE_ORDER.filter((type) => present.has(type));
}

/** One bar for each account type, with the display totals of the splits of that type. */
function typeBars(splits: ReportSplit[], types: string[]) {
  return types.map((type) => ({
    key: type,
    label: TYPE_LABELS[type],
    segments: [{
      seriesKey: type,
      value: typeTotal(splits, type),
    }],
  }));
}

function rankedChart(grouped: ReportGroupNode[], dimension: GroupDimension): ReportChartData {
  const types = typesOf(grouped);
  const nodeWeight = (node: ReportGroupNode) => weight(node.splits, types);
  // In a report with more than one type, node.total is a signed net. The chart shows positive
  // display totals instead. A node with more than one type gets one bar for each type. A payee node can have more than one type. An account node usually cannot, but with
  // collapseToParent a parent account node holds the splits of its child accounts, which can have other types.
  const byType = grouped.some((node) => typesOf([node]).length > 1);
  const ranked = [...grouped].sort((a, b) => nodeWeight(b) - nodeWeight(a));
  const shown = ranked.slice(0, TOP_ITEMS);
  const rest = ranked.slice(TOP_ITEMS);
  const groups: BarGroup[] = shown.map((node) => ({
    key: node.key,
    label: node.label,
    bars: byType
      ? typeBars(node.splits, types)
      : [{ key: "total", label: node.label, segments: [{ seriesKey: "total", value: displayTotal(node.splits) }] }],
  }));
  const series: ChartSeries[] = byType
    ? types.map((type, index) => ({ key: type, label: TYPE_LABELS[type], color: color(index) }))
    : [{ key: "total", label: "Total", color: color(0) }];
  if (rest.length > 0) {
    groups.push({
      key: OTHER_KEY,
      label: "Other",
      bars: byType
        ? typeBars(rest.flatMap((node) => node.splits), types)
        : [{
            key: "total",
            label: "Other",
            segments: [{ seriesKey: OTHER_KEY, value: rest.reduce((sum, node) => sum + displayTotal(node.splits), 0) }],
          }],
    });
    if (!byType) series.push({ key: OTHER_KEY, label: "Other", color: OTHER_COLOR });
  }

  // With more than one type in the report, add the absolute amounts so that income and expense do not cancel.
  const grand = grouped.reduce((sum, node) => sum + (types.length > 1 ? nodeWeight(node) : displayTotal(node.splits)), 0);
  const largest = byType ? nodeWeight(shown[0]) : displayTotal(shown[0].splits);

  return {
    orientation: "horizontal",
    groups,
    series,
    ariaLabel: `Totals by ${dimension}, largest ${shown[0].label} at ${formatCurrency(largest)}, all ${formatCurrency(grand)}`,
  };
}
