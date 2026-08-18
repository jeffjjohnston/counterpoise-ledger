"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { parsePriceMicros } from "@/lib/pricing";
import { formatDateShort } from "@/lib/formatters";
import { useRegisterShortcuts } from "@/hooks/useRegisterShortcuts";
import type { ShortcutDef } from "@/components/KeyboardShortcutProvider";
import { PRICES_SAVED_EVENT } from "@/lib/events";
import { apiGet, apiPost, toMessage } from "@/lib/api-client";
import { useToast } from "@/components/ui/ToastProvider";

type DueSecurity = {
  securityId: number;
  name: string;
  symbol: string;
  lastPriceMicros: number | null;
  lastPriceDate: string | null;
};

type PricesDueResponse = {
  dueDate: string | null;
  securities: DueSecurity[];
};

const microsToInput = (micros: number | null) =>
  micros == null ? "" : String(micros / 1_000_000);

/**
 * Navbar pill for manually-priced securities (options etc.) with no price
 * for the last market day. Quiet until something is due; opens a popover
 * form prefilled with the last saved mark. Enter saves all, Escape closes,
 * P opens it from any book page.
 */
export function PriceEntryPill({
  bookId,
  className,
}: {
  bookId: string;
  className?: string;
}) {
  const toast = useToast();
  const [dueDate, setDueDate] = useState<string | null>(null);
  const [items, setItems] = useState<DueSecurity[]>([]);
  const [values, setValues] = useState<Record<number, string>>({});
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const firstInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    let latestSeq = 0;
    const load = async () => {
      // Rechecks can overlap (focus and visibilitychange both fire on tab
      // return); only the most recently started one may apply
      const seq = ++latestSeq;
      try {
        const data = await apiGet<PricesDueResponse>(`/api/b/${bookId}/securities/prices-due`);
        if (cancelled || seq !== latestSeq) return;
        if (!data.dueDate || data.securities.length === 0) {
          // Definitively nothing due — e.g. prices entered in another tab —
          // clear the pill. Fetch errors don't clear: no evidence either way.
          setItems([]);
          setDueDate(null);
          setValues({});
          // Close too, or a later due date would resurface with the popover
          // already open
          setOpen(false);
          return;
        }
        setDueDate(data.dueDate);
        setItems(data.securities);
        // Keep anything already typed; prefill only newly-listed securities
        setValues((prev) =>
          Object.fromEntries(
            data.securities.map((s) => [
              s.securityId,
              prev[s.securityId] ?? microsToInput(s.lastPriceMicros),
            ])
          )
        );
      } catch {
        // Pill is best-effort chrome; a failed check leaves state as is
      }
    };
    // load already catches its own errors (best-effort chrome); it cannot
    // reject.
    void load();
    // The due date advances while the app sits open (early-morning price
    // sync), so re-check whenever the user comes back
    const recheck = () => {
      if (document.visibilityState === "visible") void load();
    };
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", recheck);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", recheck);
    };
  }, [bookId]);

  // Close on outside click or Escape while open
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

  // Focus the first field with its value selected, so an unchanged mark is
  // just Enter and a changed one is type-over
  const openPopover = useCallback(() => {
    setOpen(true);
    requestAnimationFrame(() => {
      firstInputRef.current?.focus();
      firstInputRef.current?.select();
    });
  }, []);

  const allEntered = items.every(
    (s) => parsePriceMicros(values[s.securityId] ?? "") > 0
  );

  const handleSave = useCallback(async () => {
    if (!dueDate || saving) return;
    const priceUpdates = items.map((s) => ({
      securityId: s.securityId,
      priceMicros: parsePriceMicros(values[s.securityId] ?? ""),
      priceDate: dueDate,
    }));
    if (priceUpdates.some((u) => u.priceMicros <= 0)) return;

    setSaving(true);
    try {
      await apiPost(`/api/b/${bookId}/security-prices/bulk`, { priceUpdates });
      const count = items.length;
      setItems([]);
      setDueDate(null);
      setValues({});
      setOpen(false);
      toast.success(count === 1 ? "1 price saved" : `${count} prices saved`);
      window.dispatchEvent(new CustomEvent(PRICES_SAVED_EVENT));
    } catch (err) {
      // On failure the popover stays open with values intact
      toast.error(toMessage(err, "Failed to save prices"));
    } finally {
      setSaving(false);
    }
  }, [bookId, dueDate, items, saving, toast, values]);

  const shortcuts = useMemo<ShortcutDef[]>(() => {
    if (items.length === 0) return [];
    return [
      {
        id: "price-entry",
        keys: ["p"],
        description: "Enter security prices",
        category: "Transactions",
        action: openPopover,
      },
    ];
  }, [items.length, openPopover]);
  useRegisterShortcuts(shortcuts);

  const visible = items.length > 0 && dueDate != null;

  // Render only while there's a pill to show — an empty wrapper would still
  // occupy a gap slot in the navbar's flex row. Save confirmations go through
  // the shared ToastProvider stack, not local state, so they don't need to
  // keep this mounted.
  if (!visible) return null;

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      {visible && (
        <button
          type="button"
          onClick={() => (open ? setOpen(false) : openPopover())}
          aria-haspopup="dialog"
          aria-expanded={open}
          className="flex items-center gap-1.5 whitespace-nowrap rounded-full bg-surface-tertiary px-2.5 py-1 text-xs font-medium text-fg-secondary transition-colors hover:bg-surface-tertiary/80"
        >
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500" />
          {items.length} {items.length === 1 ? "price" : "prices"} due
        </button>
      )}
      {visible && open && dueDate && (
        <div
          role="dialog"
          aria-label="Enter security prices"
          className="fixed inset-x-2 top-16 z-50 rounded-lg border border-border bg-surface-elevated p-3 shadow-lg md:absolute md:inset-x-auto md:right-0 md:top-auto md:mt-1 md:w-72"
        >
          <div className="mb-2 text-sm font-medium">
            Prices due · {formatDateShort(dueDate)}
          </div>
          <div className="space-y-1.5">
            {items.map((s, index) => (
              <label
                key={s.securityId}
                className="flex items-center justify-between gap-3 text-xs text-fg-secondary"
              >
                <span className="truncate" title={s.name}>
                  {s.symbol}
                </span>
                <input
                  ref={index === 0 ? firstInputRef : undefined}
                  type="text"
                  inputMode="decimal"
                  value={values[s.securityId] ?? ""}
                  onChange={(e) => {
                    // Read eagerly: inside the updater, e.target.value can see
                    // the node after React restored the last rendered value
                    const value = e.target.value;
                    setValues((v) => ({ ...v, [s.securityId]: value }));
                  }}
                  onKeyDown={(e) => {
                    // handleSave already catches its own errors in a
                    // try/finally; it cannot reject.
                    if (e.key === "Enter") void handleSave();
                  }}
                  className="w-24 rounded-md border border-border bg-surface px-2 py-1 text-right text-sm tabular-nums text-fg focus:border-accent focus:outline-none"
                  aria-label={`Price for ${s.name}`}
                />
              </label>
            ))}
          </div>
          <div className="mt-3 flex justify-end">
            <button
              type="button"
              onClick={handleSave}
              disabled={!allEntered || saving}
              className="rounded-md bg-accent px-3 py-1 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
