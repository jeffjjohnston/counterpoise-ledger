import type { BarGroup, ChartSeries } from "@/components/charts/types";
import { MAX_MONTHS } from "@/lib/realized-gains-chart";
import { OTHER_KEY, TOP_ITEMS, type ReportChartData } from "@/lib/report-chart";
import { buildTopParentMap, MONTH_NAMES, type ReportAccount, type ReportSplit } from "@/lib/reports";
import { formatCurrency, getDisplayBalance } from "@/lib/wasm-client";

/** `unit` tells the caller if each group is a month or a year. */
export type MonthlyChartData = ReportChartData & { unit: "month" | "year" };

/** The own balance of one expense account, in ledger-sign cents. A parent row does not hold its children. */
export type CategoryRow = { accountId: number; balance: number };

const MONTH_SERIES: ChartSeries[] = [
  { key: "income", label: "Income", color: "var(--chart-3)" },
  { key: "expense", label: "Expense", color: "var(--chart-7)" },
  { key: "net", label: "Net", color: "var(--chart-1)" },
];

/** The month after "YYYY-MM". */
export function nextMonth(month: string): string {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7));
  return index === 12 ? `${year + 1}-01` : `${year}-${String(index + 1).padStart(2, "0")}`;
}

export function monthLabel(month: string): string {
  return `${MONTH_NAMES[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
}

/**
 * Income, expense and net for each month, oldest first. Income and expense are
 * positive. Net is income less expense and goes below zero for a loss. A month
 * with no splits between the first and the last month gets a group of zeros.
 * When the range has more than `MAX_MONTHS` months, each group is one year
 * (gap years get zeros too), so that the bars stay wide enough on a phone.
 * Gives `null` for fewer than 2 months.
 */
export function toMonthlyChart(splits: ReportSplit[]): MonthlyChartData | null {
  const totals = new Map<string, { income: number; expense: number }>();
  for (const split of splits) {
    const month = split.date.slice(0, 7);
    const entry = totals.get(month) ?? { income: 0, expense: 0 };
    if (split.accountType === "income") entry.income += getDisplayBalance(split.amount, "income");
    else if (split.accountType === "expense") entry.expense += getDisplayBalance(split.amount, "expense");
    else continue;
    totals.set(month, entry);
  }
  if (totals.size === 0) return null;

  const sorted = [...totals.keys()].sort();
  const months: string[] = [];
  for (let month = sorted[0]; month <= sorted[sorted.length - 1]; month = nextMonth(month)) months.push(month);
  if (months.length < 2) return null;

  const unit = months.length > MAX_MONTHS ? "year" : "month";
  const keyOf = (month: string) => (unit === "year" ? month.slice(0, 4) : month);
  const buckets = new Map<string, { income: number; expense: number }>();
  for (const month of months) {
    const bucket = buckets.get(keyOf(month)) ?? { income: 0, expense: 0 };
    const entry = totals.get(month);
    if (entry) {
      bucket.income += entry.income;
      bucket.expense += entry.expense;
    }
    buckets.set(keyOf(month), bucket);
  }

  let income = 0;
  let expense = 0;
  const groups: BarGroup[] = [...buckets.entries()].map(([key, entry]) => {
    income += entry.income;
    expense += entry.expense;
    const values = { income: entry.income, expense: entry.expense, net: entry.income - entry.expense };
    return {
      key,
      label: unit === "year" ? key : monthLabel(key),
      bars: MONTH_SERIES.map((item) => ({
        key: item.key,
        label: item.label,
        segments: [{ seriesKey: item.key, value: values[item.key as keyof typeof values] }],
      })),
    };
  });

  return {
    orientation: "vertical",
    groups,
    series: MONTH_SERIES,
    unit,
    ariaLabel: `Income and expense by ${unit}, ${groups[0].label} to ${groups[groups.length - 1].label}: `
      + `Income ${formatCurrency(income)}, Expense ${formatCurrency(expense)}, Net ${formatCurrency(income - expense)}`,
  };
}

/**
 * Expense by top-level account, as horizontal bars: the 10 largest, then
 * "Other". Each row holds only its own account, so the roll-up adds every row
 * to its top account once. A category with a total of zero or less (net
 * refunds) is not in the chart. `period` names the range in the aria-label,
 * for example "all time" or "2026-01-01 to 2026-12-31". Gives `null` when no
 * category has an amount.
 */
export function toCategoryChart(rows: CategoryRow[], accounts: ReportAccount[], period: string): ReportChartData | null {
  const accountMap = new Map(accounts.map((account) => [account.id, account]));
  const topParent = buildTopParentMap(accountMap);
  const totals = new Map<number, number>();
  for (const row of rows) {
    const top = topParent.get(row.accountId) ?? row.accountId;
    totals.set(top, (totals.get(top) ?? 0) + getDisplayBalance(row.balance, "expense"));
  }
  const ranked = [...totals.entries()]
    .filter(([, total]) => total > 0)
    .sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0) return null;

  const shown = ranked.slice(0, TOP_ITEMS);
  const rest = ranked.slice(TOP_ITEMS);
  const groups: BarGroup[] = shown.map(([id, total]) => ({
    key: `account:${id}`,
    label: accountMap.get(id)?.name ?? `Account ${id}`,
    bars: [{ key: "total", label: accountMap.get(id)?.name ?? `Account ${id}`, segments: [{ seriesKey: "total", value: total }] }],
  }));
  const series: ChartSeries[] = [{ key: "total", label: "Expense", color: "var(--chart-1)" }];
  if (rest.length > 0) {
    groups.push({
      key: OTHER_KEY,
      label: "Other",
      bars: [{
        key: "total",
        label: "Other",
        segments: [{ seriesKey: OTHER_KEY, value: rest.reduce((sum, [, total]) => sum + total, 0) }],
      }],
    });
    series.push({ key: OTHER_KEY, label: "Other", color: "var(--chart-8)" });
  }
  const grand = ranked.reduce((sum, [, total]) => sum + total, 0);
  return {
    orientation: "horizontal",
    groups,
    series,
    ariaLabel: `Expense by category, ${period}, largest ${groups[0].label} at ${formatCurrency(shown[0][1])}, all ${formatCurrency(grand)}`,
  };
}
