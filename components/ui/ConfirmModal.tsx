"use client";

import type { ReactNode } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";

/**
 * Confirmation for an action that cannot be undone.
 *
 * Replaces window.confirm on the sync surfaces. A native confirm ignores the
 * theme and cannot format what it is about to destroy, which matters most for
 * the two calls that were understating their own consequences.
 *
 * `busy` is load-bearing rather than cosmetic: the destructive call is in
 * flight while the modal is still mounted, and without it a second click
 * fires a second delete.
 */
export function ConfirmModal({
  isOpen,
  title,
  body,
  confirmLabel,
  variant = "danger",
  busy = false,
  onConfirm,
  onClose,
}: {
  isOpen: boolean;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  variant?: "danger" | "primary";
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title} size="sm">
      <div className="space-y-4">
        <div className="text-sm text-fg-secondary [&_p]:m-0 [&_p+p]:mt-2">{body}</div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="button"
            variant={variant === "danger" ? "danger" : "primary"}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? `${confirmLabel}…` : confirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
