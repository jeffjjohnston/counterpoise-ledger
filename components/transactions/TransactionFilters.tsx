"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { PayeeAutocomplete } from "@/components/ui/PayeeAutocomplete";
import { cn } from "@/lib/utils";

interface TransactionFiltersProps {
  startDate: string;
  endDate: string;
  onStartDateChange: (date: string) => void;
  onEndDateChange: (date: string) => void;
  onClearDates: () => void;
  /** Human-readable summary of the active date range, or null when unfiltered. */
  dateFilterLabel: string | null;
  /** Matches the shape PayeeAutocomplete takes and the page holds. */
  payees: Array<{ id: number; name: string }>;
  selectedPayeeId: number | null;
  onPayeeChange: (payeeId: number | null) => void;
  showUpcoming: boolean;
  onShowUpcomingChange: (next: boolean) => void;
}

/**
 * The transactions header's filter controls.
 *
 * These used to sit open across the header on every visit -- two bare date
 * inputs, a payee box and a checkbox, 676px of it measured, saying nothing at
 * all when empty and showing raw `01/01/2025` inputs when set. The mobile
 * layout already had the better idea: a chip naming the active range with a
 * button to clear it. This is that idea given the room desktop actually has.
 *
 * So: a button that opens the controls, and one removable chip per active
 * filter. Nothing occupies the header except the filters that are doing
 * something.
 */
export function TransactionFilters({
  startDate,
  endDate,
  onStartDateChange,
  onEndDateChange,
  onClearDates,
  dateFilterLabel,
  payees,
  selectedPayeeId,
  onPayeeChange,
  showUpcoming,
  onShowUpcomingChange,
}: TransactionFiltersProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click or Escape while open, as the price-entry pill does.
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const selectedPayee = payees.find((payee) => payee.id === selectedPayeeId) ?? null;
  const activeCount =
    (dateFilterLabel ? 1 : 0) + (selectedPayee ? 1 : 0) + (showUpcoming ? 1 : 0);

  const chip = (
    key: string,
    label: string,
    onRemove: () => void,
    tone: "neutral" | "accent" = "neutral"
  ) => (
    <span
      key={key}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium",
        tone === "accent"
          ? "bg-future text-fg-accent"
          : "bg-surface-tertiary text-fg-secondary"
      )}
    >
      <span className="tabular-nums">{label}</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Clear ${label} filter`}
        className="text-fg-tertiary transition-colors hover:text-fg"
      >
        <svg
          className="h-3.5 w-3.5"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </span>
  );

  return (
    <div ref={rootRef} className="relative flex items-center gap-2">
      {dateFilterLabel && chip("date", dateFilterLabel, onClearDates)}
      {selectedPayee && chip("payee", selectedPayee.name, () => onPayeeChange(null))}
      {showUpcoming && chip("recurring", "Recurring", () => onShowUpcomingChange(false), "accent")}

      <Button
        type="button"
        variant={activeCount > 0 ? "secondary" : "ghost"}
        size="sm"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="gap-1.5 whitespace-nowrap"
      >
        <svg
          className="h-4 w-4"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={1.8}
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 5h18l-7 8v6l-4 2v-8L3 5z" />
        </svg>
        Filters
      </Button>

      {open && (
        <div
          role="dialog"
          aria-label="Transaction filters"
          className="absolute right-0 top-full z-50 mt-2 w-72 rounded-lg border border-border bg-surface-elevated p-3 shadow-lg"
        >
          {/* The two date fields stack rather than sitting in a row. Input wraps
              each field in a w-full div, so in a container this narrow a row
              would wrap one field per line anyway -- stacking on purpose reads
              better than stacking by accident, and keeps the popover narrow. */}
          <div className="space-y-3">
            <div className="space-y-2">
              <span className="block text-xs font-medium text-fg-tertiary">Date range</span>
              <Input
                type="date"
                size="compact"
                label="From"
                id="filter-start-date"
                value={startDate}
                onChange={(event) => onStartDateChange(event.target.value)}
              />
              <Input
                type="date"
                size="compact"
                label="To"
                id="filter-end-date"
                value={endDate}
                onChange={(event) => onEndDateChange(event.target.value)}
              />
              {(startDate || endDate) && (
                <Button type="button" variant="ghost" size="sm" onClick={onClearDates}>
                  Clear dates
                </Button>
              )}
            </div>

            <div>
              <span className="mb-1 block text-xs font-medium text-fg-tertiary">Payee</span>
              <PayeeAutocomplete
                payees={payees}
                value={selectedPayeeId}
                onChange={onPayeeChange}
                placeholder="Any payee"
              />
            </div>

            <label className="flex items-center gap-2 text-sm text-fg-secondary">
              <input
                type="checkbox"
                checked={showUpcoming}
                onChange={(event) => onShowUpcomingChange(event.target.checked)}
                className="rounded text-purple-600 focus:ring-purple-500"
              />
              Show upcoming recurring transactions
            </label>
          </div>
        </div>
      )}
    </div>
  );
}
