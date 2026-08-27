"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { formatDateShort } from "@/lib/formatters";
import { apiGet } from "@/lib/api-client";

type StaleAccount = {
  accountId: number;
  accountName: string;
  count: number;
  oldestDate: string;
};

type StaleUnmatchedResponse = {
  totalCount: number;
  accounts: StaleAccount[];
};

/**
 * Warn when a Plaid-synced account has manually entered transactions more
 * than 9 days old (within a 60-day lookback) that no bank transaction has
 * matched — the local entry is either a mistake or its posting is unusually
 * delayed. Marking a transaction reconciled acknowledges it and clears it
 * from the banner.
 */
export function StaleSyncBanner({
  bookId,
  refreshKey,
  className,
}: {
  bookId: string;
  /** Changing this value re-checks for stale transactions. */
  refreshKey?: unknown;
  className?: string;
}) {
  const [data, setData] = useState<StaleUnmatchedResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const payload = await apiGet<StaleUnmatchedResponse>(
          `/api/b/${bookId}/sync/stale-unmatched`
        );
        if (!cancelled) setData(payload);
      } catch {
        // Banner is best-effort; a failed check leaves current state as is
      }
    };
    // load already catches its own errors (best-effort banner); it cannot
    // reject.
    void load();
    // A sync can match transactions while the page sits open, so re-check
    // when the user returns to the tab
    const recheck = () => {
      if (document.visibilityState === "visible") void load();
    };
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", recheck);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", recheck);
    };
  }, [bookId, refreshKey]); // refreshKey exists only to retrigger the check

  if (!data || data.totalCount === 0 || data.accounts.length === 0) return null;

  const oldestDate = data.accounts.reduce(
    (oldest, a) => (a.oldestDate < oldest ? a.oldestDate : oldest),
    data.accounts[0].oldestDate
  );

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border-warning bg-warning-subtle p-3",
        className
      )}
    >
      <span className="inline-block h-2 w-2 flex-none rounded-full bg-[var(--fg-warning)]" />
      <div className="min-w-0 text-sm font-medium">
        {data.totalCount}{" "}
        {data.totalCount === 1 ? "transaction" : "transactions"} older than 9
        days with no matching bank transaction
        <span className="block text-xs font-normal text-fg-tertiary">
          oldest {formatDateShort(oldestDate)} · mark reconciled to dismiss
        </span>
      </div>
      <div className="ml-auto flex flex-wrap items-center gap-2">
        {data.accounts.map((a) => (
          <Link
            key={a.accountId}
            href={`/b/${bookId}/transactions?accountId=${a.accountId}`}
            className="rounded-full bg-surface px-2.5 py-1 text-xs text-fg-secondary transition-colors hover:text-fg"
          >
            {a.accountName}
            {data.accounts.length > 1 || a.count > 1 ? ` (${a.count})` : ""}
          </Link>
        ))}
      </div>
    </div>
  );
}
