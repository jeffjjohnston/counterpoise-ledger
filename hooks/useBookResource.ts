"use client";

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useLiveReload } from "@/components/BookChangesProvider";
import { useToast } from "@/components/ui/ToastProvider";

export interface BookResourceOptions<T> {
  /** The data before the first answer. */
  initial: T;
  /**
   * Gets the data. Give it a stable identity (`useCallback`): a new function
   * means a new resource (another book, another filter), and the hook loads
   * again.
   */
  load: () => Promise<T>;
  /** The tables whose changes by another client make the data old. */
  tables: Iterable<string>;
  /** Shown in place of the page when no data of this resource is on the screen. */
  loadError: string;
  /** Shown as a toast when a reload fails and the data on the screen stays. */
  refreshError: string;
  /** While true (an editor is open), a live change waits. */
  paused?: boolean;
}

export interface BookResource<T> {
  data: T;
  /** For a change that the page makes itself, between two loads. */
  setData: Dispatch<SetStateAction<T>>;
  /** True until the first answer, good or bad. */
  loading: boolean;
  /** The load error, or null. A failed reload does not set it. */
  error: string | null;
  /** Loads again and keeps the data on the screen meanwhile. It does not reject. */
  reload: () => Promise<void>;
}

/**
 * The data of one page of a book: the first load, the reload after a change
 * by this page or by another client, and the two ways to fail.
 *
 * - **Only the latest request shows its answer.** A live change can start a
 *   reload while another is in flight, and the answers can arrive in either
 *   order.
 * - **The first answer, not the first request, decides the kind of error.**
 *   While no data of this resource is on the screen, a failure is `error`,
 *   for a full-page message. After that, a failure is a toast, and the data
 *   stays: it is still correct.
 * - **A reload does not show the loading state.** The search text, the sort
 *   order and the scroll position of the page stay as they are.
 */
export function useBookResource<T>(options: BookResourceOptions<T>): BookResource<T> {
  const { initial, load, tables, loadError, refreshError, paused = false } = options;
  const [data, setData] = useState<T>(initial);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  // Refs hold what a caller can give with a new identity on each render. If
  // `request` depended on them, each render would start a new load.
  const current = useRef({ toast, loadError, refreshError });
  useEffect(() => {
    current.current = { toast, loadError, refreshError };
  });
  const latest = useRef(0);
  // Whether data of this resource is on the screen.
  const shown = useRef(false);

  const request = useCallback(async () => {
    const mine = ++latest.current;
    try {
      const answer = await load();
      if (mine !== latest.current) return;
      setData(answer);
      setError(null);
      shown.current = true;
      setLoading(false);
    } catch {
      if (mine !== latest.current) return;
      if (shown.current) {
        current.current.toast.error(current.current.refreshError);
      } else {
        setError(current.current.loadError);
        setLoading(false);
      }
    }
  }, [load]);

  useEffect(() => {
    shown.current = false;
    void request();
  }, [request]);

  useLiveReload(tables, () => void request(), { paused });

  return { data, setData, loading, error, reload: request };
}
