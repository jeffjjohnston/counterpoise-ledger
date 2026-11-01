import { formatCurrency } from "@/lib/wasm-client";

// Degrees. Debits are on the left of the split editor, credits on the right,
// so the left pan sinks when debits are heavier.
const TILT = 10;
// The beam's pivot and half-length, in viewBox units.
const PIVOT_X = 12;
const PIVOT_Y = 6;
const ARM = 9;

export type BalanceScaleState = "level" | "debit" | "credit" | "pending";

export function balanceScaleState(total: number, pending: boolean): BalanceScaleState {
  if (pending) return "pending";
  if (total === 0) return "level";
  return total > 0 ? "debit" : "credit";
}

/**
 * A balance scale that shows the state of the splits: level when they sum to
 * zero, tipped toward the heavier side when they do not. It only shows the
 * state; the total text and validateSplits() still decide.
 */
export function BalanceScale({ total, pending, className }: { total: number; pending: boolean; className?: string }) {
  const state = balanceScaleState(total, pending);
  const angle = state === "debit" ? -TILT : state === "credit" ? TILT : 0;
  const radians = (angle * Math.PI) / 180;
  // How far each beam end moves when the beam turns about the pivot.
  const dx = ARM * (1 - Math.cos(radians));
  const dy = ARM * Math.sin(radians);

  const label =
    state === "pending"
      ? "Balance unknown until the amounts resolve"
      : state === "level"
        ? "Balanced"
        : `Unbalanced by ${formatCurrency(Math.abs(total))}: ${state === "debit" ? "debits" : "credits"} are heavier`;

  // The overshooting curve gives the settle when the beam goes level.
  // prefers-reduced-motion drops the transition and shows the end state.
  const motion =
    "motion-safe:transition-transform motion-safe:duration-500 motion-safe:ease-[cubic-bezier(0.34,1.56,0.64,1)]";

  return (
    <svg
      role="img"
      aria-label={label}
      data-state={state}
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 6V20M8 20H16" />
      <circle cx={PIVOT_X} cy={PIVOT_Y} r={1} fill="currentColor" />
      <g
        className={motion}
        style={{ transform: `rotate(${angle}deg)`, transformOrigin: `${PIVOT_X}px ${PIVOT_Y}px` }}
      >
        <path d={`M${PIVOT_X - ARM} ${PIVOT_Y}H${PIVOT_X + ARM}`} />
      </g>
      <g transform={`translate(${PIVOT_X - ARM} ${PIVOT_Y})`}>
        <g className={motion} style={{ transform: `translate(${dx}px, ${-dy}px)` }}>
          <Pan />
        </g>
      </g>
      <g transform={`translate(${PIVOT_X + ARM} ${PIVOT_Y})`}>
        <g className={motion} style={{ transform: `translate(${-dx}px, ${dy}px)` }}>
          <Pan />
        </g>
      </g>
    </svg>
  );
}

function Pan() {
  return <path d="M0 0L-2.5 7M0 0L2.5 7M-3 7A3 2.2 0 0 0 3 7Z" />;
}
