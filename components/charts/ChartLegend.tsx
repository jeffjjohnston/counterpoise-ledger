import type { ChartSeries } from "./types";

export function ChartLegend({ series }: { series: ChartSeries[] }) {
  return (
    <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-secondary">
      {series.map((item) => (
        <li key={item.key} className="flex items-center gap-1.5">
          <span aria-hidden="true" className="h-2 w-2 rounded-sm" style={{ background: item.color }} />
          {item.label}
        </li>
      ))}
    </ul>
  );
}
