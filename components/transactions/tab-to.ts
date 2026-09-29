import type { KeyboardEvent, RefObject } from "react";

/**
 * For the last field of a quick-entry row: a plain Tab moves the focus to
 * `target`, which is the row's submit button. Call it from the field's
 * onKeyDown handler. It reads the ref only when the key event occurs.
 *
 * The browser does not always do this. On macOS, Safari and Firefox keep
 * buttons out of the tab order unless Full Keyboard Access is on, so Tab from
 * the last field skips the submit button and leaves the row. In journal mode a
 * "+ Add Line" button also sits between the last field and the submit button.
 * Shift+Tab and the modified forms stay with the browser.
 */
export function tabTo(e: KeyboardEvent, target: RefObject<HTMLElement | null>) {
  if (e.key !== "Tab" || e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) return;
  const element = target.current;
  if (!element) return;
  e.preventDefault();
  element.focus();
}
