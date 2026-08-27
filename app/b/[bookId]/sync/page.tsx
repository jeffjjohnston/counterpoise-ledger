"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { MenuButton } from "@/components/ui/MenuButton";
import { ConfirmModal } from "@/components/ui/ConfirmModal";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import { ReconciliationModal } from "@/components/sync/ReconciliationModal";
import { formatDate, toDateString } from "@/lib/formatters";
import { useBookId } from "@/hooks/useBookId";
import { apiGet, apiPost, apiDelete, toMessage } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { SYNC_QUEUE_CHANGED_EVENT } from "@/lib/events";
import type { AssignedSyncAccount } from "@/types";

function formatLastSynced(value: string | null) {
  if (!value) return "Never";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Never";
  }

  const datePart = formatDate(toDateString(date));
  const timePart = date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  return `${datePart} ${timePart}`;
}

const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

const DOT_CLASS = {
  danger: "bg-[var(--fg-danger)]",
  warning: "bg-[var(--fg-warning)]",
  success: "bg-[var(--fg-success)]",
} as const;

/**
 * The dot beside a connection's name reports its **sync freshness**.
 *
 * Deliberately not the same signal as the dot on the connections page, which
 * reports whether every bank account has been mapped. Each carries an
 * aria-label naming its own meaning so the two cannot be read as one.
 */
function syncStatus(
  lastError: string | null | undefined,
  lastSyncedAt: string | null
): { tone: keyof typeof DOT_CLASS; label: string } {
  if (lastError) return { tone: "danger", label: "last sync failed" };
  if (!lastSyncedAt) return { tone: "warning", label: "never synced" };

  const syncedAt = new Date(lastSyncedAt).getTime();
  if (Number.isNaN(syncedAt)) return { tone: "warning", label: "never synced" };
  if (Date.now() - syncedAt > STALE_AFTER_MS) {
    return { tone: "warning", label: "last synced more than 24 hours ago" };
  }

  return { tone: "success", label: "synced within the last 24 hours" };
}

