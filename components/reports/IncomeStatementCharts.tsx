"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChartCard } from "@/components/charts/ChartCard";
import { ReportBars } from "@/components/reports/ReportChart";
import { useIsMobile } from "@/hooks/useIsMobile";
import { apiGet } from "@/lib/api-client";
import {
  type CategoryRow,
  toCategoryChart,
  toMonthlyChart,
} from "@/lib/income-statement-chart";
import type { ReportAccount, ReportSplit } from "@/lib/reports";
import { formatCurrency } from "@/lib/wasm-client";

/** The dates of the page period. No date means all time. */
type MonthlyRange = { startDate?: string; endDate?: string };

/** Chart heights as [below the breakpoint, above it]. */
const MONTHLY_HEIGHT: [number, number] = [160, 200];

/**
 * The monthly chart and its states. It mounts only while the card shows the
 * chart, so a hidden chart sends no request.
 */
function MonthlyBars({ bookId, range, activeAccountIds, onTooShort }: {
  bookId: string;
  range: MonthlyRange;
  activeAccountIds: ReadonlySet<number>;
  onTooShort: (tooShort: boolean) => void;
}) {
  const [splits, setSplits] = useState<ReportSplit[] | null>(null);
  const [failed, setFailed] = useState(false);
  const isMobile = useIsMobile();
  const height = MONTHLY_HEIGHT[isMobile ? 0 : 1];
  const { startDate, endDate } = range;

  useEffect(() => {
    let current = true;
    setSplits(null);
    setFailed(false);
    const params = new URLSearchParams({ accountTypes: "income,expense" });
    if (startDate) params.set("startDate", startDate);
    if (endDate) params.set("endDate", endDate);
    apiGet<{ splits?: ReportSplit[] }>(`/api/b/${bookId}/reports/data?${params.toString()}`)
      .then((data) => {
        if (current) setSplits(Array.isArray(data.splits) ? data.splits : []);
      })
      .catch(() => {
        if (current) setFailed(true);
      });
    return () => {
      current = false;
    };
  }, [bookId, startDate, endDate]);

  // The route also returns the splits of inactive accounts. The page totals leave them out, so the chart does too.
  const data = useMemo(
    () => (splits ? toMonthlyChart(splits.filter((split) => activeAccountIds.has(split.accountId))) : null),
    [splits, activeAccountIds],
  );
  const tooShort = splits !== null && data === null;
  // The card goes away when the range has fewer than 2 months.
  useEffect(() => {
    onTooShort(tooShort);
  }, [tooShort, onTooShort]);

  if (failed) return <p className="text-sm text-fg-danger">Could not load income and expense.</p>;
  if (splits === null) {
    return <div data-testid="income-monthly-placeholder" className="animate-pulse rounded bg-surface-tertiary" style={{ height }} />;
  }
  if (!data) return null;
  return (
    <>
      <ReportBars data={data} verticalHeight={MONTHLY_HEIGHT} />
      {/* The accessible form of the chart data. The account cards show no totals by month or year.
          The div clips the table, so that a wide table cannot make the page scroll sideways. */}
      <div className="sr-only">
        <table>
          <caption>Income and expense by {data.unit}</caption>
          <thead>
            <tr>
              <th scope="col">{data.unit === "year" ? "Year" : "Month"}</th>
              <th scope="col">Income</th>
              <th scope="col">Expense</th>
              <th scope="col">Net</th>
            </tr>
          </thead>
          <tbody>
            {data.groups.map((group) => (
              <tr key={group.key}>
                <td>{group.label}</td>
                {group.bars.map((bar) => (
                  <td key={bar.key}>{formatCurrency(bar.segments[0].value)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/**
 * The two charts above the account cards of the income statement.
 * `monthlyRange` is `null` while a custom period has no dates. `expenseRows`
 * are the expense balances that the page shows, one for each account.
 * `activeAccountIds` holds the ids of the active accounts, which the page totals
 * use. The monthly chart leaves out the splits of all other accounts. The
 * account cards below are the visible table of the category chart.
 */
export function IncomeStatementCharts({ bookId, monthlyRange, expenseRows, accounts, activeAccountIds }: {
  bookId: string;
  monthlyRange: MonthlyRange | null;
  expenseRows: CategoryRow[];
  accounts: ReportAccount[];
  activeAccountIds: ReadonlySet<number>;
}) {
  const period = monthlyRange?.startDate && monthlyRange.endDate
    ? `${monthlyRange.startDate} to ${monthlyRange.endDate}`
    : "all time";
  const category = toCategoryChart(expenseRows, accounts, period);
  // The range that the "too short" answer belongs to. A new range clears the answer.
  const rangeKey = monthlyRange ? `${bookId}|${monthlyRange.startDate ?? ""}|${monthlyRange.endDate ?? ""}` : "";
  const [tooShortKey, setTooShortKey] = useState<string | null>(null);
  const onTooShort = useCallback(
    (tooShort: boolean) => setTooShortKey(tooShort ? rangeKey : null),
    [rangeKey],
  );
  const showMonthly = monthlyRange !== null && tooShortKey !== rangeKey;
  if (!showMonthly && !category) return null;

  return (
    <div className="mb-8 grid grid-cols-1 gap-6">
      {showMonthly && (
        <ChartCard title="Income and expense" storageKey="counterpoise.incomeByMonthChart.hidden">
          <MonthlyBars bookId={bookId} range={monthlyRange} activeAccountIds={activeAccountIds} onTooShort={onTooShort} />
        </ChartCard>
      )}
      {category && (
        <ChartCard title="Expense by category" storageKey="counterpoise.expenseBreakdownChart.hidden">
          <ReportBars data={category} />
        </ChartCard>
      )}
    </div>
  );
}
