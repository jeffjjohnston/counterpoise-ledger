import { useEffect, useState } from "react";
import { useRouteError } from "react-router";
import { Button } from "@/components/ui/Button";
import { isChunkLoadError, reloadOnceForStaleChunk } from "./stale-chunk";

/**
 * The error page of the root route. React Router shows it in place of the
 * app when a page cannot load or when a page throws during render.
 *
 * When a chunk does not load, the tab is usually older than the last deploy.
 * The page then reloads one time (see `stale-chunk.ts`). For all other
 * errors, and when the reload did not fix the error, the page tells the user
 * and gives a Reload button and a link to the books page.
 */
export function RouteError() {
  const error = useRouteError();
  const chunkError = isChunkLoadError(error);
  // A chunk error shows "Loading" until the effect knows if a reload started.
  const [reloading, setReloading] = useState(chunkError);

  useEffect(() => {
    console.error(error);
    if (chunkError) setReloading(reloadOnceForStaleChunk());
  }, [error, chunkError]);

  if (reloading) {
    return (
      <div className="min-h-screen flex items-center justify-center px-6">
        <p role="status" className="text-sm text-fg-tertiary">
          Loading the new version of Counterpoise…
        </p>
      </div>
    );
  }

  const message = error instanceof Error ? error.message : undefined;

  return (
    <main className="min-h-screen flex items-center justify-center px-6 py-16">
      <div className="flex flex-col items-center text-center w-full max-w-sm">
        <div className="w-12 h-12 rounded-full bg-surface-secondary flex items-center justify-center mb-4">
          <svg
            className="w-6 h-6 text-fg-tertiary"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M12 9v3.75m0 3.75h.008M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"
            />
          </svg>
        </div>
        <h1 className="text-fg font-medium">
          {chunkError ? "This page did not load" : "Something went wrong"}
        </h1>
        <p className="mt-1 text-sm text-fg-tertiary">
          {chunkError
            ? "Counterpoise possibly changed after you opened this tab. Reload the page to get the new version."
            : "An error stopped this page. Reload the page to try again."}
        </p>
        {message && (
          <p className="mt-3 w-full text-xs text-fg-tertiary break-words font-mono">{message}</p>
        )}
        <div className="mt-6 flex flex-col sm:flex-row items-center gap-3">
          <Button type="button" onClick={() => window.location.reload()}>
            Reload
          </Button>
          {/* A full page load, not a router navigation: it starts again from
              a known state and gets the newest build. */}
          <a href="/" className="text-sm text-fg-accent hover:underline font-medium">
            Go to your books
          </a>
        </div>
      </div>
    </main>
  );
}
