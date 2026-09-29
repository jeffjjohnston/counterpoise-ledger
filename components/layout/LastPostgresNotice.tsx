import { useState } from "react";

/** The upgrade guide on the public mirror. The mirror publishes `guides/`. */
export const UPGRADE_GUIDE_URL =
  "https://github.com/jeffjjohnston/counterpoise-ledger/blob/main/guides/upgrade-to-sqlite.md";

/** The localStorage key that records the dismissal. */
export const DISMISSED_KEY = "lastPostgresNoticeDismissed";

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === "true";
  } catch {
    // Storage can be blocked. Show the notice again.
    return false;
  }
}

/**
 * Tells the user that this release is the last release that uses PostgreSQL.
 * The next release needs a one-time conversion to SQLite. The server logs the
 * same text at startup (`LAST_POSTGRES_NOTICE` in `rust-api/server/src/main.rs`).
 *
 * The notice is fixed at the bottom of the screen and does not take space in
 * the page. The transactions page sets its height from the viewport, so a
 * notice in the page flow would make the document scroll. On a phone, the
 * notice stops before the new-transaction button at the bottom right.
 */
export function LastPostgresNotice() {
  const [dismissed, setDismissed] = useState(readDismissed);

  if (dismissed) return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISSED_KEY, "true");
    } catch {
      // Storage can be blocked. The notice then shows again on the next load.
    }
  };

  return (
    <aside
      aria-label="Upgrade notice"
      className="fixed bottom-[calc(1.5rem_+_env(safe-area-inset-bottom,0px))] left-4 right-20 z-30 flex items-start gap-2 rounded-lg border border-border bg-surface-elevated p-3 text-xs text-fg-secondary shadow-lg lg:bottom-6 lg:left-6 lg:right-auto lg:max-w-sm"
    >
      <span className="mt-1 inline-block h-2 w-2 flex-none rounded-full bg-(--fg-accent)" aria-hidden="true" />
      <p className="min-w-0 flex-1">
        This is the last Counterpoise release that uses PostgreSQL. The next release moves your data
        to SQLite. That upgrade needs a one-time conversion. Read the{" "}
        <a
          href={UPGRADE_GUIDE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-fg-accent underline"
        >
          upgrade guide
        </a>{" "}
        before you upgrade.
      </p>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss the upgrade notice"
        className="-m-1 flex-none rounded p-1 text-fg-tertiary transition-colors hover:text-fg"
      >
        <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
          <path d="M5 5l10 10M15 5L5 15" strokeLinecap="round" />
        </svg>
      </button>
    </aside>
  );
}
