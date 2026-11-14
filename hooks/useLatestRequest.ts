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
 * when no reload is in flight, else a promise that resolves when the last
 * reload ends.
 */
export function useReloadsInFlight() {
  const state = useRef({ count: 0, settled: null as Promise<void> | null });
  const begin = useCallback(() => {
    const current = state.current;
    current.count++;
    let finish = () => {};
    const settled = new Promise<void>((resolve) => { finish = resolve; });
    current.settled = settled;
    let open = true;
    return () => {
      if (!open) return;
      open = false;
      current.count--;
      if (current.count === 0) current.settled = null;
      finish();
    };
  }, []);
  const settled = useCallback(() => state.current.settled, []);
  // One object for the life of the component, so that a callback that
  // depends on it does not change on each render.
  return useMemo(() => ({ begin, settled }), [begin, settled]);
}
