"use client";

import { type ReactNode, useState } from "react";

function readHidden(storageKey: string): boolean {
  try {
    return localStorage.getItem(storageKey) === "true";
  } catch {
    return false;
  }
}

function writeHidden(storageKey: string, hidden: boolean): void {
  try {
    localStorage.setItem(storageKey, String(hidden));
  } catch {
    // The setting is a convenience. The page works without it.
  }
}

/**
 * The card around a chart, with a "Hide chart" button. The choice is kept for
 * each viewer under `storageKey`. `title` is the heading. `actions` (for
 * example a range group) show before the button, only while the chart is shown.
 */
export function ChartCard({ storageKey, title = "Chart", actions, children }: {
  storageKey: string;
  title?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const [hidden, setHidden] = useState(() => readHidden(storageKey));

  function toggle() {
    setHidden(!hidden);
    writeHidden(storageKey, !hidden);
  }

  return (
    <section className="bg-surface rounded-lg border border-border shadow-soft p-4">
      {/* On a narrow screen, the actions go to a second line. If they are still too wide, each group
          moves to its own line. Each group keeps its labels whole. */}
      <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h2 className="text-sm font-medium text-fg-tertiary">{title}</h2>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
          {!hidden && actions}
          <button type="button" className="whitespace-nowrap text-sm text-fg-accent hover:underline" onClick={toggle}>
            {hidden ? "Show chart" : "Hide chart"}
          </button>
        </div>
      </div>
      {!hidden && children}
    </section>
  );
}
