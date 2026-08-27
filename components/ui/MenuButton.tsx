"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export type MenuItem = {
  label: string;
  onSelect: () => void;
  variant?: "default" | "danger";
  disabled?: boolean;
};

/**
 * A ⋯ trigger and its popover menu, for page-level row and card actions.
 *
 * Deliberately not the register's menu. TransactionList's version carries
 * viewport clamping and right-click positioning because it opens from rows in
 * a scrolling virtualised table; a card header needs neither, and folding both
 * behaviours into one component with a flag would make the register's harder
 * to read without making this one better. If a third surface needs a menu,
 * that is the moment to reconcile them.
 */
export function MenuButton({
  items,
  label = "More actions",
  align = "right",
  className,
}: {
  items: MenuItem[];
  label?: string;
  align?: "left" | "right";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((prev) => !prev)}
        className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-surface-tertiary text-fg-secondary transition-colors hover:text-fg"
      >
        <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <circle cx="4" cy="10" r="1.6" />
          <circle cx="10" cy="10" r="1.6" />
          <circle cx="16" cy="10" r="1.6" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          className={cn(
            "absolute z-30 mt-1 min-w-[11rem] rounded-lg border border-border bg-surface-elevated py-1 shadow-soft",
            align === "right" ? "right-0" : "left-0"
          )}
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                if (item.disabled) return;
                setOpen(false);
                item.onSelect();
              }}
              className={cn(
                "block w-full px-3 py-2 text-left text-sm transition-colors",
                "disabled:cursor-not-allowed disabled:opacity-50",
                item.variant === "danger"
                  ? "text-fg-danger hover:bg-danger-subtle"
                  : "text-fg hover:bg-surface-tertiary"
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
