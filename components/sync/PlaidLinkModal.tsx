"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { ApiError, apiPost, toMessage } from "@/lib/api-client";
import type { PlaidLinkSession } from "@/types";

/** How often the modal asks the server for the result of the session. */
export const PLAID_LINK_POLL_MS = 3000;

/**
 * True when a failed start can pass if the user tries again: a network
 * failure or a server error (5xx, which includes a Plaid failure, 502). A
 * 4xx answer, such as a demo connection or a connection that is not in the
 * book, fails again on each try.
 */
function canRetryStart(error: unknown): boolean {
  return !(error instanceof ApiError) || error.status >= 500;
}

type PlaidLinkModalProps = {
  bookId: string;
  /** Null connects a new bank. A connection ID reconnects it (update mode). */
  tokenId: number | null;
  /** The name of the connection to reconnect, for the text. */
  institution?: string | null;
  onClose: () => void;
  /** Called one time, when the server reports the session complete. */
  onComplete: (session: PlaidLinkSession) => void;
  /** When given, a new connection offers "Map accounts", which calls it. */
  onMapAccounts?: (tokenId: number) => void;
};

/**
 * Connects a bank, or reconnects one, through Plaid Hosted Link.
 *
 * The server starts the session and makes every Plaid call. Plaid shows its
 * sign-in on its own site, in a new tab. Hosted Link sends no callback to
 * this page, so the modal asks the server for the result every few seconds
 * while it is open. The access token never comes to the browser.
 *
 * Mount the modal only while it is open. A mount continues the open session
 * of the same connection, if there is one: the server answers it in place of
 * a new session, or answers the saved connection when the user finished it
 * at Plaid. Thus a reload of the page while the Plaid tab stays open loses
 * nothing. "Start again" and "Try again" send `restart`, which stops the open
 * sessions and starts a new one.
 */
