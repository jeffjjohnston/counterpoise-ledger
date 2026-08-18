import { evaluateExpression } from "@/lib/expression";

export function formatCurrency(cents: number): string {
  const dollars = cents / 100;
  // Use a true Unicode minus (U+2212) rather than the ASCII hyphen Intl emits, so
  // negatives match the minus glyph used elsewhere (split indicators) and align in
  // tabular figures. See parseCurrency for the inverse normalization.
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  })
    .format(dollars || 0)
    .replace("-", "−");
}

/**
 * Returns true only for a strictly well-formed `YYYY-MM-DD` calendar date that
 * is safe to pass to formatDate/formatDateShort (which throw a RangeError on an
 * invalid Date). Use this to guard untrusted input such as URL query params
 * before storing it in date-filter state.
 */
export function isValidDateString(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00`);
  if (isNaN(date.getTime())) return false;
  // Reject overflow normalization (e.g. 2026-02-30 -> Mar 2) by round-tripping.
  return toDateString(date) === value;
}

export function formatDate(dateString: string): string {
  const date = new Date(dateString + "T00:00:00");
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date);
}

export function formatDateShort(dateString: string): string {
  const date = new Date(dateString + "T00:00:00");
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
  }).format(date);
}

export function toDateString(date: Date): string {
  if (isNaN(date.getTime())) {
    throw new RangeError("Invalid date passed to toDateString");
  }
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function parseCurrency(value: string): number {
  // Normalize the Unicode minus (U+2212) emitted by formatCurrency back to ASCII so
  // formatted negatives round-trip through this parser.
  const cleaned = value.replace(/−/g, "-").replace(/[^0-9.-]/g, "");
  const parsed = parseFloat(cleaned);
  if (isNaN(parsed)) return 0;
  return Math.round(parsed * 100);
}

export function parseStrictCurrency(value: string): number | null {
  const cleaned = value.replace(/−/g, "-").replace(/[$,]/g, "").trim();
  if (cleaned.length === 0) return null;

  const strictNumericPattern = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)$/;
  if (!strictNumericPattern.test(cleaned)) return null;

  const parsed = Number.parseFloat(cleaned);
  if (!Number.isFinite(parsed)) return null;
  return Math.round(parsed * 100);
}

/**
 * Evaluates a math expression (if present) and formats the result
 * to two decimal places. Used as the onBlur handler for amount fields.
 * Returns the original string if it can't be evaluated as an expression
 * or a simple numeric input.
 */
export function resolveAmountOnBlur(value: string): string {
  const result = evaluateExpression(value);
  if (result !== null) return result.toFixed(2);

  // Fallback: handle simple numeric inputs that evaluateExpression rejects
  // (e.g. ".5", "5.", whitespace-padded numbers)
  const trimmed = value.trim();
  if (trimmed.length === 0) return value;

  const simpleNumericPattern = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)$/;
  if (simpleNumericPattern.test(trimmed)) {
    const parsed = parseFloat(trimmed);
    if (!isNaN(parsed)) return parsed.toFixed(2);
  }

  return value;
}

/**
 * Extracts the short name from an account name by removing parent prefix.
 * For example: "Automobile:Lease" becomes "Lease"
 * For parent accounts without a colon: "Automobile" stays "Automobile"
 */
export function getAccountShortName(fullName: string): string {
  const lastColonIndex = fullName.lastIndexOf(":");
  if (lastColonIndex === -1) {
    return fullName;
  }
  return fullName.substring(lastColonIndex + 1);
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Coarse "how long ago" label for operational timestamps.
 *
 * Deliberately coarse: the only caller is a status board, where "3 hr ago" and
 * "3 hr 12 min ago" prompt exactly the same action.
 *
 * Two guards matter. A negative age — clock skew between the container that
 * wrote the timestamp and the browser reading it — clamps to "just now" rather
 * than rendering a future age. A non-finite age (an unparseable timestamp
 * reaching Date.parse) renders the same em dash the UI already uses for "no
 * usable timestamp", so a bad status file can never produce "NaN days ago".
 */
export function formatRelativeAge(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  if (ms < MINUTE_MS) return "just now";
  if (ms < HOUR_MS) return `${Math.floor(ms / MINUTE_MS)} min ago`;
  if (ms < DAY_MS) return `${Math.floor(ms / HOUR_MS)} hr ago`;

  const days = Math.floor(ms / DAY_MS);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/**
 * Write a price held in micros the way a price is typed into a form: always at
 * least cents, and only as many further digits as the value actually carries.
 *
 * Rounding to cents would be lossy for a fixed price like 1.0025 — and lossy in
 * the worst way, because the rounded text is what the form sends back on the
 * next save.
 */
export function formatPriceMicrosInput(priceMicros: number): string {
  return (priceMicros / 1_000_000).toFixed(6).replace(/(\.\d\d\d*?)0+$/, "$1");
}
