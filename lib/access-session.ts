/**
 * Cloudflare Access in front of the app.
 *
 * When the Access application token expires, Access answers every request
 * with a redirect to its login page on another origin. A `fetch` that
 * follows it fails as a network error, so the client asks for redirects not
 * to be followed: no API route redirects a `fetch`, and an `opaqueredirect`
 * response therefore means Access wants a sign-in. Reloading the page goes
 * through Access as a navigation, which renews the token while the Access
 * session lasts and shows the login page when it has ended.
 */

/** Pass to `fetch` for a request to this app's API. */
export const ACCESS_REDIRECT: RequestRedirect = "manual";

/** One reload a minute at most, so a redirect that a reload does not cure
 * cannot reload the page in a loop. */
const RELOAD_KEY = "counterpoise.access-reload";
const RELOAD_INTERVAL_MS = 60_000;

/** True when Access answered instead of the app. */
export function accessExpired(response: Response): boolean {
  return response.type === "opaqueredirect";
}

/** Reloads the page to renew the Access token. Returns false when it does
 * not, outside a browser or within a minute of the last reload. */
export function renewAccessSession(): boolean {
  if (typeof window === "undefined") return false;
  const now = Date.now();
  try {
    const last = Number(window.sessionStorage.getItem(RELOAD_KEY));
    if (last && now - last < RELOAD_INTERVAL_MS) return false;
    window.sessionStorage.setItem(RELOAD_KEY, String(now));
  } catch {
    // Without storage nothing could stop a loop, so leave the error showing.
    return false;
  }
  window.location.reload();
  return true;
}
