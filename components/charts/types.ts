/** One colored series. `color` is a CSS value such as "var(--chart-1)". */
export type ChartSeries = { key: string; label: string; color: string };

/** `detail` is an optional note that the tooltip shows next to the value, such as "42.1%". */
export type BarSegment = { seriesKey: string; value: number; detail?: string };

/** One bar. Its segments stack. */
export type Bar = { key: string; label: string; segments: BarSegment[] };

/** One category on the axis. Its bars stand side by side. */
export type BarGroup = { key: string; label: string; bars: Bar[] };

/** A value on a date. `date` is "YYYY-MM-DD". */
export type LinePoint = { date: string; value: number };

export type LineSeries = ChartSeries & { points: LinePoint[] };
