"use client";

import { useState } from "react";
import { CategoryIcon } from "@/components/ui/CategoryIcon";
import { cn } from "@/lib/utils";

// A starting palette, not a vocabulary. The text input accepts anything the
// OS emoji keyboard produces, so this only has to cover the common cases.
const COMMON_ICONS = [
  "🏠", "🍔", "☕", "🛒", "🚗", "⛽", "⚡", "💡", "📱", "🌐",
  "🏥", "💊", "🎓", "📚", "👕", "✂️", "🎬", "🎵", "✈️", "🏨",
  "🎁", "🐕", "🧻", "🔧", "🛡️", "💳", "🏦", "💰", "📈", "🎯",
  "🍺", "🍕", "🚌", "🅿️", "📦", "💵", "🧾", "🏋️", "💇", "🎮",
];

interface IconPickerProps {
  /** The account's own icon. `null` means it inherits. */
  value: string | null;
  onChange: (icon: string | null) => void;
  /** What the account would show with no icon of its own. */
  inheritedIcon: string | null;
  /** Name of the ancestor supplying `inheritedIcon`. */
  inheritedFrom: string | null;
}

export function IconPicker({
  value,
  onChange,
  inheritedIcon,
  inheritedFrom,
}: IconPickerProps) {
  const [isOpen, setIsOpen] = useState(false);

  // Three states, and the difference has to be visible. An empty control is
  // ambiguous under inheritance: blank means "inherits 🚗" here, not "no
  // icon", so the button style carries the distinction rather than a
  // placeholder.
  // A strict null check, not truthiness — unlike `findIconSource` in
  // lib/accounting.ts. Both are safe only because `accountIconSchema`
  // (lib/schemas/accounts.ts) maps a stored "" to null before either side
  // ever sees it; if that ever changed, this line and that one would disagree.
  const isSet = value !== null;
  const shown = value ?? inheritedIcon;

  return (
    // `role="group"` + `aria-labelledby` ties the visible "Icon" text to the
    // control the way `Input`/`Select` tie a `<label>` to their control — a
    // plain `<label htmlFor>` has no single element to point at here, since
    // the control is a disclosure button plus popover, not one input.
    <div role="group" aria-labelledby="icon-picker-label">
      <span id="icon-picker-label" className="block text-sm font-medium text-fg-secondary mb-1">Icon</span>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setIsOpen((open) => !open)}
          aria-label="Choose an icon"
          aria-expanded={isOpen}
          className={cn(
            "w-9 h-9 flex-shrink-0 rounded-md flex items-center justify-center text-lg",
            "focus:outline-none focus:ring-2 focus:ring-border-focus",
            isSet
              ? "border border-border-focus bg-surface-tertiary"
              : "border border-dashed border-border opacity-60"
          )}
        >
          {shown ?? ""}
        </button>

        <span className="text-xs text-fg-tertiary">
          {isSet ? (
            <>
              {inheritedIcon ? `Overrides ${inheritedIcon}` : "Set on this account"}
              {" · "}
              <button
                type="button"
                onClick={() => onChange(null)}
                className="underline hover:text-fg-secondary"
              >
                use inherited
              </button>
            </>
          ) : inheritedIcon ? (
            <>
              Inherits {inheritedIcon} from <strong>{inheritedFrom}</strong>
            </>
          ) : (
            "No icon — the full category path is shown"
          )}
        </span>
      </div>

      {isOpen && (
        <div className="mt-2 rounded-md border border-border p-2">
          <input
            type="text"
            value={value ?? ""}
            onChange={(e) => onChange(e.target.value.trim() || null)}
            placeholder="Type or paste any emoji"
            aria-label="Icon character"
            className="w-full mb-2 px-2 py-1 text-sm rounded border border-border bg-surface"
          />
          <div className="grid grid-cols-10 gap-1">
            {COMMON_ICONS.map((option) => (
              <button
                key={option}
                type="button"
                aria-label={option}
                onClick={() => {
                  onChange(option);
                  setIsOpen(false);
                }}
                className={cn(
                  "aspect-square rounded flex items-center justify-center hover:bg-surface-tertiary",
                  value === option && "bg-surface-tertiary ring-1 ring-border-focus"
                )}
              >
                {/* No adjacent text in this button — cancel the default
                    right margin, or the centered glyph would sit off-center. */}
                <CategoryIcon icon={option} className="mr-0" />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
