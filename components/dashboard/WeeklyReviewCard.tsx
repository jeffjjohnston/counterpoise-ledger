"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "@/lib/navigation";
import { useBookRole } from "@/components/BookRoleProvider";
import { Card, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { apiFetch, apiGet, toMessage } from "@/lib/api-client";
import {
  WEEKLY_REVIEW_SETTINGS_EVENT,
  errorText,
  formatPeriod,
  readHidden,
  writeHidden,
} from "@/lib/weekly-review";
import type { WeeklyReviewItem, WeeklyReviewState } from "@/types";

const POLL_MS = 5000;

export function WeeklyReviewCard({ bookId }: { bookId: string }) {
  const { canWrite } = useBookRole();
  const [state, setState] = useState<WeeklyReviewState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  // Undo belongs to the review that held the item.
  const [undo, setUndo] = useState<{ item: WeeklyReviewItem; reviewId: number } | null>(null);
  const [hidden, setHidden] = useState(() => readHidden(bookId));
  const url = `/api/b/${bookId}/weekly-review`;
  // The book that the card shows now. An answer for another book is late
  // and must not replace it.
  const currentUrl = useRef(url);
  // Counts dismissals and restores. A read that started before one is older
  // than the list the card shows, and must not replace it.
  const mutations = useRef(0);

  const load = useCallback(async () => {
    try {
      const started = mutations.current;
      const value = await apiGet<WeeklyReviewState>(url, { cache: "no-store" });
      if (currentUrl.current !== url || mutations.current !== started) return;
      setState(value);
      setError(null);
    } catch {
      if (currentUrl.current === url) setError("Could not load the weekly review.");
    }
  }, [url]);

  useEffect(() => {
    currentUrl.current = url;
    setState(null);
    setUndo(null);
    setHidden(readHidden(bookId));
    void load();
    const onFocus = () => void load();
    const onSettings = (event: Event) => {
      if ((event as CustomEvent<{ bookId: string }>).detail?.bookId === bookId) void load();
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener(WEEKLY_REVIEW_SETTINGS_EVENT, onSettings);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener(WEEKLY_REVIEW_SETTINGS_EVENT, onSettings);
    };
  }, [load, bookId, url]);

  const running = state?.running != null;
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [running, load]);

  async function start() {
    setStarting(true);
    setError(null);
    try {
      await apiFetch(`${url}/run`, { method: "POST" });
      await load();
    } catch (err) {
      setError(toMessage(err, "Could not start a review."));
    } finally {
      setStarting(false);
    }
  }

  async function setDismissed(item: WeeklyReviewItem, dismissed: boolean, reviewId: number) {
    mutations.current += 1;
    try {
      await apiFetch(`${url}/items/${item.id}/${dismissed ? "dismiss" : "restore"}`, { method: "POST" });
      setUndo(dismissed ? { item, reviewId } : null);
      setState((current) => {
        // The list may now be of a newer review: do not put the item in it.
        if (!current?.latest || current.latest.id !== reviewId) return current;
        const items = dismissed
          ? current.latest.items.filter((other) => other.id !== item.id)
          : [...current.latest.items, item].sort((a, b) => a.id - b.id);
        return { ...current, latest: { ...current.latest, items } };
      });
    } catch (err) {
      setError(toMessage(err, "Could not change the item."));
    } finally {
      // A read dropped above may have been the one that shows a new run; read
      // again, after the change.
      void load();
    }
  }

  function toggleHidden() {
    writeHidden(bookId, !hidden);
    setHidden(!hidden);
  }

  if (!state || !state.configured) return null;
  if (!state.enabled) {
    if (!canWrite) return null;
    return (
      <Card className="mb-6 md:mb-8 px-4 md:px-6 py-3 text-sm text-fg-secondary">
        A weekly AI review can check this book for duplicates and missed payments.{" "}
        <Link href={`/b/${bookId}/settings#features`} className="text-fg-accent font-medium">
          Turn it on
        </Link>
      </Card>
    );
  }

  const latest = state.latest;
  // A newer review replaced the list: its items cannot take the old Undo.
  const undoItem = undo && latest?.id === undo.reviewId ? undo : null;
  const period = state.running ?? latest;
  const range = period ? formatPeriod(period.periodStart, period.periodEnd) : null;
  const checks = latest?.items.filter((item) => item.kind === "check") ?? [];
  const insights = latest?.items.filter((item) => item.kind === "insight") ?? [];

  return (
    <Card className="mb-6 md:mb-8">
      <CardHeader
        action={
          <div className="flex shrink-0 items-center gap-2 whitespace-nowrap">
            {canWrite && !hidden && (
              <Button size="sm" variant="secondary" disabled={starting || running} onClick={() => void start()}>
                Review now
              </Button>
            )}
            <Button size="sm" variant="secondary" onClick={toggleHidden}>
              {hidden ? "Show" : "Hide"}
            </Button>
          </div>
        }
      >
        <h2 className="text-base font-semibold text-fg">
          Weekly review
          {range && <span className="whitespace-nowrap"> · {range}</span>}
        </h2>
      </CardHeader>
      {!hidden && (
        <div className="px-4 md:px-6 py-4 space-y-4 text-sm">
          {running && <p role="status" className="text-fg-secondary">Reviewing…</p>}
          {!running && state.lastFailure && (
            <p className="text-fg-danger">
              {errorText(state.lastFailure.error)}{" "}
              {canWrite && (
                <button type="button" className="text-fg-accent font-medium" onClick={() => void start()}>
                  Try again
                </button>
              )}
            </p>
          )}
          {!running && !latest && !state.lastFailure && (
            <p className="text-fg-secondary">Your first review runs Monday at 5:00.</p>
          )}
          {latest?.summary && <p className="text-fg">{latest.summary}</p>}
          {latest && checks.length === 0 && insights.length === 0 && (
            <p className="text-fg-secondary">Nothing to check this week.</p>
          )}
          <ItemGroup heading="Check" items={checks} bookId={bookId} canWrite={canWrite} onDismiss={(item) => latest && void setDismissed(item, true, latest.id)} />
          <ItemGroup heading="Insights" items={insights} bookId={bookId} canWrite={canWrite} onDismiss={(item) => latest && void setDismissed(item, true, latest.id)} />
          {undoItem && (
            <p className="text-xs text-fg-secondary">
              Item dismissed.{" "}
              <button type="button" className="text-fg-accent font-medium" onClick={() => void setDismissed(undoItem.item, false, undoItem.reviewId)}>
                Undo
              </button>
            </p>
          )}
          {error && <p role="alert" className="text-fg-danger">{error}</p>}
        </div>
      )}
    </Card>
  );
}

