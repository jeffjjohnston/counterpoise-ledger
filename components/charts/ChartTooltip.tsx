import { formatCurrency } from "@/lib/wasm-client";

/** `detail` is an optional note next to the value, such as a share of the total. */
export type TooltipRow = { label: string; color: string; value: number; detail?: string };

/** `x` and `y` are in pixels from the top left of the chart container. */
export type TooltipState = { x: number; y: number; title: string; rows: TooltipRow[]; total: number | null;
  /** The name of the total row. The default is "Total". */
  totalLabel?: string;
};

const TOOLTIP_WIDTH = 208;

/** The one tooltip of all charts. */
export function ChartTooltip({ state, containerWidth }: { state: TooltipState | null; containerWidth: number }) {
  if (!state) return null;
  const left = Math.max(0, Math.min(state.x + 12, containerWidth - TOOLTIP_WIDTH));
  return (
    <div
      role="tooltip"
      className="pointer-events-none absolute z-10 rounded-md border border-border bg-surface-elevated px-3 py-2 text-xs shadow-soft"
      style={{ left, top: state.y, width: TOOLTIP_WIDTH }}
    >
      <p className="mb-1 font-medium text-fg">{state.title}</p>
      {state.rows.map((row, index) => (
        <p key={index} className="flex items-center justify-between gap-2 text-fg-secondary">
          <span className="flex min-w-0 items-center gap-1.5">
            <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-sm" style={{ background: row.color }} />
            <span className="truncate">{row.label}</span>
          </span>
          <span className="flex shrink-0 items-baseline gap-1.5">
            {row.detail && <span className="tabular-nums text-fg-tertiary">{row.detail}</span>}
            <span className="tabular-nums text-fg">{formatCurrency(row.value)}</span>
          </span>
        </p>
      ))}
      {state.total !== null && (
        <p className="mt-1 flex justify-between border-t border-border pt-1 font-medium text-fg">
          <span>{state.totalLabel ?? "Total"}</span>
          <span className="tabular-nums">{formatCurrency(state.total)}</span>
        </p>
      )}
    </div>
  );
}
