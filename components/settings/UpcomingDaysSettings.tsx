"use client";

import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/ToastProvider";
import type { BookSummary } from "@/components/BookRoleProvider";
import { apiPut, toMessage } from "@/lib/api-client";

/**
 * Records which books have an upcoming-days save in flight. The owner must
 * outlive the field: a navigation away from the settings page unmounts the
 * field, and the save continues. BookRoleProvider keeps it. A field for a
 * book with a save in flight takes no input, so only one save per book runs,
 * and the last value that the user chose is the value that the server keeps.
 */
export class UpcomingDaysSaves {
  private busy = new Set<string>();
  private listeners = new Set<() => void>();

  isBusy(bookId: string) { return this.busy.has(bookId); }

  /** Runs `task` as the save of `bookId`. */
  async run(bookId: string, task: () => Promise<void>) {
    this.busy.add(bookId);
    this.notify();
    try {
      await task();
    } finally {
      this.busy.delete(bookId);
      this.notify();
    }
  }

  /** Calls `listener` when a save starts or ends. It returns the unsubscribe function. */
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private notify() {
    for (const listener of this.listeners) listener();
  }
}

type SavedBook = Pick<BookSummary, "id" | "name" | "upcomingDays">;

type Props = {
  bookId: string;
  /** The book's upcomingDays in the books cache. */
  storedValue: number;
  /** The saves of all books, kept by a parent that outlives the modal. */
  saves: UpcomingDaysSaves;
  /** Puts the saved book into the books cache, then reads the books again. */
  onSaved: (book: SavedBook) => void;
};

/**
 * The book's "Upcoming recurring days" setting. The parent mounts one per
 * book (key={bookId}).
 *
 * It sends only upcomingDays. The cached book name can be older than the
 * stored one, and sending it would undo a rename from another device.
 */
export function UpcomingDaysSettings({ bookId, storedValue, saves, onSaved }: Props) {
  const toast = useToast();
  const [value, setValue] = useState(storedValue);
  const [busy, setBusy] = useState(() => saves.isBusy(bookId));
  // True while the field holds an edit that is not saved. A books read then
  // does not replace what the user typed.
  const dirty = useRef(false);

  useEffect(() => saves.subscribe(() => setBusy(saves.isBusy(bookId))), [saves, bookId]);

  useEffect(() => {
    if (!dirty.current) setValue(storedValue);
  }, [storedValue]);

  const save = () => {
    if (!dirty.current || saves.isBusy(bookId)) return;
    if (value === storedValue) {
      dirty.current = false;
      return;
    }
    const next = value;
    void saves.run(bookId, async () => {
      try {
        const book = await apiPut<SavedBook>(`/api/books/${bookId}`, { upcomingDays: next });
        dirty.current = false;
        onSaved(book);
      } catch (err) {
        dirty.current = false;
        setValue(storedValue);
        toast.error(toMessage(err, "Failed to save the upcoming recurring days"));
      }
    });
  };

  return (
    <section className="pt-4 border-t border-border">
      <Input
        id="upcoming-days"
        label="Upcoming recurring days"
        type="number"
        min={1}
        max={365}
        value={value}
        disabled={busy}
        onChange={(e) => {
          const parsed = parseInt(e.target.value, 10);
          if (!isNaN(parsed) && parsed >= 1 && parsed <= 365) {
            dirty.current = true;
            setValue(parsed);
          }
        }}
        onBlur={save}
      />
      <p className="mt-1 text-xs text-fg-tertiary">
        Number of days into the future to show recurring transactions (1–365).
        {busy && " Saving…"}
      </p>
    </section>
  );
}
