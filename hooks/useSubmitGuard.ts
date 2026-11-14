import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Lets one save run at a time. `begin()` returns false while a save is in
 * flight; the caller then drops the submit. `end()` lets the next save
 * start. `saving` is for the submit button.
 *
 * The check uses a ref, not the state: two submits can arrive before React
 * renders the state that the first one set.
 *
 * A form disables its fields while `saving` is true, so that it takes no
 * input that the save would not send. A browser takes the focus away from
 * a field that becomes disabled. The hook records the element that has the
 * focus when the save starts, and gives the focus back when the save ends.
 * A form that moves the focus after a success does that in a later effect.
 */
export function useSubmitGuard() {
  const inFlight = useRef(false);
  const [saving, setSaving] = useState(false);
  const focusedAtStart = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (saving) return;
    const element = focusedAtStart.current;
    focusedAtStart.current = null;
    // Only when the focus is nowhere: the user can have moved it to a
    // control that stayed enabled.
    const lost = document.activeElement === null || document.activeElement === document.body;
    if (element?.isConnected && lost) element.focus();
  }, [saving]);

  const begin = useCallback(() => {
    if (inFlight.current) return false;
    inFlight.current = true;
    focusedAtStart.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSaving(true);
    return true;
  }, []);

  const end = useCallback(() => {
    inFlight.current = false;
    setSaving(false);
  }, []);

  /** Runs `save` and waits for it, unless a save is in flight. */
  const run = useCallback(
    async (save: () => unknown) => {
      if (!begin()) return;
      try {
        await save();
      } finally {
        end();
      }
    },
    [begin, end]
  );

  return { saving, begin, end, run };
}
