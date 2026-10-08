import { type RefObject, useEffect } from "react";

/**
 * While `open` is true, calls `close` on a pointer down outside `ref`
 * and on the Escape key. A touch device sends no mouse leave event,
 * so a tooltip that a tap opens needs this to close.
 */
export function useDismissOutside(ref: RefObject<HTMLElement | null>, open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!ref.current?.contains(event.target as Node)) close();
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") close();
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [ref, open, close]);
}
