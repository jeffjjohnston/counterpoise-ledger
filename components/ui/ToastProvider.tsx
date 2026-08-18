"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { Toast, type ToastVariant } from "@/components/ui/Toast";

interface ToastApi {
  error: (message: string) => void;
  success: (message: string) => void;
}

interface ToastItem {
  id: number;
  message: string;
  variant: ToastVariant;
}

const SUCCESS_DURATION_MS = 2000;
/** A failure needs longer on screen than a confirmation — the user has to read it. */
const ERROR_DURATION_MS = 5000;

// A no-op default rather than null, matching KeyboardShortcutProvider: the
// provider wraps the whole app, so the only callers outside it are tests that
// render a component bare. Throwing would break ~14 of them for no safety
// gain. The real risk — the provider not being mounted — is covered by the
// root-layout test below.
const ToastContext = createContext<ToastApi>({
  error: () => {},
  success: () => {},
});

export function useToast(): ToastApi {
  return useContext(ToastContext);
}

// A dedicated item component so each toast's onDismiss closure has a stable
// identity across ToastProvider re-renders. Toast's useEffect depends on
// onDismiss; an inline `() => dismiss(t.id)` in ToastProvider's render would
// be a fresh function every render, tearing down and restarting every other
// visible toast's setTimeout whenever any toast is pushed or dismissed.
// `dismiss` is useCallback-stable and `id` never changes for a given item,
// so useCallback here is stable across unrelated re-renders.
function ToastStackItem({
  id,
  message,
  variant,
  duration,
  onDismiss,
}: {
  id: number;
  message: string;
  variant: ToastVariant;
  duration: number;
  onDismiss: (id: number) => void;
}) {
  const handleDismiss = useCallback(() => onDismiss(id), [onDismiss, id]);
  return (
    <Toast
      message={message}
      variant={variant}
      isVisible
      duration={duration}
      onDismiss={handleDismiss}
    />
  );
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback((message: string, variant: ToastVariant) => {
    const id = nextId.current++;
    setToasts((prev) => [...prev, { id, message, variant }]);
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      error: (message: string) => push(message, "error"),
      success: (message: string) => push(message, "success"),
    }),
    [push]
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="false"
        className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex flex-col items-center gap-2"
      >
        {toasts.map((t) => (
          <ToastStackItem
            key={t.id}
            id={t.id}
            message={t.message}
            variant={t.variant}
            duration={t.variant === "error" ? ERROR_DURATION_MS : SUCCESS_DURATION_MS}
            onDismiss={dismiss}
          />
        ))}
      </div>
    </ToastContext.Provider>
  );
}
