"use client";

import { useRef } from "react";
import {
  useKeyboardShortcuts,
  SHORTCUT_CATEGORIES,
} from "@/components/KeyboardShortcutProvider";

function getKeyLabel(key: string): string {
  if (key === "Escape") return "Esc";
  if (key.length === 1) return key.toUpperCase();
  return key;
}

function KeySequence({ keys }: { keys: string[] }) {
  return (
    <span className="flex items-center gap-1">
      {keys.map((key, i) => (
        <span key={i} className="flex items-center gap-1">
          {i > 0 && (
            <span className="text-xs text-fg-tertiary mx-0.5">then</span>
          )}
          <kbd className="inline-flex items-center justify-center min-w-[1.5rem] h-6 px-1.5 font-mono text-xs font-semibold bg-surface-tertiary border border-border rounded text-fg">
            {getKeyLabel(key)}
          </kbd>
        </span>
      ))}
    </span>
  );
}

export function KeyboardShortcutOverlay() {
  const { isOverlayOpen, setOverlayOpen, allShortcuts } =
    useKeyboardShortcuts();
  const overlayRef = useRef<HTMLDivElement>(null);

  if (!isOverlayOpen) return null;

  // Group shortcuts by category
  const groups = allShortcuts.reduce<
    Record<string, typeof allShortcuts>
  >((acc, shortcut) => {
    if (!acc[shortcut.category]) acc[shortcut.category] = [];
    acc[shortcut.category].push(shortcut);
    return acc;
  }, {});

  // SHORTCUT_CATEGORIES is both the ordering here and the type of
  // ShortcutDef.category, so this can only ever skip a category nothing
  // registered under. A second hand-maintained list here is what used to drop
  // the price entry pill's P silently.
  const sortedCategories = SHORTCUT_CATEGORIES.filter((c) => groups[c]);

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 backdrop-blur-[2px]"
      onClick={(e) => {
        if (e.target === overlayRef.current) setOverlayOpen(false);
      }}
    >
      <div
        className="bg-surface-elevated rounded-lg shadow-xl max-h-[80vh] overflow-auto w-full max-w-lg animate-modal-enter"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-lg font-semibold text-fg">Keyboard Shortcuts</h2>
          <button
            onClick={() => setOverlayOpen(false)}
            className="text-fg-tertiary hover:text-fg-secondary transition-colors"
            aria-label="Close"
          >
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>
        <div className="p-6 space-y-6">
          {sortedCategories.map((category) => (
            <div key={category}>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-tertiary mb-3">
                {category}
              </h3>
              <div className="space-y-2">
                {groups[category].map((shortcut) => (
                  <div
                    key={shortcut.id}
                    className="flex items-center justify-between py-1"
                  >
                    <span className="text-sm text-fg-secondary">
                      {shortcut.description}
                    </span>
                    <KeySequence keys={shortcut.keys} />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
