"use client";

import { type MouseEvent, useCallback, useMemo, useState } from "react";
import { scaleBand, scaleLinear } from "d3-scale";
import { useIsMobile } from "@/hooks/useIsMobile";
import { tickLabelWidth, ValueAxis, valueTicks } from "./Axis";
import { ChartTooltip, type TooltipState } from "./ChartTooltip";
import type { BarGroup, ChartSeries } from "./types";
import { useChartSize } from "./useChartSize";
import { useDismissOutside } from "./useDismissOutside";

const MARGIN_VERTICAL = { top: 8, right: 8, bottom: 28, left: 56 };
const MARGIN_HORIZONTAL = { top: 8, right: 16, bottom: 24, left: 128 };
const MAX_LABEL = 18;
const FALLBACK_COLOR = "var(--chart-8)";

/** The height of one bar row of a horizontal chart. A horizontal chart is this times its bars, plus 32. */
export const BAR_ROW_HEIGHT = 28;

export type BarChartProps = {
  groups: BarGroup[];
  series: ChartSeries[];
  orientation?: "vertical" | "horizontal";
  height: number;
  ariaLabel: string;
};

/** The extent of each segment. Positive values stack up from zero, negative values stack down. */
export function stackSegments(values: number[]): [number, number][] {
  let up = 0;
  let down = 0;
  return values.map((value) => {
    if (value >= 0) {
      const extent: [number, number] = [up, up + value];
      up += value;
      return extent;
    }
    const extent: [number, number] = [down + value, down];
    down += value;
    return extent;
  });
}

/** Cuts a category label to the space at the left of a horizontal chart. */
export function truncateLabel(label: string): string {
  return label.length > MAX_LABEL ? `${label.slice(0, MAX_LABEL - 1)}…` : label;
}

/** The estimated width of the longest label at 10 px, with a gap. */
export function labelWidth(groups: BarGroup[]): number {
  return Math.max(0, ...groups.map((group) => group.label.length)) * 6 + 8;
}

/** The step between shown labels of a vertical chart. */
export function labelStepFor(groups: BarGroup[], innerWidth: number): number {
  if (groups.length === 0) return 1;
  const slot = innerWidth / groups.length;
  return Math.max(1, Math.ceil(labelWidth(groups) / Math.max(1, slot)));
}

