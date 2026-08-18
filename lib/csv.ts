/**
 * Shared helpers for building and downloading CSV files client-side.
 */

import { toDateString } from "@/lib/formatters";

/**
 * Builds a dated CSV filename, e.g. `active-securities-2026-08-09.csv`.
 *
 * Lives here so the date is derived in one place: `toISOString().slice(0, 10)`
 * at the call site names the file in UTC, which from ~8pm US Eastern until
 * midnight stamps tomorrow's date onto today's export.
 */
export function datedCsvFilename(prefix: string): string {
  return `${prefix}-${toDateString(new Date())}.csv`;
}

/**
 * Escapes a single value for safe inclusion in a CSV cell.
 *
 * - Wraps values containing commas, quotes, or newlines in double quotes,
 *   doubling any embedded quotes per RFC 4180.
 * - Neutralizes CSV formula injection: a non-numeric value whose first
 *   non-whitespace character is `=`, `+`, `-`, `@`, tab, or CR is prefixed
 *   with a single quote so spreadsheet apps treat it as text rather than
 *   executing it as a formula. Leading whitespace is ignored because some
 *   apps trim it before evaluating (e.g. `" =SUM(A1)"`). Plain numbers —
 *   including negatives like `-123.45` — pass through so spreadsheets still
 *   parse them as numbers.
 */
export function csvEscape(value: string | number | null): string {
  if (value === null) return "";
  let str = String(value);
  if (!/^-?\d+(\.\d+)?$/.test(str) && /^\s*[=+\-@\t\r]/.test(str)) {
    str = `'${str}`;
  }
  return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

/**
 * Triggers a browser download of `content` as a file named `filename`.
 * Browser-only: relies on Blob, URL.createObjectURL, and the DOM.
 */
export function triggerDownload(filename: string, content: string): void {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  // Defer revoke so the browser can start the download before the blob URL is invalidated.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
