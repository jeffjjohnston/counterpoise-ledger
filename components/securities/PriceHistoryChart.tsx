"use client";

import { useEffect, useState } from "react";
import { ChartCard } from "@/components/charts/ChartCard";
import { LineChart } from "@/components/charts/LineChart";
import { RangeGroup } from "@/components/charts/RangeGroup";
import { useIsMobile } from "@/hooks/useIsMobile";
import { apiGet } from "@/lib/api-client";
import { type ChartRange, rangeStart } from "@/lib/chart-range";
import { type PriceHistoryChartRow, toPriceHistoryChart } from "@/lib/price-history-chart";

/** The most rows that the prices route gives for one request. */
const MAX_PRICES = 5000;

/**
 * The chart and its states. It mounts only while the card shows the chart, so
 * a hidden chart sends no request. A new `refreshKey` fetches the prices again.
 */
function PriceHistoryLine({ bookId, securityId, range, refreshKey }: {
  bookId: string;
  securityId: number;
  range: ChartRange;
  refreshKey: number;
}) {
  const [rows, setRows] = useState<PriceHistoryChartRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const isMobile = useIsMobile();
  const height = isMobile ? 160 : 200;

  useEffect(() => {
    let current = true;
    setFailed(false);
    const start = rangeStart(range, new Date());
    const params = new URLSearchParams({ limit: String(MAX_PRICES) });
    if (start) params.set("startDate", start);
    apiGet<{ prices?: PriceHistoryChartRow[] }>(`/api/b/${bookId}/securities/${securityId}/prices?${params}`)
      .then((data) => {
        if (current) setRows(Array.isArray(data.prices) ? data.prices : []);
      })
      .catch(() => {
        if (current) setFailed(true);
      });
    return () => {
      current = false;
    };
  }, [bookId, securityId, range, refreshKey]);

  // A new range clears the old line. A refresh keeps it until the new rows come.
  useEffect(() => {
    setRows(null);
  }, [range]);

  if (failed) return <p className="text-sm text-fg-danger">Could not load price history.</p>;
  if (rows === null) {
    return <div data-testid="price-history-placeholder" className="animate-pulse rounded bg-surface-tertiary" style={{ height }} />;
  }
  const data = toPriceHistoryChart(rows, range);
  if (!data) return <p className="text-sm text-fg-tertiary">Not enough prices to chart yet.</p>;
  // The price table on the page shows these values, so the chart has no table of its own.
  return <LineChart height={height} ariaLabel={data.ariaLabel} series={data.series} />;
}

/** The price line on the security page. A fixed-price security has no price history, so the page does not render this. */
export function PriceHistoryChart({ bookId, securityId, refreshKey }: {
  bookId: string;
  securityId: number;
  refreshKey: number;
}) {
  const [range, setRange] = useState<ChartRange>("1Y");

  return (
    <ChartCard
      storageKey="counterpoise.priceHistoryChart.hidden"
      title="Price history"
      actions={<RangeGroup range={range} onChange={setRange} />}
    >
      <PriceHistoryLine bookId={bookId} securityId={securityId} range={range} refreshKey={refreshKey} />
    </ChartCard>
  );
}
