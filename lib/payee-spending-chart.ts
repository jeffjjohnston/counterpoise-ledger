import type { BarGroup } from "@/components/charts/types";
import { monthLabel, nextMonth } from "@/lib/income-statement-chart";
import { type ReportChartData, toChartData } from "@/lib/report-chart";
import { groupSplits, type ReportAccount, type ReportSplit } from "@/lib/reports";

/** Month grouping needs no account tree. */
const NO_ACCOUNTS = new Map<number, ReportAccount>();

/**
 * Income and expense of one payee for each month from `firstMonth` to
 * `lastMonth` ("YYYY-MM"), oldest first. A month with no splits gets a group of
 * zeros, so that a payee that is paid each quarter does not look monthly.
 * Gives `null` when the splits have no income or expense.
 */
export function toPayeeSpendingChart(splits: ReportSplit[], firstMonth: string, lastMonth: string): ReportChartData | null {
  const data = toChartData(groupSplits(splits, ["month"], NO_ACCOUNTS, false), ["month"]);
  if (!data) return null;

  const byMonth = new Map(data.groups.map((group) => [group.key, group]));
  const groups: BarGroup[] = [];
  for (let month = firstMonth; month <= lastMonth; month = nextMonth(month)) {
    groups.push(byMonth.get(month) ?? {
      key: month,
      label: monthLabel(month),
      bars: data.groups[0].bars.map((bar) => ({
        key: bar.key,
        label: bar.label,
        segments: bar.segments.map((segment) => ({ seriesKey: segment.seriesKey, value: 0 })),
      })),
    });
  }
  // The label of toChartData names the first and the last month with splits. Here the range is wider.
  const totals = data.ariaLabel.slice(data.ariaLabel.indexOf(": "));
  return {
    ...data,
    groups,
    ariaLabel: `Totals by month, ${groups[0].label} to ${groups[groups.length - 1].label}${totals}`,
  };
}
