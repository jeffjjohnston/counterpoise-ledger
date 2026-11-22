import { useCallback, useState, type Dispatch, type SetStateAction } from "react";
import { ApiError, apiGet, toMessage } from "@/lib/api-client";
import { useToast } from "@/components/ui/ToastProvider";
import type { TransactionWithSplits } from "@/types";

/**
 * The state of the transaction editor after the server refused a save or a
 * delete because another user changed the transaction (HTTP 409).
 *
 * The editor stays open and keeps the user's edits, so that the user can read
 * or copy them. The edits cannot be saved: they started from an old version.
 * `reloadLatest` replaces the transaction in the editor with the latest
 * version, and the form then shows that version.
 *
 * The conflict belongs to one loaded transaction object. It ends when the
 * editor closes or shows a different object, with no reset by the page.
 */
export function useEditConflict(
  bookId: string,
  editingTransaction: TransactionWithSplits | null,
  setEditingTransaction: Dispatch<SetStateAction<TransactionWithSplits | null>>
) {
  const toast = useToast();
  const [conflictFor, setConflictFor] = useState<TransactionWithSplits | null>(null);
  const [reloading, setReloading] = useState(false);

  const conflict = editingTransaction !== null && conflictFor === editingTransaction;

  const flagConflict = useCallback(() => {
    setConflictFor(editingTransaction);
  }, [editingTransaction]);

  const reloadLatest = useCallback(async () => {
    const stale = editingTransaction;
    if (!stale) return;
    setReloading(true);
    try {
      const latest = await apiGet<TransactionWithSplits>(
        `/api/b/${bookId}/transactions/${stale.id}`
      );
      // The user can close the editor during the request. Do not open it again.
      setEditingTransaction((current) => (current === stale ? latest : current));
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        toast.error("Another user deleted this transaction.");
        setEditingTransaction((current) => (current === stale ? null : current));
      } else {
        toast.error(toMessage(error, "Failed to load the latest version"));
      }
    } finally {
      setReloading(false);
    }
  }, [bookId, editingTransaction, setEditingTransaction, toast]);

  return { conflict, reloading, flagConflict, reloadLatest };
}
