"use client";

import { useEffect, useState } from "react";
import { AreaChart } from "@/components/charts/AreaChart";
import { ChartCard } from "@/components/charts/ChartCard";
import { ChartLegend } from "@/components/charts/ChartLegend";
import { LineChart } from "@/components/charts/LineChart";
import { RangeGroup } from "@/components/charts/RangeGroup";
import { useIsMobile } from "@/hooks/useIsMobile";
import { apiGet } from "@/lib/api-client";
import { type ChartRange, rangeStart } from "@/lib/chart-range";
import {
  type GroupedNetWorthPoint, type NetWorthGroup, type NetWorthGroupChart, toNetWorthGroupChart,
} from "@/lib/net-worth-chart";
import { cn } from "@/lib/utils";
import { formatCurrency, formatDate, toDateString } from "@/lib/wasm-client";

type NetWorthPoint = { date: string; netWorthCents: number };

type View = "total" | "group";

const VIEWS: { view: View; label: string }[] = [
  { view: "total", label: "Total" },
  { view: "group", label: "By group" },
];

/** The response, with the view that asked for it. A response of the other view is not drawn. */
type Loaded =
  | { view: "total"; points: NetWorthPoint[] }
  | { view: "group"; groups: NetWorthGroup[]; points: GroupedNetWorthPoint[] };

function summary(points: NetWorthPoint[]): string {
  const first = points[0];
  const last = points[points.length - 1];
  return `Net worth from ${formatDate(first.date)} to ${formatDate(last.date)}: `
    + `${formatCurrency(first.netWorthCents)} to ${formatCurrency(last.netWorthCents)}`;
}

/** The Total / By group buttons. The choice is not stored. */
function ViewGroup({ view, onChange }: { view: View; onChange: (view: View) => void }) {
  return (
    <div role="group" aria-label="View" className="flex gap-1 whitespace-nowrap">
      {VIEWS.map((option) => (
        <button
          key={option.view}
          type="button"
          aria-pressed={option.view === view}
          onClick={() => onChange(option.view)}
          className={cn(
            "rounded px-2 py-0.5 text-xs font-medium",
            option.view === view ? "bg-accent text-fg-on-accent" : "text-fg-tertiary hover:text-fg",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function TotalChart({ points, height }: { points: NetWorthPoint[]; height: number }) {
  return (
    <>
      <LineChart
        height={height}
        ariaLabel={summary(points)}
        series={[{
          key: "netWorth",
          label: "Net worth",
          color: "var(--chart-1)",
          points: points.map((point) => ({ date: point.date, value: point.netWorthCents })),
        }]}
      />
      {/* The accessible form of the chart data. It is not visible. */}
      <div className="sr-only">
        <table>
          <caption>Net worth by date</caption>
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Net worth</th>
            </tr>
          </thead>
          <tbody>
            {points.map((point) => (
              <tr key={point.date}>
                <td>{formatDate(point.date)}</td>
                <td>{formatCurrency(point.netWorthCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function GroupChart({ chart, height }: { chart: NetWorthGroupChart; height: number }) {
  return (
    <>
      <AreaChart height={height} ariaLabel={chart.ariaLabel} series={chart.series} total={chart.total} totalLabel="Net worth" />
      <ChartLegend series={[...chart.series, chart.total]} />
      {/* The accessible form of the chart data, with one column for each shown group. It is not visible.
          A table does not get narrower than its columns, so the div clips it. Without the div, the
          wide table makes the page scroll sideways on a phone. */}
      <div className="sr-only">
        <table>
          <caption>Net worth by date</caption>
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Net worth</th>
              {chart.series.map((item) => <th key={item.key} scope="col">{item.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {chart.total.points.map((point, index) => (
              <tr key={point.date}>
                <td>{formatDate(point.date)}</td>
                <td>{formatCurrency(point.value)}</td>
                {chart.series.map((item) => <td key={item.key}>{formatCurrency(item.points[index].value)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** The chart and its states. It mounts only while the card shows the chart, so a hidden chart sends no request. */
function NetWorthChart({ bookId, range, view }: { bookId: string; range: ChartRange; view: View }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);
  const isMobile = useIsMobile();
  const height = isMobile ? 160 : 200;

  useEffect(() => {
    let current = true;
    setLoaded(null);
    setFailed(false);
    // The end date is the browser-local date, as the other dashboard requests use.
    // Without it, the server uses the date in its own TZ.
    const today = new Date();
    const start = rangeStart(range, today);
    const params = new URLSearchParams();
    if (start) params.set("startDate", start);
    params.set("endDate", toDateString(today));
    if (view === "group") params.set("groupBy", "account");
    // Only a groupBy=account response has `groups`. The total view reads `points` only.
    apiGet<{ groups: NetWorthGroup[]; points: GroupedNetWorthPoint[] }>(`/api/b/${bookId}/reports/net-worth-history?${params}`)
      .then((data) => {
        if (!current) return;
        setLoaded(view === "group" ? { view, groups: data.groups, points: data.points } : { view, points: data.points });
      })
      .catch(() => {
        if (current) setFailed(true);
      });
    return () => {
      current = false;
    };
  }, [bookId, range, view]);

  if (failed) return <p className="text-sm text-fg-danger">Could not load net worth history.</p>;
  // On the first render after a view change, the state still holds the response of the other view.
  if (loaded === null || loaded.view !== view) {
    return <div data-testid="net-worth-placeholder" className="animate-pulse rounded bg-surface-tertiary" style={{ height }} />;
  }
  const notEnough = <p className="text-sm text-fg-tertiary">Not enough history to chart yet.</p>;
  if (loaded.view === "total") {
    return loaded.points.length < 2 ? notEnough : <TotalChart points={loaded.points} height={height} />;
  }
  const chart = toNetWorthGroupChart(loaded.groups, loaded.points);
  return chart ? <GroupChart chart={chart} height={height} /> : notEnough;
}

/** The net worth chart under the KPI cards on the dashboard: one line, or stacked areas by group. */
export function NetWorthCard({ bookId }: { bookId: string }) {
  const [range, setRange] = useState<ChartRange>("1Y");
  const [view, setView] = useState<View>("total");

  return (
    <ChartCard
      storageKey="counterpoise.netWorthChart.hidden"
      title="Net worth"
      actions={(
        <>
          <ViewGroup view={view} onChange={setView} />
          <RangeGroup range={range} onChange={setRange} />
        </>
      )}
    >
      <NetWorthChart bookId={bookId} range={range} view={view} />
    </ChartCard>
  );
}
