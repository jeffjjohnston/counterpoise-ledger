"use client";
import { useEffect, useId, useRef, useState } from "react";
import { patternAccounts, patternLabel } from "@/lib/entry-patterns";
import type { EntryPattern } from "@/lib/typesafe/types";
import type { AccountWithBalance } from "@/types";

/** How many other patterns show as buttons beside the chip. */
const QUICK_PICKS = 2;

/**
 * "Filled from: Groceries · $42.10 (history)": the pattern that the form
 * shows, and where it came from. The next patterns show as buttons beside
 * it, so that one click picks one: in production the right pattern was often
 * offered but not picked, and the list behind the chip was never used. A
 * click on the chip opens all of the payee's patterns in this account; a pick
 * fills the form again. With `hideAmount` the label names only the accounts,
 * for a form that shows the range elsewhere.
 */
export function EntryPatternChip({
  patterns,
  accounts,
  accountId,
  chosen,
  source,
  hideAmount = false,
  onPick,
}: {
  patterns: EntryPattern[];
  accounts: AccountWithBalance[];
  accountId: number;
  chosen: EntryPattern;
  source: string;
  hideAmount?: boolean;
  onPick: (pattern: EntryPattern, index: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const quickPicks = patterns
    .map((pattern, index) => ({ pattern, index }))
    .filter(({ pattern }) => pattern.key !== chosen.key)
    .slice(0, QUICK_PICKS);
  const listId = useId();
  const root = useRef<HTMLDivElement>(null);
  // A click outside closes the list.
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  return (
    <div
      ref={root}
      className="flex min-w-0 flex-wrap items-center gap-1 text-xs"
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        className="max-w-full truncate rounded-md bg-surface-secondary px-2 py-0.5 text-left text-fg-secondary hover:text-fg"
        onClick={() => setOpen(!open)}
      >
        Filled from: {(hideAmount ? patternAccounts : patternLabel)(chosen, accounts, accountId)} ({source})
      </button>
      {!open && quickPicks.length > 0 && (
        <div role="group" aria-label="Other patterns" className="flex min-w-0 flex-wrap items-center gap-1">
          <span className="text-fg-tertiary">or</span>
          {quickPicks.map(({ pattern, index }) => (
            <button
              key={pattern.key}
              type="button"
              className="max-w-[14rem] truncate rounded-md border border-border px-2 py-0.5 text-left text-fg-secondary hover:text-fg"
              onClick={() => onPick(pattern, index)}
            >
              {patternLabel(pattern, accounts, accountId)}
            </button>
          ))}
        </div>
      )}
      {open && (
        <ul id={listId} aria-label="Earlier patterns" className="mt-1 basis-full rounded-md border border-border bg-surface-elevated shadow-soft">
          {patterns.map((pattern, index) => (
            <li key={pattern.key}>
              <button
                type="button"
                aria-current={pattern.key === chosen.key || undefined}
                className="w-full truncate px-2 py-1 text-left text-fg hover:bg-surface-tertiary"
                onClick={() => {
                  setOpen(false);
                  onPick(pattern, index);
                }}
              >
                {patternLabel(pattern, accounts, accountId)} · {pattern.count} {pattern.count === 1 ? "use" : "uses"} · last {pattern.lastDate}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
