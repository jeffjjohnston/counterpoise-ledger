/** The text of each error code that a failed weekly review stores. */
export const WEEKLY_REVIEW_ERRORS: Record<string, string> = {
  not_configured: "The server has no Anthropic API key.",
  network_error: "The server could not reach Anthropic.",
  timeout: "Anthropic did not answer in time.",
  rate_limited: "Anthropic asked the server to wait. Try again later.",
  provider_error: "Anthropic returned an error.",
  invalid_api_key: "Anthropic refused the server's API key. Ask the operator to check ANTHROPIC_API_KEY.",
  provider_unavailable: "Anthropic is busy or down. Try again later.",
  refusal: "The model declined to review this week.",
  invalid_response: "The answer could not be read.",
  discarded: "The setting changed during the review, so its result was discarded.",
  interrupted: "The server restarted during the review.",
  database_error: "The server could not read or save the review.",
};

export function errorText(code: string | null): string {
  return (code && WEEKLY_REVIEW_ERRORS[code]) || "The review failed.";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Oct 5 – 11", or "Sep 29 – Oct 5" across two months. Dates are YYYY-MM-DD. */
export function formatPeriod(start: string, end: string): string {
  const [, startMonth, startDay] = start.split("-").map(Number);
  const [, endMonth, endDay] = end.split("-").map(Number);
  const from = `${MONTHS[startMonth - 1]} ${startDay}`;
  return startMonth === endMonth ? `${from} – ${endDay}` : `${from} – ${MONTHS[endMonth - 1]} ${endDay}`;
}

/** BookNavbar opens the book settings modal on this window event. */
export const OPEN_BOOK_SETTINGS_EVENT = "counterpoise:open-book-settings";

export function openBookSettings(): void {
  window.dispatchEvent(new Event(OPEN_BOOK_SETTINGS_EVENT));
}

/** The settings section sends this window event after a successful save. */
export const WEEKLY_REVIEW_SETTINGS_EVENT = "counterpoise:weekly-review-settings";

export function notifyWeeklyReviewSettings(bookId: string): void {
  window.dispatchEvent(new CustomEvent(WEEKLY_REVIEW_SETTINGS_EVENT, { detail: { bookId } }));
}

export function hiddenKey(bookId: string): string {
  return `counterpoise.weeklyReview.${bookId}.hidden`;
}

export function readHidden(bookId: string): boolean {
  try {
    return localStorage.getItem(hiddenKey(bookId)) === "true";
  } catch {
    return false;
  }
}

export function writeHidden(bookId: string, hidden: boolean): void {
  try {
    localStorage.setItem(hiddenKey(bookId), String(hidden));
  } catch {
    // The setting is a convenience. The card works without it.
  }
}
