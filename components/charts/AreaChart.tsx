"use client";

import { type MouseEvent, useCallback, useState } from "react";
import { bisector, extent } from "d3-array";
import { scaleLinear, scaleTime } from "d3-scale";
import { area, line, type SeriesPoint, stack, stackOffsetDiverging } from "d3-shape";
import { useIsMobile } from "@/hooks/useIsMobile";
import { formatDate } from "@/lib/wasm-client";
import { DateAxis, tickLabelWidth, toDate, ValueAxis, valueTicks } from "./Axis";
import { ChartTooltip } from "./ChartTooltip";
import type { LinePoint, LineSeries } from "./types";
import { useChartSize } from "./useChartSize";
import { useDismissOutside } from "./useDismissOutside";

const MARGIN = { top: 8, right: 12, bottom: 24, left: 56 };

/**
 * Each series has the same dates. `total` is an optional line on top of the areas, such as the sum.
 * `totalLabel` names the total row of the tooltip. The default is "Total".
 */
export type AreaChartProps = {
  series: LineSeries[];
  total?: LineSeries;
  totalLabel?: string;
  height: number;
  ariaLabel: string;
};

const nearest = bisector<Date, Date>((date) => date).center;

/**
 * Stacked areas over time. Positive values stack up from zero, negative
 * values stack down from zero (d3 `stackOffsetDiverging`).
 */
export function AreaChart({ series, total, totalLabel, height, ariaLabel }: AreaChartProps) {
  const [ref, width] = useChartSize<HTMLDivElement>();
  const isMobile = useIsMobile();
  const [hover, setHover] = useState<number | null>(null);

  const clear = useCallback(() => setHover(null), []);
  useDismissOutside(ref, hover !== null, clear);

  const base = series[0]?.points ?? total?.points ?? [];
  const dates = base.map((point) => toDate(point.date));
  const valueAt = (item: LineSeries, index: number) => item.points[index]?.value ?? 0;
  // The datum of the stack is the index of a date.
  const layers = stack<number, number>()
    .keys(series.map((_, index) => index))
    .value((dateIndex, seriesIndex) => valueAt(series[seriesIndex], dateIndex))
    .offset(stackOffsetDiverging)(dates.map((_, index) => index));

  const innerHeight = Math.max(0, height - MARGIN.top - MARGIN.bottom);
  const values = [0, ...layers.flatMap((layer) => layer.flat()), ...(total?.points.map((point) => point.value) ?? [])];
  const [minValue, maxValue] = extent(values);
  const y = scaleLinear()
    .domain([minValue ?? 0, maxValue ?? 0])
    .nice()
    .range([innerHeight, 0]);
  const valueTickList = valueTicks(y, isMobile ? 3 : 5);
  // The left margin grows when the longest value label needs more space.
  const left = Math.max(MARGIN.left, tickLabelWidth(valueTickList));
  const innerWidth = Math.max(0, width - left - MARGIN.right);
  const [minDate, maxDate] = extent(dates);
  const x = scaleTime()
    .domain([minDate ?? new Date(), maxDate ?? new Date()])
    .range([0, innerWidth]);
  const areaPath = area<SeriesPoint<number>>()
    .x((point) => x(dates[point.data]))
    .y0((point) => y(point[0]))
    .y1((point) => y(point[1]));
  const linePath = line<LinePoint>()
    .x((point) => x(toDate(point.date)))
    .y((point) => y(point.value));

  function track(event: MouseEvent) {
    const box = ref.current?.getBoundingClientRect();
    const date = x.invert(event.clientX - (box?.left ?? 0) - left);
    setHover(dates.length > 0 ? nearest(dates, date) : null);
  }

  // Without a total line, the tooltip total is the sum of the series, and it sits at the top of the stack.
  const hoveredTotal = hover === null
    ? 0
    : total ? valueAt(total, hover) : series.reduce((sum, item) => sum + valueAt(item, hover), 0);
  const anchor = hover === null
    ? 0
    : total ? hoveredTotal : Math.max(0, ...layers.map((layer) => layer[hover][1]));
  const tooltip = hover === null
    ? null
    : {
        x: x(dates[hover]) + left,
        y: y(anchor) + MARGIN.top,
        title: formatDate(base[hover].date),
        rows: series.map((item) => ({ label: item.label, color: item.color, value: valueAt(item, hover) })),
        total: hoveredTotal,
        totalLabel,
      };

  return (
    <div ref={ref} className="relative w-full" style={{ height }}>
      {width > 0 && (
        <svg role="img" aria-label={ariaLabel} width={width} height={height} onMouseLeave={() => setHover(null)}>
          <g transform={`translate(${left},${MARGIN.top})`}>
            <ValueAxis side="left" ticks={valueTickList} length={innerWidth} />
            <DateAxis scale={x} count={isMobile ? 3 : 6} width={innerWidth} top={innerHeight} />
            {layers.map((layer) => (
              <path key={series[layer.key].key} data-area-series={series[layer.key].key} d={areaPath(layer) ?? ""}
                fill={series[layer.key].color} fillOpacity={0.85} />
            ))}
            <line data-zero-line x1={0} x2={innerWidth} y1={y(0)} y2={y(0)} stroke="var(--fg-tertiary)" />
            {total && (
              <path data-area-total d={linePath(total.points) ?? ""} fill="none" stroke={total.color} strokeWidth={2} />
            )}
            {hover !== null && (
              <g aria-hidden="true">
                <line x1={x(dates[hover])} x2={x(dates[hover])} y1={0} y2={innerHeight}
                  stroke="var(--border-focus)" strokeDasharray="3 3" />
                {total && <circle cx={x(dates[hover])} cy={y(hoveredTotal)} r={4} fill={total.color} />}
              </g>
            )}
            <rect data-area-overlay fill="transparent" width={innerWidth} height={innerHeight}
              onMouseMove={track} onClick={track} />
          </g>
        </svg>
      )}
      <ChartTooltip state={tooltip} containerWidth={width} />
    </div>
  );
}
