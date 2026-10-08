/**
 * Detection of a new client build on the server.
 *
 * The client is a single-page app. A page that stays open, for example a
 * Safari web app in the Dock, does not load `index.html` again after a
 * deploy. It continues to run the old build until a full reload. The cache
 * headers are correct (`static_pages.rs`), so the browser is not the cause.
 *
 * This module asks `/api/version` for the version of the server and compares
 * it with the version of this build. It asks when the page becomes visible,
 * when the window gets focus, when the browser restores the page from its
 * back-forward cache, and at a slow interval. When the versions are
 * different:
 *
 * - `UpdateBanner` shows a "Reload" button.
 * - The next navigation to a different path does a full page load, because
 *   the user leaves the current page at that time and loses nothing.
 */

import { createPath, type createBrowserRouter } from "react-router";
import { getAppVersion } from "@/lib/api-contract";

/**
 * The sessionStorage key that holds the server version of the last automatic
 * reload. If the page is still at an old build after that reload, it does
 * not reload again for the same version. The banner stays.
 */
export const VERSION_RELOAD_KEY = "counterpoise:version-reload-for";

/** A deploy is rare, so a slow poll is sufficient. Focus also starts a check. */
export const CHECK_INTERVAL_MS = 10 * 60_000;

type Listener = () => void;
type AppRouter = ReturnType<typeof createBrowserRouter>;

let serverVersion: string | null = null;
let checking = false;
const listeners = new Set<Listener>();

function setServerVersion(version: string | null) {
  if (version === serverVersion) return;
  serverVersion = version;
  for (const listener of listeners) listener();
}

/**
 * The version on the server when it is different from this build. Null when
 * they are the same, or before the first check.
 */
export function getNewVersion(): string | null {
  return serverVersion !== null && serverVersion !== getAppVersion() ? serverVersion : null;
}

/** For `useSyncExternalStore`. */
export function subscribeToNewVersion(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Asks the server for its version. A failed request changes nothing: the
 * server can be down for a short time during a deploy.
 */
export async function checkForNewVersion(): Promise<void> {
  if (checking) return;
  checking = true;
  try {
    const response = await fetch("/api/version", { cache: "no-store" });
    if (!response.ok) return;
    const body: unknown = await response.json();
    const version = (body as { version?: unknown } | null)?.version;
    if (typeof version === "string" && version !== "") setServerVersion(version);
  } catch {
    // Keep the last known version.
  } finally {
    checking = false;
  }
}

/**
 * Loads `href` from the server, unless an automatic reload for this server
 * version occurred before in this tab. Returns true when the load started.
 *
 * Without sessionStorage, there is no guard against a reload at each
 * navigation, so this function does not load.
 */
export function loadNewVersion(href: string): boolean {
  const version = getNewVersion();
  if (version === null) return false;
  try {
    const storage = window.sessionStorage;
    if (storage.getItem(VERSION_RELOAD_KEY) === version) return false;
    storage.setItem(VERSION_RELOAD_KEY, version);
  } catch {
    return false;
  }
  window.location.assign(href);
  return true;
}

/**
 * Starts the checks and the reload at the next navigation. Returns a function
 * that stops them, for the tests.
 */
export function startVersionCheck(router: Pick<AppRouter, "state" | "subscribe">): () => void {
  let pathname = router.state.location.pathname;
  let loading = false;

  const unsubscribe = router.subscribe((state) => {
    // A navigation that must load a chunk or data starts in the "loading"
    // state. A full load of the new URL at this time does not ask for a
    // chunk of the old build, which the deploy removed.
    const next = state.navigation.location;
    if (next && next.pathname !== pathname) {
      if (!loading && loadNewVersion(createPath(next))) loading = true;
      return;
    }
    // A navigation to a page that is already loaded goes directly to the new
    // location. Load that location from the server.
    if (state.location.pathname !== pathname) {
      pathname = state.location.pathname;
      if (!loading && loadNewVersion(createPath(state.location))) loading = true;
    }
  });

  const check = () => void checkForNewVersion();
  const onVisible = () => {
    if (document.visibilityState === "visible") check();
  };
  const onPageShow = (event: PageTransitionEvent) => {
    if (event.persisted) check();
  };

  check();
  const timer = setInterval(check, CHECK_INTERVAL_MS);
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("focus", check);
  window.addEventListener("pageshow", onPageShow);

  return () => {
    unsubscribe();
    clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("focus", check);
    window.removeEventListener("pageshow", onPageShow);
  };
}
