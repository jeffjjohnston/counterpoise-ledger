"use client";

import { createContext, useCallback, useContext, useEffect, useRef, type ReactNode } from "react";
import { useBookId } from "@/hooks/useBookId";
import { BOOK_SESSION_ENDED_EVENT } from "@/lib/events";
import type { BookChange } from "@/lib/book-change-hub";

type Subscribe = (callback: (change: BookChange) => void) => () => void;
const BookChangesContext = createContext<Subscribe | null>(null);

export function BookChangesProvider({ children }: { children: ReactNode }) {
  const bookId = useBookId();
  return <BookChangesScope key={bookId} bookId={bookId}>{children}</BookChangesScope>;
}

function BookChangesScope({ bookId, children }: { bookId: string; children: ReactNode }) {
  const listenersRef = useRef(new Set<(change: BookChange) => void>());
  const subscribe = useCallback<Subscribe>((callback) => {
    const listeners = listenersRef.current;
    listeners.add(callback);
    return () => { listeners.delete(callback); };
  }, []);

  useEffect(() => {
    if (!bookId) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reset = false;
    const tables = new Set<string>();
    const source = typeof EventSource === "undefined" ? null : new EventSource(`/api/b/${bookId}/events`);
    function invalidate(change: BookChange) {
      if (!active) return;
      reset ||= change.type === "reset";
      for (const table of change.tables) tables.add(table);
      timer ??= setTimeout(() => {
        timer = undefined;
        const event: BookChange = { type: reset ? "reset" : "change", tables: [...tables] };
        reset = false; tables.clear();
        for (const callback of listenersRef.current) callback(event);
      }, 100);
    }
    const catchUp = () => invalidate({ type: "reset", tables: [] });
    const changed = (event: MessageEvent) => {
      try {
        const data: unknown = JSON.parse(event.data);
        if (!data || typeof data !== "object" || !("tables" in data) || !Array.isArray(data.tables) ||
            !data.tables.every((table) => typeof table === "string")) return;
        invalidate({ type: "change", tables: data.tables });
      } catch { /* A malformed hint must not break the subscription. */ }
    };
    const visible = () => { if (document.visibilityState === "visible") catchUp(); };
    function stop() { active = false; clearTimeout(timer); source?.close(); }
    source?.addEventListener("ready", catchUp);
    source?.addEventListener("reset", catchUp);
    source?.addEventListener("change", changed);
    window.addEventListener("focus", catchUp);
    document.addEventListener("visibilitychange", visible);
    window.addEventListener(BOOK_SESSION_ENDED_EVENT, stop);
    return () => {
      stop();
      window.removeEventListener("focus", catchUp);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener(BOOK_SESSION_ENDED_EVENT, stop);
    };
  }, [bookId]);

  return <BookChangesContext.Provider value={subscribe}>{children}</BookChangesContext.Provider>;
}

/** Callback changes do not reconnect the shared stream. Outside a book layout
 * there is no subscription (isolated component tests and non-book surfaces). */
export function useBookChanges(onChange: (change: BookChange) => void) {
  const subscribe = useContext(BookChangesContext);
  const callback = useRef(onChange);
  useEffect(() => { callback.current = onChange; }, [onChange]);
  useEffect(() => subscribe?.((change) => callback.current(change)), [subscribe]);
}
