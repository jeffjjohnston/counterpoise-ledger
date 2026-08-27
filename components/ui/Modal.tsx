"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
}

type OpenModal = {
  overlay: React.RefObject<HTMLDivElement | null>;
  close: () => void;
};

/**
 * Every Modal currently open, in the order they opened.
 *
 * Modals nest: PlaidBanner's unlink confirmation renders inside
 * TransactionForm, which the transactions page renders inside a Modal of its
 * own. Two things have to be decided across the whole set rather than per
 * instance — which one Escape closes, and when page scroll is safe to unlock —
 * so the set lives at module scope.
 */
const openModals: OpenModal[] = [];

/**
 * The modal Escape belongs to: the innermost one, and among equals the one
 * that opened last.
 *
 * A modal whose overlay contains another open overlay is a parent, never the
 * target. That test settles nesting on its own, without depending on effect
 * ordering — React runs a child's effect before its parent's, so registration
 * order alone would hand Escape to the wrong one when both open in the same
 * commit. Order still decides between two modals that do not contain each
 * other.
 */
function topmostModal(): OpenModal | null {
  const innermost = openModals.filter(
    (candidate) =>
      !openModals.some(
        (other) =>
          other !== candidate &&
          candidate.overlay.current !== null &&
          other.overlay.current !== null &&
          candidate.overlay.current.contains(other.overlay.current)
      )
  );

  return innermost.at(-1) ?? null;
}

export function Modal({
  isOpen,
  onClose,
  title,
  children,
  size = "md",
}: ModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null);

  // Read through a ref so the registration effect depends on `isOpen` alone.
  // A parent that re-renders with a fresh onClose would otherwise re-register
  // itself and jump ahead of the confirmation open on top of it.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!isOpen) return;

    const entry: OpenModal = {
      overlay: overlayRef,
      close: () => onCloseRef.current(),
    };
    openModals.push(entry);
    document.body.style.overflow = "hidden";

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (topmostModal() !== entry) return;
      e.stopPropagation();
      entry.close();
    };

    document.addEventListener("keydown", handleEscape);

    return () => {
      document.removeEventListener("keydown", handleEscape);
      const index = openModals.indexOf(entry);
      if (index !== -1) openModals.splice(index, 1);
      // The page behind a still-open modal must not start scrolling again.
      if (openModals.length === 0) {
        document.body.style.overflow = "";
      }
    };
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === overlayRef.current) {
          onClose();
        }
      }}
    >
      <div
        className={cn(
          "bg-surface-elevated shadow-xl max-h-[85vh] sm:max-h-[90vh] overflow-auto animate-modal-enter",
          "w-full rounded-t-xl sm:rounded-lg sm:mx-4",
          {
            "sm:max-w-sm": size === "sm",
            "sm:max-w-lg": size === "md",
            "sm:max-w-2xl": size === "lg",
            "sm:max-w-5xl": size === "xl",
          }
        )}
      >
        <div className="flex items-center justify-between px-4 sm:px-6 py-4 border-b border-border">
          <h2 className="text-lg font-semibold text-fg">{title}</h2>
          <button
            onClick={onClose}
            className="text-fg-tertiary hover:text-fg-secondary transition-colors"
          >
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>
        <div className="p-4 sm:p-6">{children}</div>
      </div>
    </div>
  );
}
