"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useBookChanges } from "@/components/BookChangesProvider";
import { useToast } from "@/components/ui/ToastProvider";
import { useBookId } from "@/hooks/useBookId";
import { apiGet } from "@/lib/api-client";
import { roleSatisfies, type BookRole } from "@/lib/book-roles";

export type BookSummary = { id: number; name: string; upcomingDays: number; userId: number; role?: BookRole };
export type BookMemberSummary = { userId: number; username: string; role: BookRole; createdAt: string };

/**
 * The state of the role load. `loading` is before the first answer. `error`
 * is after the last load failed. In both, the role is the least privilege.
 */
export type BookRoleStatus = "loading" | "ready" | "error";

export type BookRoleValue = {
  books: BookSummary[];
  currentBook: BookSummary | null;
  currentUserId: number | null;
  role: BookRole;
  status: BookRoleStatus;
  canWrite: boolean;
  isOwner: boolean;
  members: BookMemberSummary[];
  refresh: () => void;
};

// Outside a book layout (isolated component tests, non-book pages) the hook
// gives owner access. This decides only which controls show. The server
// enforces every level.
const OUTSIDE_PROVIDER: BookRoleValue = {
  books: [], currentBook: null, currentUserId: null, role: "owner", status: "ready",
  canWrite: true, isOwner: true, members: [], refresh: () => {},
};

const BookRoleContext = createContext<BookRoleValue>(OUTSIDE_PROVIDER);

export function BookRoleProvider({ children }: { children: ReactNode }) {
  const bookId = useBookId();
  const [books, setBooks] = useState<BookSummary[]>([]);
  const [members, setMembers] = useState<BookMemberSummary[]>([]);
  const [currentUserId, setCurrentUserId] = useState<number | null>(null);
  const [status, setStatus] = useState<BookRoleStatus>("loading");
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  const toast = useToast();

  useEffect(() => {
    let active = true;
    // A failed load shows an error toast, as a failed page load does. It
    // does not give access: the role becomes the least privilege until a
    // load succeeds. A refresh keeps the last role while it runs, so the
    // controls do not flicker on each change event.
    let membersErrorShown = false;
    const membersFailed = () => {
      if (!active || membersErrorShown) return;
      membersErrorShown = true;
      toast.error("Could not load the members of this book.");
    };
    apiGet<BookSummary[]>("/api/books")
      .then((d) => { if (active) { setBooks(d); setStatus("ready"); } })
      .catch(() => {
        if (!active) return;
        setStatus("error");
        toast.error("Could not load your role in this book. The controls that change data stay hidden.");
      });
    apiGet<BookMemberSummary[]>(`/api/books/${bookId}/members`)
      .then((d) => { if (active) setMembers(d); })
      .catch(membersFailed);
    apiGet<{ id: number }>("/api/auth/me")
      .then((d) => { if (active) setCurrentUserId(d.id); })
      .catch(membersFailed);
    return () => { active = false; };
  }, [bookId, version, toast]);

  useBookChanges((change) => {
    if (change.type === "reset" || change.tables.includes("books") || change.tables.includes("book_members")) {
      refresh();
    }
  });

  const value = useMemo<BookRoleValue>(() => {
    const currentBook = books.find((b) => b.id === Number(bookId)) ?? null;
    // Until the role is known, use the least privilege. Controls that change
    // data show only after a successful load. The server enforces every
    // level, so this decides only which controls show.
    const role: BookRole = status === "ready" ? currentBook?.role ?? "viewer" : "viewer";
    return {
      books, currentBook, currentUserId, role, status,
      canWrite: roleSatisfies(role, "write"), isOwner: role === "owner",
      members, refresh,
    };
  }, [books, bookId, currentUserId, members, refresh, status]);

  return <BookRoleContext.Provider value={value}>{children}</BookRoleContext.Provider>;
}

export function useBookRole(): BookRoleValue {
  return useContext(BookRoleContext);
}
