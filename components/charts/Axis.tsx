import type { ScaleLinear, ScaleTime } from "d3-scale";
import { compactDecimals, formatCurrencyCompact } from "@/lib/formatters";

export type Tick = { value: number; position: number; label: string };

/** Round value ticks for a money scale in cents. A tick that is not a whole number of cents is dropped. */
export function valueTicks(scale: ScaleLinear<number, number>, count: number): Tick[] {
  const values = scale.ticks(count).filter((value) => Number.isInteger(value));
  let labels = values.map((value) => formatCurrencyCompact(value));
  // On a narrow range, the short labels can be the same. Then give each label
  // the decimals that the tick step needs, so that two ticks never share a label.
  if (new Set(labels).size !== labels.length) {
    const step = values[1] - values[0];
    labels = values.map((value) => formatCurrencyCompact(value, compactDecimals(value, step)));
  }
  return values.map((value, index) => ({ value, position: scale(value), label: labels[index] }));
}

/** The estimated width of the longest tick label at 10 px (6 px for each character), with the gap to the axis. */
export function tickLabelWidth(ticks: Tick[]): number {
  return Math.max(0, ...ticks.map((tick) => tick.label.length)) * 6 + 8;
}

/**
 * Value ticks with grid lines. "left" is for vertical bars and lines.
 * "bottom" is for horizontal bars. `length` is the length of a grid line.
 */
export function ValueAxis({ side, ticks, length }: { side: "left" | "bottom"; ticks: Tick[]; length: number }) {
  // On the bottom axis, show every nth label, so that two labels never overlap. Each tick keeps its grid line.
  // The count starts at the zero tick, so that $0 always shows. Without a zero tick, it starts at the first tick.
  const spacing = ticks.length > 1 ? Math.abs(ticks[1].position - ticks[0].position) : Infinity;
  const labelStep = side === "bottom" ? Math.max(1, Math.ceil(tickLabelWidth(ticks) / Math.max(1, spacing))) : 1;
  const zeroIndex = Math.max(0, ticks.findIndex((tick) => tick.value === 0));
  return (
    <g aria-hidden="true" fontSize={10}>
      {ticks.map((tick, index) =>
        side === "left" ? (
          <g key={tick.value}>
            <line x1={0} x2={length} y1={tick.position} y2={tick.position} stroke="var(--border-primary)" />
            <text x={-6} y={tick.position} dy="0.32em" textAnchor="end" fill="var(--fg-tertiary)">
              {tick.label}
            </text>
          </g>
        ) : (
          <g key={tick.value}>
            <line y1={0} y2={length} x1={tick.position} x2={tick.position} stroke="var(--border-primary)" />
            {(index - zeroIndex) % labelStep === 0 && (
              <text y={length + 14} x={tick.position} textAnchor="middle" fill="var(--fg-tertiary)">
                {tick.label}
              </text>
            )}
          </g>
        ),
      )}
    </g>
  );
}

/** A "YYYY-MM-DD" date at local midnight. */
export function toDate(value: string): Date {
  return new Date(`${value}T00:00:00`);
}

/** The space from a plot edge in which a date label grows inward. */
const EDGE = 30;

/** The date labels under a time chart. `top` is the y of the bottom of the plot. */
export function DateAxis({ scale, count, width, top }: {
  scale: ScaleTime<number, number>;
  count: number;
  width: number;
  top: number;
}) {
  const format = scale.tickFormat();
  return (
    <g aria-hidden="true" fontSize={10} fill="var(--fg-tertiary)">
      {scale.ticks(count).map((tick) => {
        // A label at an edge grows inward, so the margin does not clip it.
        const position = scale(tick);
        const anchor = position > width - EDGE ? "end" : position < EDGE ? "start" : "middle";
        return (
          <text key={tick.getTime()} x={position} y={top + 16} textAnchor={anchor}>{format(tick)}</text>
        );
      })}
    </g>
  );
}
