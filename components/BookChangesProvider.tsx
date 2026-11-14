"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import { useBookId } from "@/hooks/useBookId";
import { ACCESS_REDIRECT, accessExpired, renewAccessSession } from "@/lib/access-session";
import { BOOK_SESSION_ENDED_EVENT } from "@/lib/events";
import type { BookChange } from "@/lib/book-change-hub";

type Subscribe = (callback: (change: BookChange) => void) => () => void;
type BookChanges = { subscribe: Subscribe; live: () => boolean };
const BookChangesContext = createContext<BookChanges | null>(null);

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
  const liveRef = useRef(false);
  const live = useCallback(() => liveRef.current, []);
  const changes = useMemo(() => ({ subscribe, live }), [subscribe, live]);

  useEffect(() => {
    if (!bookId) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reset = false;
    const tables = new Set<string>();
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
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
    let opened = false;
    function received(event: MessageEvent) {
      try {
        const data: unknown = JSON.parse(String(event.data));
        if (!data || typeof data !== "object" || !("type" in data)) return;
        if (data.type === "ready") {
          opened = true;
          liveRef.current = true;
          failures = 0;
          catchUp();
          return;
        }
        if (data.type !== "change" || !("tables" in data) || !Array.isArray(data.tables) ||
            !data.tables.every((table) => typeof table === "string")) return;
        invalidate({ type: "change", tables: data.tables });
      } catch { /* A malformed hint must not break the subscription. */ }
    }
    const path = `/api/b/${bookId}/socket`;
    // A server that restarts or a network that drops: try again, at most
    // every 30 seconds, with jitter so that tabs spread out.
    function later() {
      const delay = Math.min(30_000, 1000 * 2 ** failures) * (0.5 + Math.random() / 2);
      failures++;
      retry = setTimeout(connect, delay);
    }
    // A browser reports a refused handshake as a close with code 1006, not
    // as its HTTP status. The same request without the upgrade gets the
    // status: 400 when the credential reads the book, else 401, 403 or 404.
    // A probe that does not answer in 10 seconds counts as no refusal, so the
    // retry follows.
    let probe: { abort: AbortController; limit: ReturnType<typeof setTimeout> } | undefined;
    async function refused() {
      const abort = new AbortController();
      const current = { abort, limit: setTimeout(() => abort.abort(), 10_000) };
      probe = current;
      try {
        const response = await fetch(path, { signal: abort.signal, redirect: ACCESS_REDIRECT });
        // Cloudflare Access refused the upgrade: the reload renews its
        // token, and no retry would get past Access before it.
        if (accessExpired(response)) {
          renewAccessSession();
          return true;
        }
        return [401, 403, 404].includes(response.status);
      } catch {
        return false;
      } finally {
        clearTimeout(current.limit);
        if (probe === current) probe = undefined;
      }
    }
    function connect() {
      retry = undefined;
      if (!active || socket || typeof WebSocket === "undefined") return;
      const url = new URL(path, window.location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const current = new WebSocket(url);
      socket = current;
      opened = false;
      current.addEventListener("message", received);
      current.addEventListener("close", (event) => {
        if (socket !== current) return;
        socket = null;
        liveRef.current = false;
        // 4000 + the HTTP status: the credential no longer reads the book.
        // Another try gets the same answer, and the next request of the page
        // ends the session or leaves the book.
        if (!active || (event.code >= 4400 && event.code < 4500)) return;
        if (opened) {
          later();
          return;
        }
        void refused().then((stop) => { if (active && !stop) later(); });
      });
    }
    // A tab that comes back reconnects at once rather than at its next try.
    const resume = () => {
      if (retry === undefined) return;
      clearTimeout(retry);
      connect();
    };
    const focused = () => { catchUp(); resume(); };
    const visible = () => { if (document.visibilityState === "visible") focused(); };
    function stop() {
      active = false;
      clearTimeout(timer);
      clearTimeout(retry);
      if (probe) { clearTimeout(probe.limit); probe.abort.abort(); }
      socket?.close();
      socket = null;
      liveRef.current = false;
    }
    connect();
    window.addEventListener("focus", focused);
    document.addEventListener("visibilitychange", visible);
    window.addEventListener(BOOK_SESSION_ENDED_EVENT, stop);
    return () => {
      stop();
      window.removeEventListener("focus", focused);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener(BOOK_SESSION_ENDED_EVENT, stop);
    };
  }, [bookId]);

  return <BookChangesContext.Provider value={changes}>{children}</BookChangesContext.Provider>;
}

/** Callback changes do not reconnect the shared socket. Outside a book layout
 * there is no subscription (isolated component tests and non-book surfaces). */
export function useBookChanges(onChange: (change: BookChange) => void) {
  const subscribe = useContext(BookChangesContext)?.subscribe;
  const callback = useRef(onChange);
  useEffect(() => { callback.current = onChange; }, [onChange]);
  useEffect(() => subscribe?.((change) => callback.current(change)), [subscribe]);
}

const notLive = () => false;

/** Whether the book's socket is open, so that a change to a table it
 * watches reaches `useBookChanges`. A poll for data that only such tables
 * hold can skip its turn while it is: each new socket's readiness, and each
 * focus, sends a reset that catches up on the gap. False outside a book
 * layout. */
export function useBookChangesLive(): () => boolean {
  return useContext(BookChangesContext)?.live ?? notLive;
}


/** Calls `reload` when another client changes one of `tables`, and on each
 * reset (a new socket, or a return to the tab), since a reset can hide any
 * change. While `paused` is true (for example, while an editor is open), a
 * matching change is kept, and `reload` runs one time when `paused` becomes
 * false. `tables` and `reload` can change on each render. `reload` must keep the
 * data on the screen and must not replace a form that the user edits. */
export function useLiveReload(
  tables: Iterable<string>,
  reload: () => void,
  options: { paused?: boolean } = {},
) {
  const paused = options.paused ?? false;
  const state = useRef({ tables: new Set<string>(), reload, paused, missed: false });
  useEffect(() => {
    state.current.tables = new Set(tables);
    state.current.reload = reload;
  });
  useBookChanges((change) => {
    const current = state.current;
    if (change.type !== "reset" && !change.tables.some((table) => current.tables.has(table))) return;
    if (current.paused) { current.missed = true; return; }
    current.reload();
  });
  useEffect(() => {
    const current = state.current;
    current.paused = paused;
    if (paused || !current.missed) return;
    current.missed = false;
    current.reload();
  }, [paused]);
}
