import { toDateString } from "@/lib/wasm-client";

/** The range choices of a chart that shows history. */
export type ChartRange = "1Y" | "5Y" | "All";

export const CHART_RANGES: ChartRange[] = ["1Y", "5Y", "All"];

/** The words for a range in a chart label. */
export const RANGE_NAMES: Record<ChartRange, string> = {
  "1Y": "last year",
  "5Y": "last 5 years",
  All: "all history",
};

/** The first date of a range, or null for all history. */
export function rangeStart(range: ChartRange, today: Date): string | null {
  if (range === "All") return null;
  const years = range === "1Y" ? 1 : 5;
  return toDateString(new Date(today.getFullYear() - years, today.getMonth(), today.getDate()));
}
