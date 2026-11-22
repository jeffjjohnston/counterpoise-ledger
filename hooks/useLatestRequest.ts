import { useCallback, useMemo, useRef } from "react";

/**
 * A live update can start a reload while another reload is in flight, and the
 * answers can arrive in either order. Call the returned function at the start
 * of each request. It gives a check that is true only while no later request
 * has started, so that only the latest answer goes on the screen.
 */
export function useLatestRequest(): () => () => boolean {
  const latest = useRef(0);
  return useCallback(() => {
    const request = ++latest.current;
    return () => request === latest.current;
  }, []);
}

/**
 * Tells whether a reload of a list with "load more" is in flight. A "load
 * more" that starts during a reload asks for rows after the old list, and its
 * rows do not fit on the end of the new list. Call `begin()` at the start of
 * each reload and the returned function when it ends. `settled()` gives null
 * when no reload is in flight, else a promise that resolves when all the
 * reloads in flight have ended.
 *
 * Reloads can overlap, and the newer one can end first. The promise is thus
 * one promise for the full busy time, not one for each reload: a promise that
 * was already resolved while a reload was in flight would let a caller that
 * waits in a loop spin with no end.
 */
export function useReloadsInFlight() {
  const state = useRef({
    count: 0,
    settled: null as Promise<void> | null,
    finish: () => {},
  });
  const begin = useCallback(() => {
    const current = state.current;
    if (current.count === 0) {
      current.settled = new Promise<void>((resolve) => { current.finish = resolve; });
    }
    current.count++;
    let open = true;
    return () => {
      if (!open) return;
      open = false;
      current.count--;
      if (current.count > 0) return;
      current.settled = null;
      current.finish();
    };
  }, []);
  const settled = useCallback(() => state.current.settled, []);
  // One object for the life of the component, so that a callback that
  // depends on it does not change on each render.
  return useMemo(() => ({ begin, settled }), [begin, settled]);
}
