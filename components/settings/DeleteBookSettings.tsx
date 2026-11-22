"use client";

import { useState } from "react";
import { useRouter } from "@/lib/navigation";
import { apiDelete, toMessage } from "@/lib/api-client";
import { BOOK_SESSION_ENDED_EVENT } from "@/lib/events";
import type { BookSummary } from "@/components/BookRoleProvider";

/** The owner's control to delete the book. It asks two times. */
export function DeleteBookSettings({ book }: { book: BookSummary }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");

  const remove = async () => {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    if (!window.confirm(`Delete "${book.name}" permanently? This removes all data in this book and cannot be undone.`)) return;
    setDeleting(true);
    setError("");
    try {
      await apiDelete(`/api/books/${book.id}`);
      // The book is gone, so its pages are gone too. Stop its socket before
      // the home page loads, and replace the entry so Back does not open the
      // deleted book.
      window.dispatchEvent(new Event(BOOK_SESSION_ENDED_EVENT));
      router.replace("/");
    } catch (err) {
      setError(toMessage(err, "Failed to delete book"));
      setDeleting(false);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-danger-subtle p-3">
      <p className="text-xs text-fg-danger mb-3">
        Deleting this book permanently removes its transactions, accounts, and all related data. This action cannot
        be undone.
      </p>
      {error && <p className="text-xs text-fg-danger mb-2">{error}</p>}
      {!confirming ? (
        <button
          type="button"
          onClick={remove}
          className="rounded-lg border border-border bg-surface px-3 py-2 text-sm font-medium text-fg-danger hover:bg-danger-subtle"
        >
          Delete book...
        </button>
      ) : (
        <div className="space-y-2">
          <p className="text-xs font-medium text-fg-danger">Final confirmation required: this cannot be undone.</p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={remove}
              disabled={deleting}
              className="rounded-lg bg-danger px-3 py-2 text-sm font-medium text-fg-on-accent hover:bg-danger disabled:opacity-50"
            >
              {deleting ? "Deleting..." : "Yes, permanently delete"}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={deleting}
              className="rounded-lg border border-border bg-surface px-3 py-2 text-sm font-medium text-fg-secondary hover:bg-surface-tertiary disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
