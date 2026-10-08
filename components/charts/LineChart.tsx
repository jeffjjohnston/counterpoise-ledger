"use client";

import { type MouseEvent, useCallback, useState } from "react";
import { bisector, extent } from "d3-array";
import { scaleLinear, scaleTime } from "d3-scale";
import { line } from "d3-shape";
import { useIsMobile } from "@/hooks/useIsMobile";
import { formatDate } from "@/lib/wasm-client";
import { DateAxis, tickLabelWidth, toDate, ValueAxis, valueTicks } from "./Axis";
import { ChartTooltip } from "./ChartTooltip";
import type { LinePoint, LineSeries } from "./types";
import { useChartSize } from "./useChartSize";
import { useDismissOutside } from "./useDismissOutside";

const MARGIN = { top: 8, right: 12, bottom: 24, left: 56 };

export type LineChartProps = { series: LineSeries[]; height: number; ariaLabel: string };

const nearest = bisector<LinePoint, Date>((point) => toDate(point.date)).center;

export function LineChart({ series, height, ariaLabel }: LineChartProps) {
  const [ref, width] = useChartSize<HTMLDivElement>();
  const isMobile = useIsMobile();
  const [hover, setHover] = useState<number | null>(null);

  const clear = useCallback(() => setHover(null), []);
  useDismissOutside(ref, hover !== null, clear);

  const innerHeight = Math.max(0, height - MARGIN.top - MARGIN.bottom);
  const points = series.flatMap((item) => item.points);
  const [minDate, maxDate] = extent(points, (point) => toDate(point.date));
  const [minValue, maxValue] = extent(points, (point) => point.value);
  const y = scaleLinear()
    .domain([minValue ?? 0, maxValue ?? 0])
    .nice()
    .range([innerHeight, 0]);
  const valueTickList = valueTicks(y, isMobile ? 3 : 5);
  // The left margin grows when the longest value label needs more space.
  const left = Math.max(MARGIN.left, tickLabelWidth(valueTickList));
  const innerWidth = Math.max(0, width - left - MARGIN.right);
  const x = scaleTime()
    .domain([minDate ?? new Date(), maxDate ?? new Date()])
    .range([0, innerWidth]);
  const path = line<LinePoint>()
    .x((point) => x(toDate(point.date)))
    .y((point) => y(point.value));
  // The tooltip follows the first series. Each series has the same dates.
  const primary = series[0]?.points ?? [];

  function track(event: MouseEvent) {
    const box = ref.current?.getBoundingClientRect();
    const date = x.invert(event.clientX - (box?.left ?? 0) - left);
    setHover(primary.length > 0 ? nearest(primary, date) : null);
  }

  const hovered = hover === null ? null : primary[hover];
  const tooltip = hovered && hover !== null
    ? {
        x: x(toDate(hovered.date)) + left,
        y: y(hovered.value) + MARGIN.top,
        title: formatDate(hovered.date),
        rows: series.map((item) => ({ label: item.label, color: item.color, value: item.points[hover]?.value ?? 0 })),
        total: null,
      }
    : null;

  return (
    <div ref={ref} className="relative w-full" style={{ height }}>
      {width > 0 && (
        <svg role="img" aria-label={ariaLabel} width={width} height={height} onMouseLeave={() => setHover(null)}>
          <g transform={`translate(${left},${MARGIN.top})`}>
            <ValueAxis side="left" ticks={valueTickList} length={innerWidth} />
            <DateAxis scale={x} count={isMobile ? 3 : 6} width={innerWidth} top={innerHeight} />
            {series.map((item) => (
              <path key={item.key} data-line-series={item.key} d={path(item.points) ?? ""}
                fill="none" stroke={item.color} strokeWidth={2} />
            ))}
            {hovered && (
              <g aria-hidden="true">
                <line x1={x(toDate(hovered.date))} x2={x(toDate(hovered.date))} y1={0} y2={innerHeight}
                  stroke="var(--border-focus)" strokeDasharray="3 3" />
                <circle cx={x(toDate(hovered.date))} cy={y(hovered.value)} r={4} fill={series[0].color} />
              </g>
            )}
            <rect data-line-overlay fill="transparent" width={innerWidth} height={innerHeight}
              onMouseMove={track} onClick={track} />
          </g>
        </svg>
      )}
      <ChartTooltip state={tooltip} containerWidth={width} />
    </div>
  );
}
