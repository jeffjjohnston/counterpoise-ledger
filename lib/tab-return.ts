/** The time in which the events of one return to the tab make one call. */
export const TAB_RETURN_MS = 100;

/**
 * Calls `callback` when the user comes back to the tab. One return fires
 * both `focus` and `visibilitychange`, and each started a load of its own,
 * so the events within `TAB_RETURN_MS` make one call. Returns the function
 * that removes the listeners.
 */
export function onTabReturn(callback: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const returned = () => {
    if (document.visibilityState !== "visible") return;
    timer ??= setTimeout(() => {
      timer = undefined;
      callback();
    }, TAB_RETURN_MS);
  };
  window.addEventListener("focus", returned);
  document.addEventListener("visibilitychange", returned);
  return () => {
    clearTimeout(timer);
    window.removeEventListener("focus", returned);
    document.removeEventListener("visibilitychange", returned);
  };
}
