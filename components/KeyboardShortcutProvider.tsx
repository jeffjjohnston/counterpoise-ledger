"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
} from "react";
import { useRouter, useParams } from "next/navigation";

/**
 * Every category a shortcut may be registered under, in the order the `?`
 * overlay lists them.
 *
 * One list, read by both sides on purpose. The overlay used to keep its own
 * ordering array and *filter* through it, so a category registered here but
 * missing there lost its shortcuts with no error — which is why the price
 * entry pill's P never appeared in the overlay. Because `category` is typed
 * from this list, a new one is now a compile error until it is added here,
 * and adding it here is what puts it in the overlay.
 */
export const SHORTCUT_CATEGORIES = [
  "General",
  "Navigation",
  "Page",
  "Transactions",
  "Sync",
] as const;

export type ShortcutCategory = (typeof SHORTCUT_CATEGORIES)[number];

export type ShortcutDef = {
  id: string;
  keys: string[];
  description: string;
  category: ShortcutCategory;
  action: () => void;
};

type KeyboardShortcutContextValue = {
  isOverlayOpen: boolean;
  setOverlayOpen: (open: boolean) => void;
  registerShortcuts: (shortcuts: ShortcutDef[]) => () => void;
  allShortcuts: ShortcutDef[];
  pendingPrefix: string | null;
};

const KeyboardShortcutContext = createContext<KeyboardShortcutContextValue>({
  isOverlayOpen: false,
  setOverlayOpen: () => {},
  registerShortcuts: () => () => {},
  allShortcuts: [],
  pendingPrefix: null,
});

export function useKeyboardShortcuts() {
  return useContext(KeyboardShortcutContext);
}

function isTypingInField(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = (el as HTMLElement).tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if ((el as HTMLElement).isContentEditable) return true;
  return false;
}

// Enter and Space are how a keyboard activates the control it is focused on.
const ACTIVATION_KEYS = new Set(["Enter", " ", "Spacebar"]);

const ACTIVATABLE_TAGS = new Set(["BUTTON", "A", "SUMMARY", "OPTION"]);
const ACTIVATABLE_ROLES = new Set([
  "button",
  "link",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "tab",
  "checkbox",
  "radio",
  "switch",
]);

/**
 * Is focus on something the browser itself would activate?
 *
 * The listener below runs on the capture phase and calls preventDefault(), so a
 * shortcut bound to Enter or Space suppresses the native activation of a
 * focused button or link. A keyboard user who tabs to Ignore in the
 * reconciliation queue and presses Enter would get the shortcut instead of
 * Ignore — matching a transaction they did not choose. Only the activation keys
 * consult this; every other key has no default action on these elements, so a
 * letter or arrow shortcut still works with a button focused.
 */
function isFocusOnActivatableElement(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  if (ACTIVATABLE_TAGS.has(el.tagName)) return true;
  const role = el.getAttribute("role");
  return role !== null && ACTIVATABLE_ROLES.has(role);
}

function PrefixIndicator({ prefix }: { prefix: string }) {
  return (
    <div className="fixed bottom-6 right-6 z-[70] bg-surface-elevated border border-border rounded-lg shadow-lg px-3 py-2 text-sm text-fg-secondary animate-modal-enter">
      <kbd className="inline-flex items-center justify-center min-w-[1.5rem] h-6 px-1.5 font-mono text-xs font-semibold bg-surface-tertiary border border-border rounded text-fg">
        {prefix}
      </kbd>
      <span className="ml-1.5 text-fg-tertiary">...</span>
    </div>
  );
}