export default function SyncPage() {
  const bookId = useBookId();
  const router = useRouter();
  const [rows, setRows] = useState<AssignedSyncAccount[]>([]);
  const [loading, setLoading] = useState(true);
  // A failure the user just triggered, plus the connection it belongs to when
  // there is one. The token id has to travel with the message: syncOne does not
  // refetch on its error path, so the banner cannot recover the connection from
  // the rows it is already holding.
  const [error, setError] = useState<{ message: string; tokenId: number | null } | null>(
    null
  );
  const [syncingById, setSyncingById] = useState<Record<number, boolean>>({});
  const [resettingById, setResettingById] = useState<Record<number, boolean>>({});
  const [selectedRow, setSelectedRow] = useState<AssignedSyncAccount | null>(null);
  const [showReconcileModal, setShowReconcileModal] = useState(false);
  const [resetTarget, setResetTarget] = useState<{ tokenId: number; institution: string } | null>(
    null
  );

  const fetchAssignedAccounts = useCallback(async () => {
    const data = await apiGet<AssignedSyncAccount[]>(
      `/api/b/${bookId}/sync/assigned-accounts`
    );
    const nextRows = Array.isArray(data) ? data : [];
    setRows(nextRows);
    return nextRows;
  }, [bookId]);

  useEffect(() => {
    const fetchInitial = async () => {
      try {
        setLoading(true);
        setError(null);
        await fetchAssignedAccounts();
      } catch (fetchError) {
        const message = toMessage(fetchError, "Failed to load assigned accounts");
        setError({ message, tokenId: null });
      } finally {
        setLoading(false);
      }
    };

    void fetchInitial();
  }, [fetchAssignedAccounts]);

  // The navbar badge polls this book's pending count every 60s. Without the same
  // cadence here the page's counts drift away from the badge directly above them.
  useEffect(() => {
    const refresh = () => {
      void fetchAssignedAccounts().catch(() => {
        // Best-effort background refresh; the visible error state belongs to
        // explicit actions, not to a poll that lost a race with a navigation.
      });
    };

    const interval = setInterval(refresh, 60_000);
    const onFocus = () => {
      if (document.visibilityState === "visible") refresh();
    };

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    window.addEventListener(SYNC_QUEUE_CHANGED_EVENT, refresh);

    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      window.removeEventListener(SYNC_QUEUE_CHANGED_EVENT, refresh);
    };
  }, [fetchAssignedAccounts]);

  const groupedRows = useMemo(() => {
    return rows.reduce<Record<number, AssignedSyncAccount[]>>((acc, row) => {
      if (!acc[row.tokenId]) {
        acc[row.tokenId] = [];
      }
      acc[row.tokenId].push(row);
      return acc;
    }, {});
  }, [rows]);

  const summary = useMemo(() => {
    const connectionCount = Object.keys(groupedRows).length;
    const queueTotal = rows.reduce((sum, row) => sum + row.pendingCount + row.reviewCount, 0);
    const freshest = rows
      .map((row) => row.lastSyncedAt)
      .filter((value): value is string => !!value)
      .sort()
      .at(-1) ?? null;
    return { connectionCount, queueTotal, freshest };
  }, [groupedRows, rows]);

  // One row per connection whose last sync failed. A connection's card no
  // longer reports its own failure; the page shows one banner for all of them.
  const failedConnections = useMemo(
    () =>
      Object.entries(groupedRows)
        .map(([tokenIdStr, groupRows]) => ({
          tokenId: Number(tokenIdStr),
          institution: groupRows[0].financialInstitution,
          lastError: groupRows[0].lastError,
        }))
        .filter((entry): entry is typeof entry & { lastError: string } => !!entry.lastError),
    [groupedRows]
  );

  const openReconcileModal = (row: AssignedSyncAccount) => {
    setSelectedRow(row);
    setShowReconcileModal(true);
  };

  const closeReconcileModal = () => {
    setShowReconcileModal(false);
    setSelectedRow(null);
  };

  // Returns the error message, or null on success. handleSync keeps setting
  // `error` for the single-connection case; syncAll needs the value back so it
  // can report every failure rather than only the last one.
  const syncOne = useCallback(
    async (tokenId: number): Promise<string | null> => {
      setSyncingById((prev) => ({ ...prev, [tokenId]: true }));
      try {
        await apiPost(`/api/b/${bookId}/sync/tokens/${tokenId}/sync`);
        await fetchAssignedAccounts();
        return null;
      } catch (syncError) {
        return toMessage(syncError, "Failed to sync");
      } finally {
        setSyncingById((prev) => ({ ...prev, [tokenId]: false }));
      }
    },
    [bookId, fetchAssignedAccounts]
  );

  const handleSync = useCallback(
    async (tokenId: number) => {
      setError(null);
      const message = await syncOne(tokenId);
      if (message) setError({ message, tokenId });
    },
    [syncOne]
  );

  const handleSyncAll = useCallback(async () => {
    setError(null);
    const entries = Object.entries(groupedRows).map(([id, group]) => ({
      tokenId: Number(id),
      institution: group[0].financialInstitution,
    }));

    // Sequential, not Promise.all: syncToken takes a per-token advisory lock and
    // returns 409 on contention rather than waiting, and a serial loop lets one
    // connection fail without taking the others with it.
    const failures: Array<{ tokenId: number; text: string }> = [];
    for (const entry of entries) {
      const message = await syncOne(entry.tokenId);
      if (message) {
        failures.push({ tokenId: entry.tokenId, text: `${entry.institution}: ${message}` });
      }
    }

    // One failure still belongs to one connection, so the banner can name it and
    // offer a Retry that reaches it. Several belong to no single connection.
    if (failures.length === 1) {
      setError({ message: failures[0].text, tokenId: failures[0].tokenId });
    } else if (failures.length > 1) {
      setError({
        message: `${failures.length} connections failed to sync — ${failures
          .map((failure) => failure.text)
          .join("; ")}`,
        tokenId: null,
      });
    }
  }, [groupedRows, syncOne]);

  const anySyncing = Object.values(syncingById).some(Boolean);

  // One error surface, not two. A failure the user just triggered and a
  // lastError still recorded on a connection are the same news, so they share
  // one banner: the connection names it and owns the Retry, and the freshest
  // message wins the detail line.
  const errorBanner = useMemo(() => {
    // Whose failure this is. A sync the user just watched fail names its own
    // connection: syncOne does not refetch on the error path, so
    // failedConnections still describes the state before the click. Reading the
    // identity from there names whichever connection failed last time, prints
    // this failure's message underneath it, and points Retry at the wrong one.
    const activeTokenId = error?.tokenId ?? null;
    const activeGroup =
      activeTokenId === null
        ? undefined
        : (groupedRows[activeTokenId] as AssignedSyncAccount[] | undefined);
    const failed =
      activeGroup && activeTokenId !== null
        ? {
            tokenId: activeTokenId,
            institution: activeGroup[0].financialInstitution,
            lastError: activeGroup[0].lastError,
          }
        : failedConnections[0] ?? null;

    // No connection to name: either there is nothing to report, or the failure
    // is one no single connection owns (the initial load, a reset, several
    // connections at once).
    if (!failed) {
      return error ? { headline: error.message, detail: null, tokenId: null } : null;
    }

    // Every other connection known to be failing, counted but not named. The
    // one this banner is about may not be among them yet, so this cannot be a
    // plain length - 1.
    const others = failedConnections.filter(
      (connection) => connection.tokenId !== failed.tokenId
    ).length;
    return {
      headline: `${failed.institution} could not sync${
        others > 0
          ? `, along with ${others} other ${others === 1 ? "connection" : "connections"}`
          : ""
      }.`,
      detail: error?.message ?? failed.lastError,
      tokenId: failed.tokenId,
    };
  }, [error, failedConnections, groupedRows]);

  const handleReset = async (tokenId: number) => {
    setError(null);
    setResettingById((prev) => ({ ...prev, [tokenId]: true }));

    try {
      await apiDelete(`/api/b/${bookId}/sync/tokens/${tokenId}/sync`);
      await fetchAssignedAccounts();
    } catch (resetError) {
      // Deliberately unattributed: the banner's only action is Retry, which
      // syncs. Naming this connection would offer a sync in answer to a failed
      // reset.
      const message = toMessage(resetError, "Failed to reset sync");
      setError({ message, tokenId: null });
    } finally {
      setResettingById((prev) => ({ ...prev, [tokenId]: false }));
      setResetTarget(null);
    }
  };

  if (loading) {
    return (
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="space-y-4">
          {[0, 1].map((i) => (
            <div key={i} className="overflow-hidden rounded-lg border border-border bg-surface">
              <div className="flex items-center gap-3 border-b border-border bg-surface-secondary px-4 py-3">
                <Skeleton className="h-2 w-2 rounded-full" />
                <Skeleton className="h-5 w-32" />
                <Skeleton className="ml-auto h-8 w-16" />
              </div>
              <div className="space-y-2 px-4 py-4">
                <Skeleton className="h-5 w-64" />
                <Skeleton className="h-4 w-24" />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-fg">Sync</h1>
          <div className="inline-flex items-center gap-2">
            <Button
              onClick={() => void handleSyncAll()}
              disabled={anySyncing || rows.length === 0}
            >
              {anySyncing ? "Syncing…" : "Sync all"}
            </Button>
            <MenuButton
              label="Sync options"
              items={[
                {
                  label: "Manage connections",
                  onSelect: () => router.push(`/b/${bookId}/sync/tokens`),
                },
              ]}
            />
          </div>
        </div>
        <p data-testid="sync-summary" className="mt-1.5 text-sm text-fg-secondary">
          {summary.connectionCount} {summary.connectionCount === 1 ? "connection" : "connections"}
          <span className="text-fg-tertiary"> · </span>
          {summary.queueTotal === 0 ? (
            <span>nothing to review</span>
          ) : (
            <span className="font-medium text-fg">{summary.queueTotal} to review</span>
          )}
          <span className="text-fg-tertiary"> · </span>
          <span className="tabular-nums">
            {summary.freshest ? `last synced ${formatLastSynced(summary.freshest)}` : "never synced"}
          </span>
        </p>
      </div>

      {errorBanner && (
        <div
          role="alert"
          className="mb-4 flex items-start gap-3 rounded-lg border border-border bg-danger-subtle p-4"
        >
          <div className="flex-1">
            <p className="text-sm font-medium text-fg-danger">{errorBanner.headline}</p>
            {errorBanner.detail && (
              <p className="mt-1 text-13 text-fg-tertiary">{errorBanner.detail}</p>
            )}
          </div>
          {errorBanner.tokenId !== null && (
            <Button
              size="sm"
              onClick={() => void handleSync(errorBanner.tokenId as number)}
              disabled={syncingById[errorBanner.tokenId] === true}
            >
              {syncingById[errorBanner.tokenId] ? "Retrying…" : "Retry"}
            </Button>
          )}
        </div>
      )}

      {rows.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface">
          <EmptyState
            title="No bank accounts are connected yet"
            description="Connect a bank, then map its accounts to accounts in this book. Synced transactions appear here for you to review."
            action={{ label: "Connect a bank", href: `/b/${bookId}/sync/tokens` }}
          />
        </div>
      ) : (
        <div className="space-y-4">
          {Object.entries(groupedRows).map(([tokenIdStr, groupRows]) => {
            const tokenId = Number(tokenIdStr);
            const institution = groupRows[0].financialInstitution;
            const lastSyncedAt = groupRows[0].lastSyncedAt;
            const isSyncing = syncingById[tokenId] === true;
            const isResetting = resettingById[tokenId] === true;
            const status = syncStatus(groupRows[0].lastError, lastSyncedAt);

            return (
              <section
                key={tokenId}
                className="bg-surface rounded-lg border border-border overflow-hidden"
              >
                <div className="px-4 py-3 bg-surface-secondary border-b border-border flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span
                      role="status"
                      aria-label={`${institution}: ${status.label}`}
                      className={cn(
                        "h-2 w-2 flex-none rounded-full",
                        DOT_CLASS[status.tone]
                      )}
                    />
                    <div>
                      <h2 className="text-sm font-semibold text-fg">{institution}</h2>
                      <p className="text-xs text-fg-tertiary mt-0.5">
                        Last sync: {formatLastSynced(lastSyncedAt)}
                      </p>
                    </div>
                  </div>
                  <div className="inline-flex items-center gap-2">
                    <Button
                      size="sm"
                      onClick={() => void handleSync(tokenId)}
                      disabled={isSyncing}
                    >
                      {isSyncing ? "Syncing…" : "Sync"}
                    </Button>
                    <MenuButton
                      label={`${institution} actions`}
                      items={[
                        {
                          label: "Reset sync data",
                          variant: "danger",
                          disabled: isSyncing || isResetting,
                          onSelect: () => setResetTarget({ tokenId, institution }),
                        },
                      ]}
                    />
                  </div>
                </div>
                {groupRows.map((row) => {
                  const queueCount = row.pendingCount + row.reviewCount;

                  return (
                    <div
                      key={row.plaidLinkId}
                      data-testid={`mapping-${row.plaidLinkId}`}
                      className="flex items-center gap-4 border-t border-border-secondary px-4 py-3 first:border-t-0"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2 text-sm text-fg">
                          <span>{row.plaidAccountName}</span>
                          {row.plaidAccountMask && (
                            <span className="text-13 tabular-nums text-fg-tertiary">
                              ••••{row.plaidAccountMask}
                            </span>
                          )}
                          <svg
                            role="img"
                            aria-label="maps to"
                            width="18"
                            height="18"
                            viewBox="0 0 20 20"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth={1.5}
                            className="text-fg-tertiary"
                          >
                            <path
                              d="M3.5 10h13m-4.5-4.5L16.5 10 12 14.5"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                          <span className="font-medium">{row.counterpoiseAccountName}</span>
                        </div>
                        <p className="mt-0.5 text-13 text-fg-tertiary">
                          {queueCount === 0 ? (
                            "Up to date"
                          ) : (
                            <>
                              {row.pendingCount > 0 && `${row.pendingCount} waiting`}
                              {row.pendingCount > 0 && row.reviewCount > 0 && " "}
                              {row.reviewCount > 0 && (
                                <span className="text-fg-warning">
                                  {row.pendingCount > 0 ? "· " : ""}
                                  {row.reviewCount} changed at the bank
                                </span>
                              )}
                            </>
                          )}
                        </p>
                      </div>
                      {queueCount === 0 ? (
                        <span className="inline-flex items-center gap-1.5 text-13 text-fg-success">
                          <svg
                            width="16"
                            height="16"
                            viewBox="0 0 20 20"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth={1.9}
                            aria-hidden="true"
                          >
                            <path
                              d="M4 10.6 8 14.6 16.2 5.8"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                          <span className="sr-only">Nothing to review</span>
                        </span>
                      ) : (
                        <Button
                          size="sm"
                          className="min-h-11 sm:min-h-0"
                          onClick={() => openReconcileModal(row)}
                        >
                          Review {queueCount}
                        </Button>
                      )}
                    </div>
                  );
                })}
              </section>
            );
          })}
        </div>
      )}

      <ReconciliationModal
        isOpen={showReconcileModal}
        row={selectedRow}
        onClose={closeReconcileModal}
        onQueueChanged={() => void fetchAssignedAccounts()}
      />

      <ConfirmModal
        isOpen={resetTarget !== null}
        title={`Reset sync for ${resetTarget?.institution ?? ""}?`}
        confirmLabel="Reset sync data"
        busy={resetTarget ? resettingById[resetTarget.tokenId] === true : false}
        onClose={() => setResetTarget(null)}
        onConfirm={() => {
          if (resetTarget) void handleReset(resetTarget.tokenId);
        }}
        body={
          <>
            <p>
              Every staged transaction still waiting to be reconciled will be discarded,
              and the sync cursor resets so the next sync starts over.
            </p>
            <p>Transactions you have already matched, created or ignored are kept.</p>
          </>
        }
      />
    </div>
  );
}
