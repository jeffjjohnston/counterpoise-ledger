"use client";

import { useEffect, useState } from "react";
import { ChartCard } from "@/components/charts/ChartCard";
import { LineChart } from "@/components/charts/LineChart";
import { RangeGroup } from "@/components/charts/RangeGroup";
import { useIsMobile } from "@/hooks/useIsMobile";
import { type AccountBalancePoint, toAccountBalanceChart } from "@/lib/account-balance-chart";
import { apiGet } from "@/lib/api-client";
import { type ChartRange, rangeStart } from "@/lib/chart-range";
import { formatCurrency, formatDate, toDateString } from "@/lib/wasm-client";

type Props = {
  bookId: string;
  accountId: number;
  accountType: string;
  /** A new value fetches the points again, for example after a transaction changes. */
  refreshKey: number;
};

/**
 * The chart and its states. It mounts only while the card shows the chart, so
 * a hidden chart sends no request.
 */
function AccountBalanceLine({ bookId, accountId, accountType, refreshKey, range }: Props & { range: ChartRange }) {
  // The points remember the request that they answer. A new account or range
  // shows the placeholder, and a refresh keeps the old line until the new points come.
  const key = `${bookId}:${accountId}:${range}`;
  const [loaded, setLoaded] = useState<{ key: string; points: AccountBalancePoint[] } | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const isMobile = useIsMobile();
  // Lower than the other charts: the register needs its vertical space.
  const height = isMobile ? 120 : 160;

  useEffect(() => {
    let current = true;
    // The end date is the browser-local date. Without it, the server uses the date in its own TZ.
    const today = new Date();
    const start = rangeStart(range, today);
    const params = new URLSearchParams();
    if (start) params.set("startDate", start);
    params.set("endDate", toDateString(today));
    apiGet<{ points?: AccountBalancePoint[] }>(`/api/b/${bookId}/accounts/${accountId}/balance-history?${params}`)
      .then((data) => {
        if (!current) return;
        setLoaded({ key, points: Array.isArray(data.points) ? data.points : [] });
        setFailedKey(null);
      })
      .catch(() => {
        if (current) setFailedKey(key);
      });
    return () => {
      current = false;
    };
  }, [key, bookId, accountId, range, refreshKey]);

  if (failedKey === key) return <p className="text-sm text-fg-danger">Could not load the balance history.</p>;
  if (loaded?.key !== key) {
    return <div data-testid="account-balance-placeholder" className="animate-pulse rounded bg-surface-tertiary" style={{ height }} />;
  }
  const data = toAccountBalanceChart(loaded.points, accountType, range);
  if (!data) return <p className="text-sm text-fg-tertiary">Not enough history to chart yet.</p>;
  const points = data.series[0].points;
  return (
    <>
      <LineChart height={height} ariaLabel={data.ariaLabel} series={data.series} />
      {/* The accessible form of the chart data. It is not visible.
          The div clips the table, so that a wide table cannot make the page scroll sideways. */}
      <div className="sr-only">
        <table>
          <caption>Balance by date</caption>
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Balance</th>
            </tr>
          </thead>
          <tbody>
            {points.map((point) => (
              <tr key={point.date}>
                <td>{formatDate(point.date)}</td>
                <td>{formatCurrency(point.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/**
 * The balance line of one account above the register. The page shows it only
 * for one selected account that is not an investment account.
 */
export function AccountBalanceChart(props: Props) {
  const [range, setRange] = useState<ChartRange>("1Y");

  return (
    <ChartCard
      storageKey="counterpoise.accountBalanceChart.hidden"
      title="Balance"
      actions={<RangeGroup range={range} onChange={setRange} />}
    >
      <AccountBalanceLine {...props} range={range} />
    </ChartCard>
  );
}
