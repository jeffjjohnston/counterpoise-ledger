"use client";

import { useEffect } from "react";
import { cn } from "@/lib/utils";

export type ToastVariant = "error" | "success";

interface ToastProps {
  message: string;
  isVisible: boolean;
  onDismiss: () => void;
  duration?: number;
  variant?: ToastVariant;
}

export function Toast({
  message,
  isVisible,
  onDismiss,
  duration = 2000,
  variant = "success",
}: ToastProps) {
  useEffect(() => {
    if (!isVisible) return;
    const timer = setTimeout(onDismiss, duration);
    return () => clearTimeout(timer);
  }, [isVisible, onDismiss, duration]);

  return (
    // Positioning lives in ToastProvider's stack container, not here: a
    // `fixed` root would pile every stacked toast at the same spot.
    <div
      className={cn(
        "transition-all duration-300",
        isVisible
          ? "opacity-100 translate-y-0"
          : "opacity-0 translate-y-2 pointer-events-none"
      )}
    >
      <div
        className={cn(
          "text-sm px-4 py-2 rounded-lg shadow-lg max-w-md break-words whitespace-pre-line",
          // bg-danger + text-fg-on-accent is this codebase's established pairing
          // for a solid danger surface — see app/page.tsx:505.
          variant === "error"
            ? "bg-danger text-fg-on-accent"
            : "bg-fg text-surface"
        )}
      >
        {message}
      </div>
    </div>
  );
}
