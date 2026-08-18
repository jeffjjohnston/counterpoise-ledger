import { useEffect } from "react";
import {
  useKeyboardShortcuts,
  type ShortcutDef,
} from "@/components/KeyboardShortcutProvider";

/**
 * Register page-specific keyboard shortcuts.
 * Automatically unregisters when the component unmounts or shortcuts change.
 */
export function useRegisterShortcuts(shortcuts: ShortcutDef[]) {
  const { registerShortcuts } = useKeyboardShortcuts();

  useEffect(() => {
    if (shortcuts.length === 0) return;
    const unregister = registerShortcuts(shortcuts);
    return unregister;
  }, [shortcuts, registerShortcuts]);
}