function ItemGroup({
  heading,
  items,
  bookId,
  canWrite,
  onDismiss,
}: {
  heading: string;
  items: WeeklyReviewItem[];
  bookId: string;
  canWrite: boolean;
  onDismiss: (item: WeeklyReviewItem) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-tertiary mb-2">{heading}</h3>
      <ul className="space-y-3">
        {items.map((item) => (
          <li key={item.id} className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="font-medium text-fg">{item.title}</p>
              <p className="text-fg-secondary">{item.detail}</p>
              <p className="mt-1 flex flex-wrap gap-x-3 text-xs">
                {item.transactions.map(({ id, accountId }) => (
                  <Link
                    key={id}
                    href={`/b/${bookId}/transactions?${accountId === null ? "" : `accountId=${accountId}&`}highlight=${id}`}
                    className="text-fg-accent"
                  >
                    Transaction {id}
                  </Link>
                ))}
                {item.recurringRuleId !== null && (
                  <Link href={`/b/${bookId}/recurring/${item.recurringRuleId}`} className="text-fg-accent">
                    Recurring rule
                  </Link>
                )}
              </p>
            </div>
            {canWrite && (
              <button
                type="button"
                aria-label={`Dismiss ${item.title}`}
                className="text-xs text-fg-tertiary hover:text-fg"
                onClick={() => onDismiss(item)}
              >
                Dismiss
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
