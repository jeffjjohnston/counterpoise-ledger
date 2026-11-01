"use client";
import { useState } from "react";
import { prepareSaveChord, readSaveChordEnabled, writeSaveChordEnabled } from "@/lib/save-chord";

export function SaveChordSettings() {
  const [enabled, setEnabled] = useState(readSaveChordEnabled);

  return (
    <section className="pt-4 border-t border-border space-y-2">
      <label className="flex items-start gap-2 text-sm text-fg">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => {
            const next = e.target.checked;
            writeSaveChordEnabled(next);
            setEnabled(next);
            // A preview, so the user hears what they turned on. The change
            // is a user gesture, so the browser lets it play.
            if (next) prepareSaveChord()?.();
          }}
          className="mt-1"
        />
        Play a chord when a transaction saves
      </label>
      <p className="text-xs text-fg-tertiary">A short, quiet two-note chord. Applies to this device only.</p>
    </section>
  );
}
