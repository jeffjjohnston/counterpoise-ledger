// Browser notifications carry only a book ID, never transaction data or secrets.
export const TYPESAFE_SETTINGS_CHANGED = "typesafe-settings-changed";
export function notifyTypeSafeSettings(bookId: string) {
  window.dispatchEvent(
    new CustomEvent(TYPESAFE_SETTINGS_CHANGED, { detail: bookId }),
  );
  if (typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel(TYPESAFE_SETTINGS_CHANGED);
    channel.postMessage(bookId);
    channel.close();
  }
}
export function subscribeTypeSafeSettings(
  bookId: string,
  invalidate: () => void,
) {
  const local = (event: Event) => {
    if ((event as CustomEvent).detail === bookId) invalidate();
  };
  window.addEventListener(TYPESAFE_SETTINGS_CHANGED, local);
  const channel =
    typeof BroadcastChannel === "undefined"
      ? null
      : new BroadcastChannel(TYPESAFE_SETTINGS_CHANGED);
  if (channel)
    channel.onmessage = (event) => {
      if (event.data === bookId) invalidate();
    };
  return () => {
    window.removeEventListener(TYPESAFE_SETTINGS_CHANGED, local);
    channel?.close();
  };
}