export function PlaidLinkModal({
  bookId,
  tokenId,
  institution,
  onClose,
  onComplete,
  onMapAccounts,
}: PlaidLinkModalProps) {
  const [attempt, setAttempt] = useState(0);
  const [session, setSession] = useState<PlaidLinkSession | null>(null);
  const [startError, setStartError] = useState<{ message: string; retry: boolean } | null>(
    null
  );
  const [checkError, setCheckError] = useState<string | null>(null);
  const reported = useRef<number | null>(null);

  // Starts or continues a session. "Start again" increases the attempt, and
  // each attempt after the first asks for a new session.
  useEffect(() => {
    let cancelled = false;
    const start = async () => {
      try {
        const created = await apiPost<PlaidLinkSession>(
          `/api/b/${bookId}/sync/link-sessions`,
          attempt > 0 ? { tokenId, restart: true } : { tokenId }
        );
        if (!cancelled) setSession(created);
      } catch (error) {
        if (!cancelled) {
          setStartError({
            message: toMessage(error, "Failed to start the bank connection"),
            retry: canRetryStart(error),
          });
        }
      }
    };
    void start();
    return () => {
      cancelled = true;
    };
  }, [attempt, bookId, tokenId]);

  // Polls a pending session. Each answer is a new object, which schedules
  // the next poll. A failed poll stops until the user asks again.
  useEffect(() => {
    if (!session || session.status !== "pending" || checkError) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const next = await apiPost<PlaidLinkSession>(
          `/api/b/${bookId}/sync/link-sessions/${session.id}/check`
        );
        if (!cancelled) setSession(next);
      } catch (error) {
        if (!cancelled) setCheckError(toMessage(error, "Failed to check the bank connection"));
      }
    };
    const timer = window.setTimeout(() => void poll(), PLAID_LINK_POLL_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [bookId, checkError, session]);

  useEffect(() => {
    if (session?.status === "complete" && reported.current !== session.id) {
      reported.current = session.id;
      onComplete(session);
    }
  }, [onComplete, session]);

  const startAgain = () => {
    setSession(null);
    setStartError(null);
    setCheckError(null);
    setAttempt((value) => value + 1);
  };

  const isUpdate = tokenId !== null;
  const bankName = session?.financialInstitution ?? institution ?? "your bank";
  const title = isUpdate ? `Reconnect ${institution ?? "bank"}` : "Connect a bank";

  let body: ReactNode;
  if (startError) {
    body = (
      <div className="space-y-4">
        <p className="text-sm text-fg-danger">{startError.message}</p>
        <div className="flex justify-end gap-2">
          {startError.retry ? (
            <>
              <Button variant="secondary" onClick={onClose}>
                Cancel
              </Button>
              <Button onClick={startAgain}>Try again</Button>
            </>
          ) : (
            <Button onClick={onClose}>Close</Button>
          )}
        </div>
      </div>
    );
  } else if (!session) {
    body = (
      <div className="flex items-center gap-3 py-6">
        <div className="h-4 w-4 animate-spin rounded-full border-2 border-border border-t-accent" />
        <p className="text-sm text-fg-secondary">Starting a session with Plaid…</p>
      </div>
    );
  } else if (session.status === "pending") {
    body = (
      <div className="space-y-4">
        <p className="text-sm leading-relaxed text-fg-secondary">
          {isUpdate
            ? `Sign in to ${bankName} again at Plaid. You can also select more accounts to sync.`
            : "Sign in to your bank at Plaid. Plaid opens in a new tab, and Counterpoise never sees your bank password."}
        </p>
        {session.hostedLinkUrl && (
          <a
            href={session.hostedLinkUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center rounded-md bg-accent px-4 py-2 text-sm font-medium text-fg-on-accent hover:bg-accent-hover focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-border-focus"
          >
            Open Plaid
          </a>
        )}
        {checkError ? (
          <div className="space-y-2">
            <p className="text-sm text-fg-danger">{checkError}</p>
            {/* Some failures do not go away, for example a public token that
                Plaid no longer accepts. "Start again" stops this session and
                starts a new one. */}
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" onClick={() => setCheckError(null)}>
                Check again
              </Button>
              <Button size="sm" variant="secondary" onClick={startAgain}>
                Start again
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-3" role="status">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-border border-t-accent" />
            <p className="text-13 text-fg-tertiary">
              Waiting for you to finish at Plaid. This window updates when you finish.
            </p>
          </div>
        )}
        <div className="flex justify-end">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    );
  } else if (session.status === "complete") {
    const newTokenId = session.tokenId;
    body = (
      <div className="space-y-4">
        <p className="text-sm text-fg" role="status">
          {isUpdate
            ? `${bankName} is reconnected. The next sync uses it.`
            : `${bankName} is connected. Map its accounts to accounts in this book so that they sync.`}
        </p>
        <div className="flex justify-end gap-2">
          {!isUpdate && onMapAccounts && newTokenId !== null ? (
            <>
              <Button variant="secondary" onClick={onClose}>
                Close
              </Button>
              <Button onClick={() => onMapAccounts(newTokenId)}>Map accounts</Button>
            </>
          ) : (
            <Button onClick={onClose}>Done</Button>
          )}
        </div>
      </div>
    );
  } else if (session.status === "expired") {
    body = (
      <div className="space-y-4">
        <p className="text-sm text-fg-secondary">
          This session expired before it was finished. Start a new one to continue.
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          <Button onClick={startAgain}>Start again</Button>
        </div>
      </div>
    );
  } else {
    body = (
      <div className="space-y-4">
        <p className="text-sm text-fg-danger">
          {session.error ?? "The bank connection could not be saved."}
        </p>
        <div className="flex justify-end">
          <Button onClick={onClose}>Close</Button>
        </div>
      </div>
    );
  }

  return (
    <Modal isOpen onClose={onClose} title={title}>
      {body}
    </Modal>
  );
}
