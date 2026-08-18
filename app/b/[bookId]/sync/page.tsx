"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { ReconciliationModal } from "@/components/sync/ReconciliationModal";
import { formatDate, toDateString } from "@/lib/formatters";
import { useBookId } from "@/hooks/useBookId";
import { apiGet, apiPost, apiDelete, toMessage } from "@/lib/api-client";
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

export default function SyncPage() {
  const bookId = useBookId();
  const [rows, setRows] = useState<AssignedSyncAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncingById, setSyncingById] = useState<Record<number, boolean>>({});
  const [resettingById, setResettingById] = useState<Record<number, boolean>>({});
  const [selectedRow, setSelectedRow] = useState<AssignedSyncAccount | null>(null);
  const [showReconcileModal, setShowReconcileModal] = useState(false);

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
        setError(message);
      } finally {
        setLoading(false);
      }
    };

    void fetchInitial();
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

  const openReconcileModal = (row: AssignedSyncAccount) => {
    setSelectedRow(row);
    setShowReconcileModal(true);
  };

  const closeReconcileModal = () => {
    setShowReconcileModal(false);
    setSelectedRow(null);
  };

  const handleSync = async (tokenId: number) => {
    setError(null);
    setSyncingById((prev) => ({ ...prev, [tokenId]: true }));

    try {
      await apiPost(`/api/b/${bookId}/sync/tokens/${tokenId}/sync`);
      await fetchAssignedAccounts();
    } catch (syncError) {
      const message = toMessage(syncError, "Failed to sync");
      setError(message);
    } finally {
      setSyncingById((prev) => ({ ...prev, [tokenId]: false }));
    }
  };

  const handleReset = async (tokenId: number) => {
    if (!confirm("Reset sync? This will delete all pending reconciliation items and clear the sync cursor. Resolved items are preserved.")) {
      return;
    }

    setError(null);
    setResettingById((prev) => ({ ...prev, [tokenId]: true }));

    try {
      await apiDelete(`/api/b/${bookId}/sync/tokens/${tokenId}/sync`);
      await fetchAssignedAccounts();
    } catch (resetError) {
      const message = toMessage(resetError, "Failed to reset sync");
      setError(message);
    } finally {
      setResettingById((prev) => ({ ...prev, [tokenId]: false }));
    }
  };

  if (loading) {
    return (
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="animate-pulse space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-16 bg-surface-tertiary rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-fg">Sync</h1>
        <Link
          href={`/b/${bookId}/sync/tokens`}
          className="inline-flex items-center justify-center px-4 py-2 text-sm font-medium rounded-lg bg-accent text-fg-on-accent hover:bg-accent-hover transition-colors focus:outline-none focus:ring-2 focus:ring-border-focus focus:ring-offset-2"
        >
          Manage Tokens
        </Link>
      </div>

      {error ? (
        <div className="bg-danger-subtle border border-border rounded-lg p-4 text-sm text-fg-danger mb-4">
          {error}
        </div>
      ) : null}

      {rows.length === 0 ? (
        <div className="bg-surface rounded-lg border border-border p-6 text-fg-tertiary">
          No account mappings yet. Add a token and assign accounts to start syncing.
        </div>
      ) : (
        <div className="space-y-4">
          {Object.entries(groupedRows).map(([tokenIdStr, groupRows]) => {
            const tokenId = Number(tokenIdStr);
            const institution = groupRows[0].financialInstitution;
            const lastSyncedAt = groupRows[0].lastSyncedAt;
            const isSyncing = syncingById[tokenId] === true;
            const isResetting = resettingById[tokenId] === true;

            return (
              <section
                key={tokenId}
                className="bg-surface rounded-lg border border-border overflow-hidden"
              >
                <div className="px-4 py-3 bg-surface-secondary border-b border-border flex items-center justify-between">
                  <div>
                    <h2 className="text-sm font-semibold text-fg">{institution}</h2>
                    <p className="text-xs text-fg-tertiary mt-0.5">
                      Last sync: {formatLastSynced(lastSyncedAt)}
                    </p>
                    {groupRows[0].lastError && (
                      <p className="text-sm text-red-600 dark:text-red-400">
                        Last sync failed: {groupRows[0].lastError}
                      </p>
                    )}
                  </div>
                  <div className="inline-flex items-center gap-2">
                    <Button
                      size="sm"
                      onClick={() => void handleSync(tokenId)}
                      disabled={isSyncing}
                    >
                      {isSyncing ? "Syncing..." : "Sync"}
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => void handleReset(tokenId)}
                      disabled={isResetting || isSyncing}
                    >
                      {isResetting ? "Resetting..." : "Reset"}
                    </Button>
                  </div>
                </div>
                <table className="w-full">
                  <thead>
                    <tr className="text-left text-xs font-medium text-fg-tertiary uppercase tracking-wider">
                      <th className="px-4 py-3">Plaid Account</th>
                      <th className="px-4 py-3">Counterpoise Account</th>
                      <th className="px-4 py-3">To Review</th>
                      <th className="px-4 py-3"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border-secondary">
                    {groupRows.map((row) => {
                      const queueCount = row.pendingCount + row.reviewCount;

                      return (
                        <tr key={row.plaidLinkId} className="hover:bg-surface-tertiary">
                          <td className="px-4 py-3 text-sm text-fg">{row.plaidAccountName}</td>
                          <td className="px-4 py-3 text-sm text-fg">
                            {row.counterpoiseAccountName}
                          </td>
                          <td className="px-4 py-3">
                            {queueCount === 0 ? (
                              <span className="text-sm text-fg-tertiary">None</span>
                            ) : (
                              <div className="flex items-center gap-2">
                                {row.pendingCount > 0 && (
                                  <span className="inline-flex items-center rounded-full bg-accent-subtle px-2 py-0.5 text-xs font-medium text-fg-accent">
                                    Pending {row.pendingCount}
                                  </span>
                                )}
                                {row.reviewCount > 0 && (
                                  <span className="inline-flex items-center rounded-full bg-warning-subtle px-2 py-0.5 text-xs font-medium text-fg-warning">
                                    Review {row.reviewCount}
                                  </span>
                                )}
                              </div>
                            )}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => openReconcileModal(row)}
                            >
                              Review
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
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
    </div>
  );
}
