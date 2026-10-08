"use client";

import { useMemo } from "react";
import { BAR_ROW_HEIGHT, BarChart } from "@/components/charts/BarChart";
import { ChartCard } from "@/components/charts/ChartCard";
import { ChartLegend } from "@/components/charts/ChartLegend";
import { useIsMobile } from "@/hooks/useIsMobile";
import { type ReportChartData, toChartData } from "@/lib/report-chart";
import type { GroupDimension, ReportGroupNode } from "@/lib/reports";

/**
 * The bars and the legend of a report chart. The caller sets the card around them.
 * `verticalHeight` sets the height of a vertical chart as [mobile, desktop].
 */
export function ReportBars({ data, verticalHeight = [220, 260] }: { data: ReportChartData; verticalHeight?: [number, number] }) {
  const isMobile = useIsMobile();
  const height = data.orientation === "horizontal"
    ? data.groups.reduce((sum, group) => sum + group.bars.length, 0) * BAR_ROW_HEIGHT + 32
    : verticalHeight[isMobile ? 0 : 1];

  // Time charts and per-type bars have more than one series to name.
  const showLegend = data.series.length > 1 && (data.orientation === "vertical" || data.groups[0].bars.length > 1);

  return (
    <>
      <BarChart groups={data.groups} series={data.series} orientation={data.orientation}
        height={height} ariaLabel={data.ariaLabel} />
      {showLegend && <ChartLegend series={data.series} />}
    </>
  );
}

/** The chart above the report table. It uses the tree that the table shows. */
export function ReportChart({ groups, dimensions }: { groups: ReportGroupNode[]; dimensions: GroupDimension[] }) {
  const data = useMemo(() => toChartData(groups, dimensions), [groups, dimensions]);
  if (!data) return null;

  return (
    <ChartCard title="Report" storageKey="counterpoise.reportChart.hidden">
      <ReportBars data={data} />
    </ChartCard>
  );
}
