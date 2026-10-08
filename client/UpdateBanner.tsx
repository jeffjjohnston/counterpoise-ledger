import { useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/Button";
import { getNewVersion, subscribeToNewVersion } from "./version-check";

/**
 * Tells the user that the server has a new build (see `version-check.ts`).
 * The banner is at the bottom left: the toasts are at the bottom center and
 * the add button of the register is at the bottom right.
 *
 * "Later" hides the banner for this page only. The next navigation to a
 * different path loads the new build in all cases.
 */
export function UpdateBanner() {
  const version = useSyncExternalStore(subscribeToNewVersion, getNewVersion, () => null);
  const [hiddenFor, setHiddenFor] = useState<string | null>(null);

  if (version === null || version === hiddenFor) return null;

  return (
    <div
      role="status"
      className="fixed left-4 z-50 flex max-w-[calc(100vw-7rem)] items-center gap-3 rounded-lg bg-fg px-4 py-2 text-sm text-surface shadow-lg"
      style={{ bottom: "calc(1.5rem + env(safe-area-inset-bottom, 0px))" }}
    >
      <span>A new version of Counterpoise is available.</span>
      <Button size="sm" onClick={() => window.location.reload()}>
        Reload
      </Button>
      <button
        type="button"
        onClick={() => setHiddenFor(version)}
        className="rounded-md px-1.5 py-1 text-surface/70 hover:text-surface"
      >
        Later
      </button>
    </div>
  );
}
