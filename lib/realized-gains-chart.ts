import type { BarGroup, ChartSeries } from "@/components/charts/types";
import { formatCurrency } from "@/lib/wasm-client";

/** The fields of a realized gains row that the chart uses. */
export type RealizedGainChartRow = {
  sellDate: string;
  term: "short" | "long" | "unknown";
  gainCents: number | null;
};

export type RealizedGainsChartData = {
  groups: BarGroup[];
  series: ChartSeries[];
  ariaLabel: string;
};

/**
 * Above this number of months, a time chart has one group for each year.
 * The income statement chart uses the same rule.
 */
export const MAX_MONTHS = 24;

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const SERIES: ChartSeries[] = [
  { key: "short", label: "Short term", color: "var(--chart-1)" },
  { key: "long", label: "Long term", color: "var(--chart-2)" },
];

/**
 * The months from the month of `start` to the month of `end`, as "YYYY-MM".
 * The loop compares numbers, not text: as text, "10000-01" sorts before "9999-12".
 */
function monthKeys(start: string, end: string): string[] {
  const keys: string[] = [];
  const first = Number(start.slice(0, 4)) * 12 + Number(start.slice(5, 7)) - 1;
  const last = Number(end.slice(0, 4)) * 12 + Number(end.slice(5, 7)) - 1;
  for (let index = first; index <= last; index += 1) {
    keys.push(`${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`);
  }
  return keys;
}

function monthName(key: string): string {
  return `${MONTHS[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;
}

/**
 * The bars of the realized gains page: one group for each month of the range,
 * or for each year when the range has more than 24 months. Short-term and
 * long-term gains stack. A loss stacks below zero. A row with no known basis
 * has no gain, so the chart leaves it out, as it does a row outside the range.
 * No known gain in the range gives no chart.
 */
export function toRealizedGainsChart(
  rows: RealizedGainChartRow[],
  range: { startDate: string; endDate: string },
): RealizedGainsChartData | null {
  const known = rows.filter((row) => row.term !== "unknown" && row.gainCents !== null);
  if (known.length === 0) return null;

  const dates = known.map((row) => row.sellDate).sort();
  const start = range.startDate || dates[0];
  const end = range.endDate || dates[dates.length - 1];
  const months = monthKeys(start, end);
  const byYear = months.length > MAX_MONTHS;
  const keys = byYear ? Array.from(new Set(months.map((key) => key.slice(0, 4)))) : months;
  const oneYear = new Set(months.map((key) => key.slice(0, 4))).size === 1;

  const sums = new Map(keys.map((key) => [key, { short: 0, long: 0 }]));
  let counted = 0;
  for (const row of known) {
    // A bucket can start before the range or end after it, so compare the full date.
    if (row.sellDate < start || row.sellDate > end) continue;
    const sum = sums.get(row.sellDate.slice(0, byYear ? 4 : 7));
    if (!sum) continue;
    sum[row.term as "short" | "long"] += row.gainCents!;
    counted += 1;
  }
  if (counted === 0) return null;

  const groups = keys.map((key) => {
    const sum = sums.get(key)!;
    const month = MONTHS[Number(key.slice(5, 7)) - 1]?.slice(0, 3);
    const label = byYear ? key : oneYear ? month : `${month} ${key.slice(0, 4)}`;
    return {
      key,
      label,
      bars: [{
        key: "gain",
        label: "Gain",
        segments: [
          { seriesKey: "short", value: sum.short },
          { seriesKey: "long", value: sum.long },
        ],
      }],
    };
  });

  // The totals of the groups, so that a row outside the range cannot add to the label.
  const total = (term: "short" | "long") => [...sums.values()].reduce((sum, item) => sum + item[term], 0);
  const span = byYear
    ? `by year, ${keys[0]} to ${keys[keys.length - 1]}`
    : `by month, ${monthName(months[0])} to ${monthName(months[months.length - 1])}`;

  return {
    groups,
    series: SERIES,
    ariaLabel: `Realized gains ${span}: short term ${formatCurrency(total("short"))}, long term ${formatCurrency(total("long"))}`,
  };
}