export function BarChart({ groups, series, orientation = "vertical", height, ariaLabel }: BarChartProps) {
  const [ref, width] = useChartSize<HTMLDivElement>();
  const isMobile = useIsMobile();
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const clear = useCallback(() => setTooltip(null), []);
  useDismissOutside(ref, tooltip !== null, clear);
  const seriesByKey = useMemo(() => new Map(series.map((item) => [item.key, item])), [series]);

  const vertical = orientation === "vertical";
  const base = vertical ? MARGIN_VERTICAL : MARGIN_HORIZONTAL;
  const innerHeight = Math.max(0, height - base.top - base.bottom);
  const extents = groups.flatMap((group) =>
    group.bars.flatMap((bar) => stackSegments(bar.segments.map((segment) => segment.value)).flat()),
  );
  const valueScale = (range: [number, number]) =>
    scaleLinear().domain([Math.min(0, ...extents), Math.max(0, ...extents)]).nice().range(range);
  const tickCount = isMobile ? 3 : 5;
  // A vertical chart has the value labels at the left. The left margin grows when the longest label needs more space.
  const leftTicks = vertical ? valueTicks(valueScale([innerHeight, 0]), tickCount) : [];
  const margin = vertical ? { ...base, left: Math.max(base.left, tickLabelWidth(leftTicks)) } : base;
  const innerWidth = Math.max(0, width - margin.left - margin.right);
  const value = valueScale(vertical ? [innerHeight, 0] : [0, innerWidth]);
  const band = scaleBand<string>()
    .domain(groups.map((group) => group.key))
    .range(vertical ? [0, innerWidth] : [0, innerHeight])
    .padding(0.2);
  const barKeys = Array.from(new Set(groups.flatMap((group) => group.bars.map((bar) => bar.key))));
  const inner = scaleBand<string>().domain(barKeys).range([0, band.bandwidth()]).padding(0.08);
  const ticks = vertical ? leftTicks : valueTicks(value, tickCount);
  // Show every nth label, so that two labels never overlap.
  const labelStep = labelStepFor(groups, innerWidth);

  function show(group: BarGroup, event: MouseEvent) {
    const box = ref.current?.getBoundingClientRect();
    const rows = group.bars.flatMap((bar) =>
      bar.segments
        .filter((segment) => segment.value !== 0)
        .map((segment) => {
          const item = seriesByKey.get(segment.seriesKey);
          const label = item?.label ?? segment.seriesKey;
          return {
            label: group.bars.length === 1 || label === bar.label ? label : `${bar.label} · ${label}`,
            color: item?.color ?? FALLBACK_COLOR,
            value: segment.value,
            detail: segment.detail,
          };
        }),
    );
    setTooltip({
      x: event.clientX - (box?.left ?? 0),
      y: event.clientY - (box?.top ?? 0),
      title: group.label,
      rows,
      // A total of different bars (income and expense) has no meaning.
      total: group.bars.length === 1 && rows.length > 1 ? rows.reduce((sum, row) => sum + row.value, 0) : null,
    });
  }

  return (
    <div ref={ref} className="relative w-full" style={{ height }}>
      {width > 0 && (
        <svg role="img" aria-label={ariaLabel} width={width} height={height} onMouseLeave={() => setTooltip(null)}>
          <g transform={`translate(${margin.left},${margin.top})`}>
            <ValueAxis side={vertical ? "left" : "bottom"} ticks={ticks} length={vertical ? innerWidth : innerHeight} />
            {groups.map((group) => {
              const offset = band(group.key) ?? 0;
              return (
                <g key={group.key}>
                  {group.bars.map((bar) => {
                    const stacks = stackSegments(bar.segments.map((segment) => segment.value));
                    const position = offset + (group.bars.length > 1 ? (inner(bar.key) ?? 0) : 0);
                    const thickness = group.bars.length > 1 ? inner.bandwidth() : band.bandwidth();
                    return bar.segments.map((segment, index) => {
                      if (segment.value === 0) return null;
                      const [low, high] = stacks[index];
                      const fill = seriesByKey.get(segment.seriesKey)?.color ?? FALLBACK_COLOR;
                      const id = `${group.key}/${bar.key}/${segment.seriesKey}`;
                      return vertical ? (
                        <rect key={id} data-bar-segment={id} x={position} width={thickness}
                          y={value(high)} height={value(low) - value(high)} fill={fill} />
                      ) : (
                        <rect key={id} data-bar-segment={id} y={position} height={thickness}
                          x={value(low)} width={value(high) - value(low)} fill={fill} />
                      );
                    });
                  })}
                </g>
              );
            })}
            {vertical ? (
              <line data-zero-line x1={0} x2={innerWidth} y1={value(0)} y2={value(0)} stroke="var(--fg-tertiary)" />
            ) : (
              <line data-zero-line y1={0} y2={innerHeight} x1={value(0)} x2={value(0)} stroke="var(--fg-tertiary)" />
            )}
            <g aria-hidden="true" fontSize={10} fill="var(--fg-tertiary)">
              {groups.map((group, index) => {
                const center = (band(group.key) ?? 0) + band.bandwidth() / 2;
                if (vertical) {
                  return index % labelStep === 0 ? (
                    <text key={group.key} x={center} y={innerHeight + 16} textAnchor="middle">{group.label}</text>
                  ) : null;
                }
                return (
                  <text key={group.key} x={-8} y={center} dy="0.32em" textAnchor="end">{truncateLabel(group.label)}</text>
                );
              })}
            </g>
            {groups.map((group) => {
              const offset = band(group.key) ?? 0;
              return (
                <rect
                  key={group.key}
                  data-bar-hit={group.key}
                  fill="transparent"
                  x={vertical ? offset : 0}
                  y={vertical ? 0 : offset}
                  width={vertical ? band.bandwidth() : innerWidth}
                  height={vertical ? innerHeight : band.bandwidth()}
                  onMouseMove={(event) => show(group, event)}
                  onClick={(event) => show(group, event)}
                />
              );
            })}
          </g>
        </svg>
      )}
      <ChartTooltip state={tooltip} containerWidth={width} />
    </div>
  );
}
