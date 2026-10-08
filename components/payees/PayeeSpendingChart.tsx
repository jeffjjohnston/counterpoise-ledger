"use client";

import { useEffect, useMemo, useState } from "react";
import { ChartCard } from "@/components/charts/ChartCard";
import { ReportBars } from "@/components/reports/ReportChart";
import { useIsMobile } from "@/hooks/useIsMobile";
import { apiGet } from "@/lib/api-client";
import { toPayeeSpendingChart } from "@/lib/payee-spending-chart";
import type { ReportSplit } from "@/lib/reports";
import { formatCurrency, toDateString } from "@/lib/wasm-client";

/** Chart heights as [below the breakpoint, above it]. */
const PAYEE_HEIGHT: [number, number] = [160, 200];

/** The first day of the month 11 months before `today`, so that the range holds 12 months. */
function rangeStart(today: Date): string {
  return toDateString(new Date(today.getFullYear(), today.getMonth() - 11, 1));
}

/**
 * The chart and its states. It mounts only while the card shows the chart, so
 * a hidden chart sends no request. A new `refreshKey` fetches the splits again.
 */
function PayeeSpendingBars({ bookId, payeeId, refreshKey }: { bookId: string; payeeId: number; refreshKey: number }) {
  // The splits and the months of the request that fetched them, so that the bars,
  // the table and the label all use the window of the data they show.
  const [loaded, setLoaded] = useState<{ splits: ReportSplit[]; firstMonth: string; lastMonth: string } | null>(null);
  const [failed, setFailed] = useState(false);
  const isMobile = useIsMobile();
  const height = PAYEE_HEIGHT[isMobile ? 0 : 1];
  useEffect(() => {
    let current = true;
    setFailed(false);
    // The dates are browser-local, as the other chart requests use. One snapshot
    // gives the request dates and the months of the bars.
    const today = new Date();
    const firstMonth = rangeStart(today).slice(0, 7);
    const lastMonth = toDateString(today).slice(0, 7);
    apiGet<{ splits?: ReportSplit[] }>(
      `/api/b/${bookId}/reports/data?payeeId=${payeeId}&accountTypes=income,expense`
        + `&startDate=${rangeStart(today)}&endDate=${toDateString(today)}`,
    )
      .then((data) => {
        if (current) setLoaded({ splits: Array.isArray(data.splits) ? data.splits : [], firstMonth, lastMonth });
      })
      .catch(() => {
        if (current) setFailed(true);
      });
    return () => {
      current = false;
    };
  }, [bookId, payeeId, refreshKey]);

  // A new payee clears the old bars. A refresh keeps them until the new splits come.
  useEffect(() => {
    setLoaded(null);
  }, [bookId, payeeId]);

  // The same month grouping and bars as the custom report chart, with a zero bar for each empty month.
  const data = useMemo(
    () => (loaded ? toPayeeSpendingChart(loaded.splits, loaded.firstMonth, loaded.lastMonth) : null),
    [loaded],
  );

  if (failed) return <p className="text-sm text-fg-danger">Could not load spending by month.</p>;
  if (loaded === null) {
    return <div data-testid="payee-spending-placeholder" className="animate-pulse rounded bg-surface-tertiary" style={{ height }} />;
  }
  if (!data) return <p className="text-sm text-fg-tertiary">No income or expense in the last 12 months.</p>;
  return (
    <>
      <ReportBars data={data} verticalHeight={PAYEE_HEIGHT} />
      {/* The accessible form of the chart data. The transaction list shows no monthly totals.
          The div clips the table, so that a wide table cannot make the page scroll sideways. */}
      <div className="sr-only">
        <table>
          <caption>Spending by month</caption>
          <thead>
            <tr>
              <th scope="col">Month</th>
              <th scope="col">Type</th>
              <th scope="col">Amount</th>
            </tr>
          </thead>
          <tbody>
            {data.groups.flatMap((group) =>
              group.bars.map((bar) => (
                <tr key={`${group.key}/${bar.key}`}>
                  <td>{group.label}</td>
                  <td>{bar.label}</td>
                  <td>{formatCurrency(bar.segments.reduce((sum, segment) => sum + segment.value, 0))}</td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** Income and expense of one payee by month, for the last 12 months. It goes on the payee page. */
export function PayeeSpendingChart({ bookId, payeeId, refreshKey = 0 }: {
  bookId: string;
  payeeId: number;
  /** A new value fetches the splits again, for example after a transaction changes. */
  refreshKey?: number;
}) {
  return (
    <ChartCard title="By month" storageKey="counterpoise.payeeSpendingChart.hidden">
      <PayeeSpendingBars bookId={bookId} payeeId={payeeId} refreshKey={refreshKey} />
    </ChartCard>
  );
}
