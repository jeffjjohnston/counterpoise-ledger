"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { JobStatusTable } from "@/components/system/JobStatusTable";
import { apiGet, apiPost, apiPut, apiDelete, toMessage } from "@/lib/api-client";
import { useToast } from "@/components/ui/ToastProvider";

interface Book {
  id: number;
  name: string;
  createdAt: string;
  updatedAt: string;
}

interface IssueReport {
  id: number;
  description: string;
  type: "bug" | "improvement" | "other";
  page: string;
  status: "new" | "resolved" | "wontfix";
  createdAt: string;
}

const BOOK_COLORS = ["#3b82f6", "#8b5cf6", "#10b981", "#f59e0b", "#ef4444"];

export default function BookSelectorPage() {
  const router = useRouter();
  const toast = useToast();
  const [books, setBooks] = useState<Book[]>([]);
  const [loading, setLoading] = useState(true);
  const [newBookName, setNewBookName] = useState("");
  const [creating, setCreating] = useState(false);
  const [creatingDemo, setCreatingDemo] = useState(false);
  const [editingBook, setEditingBook] = useState<Book | null>(null);
  const [editingBookName, setEditingBookName] = useState("");
  const [savingBook, setSavingBook] = useState(false);
  const [deletingBook, setDeletingBook] = useState(false);
  const [showDeleteConfirmation, setShowDeleteConfirmation] = useState(false);
  const [error, setError] = useState("");
  const [signingOut, setSigningOut] = useState(false);
  const [issues, setIssues] = useState<IssueReport[]>([]);
  const [issuesLoading, setIssuesLoading] = useState(true);
  const [showAllIssues, setShowAllIssues] = useState(false);
  const [editingIssue, setEditingIssue] = useState<IssueReport | null>(null);
  const [editingIssueDescription, setEditingIssueDescription] = useState("");
  const [editingIssueStatus, setEditingIssueStatus] = useState<string>("new");
  const [editingIssueType, setEditingIssueType] = useState<string>("bug");
  const [savingIssue, setSavingIssue] = useState(false);
  const [deletingIssue, setDeletingIssue] = useState(false);

  const fetchBooks = useCallback(async () => {
    try {
      const data = await apiGet<Book[]>("/api/books");
      setBooks(data);
    } catch (err) {
      setError(toMessage(err, "Could not load books."));
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchIssues = useCallback(async () => {
    try {
      const data = await apiGet<IssueReport[]>("/api/issue-reports");
      setIssues(data);
    } catch {
      // Issue reports are supplementary to the books list; the page is
      // useful without them, so this fails silently — matching the
      // original's empty catch.
    } finally {
      setIssuesLoading(false);
    }
  }, []);

  useEffect(() => {
    // Both fetch functions handle their own errors internally.
    void fetchBooks();
    void fetchIssues();
  }, [fetchBooks, fetchIssues]);

  const handleCreateBook = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = newBookName.trim();
    if (!name) return;

    setCreating(true);
    setError("");

    try {
      const book = await apiPost<Book>("/api/books", { name });
      setNewBookName("");
      setBooks((prev) => [...prev, book]);
    } catch (err) {
      setError(toMessage(err, "Failed to create book"));
    } finally {
      setCreating(false);
    }
  };

  // The request runs the full seed on the server and takes seconds, not
  // milliseconds. `creatingDemo` disables both actions in this panel for its
  // whole duration, so the wait reads as work in progress rather than a dead
  // button. The route takes no body — the book it seeds is the one it creates.
  const handleCreateDemoBook = async () => {
    setCreatingDemo(true);
    setError("");

    try {
      const book = await apiPost<Book>("/api/books/demo");
      setBooks((prev) => [...prev, book]);
    } catch (err) {
      setError(toMessage(err, "Failed to create demo book"));
    } finally {
      setCreatingDemo(false);
    }
  };

  const handleSignOut = async () => {
    setSigningOut(true);
    try {
      await apiPost("/api/auth/logout");
      router.push("/login");
    } catch {
      // Do NOT redirect on failure. destroySession() clears the session
      // cookie (HTTP-only) and deletes the session row — both entirely
      // server-side — so if this request never landed, the session is still
      // fully valid. Sending the user to /login here would tell them they
      // are signed out while leaving the session live: on a shared machine,
      // that is a real exposure, not just a stale UI.
      //
      // The message is a fixed string rather than routed through
      // toMessage(e, ...): the one fact that matters is "you are still
      // signed in," and neither an ApiError's server-supplied text (e.g. a
      // 500's `{ error: "Failed to log out" }`) nor toMessage's network-error
      // string says that. A generic message here would be actively
      // misleading, not just uninformative.
      toast.error("Could not sign out — you are still signed in. Please try again.");
      setSigningOut(false);
    }
  };

  const openEditModal = (book: Book) => {
    setEditingBook(book);
    setEditingBookName(book.name);
    setShowDeleteConfirmation(false);
    setError("");
  };

  const closeEditModal = (force = false) => {
    if (!force && (savingBook || deletingBook)) return;
    setEditingBook(null);
    setEditingBookName("");
    setShowDeleteConfirmation(false);
  };

  const handleRenameBook = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingBook) return;

    const name = editingBookName.trim();
    if (!name) return;

    setSavingBook(true);
    setError("");

    try {
      const updated = await apiPut<Book>(`/api/books/${editingBook.id}`, { name });
      setBooks((prev) =>
        prev.map((book) => (book.id === editingBook.id ? { ...book, ...updated } : book))
      );
      closeEditModal(true);
    } catch (err) {
      setError(toMessage(err, "Failed to update book"));
    } finally {
      setSavingBook(false);
    }
  };

  const handleDeleteBook = async () => {
    if (!editingBook) return;

    if (!showDeleteConfirmation) {
      setShowDeleteConfirmation(true);
      return;
    }

    const confirmed = window.confirm(
      `Delete "${editingBook.name}" permanently? This removes all data in this book and cannot be undone.`
    );
    if (!confirmed) return;

    setDeletingBook(true);
    setError("");

    try {
      await apiDelete(`/api/books/${editingBook.id}`);
      setBooks((prev) => prev.filter((book) => book.id !== editingBook.id));
      closeEditModal(true);
    } catch (err) {
      setError(toMessage(err, "Failed to delete book"));
    } finally {
      setDeletingBook(false);
    }
  };

  const openEditIssueModal = (issue: IssueReport) => {
    setEditingIssue(issue);
    setEditingIssueDescription(issue.description);
    setEditingIssueStatus(issue.status);
    setEditingIssueType(issue.type);
    setError("");
  };

  const closeEditIssueModal = (force = false) => {
    if (!force && (savingIssue || deletingIssue)) return;
    setEditingIssue(null);
  };

  const handleSaveIssue = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingIssue) return;

    const description = editingIssueDescription.trim();
    if (!description) return;

    setSavingIssue(true);
    setError("");

    try {
      const updated = await apiPut<IssueReport>(`/api/issue-reports/${editingIssue.id}`, {
        description,
        status: editingIssueStatus,
        type: editingIssueType,
      });
      setIssues((prev) =>
        prev.map((issue) => (issue.id === editingIssue.id ? updated : issue))
      );
      closeEditIssueModal(true);
    } catch (err) {
      setError(toMessage(err, "Failed to update issue"));
    } finally {
      setSavingIssue(false);
    }
  };

  const handleDeleteIssue = async () => {
    if (!editingIssue) return;

    const confirmed = window.confirm("Delete this issue report? This cannot be undone.");
    if (!confirmed) return;

    setDeletingIssue(true);
    setError("");

    try {
      await apiDelete(`/api/issue-reports/${editingIssue.id}`);
      setIssues((prev) => prev.filter((issue) => issue.id !== editingIssue.id));
      closeEditIssueModal(true);
    } catch (err) {
      setError(toMessage(err, "Failed to delete issue"));
    } finally {
      setDeletingIssue(false);
    }
  };

  const filteredIssues = showAllIssues
    ? issues
    : issues.filter((i) => i.status === "new");

  if (loading) {
    return (
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
        <div className="animate-pulse space-y-6">
          <div className="h-8 bg-surface-tertiary rounded w-48" />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {[1, 2].map((i) => (
              <div key={i} className="h-32 bg-surface-tertiary rounded-lg" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-2xl font-bold text-fg">Your Books</h1>
        <button
          onClick={handleSignOut}
          disabled={signingOut}
          className="text-sm text-fg-tertiary hover:text-fg-secondary font-medium disabled:opacity-50"
        >
          {signingOut ? "Signing out..." : "Sign out"}
        </button>
      </div>

      {error && (
        <div className="mb-6 bg-danger-subtle border border-border text-fg-danger rounded-lg px-4 py-3 text-sm">
          {error}
        </div>
      )}

      {books.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-10">
          {books.map((book, index) => {
            const accentColor = BOOK_COLORS[index % BOOK_COLORS.length];
            return (
              <div
                key={book.id}
                className="bg-surface rounded-lg border border-border shadow-soft p-6 hover:border-border-focus hover:shadow-md transition-all"
                style={{ borderLeftWidth: 3, borderLeftStyle: "solid", borderLeftColor: accentColor }}
              >
                <div className="flex items-start justify-between gap-3">
                  <Link href={`/b/${book.id}`} className="block flex-1 min-w-0">
                    <h2 className="text-lg font-semibold text-fg mb-2 truncate">
                      {book.name}
                    </h2>
                    <p className="text-xs text-fg-tertiary">
                      Created{" "}
                      {new Date(book.createdAt).toLocaleDateString(undefined, {
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                      })}
                    </p>
                  </Link>
                  <button
                    type="button"
                    onClick={() => openEditModal(book)}
                    className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-fg-secondary hover:bg-surface-tertiary transition-colors"
                    aria-label={`Edit ${book.name}`}
                  >
                    Edit
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {books.length === 0 && (
        <div className="text-center py-12 mb-10">
          <p className="text-fg-tertiary mb-2">
            You don&apos;t have any books yet.
          </p>
          <p className="text-sm text-fg-tertiary">
            Create one below to get started.
          </p>
        </div>
      )}

      <div className="rounded-lg border-2 border-dashed border-border p-6">
        <h2 className="text-lg font-semibold text-fg mb-4">
          Create a new book
        </h2>
        <form onSubmit={handleCreateBook} className="flex gap-3">
          <input
            type="text"
            value={newBookName}
            onChange={(e) => setNewBookName(e.target.value)}
            placeholder="Book name"
            className="flex-1 rounded-lg border border-border bg-surface-inset px-4 py-2 text-sm text-fg placeholder:text-fg-tertiary focus:outline-none focus:ring-2 focus:ring-border-focus focus:border-transparent"
            disabled={creating || creatingDemo}
          />
          <button
            type="submit"
            disabled={creating || creatingDemo || !newBookName.trim()}
            className="rounded-lg bg-accent px-5 py-2 text-sm font-medium text-fg-on-accent hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {creating ? "Creating..." : "Create"}
          </button>
        </form>

        <div className="mt-5 pt-5 border-t border-border flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-medium text-fg">Or explore with sample data</p>
            <p className="text-xs text-fg-tertiary mt-0.5">
              Three years of transactions, accounts, and investments. Takes a few seconds.
            </p>
          </div>
          <button
            type="button"
            onClick={handleCreateDemoBook}
            disabled={creating || creatingDemo}
            className="shrink-0 rounded-lg border border-border px-4 py-2 text-sm font-medium text-fg-secondary hover:bg-surface-tertiary disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {creatingDemo ? "Creating demo book..." : "Add demo book"}
          </button>
        </div>
      </div>

      <JobStatusTable />

      {/* ── Reported Issues ────────────────────── */}
      <div className="mt-10">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-fg">Reported Issues</h2>
          <label className="flex items-center gap-2 text-sm text-fg-secondary cursor-pointer">
            <input
              type="checkbox"
              checked={showAllIssues}
              onChange={(e) => setShowAllIssues(e.target.checked)}
              className="rounded border-border"
            />
            Show all
          </label>
        </div>

        {issuesLoading ? (
          <div className="animate-pulse space-y-3">
            {[1, 2].map((i) => (
              <div key={i} className="h-16 bg-surface-tertiary rounded-lg" />
            ))}
          </div>
        ) : filteredIssues.length === 0 ? (
          <p className="text-sm text-fg-tertiary py-4">
            {showAllIssues ? "No reported issues." : "No new issues."}
          </p>
        ) : (
          <div className="space-y-2">
            {filteredIssues.map((issue) => (
              <div
                key={issue.id}
                className="bg-surface rounded-lg border border-border p-4 flex items-start justify-between gap-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                      issue.status === "new"
                        ? "bg-warning-subtle text-fg-warning"
                        : issue.status === "resolved"
                          ? "bg-success-subtle text-fg-success"
                          : "bg-surface-tertiary text-fg-tertiary"
                    }`}>
                      {issue.status}
                    </span>
                    <span className="text-xs text-fg-tertiary">
                      {issue.type}
                    </span>
                    <span className="text-xs text-fg-tertiary">
                      {new Date(issue.createdAt).toLocaleDateString(undefined, {
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                      })}
                    </span>
                  </div>
                  <p className="text-sm text-fg truncate">{issue.description}</p>
                  <p className="text-xs text-fg-tertiary mt-0.5">{issue.page}</p>
                </div>
                <button
                  type="button"
                  onClick={() => openEditIssueModal(issue)}
                  className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-fg-secondary hover:bg-surface-tertiary transition-colors"
                >
                  Edit
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <Modal
        isOpen={Boolean(editingBook)}
        onClose={closeEditModal}
        title="Edit Book"
        size="sm"
      >
        <form onSubmit={handleRenameBook} className="space-y-4">
          <Input
            id="edit-book-name"
            label="Book name"
            type="text"
            value={editingBookName}
            onChange={(e) => setEditingBookName(e.target.value)}
            disabled={savingBook || deletingBook}
          />

          <div className="rounded-lg border border-border bg-danger-subtle p-3">
            <p className="text-sm font-semibold text-fg-danger mb-1">Danger zone</p>
            <p className="text-xs text-fg-danger mb-3">
              Deleting this book permanently removes its transactions, accounts, and all
              related data. This action cannot be undone.
            </p>

            {!showDeleteConfirmation ? (
              <button
                type="button"
                onClick={handleDeleteBook}
                disabled={savingBook || deletingBook}
                className="rounded-lg border border-border bg-surface px-3 py-2 text-sm font-medium text-fg-danger hover:bg-danger-subtle disabled:opacity-50"
              >
                Delete book...
              </button>
            ) : (
              <div className="space-y-2">
                <p className="text-xs font-medium text-fg-danger">
                  Final confirmation required: this cannot be undone.
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={handleDeleteBook}
                    disabled={savingBook || deletingBook}
                    className="rounded-lg bg-danger px-3 py-2 text-sm font-medium text-fg-on-accent hover:bg-danger disabled:opacity-50"
                  >
                    {deletingBook ? "Deleting..." : "Yes, permanently delete"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowDeleteConfirmation(false)}
                    disabled={savingBook || deletingBook}
                    className="rounded-lg border border-border px-3 py-2 text-sm font-medium text-fg-secondary hover:bg-surface-tertiary disabled:opacity-50"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => closeEditModal()}
              disabled={savingBook || deletingBook}
              className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-fg-secondary hover:bg-surface-tertiary disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={savingBook || deletingBook || !editingBookName.trim()}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-fg-on-accent hover:bg-accent-hover disabled:opacity-50"
            >
              {savingBook ? "Saving..." : "Save"}
            </button>
          </div>
        </form>
      </Modal>

      <Modal
        isOpen={Boolean(editingIssue)}
        onClose={closeEditIssueModal}
        title="Edit Issue Report"
        size="sm"
      >
        <form onSubmit={handleSaveIssue} className="space-y-4">
          <div>
            <label htmlFor="edit-issue-description" className="block text-sm font-medium text-fg mb-1">
              Description
            </label>
            <textarea
              id="edit-issue-description"
              value={editingIssueDescription}
              onChange={(e) => setEditingIssueDescription(e.target.value)}
              disabled={savingIssue || deletingIssue}
              rows={3}
              className="w-full rounded-lg border border-border bg-surface-inset px-3 py-2 text-sm text-fg placeholder:text-fg-tertiary focus:outline-none focus:ring-2 focus:ring-border-focus focus:border-transparent resize-y"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="edit-issue-type" className="block text-sm font-medium text-fg mb-1">
                Type
              </label>
              <select
                id="edit-issue-type"
                value={editingIssueType}
                onChange={(e) => setEditingIssueType(e.target.value)}
                disabled={savingIssue || deletingIssue}
                className="w-full rounded-lg border border-border bg-surface-inset px-3 py-2 text-sm text-fg focus:outline-none focus:ring-2 focus:ring-border-focus focus:border-transparent"
              >
                <option value="bug">Bug</option>
                <option value="improvement">Improvement</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div>
              <label htmlFor="edit-issue-status" className="block text-sm font-medium text-fg mb-1">
                Status
              </label>
              <select
                id="edit-issue-status"
                value={editingIssueStatus}
                onChange={(e) => setEditingIssueStatus(e.target.value)}
                disabled={savingIssue || deletingIssue}
                className="w-full rounded-lg border border-border bg-surface-inset px-3 py-2 text-sm text-fg focus:outline-none focus:ring-2 focus:ring-border-focus focus:border-transparent"
              >
                <option value="new">New</option>
                <option value="resolved">Resolved</option>
                <option value="wontfix">Won&apos;t Fix</option>
              </select>
            </div>
          </div>

          <div className="flex items-center justify-between pt-2">
            <button
              type="button"
              onClick={handleDeleteIssue}
              disabled={savingIssue || deletingIssue}
              className="rounded-lg px-3 py-2 text-sm font-medium text-fg-danger hover:bg-danger-subtle disabled:opacity-50 transition-colors"
            >
              {deletingIssue ? "Deleting..." : "Delete"}
            </button>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => closeEditIssueModal()}
                disabled={savingIssue || deletingIssue}
                className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-fg-secondary hover:bg-surface-tertiary disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={savingIssue || deletingIssue || !editingIssueDescription.trim()}
                className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-fg-on-accent hover:bg-accent-hover disabled:opacity-50"
              >
                {savingIssue ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </form>
      </Modal>
    </div>
  );
}
