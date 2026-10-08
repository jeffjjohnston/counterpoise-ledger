"use client";

import { useMemo } from "react";
import { BarChart } from "@/components/charts/BarChart";
import { ChartCard } from "@/components/charts/ChartCard";
import { ChartLegend } from "@/components/charts/ChartLegend";
import { useIsMobile } from "@/hooks/useIsMobile";
import { type RealizedGainChartRow, toRealizedGainsChart } from "@/lib/realized-gains-chart";

/** The chart above the realized gains table: gains by month, short and long term stacked. */
export function RealizedGainsChart({ rows, range }: {
  rows: RealizedGainChartRow[];
  range: { startDate: string; endDate: string };
}) {
  const data = useMemo(() => toRealizedGainsChart(rows, range), [rows, range]);
  const isMobile = useIsMobile();
  if (!data) return null;

  return (
    <ChartCard title="Gains by month" storageKey="counterpoise.realizedGainsChart.hidden">
      <BarChart groups={data.groups} series={data.series} height={isMobile ? 220 : 260} ariaLabel={data.ariaLabel} />
      <ChartLegend series={data.series} />
    </ChartCard>
  );
}
