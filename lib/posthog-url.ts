/**
 * The placeholder that stands in for every query string value sent to
 * analytics. It is deliberately not a valid value of any parameter the app
 * reads, so a redacted URL can never be mistaken for a real one.
 */
const REDACTED = "[redacted]";

/**
 * Build the URL to report as `$current_url` on a `$pageview`.
 *
 * Every query string VALUE is replaced; only the parameter NAMES survive. The
 * search page puts what the user typed into `?q=`, so a payee name, a merchant
 * or an amount would otherwise reach the analytics provider verbatim. Keeping
 * the names preserves the measurement that matters — that a search happened,
 * and which filters were in play — without the financial detail.
 *
 * Redaction is unconditional rather than a list of known-sensitive parameters.
 * A parameter added to a page later is then private by default, instead of
 * leaking until someone remembers to extend a list.
 */
export function redactedCaptureUrl(
  origin: string,
  pathname: string,
  search: string,
): string {
  const params = new URLSearchParams(search);
  const names = [...params.keys()];
  if (names.length === 0) return `${origin}${pathname}`;

  // The name is re-encoded: `URLSearchParams` hands back a decoded key, and
  // one carrying `&` or `=` would otherwise reassemble into two parameters.
  const redacted = names
    .map((name) => `${encodeURIComponent(name)}=${REDACTED}`)
    .join("&");
  return `${origin}${pathname}?${redacted}`;
}
