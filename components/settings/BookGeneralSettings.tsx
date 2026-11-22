"use client";

import { useState } from "react";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/ToastProvider";
import { useBookRole, type BookSummary } from "@/components/BookRoleProvider";
import { UpcomingDaysSettings } from "@/components/settings/UpcomingDaysSettings";
import { apiPut, toMessage } from "@/lib/api-client";

type SavedBook = Pick<BookSummary, "id" | "name" | "upcomingDays">;

/**
 * The book's name and its upcoming recurring days. Only the owner can change
 * them. A rename sends only the name: the cached upcomingDays can be older
 * than the stored value, and sending it would undo a change from another
 * device.
 */
export function BookGeneralSettings({ book }: { book: BookSummary }) {
  const { isOwner, applyBook, refresh, upcomingSaves } = useBookRole();
  const toast = useToast();
  // The edit in the field. Null shows the stored name, so a rename from
  // another device shows when the field holds no edit.
  const [draft, setDraft] = useState<string | null>(null);
  const name = draft ?? book.name;
  const [saving, setSaving] = useState(false);

  if (!isOwner) {
    return (
      <dl className="space-y-2 text-sm">
        <div><dt className="text-fg-tertiary">Book name</dt><dd className="text-fg">{book.name}</dd></div>
        <div><dt className="text-fg-tertiary">Upcoming recurring days</dt><dd className="text-fg">{book.upcomingDays}</dd></div>
      </dl>
    );
  }

  const rename = async (event: React.FormEvent) => {
    event.preventDefault();
    const next = name.trim();
    if (!next || next === book.name || saving) return;
    setSaving(true);
    try {
      const saved = await apiPut<SavedBook>(`/api/books/${book.id}`, { name: next });
      applyBook(saved);
      refresh();
      setDraft(null);
    } catch (err) {
      toast.error(toMessage(err, "Failed to rename the book"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <form onSubmit={rename} className="flex flex-col sm:flex-row sm:items-end gap-3">
        <div className="flex-1">
          <Input id="book-name" label="Book name" value={name} disabled={saving} onChange={(e) => setDraft(e.target.value)} />
        </div>
        <Button type="submit" disabled={saving || !name.trim() || name.trim() === book.name}>
          {saving ? "Saving..." : "Rename"}
        </Button>
      </form>
      <UpcomingDaysSettings
        key={`upcoming-${book.id}`}
        bookId={String(book.id)}
        storedValue={book.upcomingDays}
        saves={upcomingSaves}
        onSaved={(saved) => { applyBook(saved); refresh(); }}
      />
    </div>
  );
}