export function KeyboardShortcutProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const params = useParams();
  const bookId = params.bookId as string;
  const router = useRouter();
  const routerRef = useRef(router);
  routerRef.current = router;

  const [isOverlayOpen, setIsOverlayOpen] = useState(false);
  const isOverlayOpenRef = useRef(false);

  const [pendingPrefix, setPendingPrefix] = useState<string | null>(null);
  const pendingPrefixRef = useRef<string | null>(null);
  const pendingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const pageShortcutsRef = useRef<Map<string, ShortcutDef>>(new Map());
  const [pageShortcutsVersion, setPageShortcutsVersion] = useState(0);

  // Keep overlay ref in sync
  useEffect(() => {
    isOverlayOpenRef.current = isOverlayOpen;
  }, [isOverlayOpen]);

  const clearPendingPrefix = useCallback(() => {
    if (pendingTimeoutRef.current) {
      clearTimeout(pendingTimeoutRef.current);
      pendingTimeoutRef.current = null;
    }
    pendingPrefixRef.current = null;
    setPendingPrefix(null);
  }, []);

  const setOverlayOpen = useCallback((open: boolean) => {
    setIsOverlayOpen(open);
    isOverlayOpenRef.current = open;
  }, []);

  const toggleOverlay = useCallback(() => {
    const next = !isOverlayOpenRef.current;
    setIsOverlayOpen(next);
    isOverlayOpenRef.current = next;
  }, []);
  const toggleOverlayRef = useRef(toggleOverlay);
  toggleOverlayRef.current = toggleOverlay;

  const prefix = `/b/${bookId}`;

  const globalShortcuts: ShortcutDef[] = useMemo(
    () => [
      {
        id: "nav-dashboard",
        keys: ["g", "d"],
        description: "Go to Dashboard",
        category: "Navigation",
        action: () => routerRef.current.push(prefix),
      },
      {
        id: "nav-transactions",
        keys: ["g", "t"],
        description: "Go to Transactions",
        category: "Navigation",
        action: () => routerRef.current.push(`${prefix}/transactions`),
      },
      {
        id: "nav-accounts",
        keys: ["g", "a"],
        description: "Go to Accounts",
        category: "Navigation",
        action: () => routerRef.current.push(`${prefix}/accounts`),
      },
      {
        id: "nav-recurring",
        keys: ["g", "r"],
        description: "Go to Recurring",
        category: "Navigation",
        action: () => routerRef.current.push(`${prefix}/recurring`),
      },
      {
        id: "nav-income-statement",
        keys: ["g", "i"],
        description: "Go to Income Statement",
        category: "Navigation",
        action: () =>
          routerRef.current.push(`${prefix}/reports/income-statement`),
      },
      {
        id: "nav-payees",
        keys: ["g", "p"],
        description: "Go to Payees",
        category: "Navigation",
        action: () => routerRef.current.push(`${prefix}/payees`),
      },
      {
        id: "nav-securities",
        keys: ["g", "s"],
        description: "Go to Securities",
        category: "Navigation",
        action: () => routerRef.current.push(`${prefix}/securities`),
      },
      {
        id: "nav-search",
        keys: ["/"],
        description: "Search",
        category: "Navigation",
        action: () => routerRef.current.push(`${prefix}/search`),
      },
      {
        id: "show-shortcuts",
        keys: ["?"],
        description: "Show keyboard shortcuts",
        category: "General",
        action: () => toggleOverlayRef.current(),
      },
    ],
    [prefix]
  );

  const globalShortcutsRef = useRef(globalShortcuts);
  globalShortcutsRef.current = globalShortcuts;

  const registerShortcuts = useCallback((shortcuts: ShortcutDef[]) => {
    for (const s of shortcuts) {
      pageShortcutsRef.current.set(s.id, s);
    }
    setPageShortcutsVersion((v) => v + 1);

    return () => {
      for (const s of shortcuts) {
        pageShortcutsRef.current.delete(s.id);
      }
      setPageShortcutsVersion((v) => v + 1);
    };
  }, []);

  const allShortcuts = useMemo(
    () => [
      ...globalShortcuts,
      ...Array.from(pageShortcutsRef.current.values()),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [globalShortcuts, pageShortcutsVersion]
  );

  // Global keydown listener
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (isTypingInField()) {
        clearPendingPrefix();
        return;
      }

      // When overlay is open, only handle Escape and ? to close
      if (isOverlayOpenRef.current) {
        if (e.key === "Escape" || e.key === "?") {
          e.preventDefault();
          e.stopImmediatePropagation();
          setIsOverlayOpen(false);
          isOverlayOpenRef.current = false;
          clearPendingPrefix();
        }
        return;
      }

      // Don't handle keys with Ctrl/Cmd/Alt modifiers
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      // Never take Enter or Space away from the control the user has focused.
      if (ACTIVATION_KEYS.has(e.key) && isFocusOnActivatableElement()) return;

      // Normalize single letters to lowercase so Caps Lock / Shift don't break matching
      const key = e.key.length === 1 && e.key >= "A" && e.key <= "Z"
        ? e.key.toLowerCase()
        : e.key;

      // Handle pending two-key sequences
      if (pendingPrefixRef.current) {
        const pfx = pendingPrefixRef.current;
        clearPendingPrefix();

        const allDefs = [
          ...globalShortcutsRef.current,
          ...Array.from(pageShortcutsRef.current.values()),
        ];
        const match = allDefs.find(
          (s) => s.keys.length === 2 && s.keys[0] === pfx && s.keys[1] === key
        );
        if (match) {
          e.preventDefault();
          match.action();
        }
        return;
      }

      // Check if this key starts a two-key sequence
      const allDefs = [
        ...globalShortcutsRef.current,
        ...Array.from(pageShortcutsRef.current.values()),
      ];
      const hasSequenceStartingWith = allDefs.some(
        (s) => s.keys.length === 2 && s.keys[0] === key
      );
      if (hasSequenceStartingWith) {
        e.preventDefault();
        pendingPrefixRef.current = key;
        setPendingPrefix(key);
        pendingTimeoutRef.current = setTimeout(() => {
          pendingPrefixRef.current = null;
          setPendingPrefix(null);
        }, 1500);
        return;
      }

      // Check single-key shortcuts
      const singleMatch = allDefs.find(
        (s) => s.keys.length === 1 && s.keys[0] === key
      );
      if (singleMatch) {
        e.preventDefault();
        singleMatch.action();
      }
    };

    document.addEventListener("keydown", handler, { capture: true });
    return () =>
      document.removeEventListener("keydown", handler, { capture: true });
  }, [clearPendingPrefix]);

  const contextValue = useMemo<KeyboardShortcutContextValue>(
    () => ({
      isOverlayOpen,
      setOverlayOpen,
      registerShortcuts,
      allShortcuts,
      pendingPrefix,
    }),
    [isOverlayOpen, setOverlayOpen, registerShortcuts, allShortcuts, pendingPrefix]
  );

  return (
    <KeyboardShortcutContext.Provider value={contextValue}>
      {children}
      {pendingPrefix && <PrefixIndicator prefix={pendingPrefix} />}
    </KeyboardShortcutContext.Provider>
  );
}
