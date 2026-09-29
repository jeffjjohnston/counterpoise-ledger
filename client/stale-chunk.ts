/**
 * Recovery from a stale chunk after a deploy.
 *
 * Each build gives its chunks new hashed names, and a deploy removes the old
 * files. A tab that was open before the deploy still has the old route
 * table. When it goes to a page that it did not load before, it asks for an
 * old chunk, and the server sends 404. The fix is a full reload, which gets
 * the new `index.html` and the new chunk names.
 *
 * The root error page (`RouteError.tsx`) calls `reloadOnceForStaleChunk()`.
 * It does not come from a `vite:preloadError` listener, because that event
 * occurs before the router goes to the new page. A reload at that time loads
 * the old page, not the page that the user asked for. When the error gets to
 * the error page, the router is at the new URL, so the reload loads it.
 */

/** The sessionStorage key that holds the time of the last automatic reload. */
export const RELOAD_MARKER_KEY = "counterpoise:stale-chunk-reload-at";

/**
 * A chunk error in this period after an automatic reload does not cause a
 * second reload. The reload did not fix the error, so the error page shows.
 * The period is long enough for a slow phone to load the page again.
 */
export const RELOAD_WINDOW_MS = 30_000;

/**
 * The messages that browsers and Vite give when a chunk does not load. The
 * server sends 404 for a missing chunk (`static_pages.rs`). The MIME message
 * is for a server that sends HTML in place of the chunk.
 */
const CHUNK_ERROR_MESSAGES = [
  /Failed to fetch dynamically imported module/i, // Chromium
  /error loading dynamically imported module/i, // Firefox
  /Importing a module script failed/i, // Safari
  /Unable to preload CSS/i, // Vite, for a missing CSS file of a chunk
  /is not a valid JavaScript MIME type/i, // Safari, when HTML comes for a script
];

/** True when the error is a failure to load a chunk of the client build. */
export function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return CHUNK_ERROR_MESSAGES.some((pattern) => pattern.test(error.message));
}

// Set when this page started a reload, so that a second render of the error
// page does not show the error while the browser unloads the page.
let reloadStarted = false;

/**
 * Reloads the page, unless an automatic reload occurred in the last
 * `RELOAD_WINDOW_MS`. Returns true when a reload started. Returns false when
 * the caller must show the error.
 *
 * Without sessionStorage, there is no guard against a reload loop, so this
 * function does not reload.
 */
export function reloadOnceForStaleChunk(now: number = Date.now()): boolean {
  if (reloadStarted) return true;
  try {
    const storage = window.sessionStorage;
    const last = Number(storage.getItem(RELOAD_MARKER_KEY));
    if (last > 0 && now >= last && now - last < RELOAD_WINDOW_MS) return false;
    storage.setItem(RELOAD_MARKER_KEY, String(now));
  } catch {
    return false;
  }
  reloadStarted = true;
  window.location.reload();
  return true;
}
