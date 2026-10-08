"use client";

import { useMemo } from "react";
import { BAR_ROW_HEIGHT, BarChart } from "@/components/charts/BarChart";
import { ChartCard } from "@/components/charts/ChartCard";
import { type AllocationSecurity, toAllocationChart } from "@/lib/allocation-chart";

/** The chart above the securities table: market value by security, largest first. */
export function AllocationChart({ securities }: { securities: AllocationSecurity[] }) {
  const data = useMemo(() => toAllocationChart(securities), [securities]);
  if (!data) return null;

  return (
    <ChartCard title="Allocation" storageKey="counterpoise.allocationChart.hidden">
      <BarChart groups={data.groups} series={data.series} orientation="horizontal"
        height={data.groups.length * BAR_ROW_HEIGHT + 32} ariaLabel={data.ariaLabel} />
    </ChartCard>
  );
}
