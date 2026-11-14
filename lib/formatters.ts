/**
 * The TypeScript formatters that the browser still runs, and the types of the
 * ledger-core formatters.
 *
 * Components call the formatters in lib/wasm-client.ts, which run the Rust
 * code (rust-api/core/src/formatters.rs and expression.rs). This module keeps
 * only:
 * - `formatCurrency()`, the fallback of lib/wasm-client.ts for a value that
 *   JSON cannot carry to the WASM module (a fraction while the user types)
 * - `formatCurrencyCompact()` and `compactDecimals()`, the chart axis labels
 * - `toDateString()`, which the tests use to get today's date
 * - `FormattersCore`, the signatures of the WASM formatters
 */

export function formatCurrency(cents: number): string {
  const dollars = cents / 100;
  // Use a true Unicode minus (U+2212) rather than the ASCII hyphen Intl emits, so
  // negatives match the minus glyph used elsewhere (split indicators) and align in
  // tabular figures. The Rust `parse_currency()` reads this minus back.
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  })
    .format(dollars || 0)
    .replace("-", "−");
}

/**
 * A short money label for a chart axis: "$999", "$1.2k", "$12k", "$1.2M".
 * A negative value uses the U+2212 minus sign, as formatCurrency does.
 * Tooltips use formatCurrency. `decimals` sets the maximum decimals of the
 * number: of the dollars below $1,000 ("$0.5"), else of the k and M forms.
 */
export function formatCurrencyCompact(cents: number, decimals?: number): string {
  if (decimals === undefined) {
    const dollars = Math.round(Math.abs(cents) / 100);
    const sign = cents < 0 && dollars > 0 ? "−" : "";
    if (dollars < 1000) return `${sign}$${dollars}`;
    if (dollars < 999_500) return `${sign}$${shortNumber(dollars / 1000)}k`;
    return `${sign}$${shortNumber(dollars / 1_000_000)}M`;
  }
  const dollars = Math.abs(cents) / 100;
  const unit = compactUnit(dollars, decimals);
  const number = shortNumber(dollars / unit.size, decimals);
  const sign = cents < 0 && number !== "0" ? "−" : "";
  return `${sign}$${number}${unit.suffix}`;
}

const COMPACT_UNITS = [
  { size: 1, suffix: "" },
  { size: 1000, suffix: "k" },
  { size: 1_000_000, suffix: "M" },
];

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** The smallest unit in which the rounded number stays below 1000, so that no label is "$1000k". */
function compactUnit(dollars: number, decimals: number) {
  return COMPACT_UNITS.find((unit) => roundTo(dollars / unit.size, decimals) < 1000)
    ?? COMPACT_UNITS[COMPACT_UNITS.length - 1];
}

/**
 * The decimals that formatCurrencyCompact needs to show `cents` exactly
 * when the values are whole multiples of `stepCents`. Then two values one
 * step apart always have different labels.
 */
export function compactDecimals(cents: number, stepCents: number): number {
  const dollars = Math.abs(cents) / 100;
  // The decimals of one step in a unit: 0.05 needs 2. The tolerance stops a
  // floating point error from adding a decimal.
  const decimalsIn = (size: number) => Math.max(0, Math.ceil(-Math.log10(stepCents / 100 / size) - 1e-9));
  const unit = COMPACT_UNITS.find((item) => roundTo(dollars / item.size, decimalsIn(item.size)) < 1000)
    ?? COMPACT_UNITS[COMPACT_UNITS.length - 1];
  return decimalsIn(unit.size);
}

/**
 * Without `decimals`: one decimal below 10, else a whole number.
 * With `decimals`: that many decimals at most. A trailing zero is dropped.
 */
function shortNumber(value: number, decimals?: number): string {
  if (decimals !== undefined) return String(roundTo(value, decimals));
  return value < 10 ? String(Math.round(value * 10) / 10) : String(Math.round(value));
}

/** The local calendar date of `date` as YYYY-MM-DD. Throws on an invalid date. */
export function toDateString(date: Date): string {
  if (isNaN(date.getTime())) {
    throw new RangeError("Invalid date passed to toDateString");
  }
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export interface FormattersCore {
  formatCurrency(cents: number): string;
  /** "Jan 15, 2026". */
  formatDate(dateString: string): string;
  /** "Jan 15". */
  formatDateShort(dateString: string): string;
  /** True only for a calendar date in the form YYYY-MM-DD. */
  isValidDateString(value: string): boolean;
  /** Cents, or null when the text is not a plain decimal amount. */
  parseStrictCurrency(value: string): number | null;
  /**
   * The amount with two decimals after the user leaves an amount field. An
   * expression ("12.50 + 3") is evaluated. Text that is not an amount stays
   * as it is.
   */
  resolveAmountOnBlur(value: string): string;
  /** The last part of a colon path: "Automobile:Lease" gives "Lease". */
  getAccountShortName(fullName: string): string;
  /** A coarse age, such as "3 hr ago". A non-finite age gives a dash. */
  formatRelativeAge(ms: number): string;
  /** A price in micros as a form shows it: cents at least, more digits only when the price has them. */
  formatPriceMicrosInput(priceMicros: number): string;
  /** The value of an amount expression (`+`, `-`, `*`, `/`, parentheses), or null. */
  evaluateExpression(input: string): number | null;
}
