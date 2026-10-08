"use client";

import { CHART_RANGES, type ChartRange } from "@/lib/chart-range";
import { cn } from "@/lib/utils";

/** The 1Y / 5Y / All buttons for the `actions` of a `ChartCard`. */
export function RangeGroup({ range, onChange }: { range: ChartRange; onChange: (range: ChartRange) => void }) {
  return (
    <div role="group" aria-label="Range" className="flex gap-1 whitespace-nowrap">
      {CHART_RANGES.map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={option === range}
          onClick={() => onChange(option)}
          className={cn(
            "rounded px-2 py-0.5 text-xs font-medium",
            option === range ? "bg-accent text-fg-on-accent" : "text-fg-tertiary hover:text-fg",
          )}
        >
          {option}
        </button>
      ))}
    </div>
  );
}
