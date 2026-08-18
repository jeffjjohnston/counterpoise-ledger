"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useBookId } from "@/hooks/useBookId";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { AccountAutocomplete } from "@/components/ui/AccountAutocomplete";
import { PayeeAutocomplete } from "@/components/ui/PayeeAutocomplete";
import { flattenAccounts } from "@/lib/accounting";
import { formatCurrency, formatDate } from "@/lib/formatters";
import { SYNC_QUEUE_CHANGED_EVENT } from "@/lib/events";
import { apiGet, apiPost, toMessage } from "@/lib/api-client";
import type { AccountWithBalance, AssignedSyncAccount, SyncMatchCandidate, SyncReconciliationItem } from "@/types";

type ReconciliationResponse = {
  items: SyncReconciliationItem[];
  totalCount: number;
  offset: number;
  limit: number;
  hasMore: boolean;
};

type Props = {
  isOpen: boolean;
  row: AssignedSyncAccount | null;
  onClose: () => void;
  onQueueChanged?: () => void | Promise<void>;
};

const PAGE_SIZE = 25;

function isUnresolved(item: SyncReconciliationItem): boolean {
  return item.resolutionStatus === "pending" || item.reviewReason !== null;
}

function reviewLabel(reviewReason: SyncReconciliationItem["reviewReason"]): string {
  if (reviewReason === "plaid_modified") return "Needs Review: Modified";
  if (reviewReason === "plaid_removed") return "Needs Review: Removed";
  return "Pending";
}

function formatDayDelta(value: number): string {
  if (value === 0) return "same day";
  if (value > 0) return `${value}d after`;
  return `${Math.abs(value)}d before`;
}

function isStrongMatch(candidate: SyncMatchCandidate): boolean {
  return candidate.amountDelta === 0 && Math.abs(candidate.dayDelta) <= 1;
}

export function ReconciliationModal({
  isOpen,
  row,
  onClose,
  onQueueChanged,
}: Props) {
  const bookId = useBookId();
  const plaidLinkId = row?.plaidLinkId ?? null;
  const [items, setItems] = useState<SyncReconciliationItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [totalCount, setTotalCount] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [matchingAction, setMatchingAction] = useState<{
    transactionId: number;
    action: "match" | "match_update_amount";
  } | null>(null);

  const [accounts, setAccounts] = useState<AccountWithBalance[]>([]);
  const [selectedCounterAccountId, setSelectedCounterAccountId] = useState<number | null>(
    null
  );
  const [payeeName, setPayeeName] = useState("");
  const [payeeSuggestions, setPayeeSuggestions] = useState<
    Array<{ id: number; name: string }>
  >([]);

  const selectedItem = useMemo(
    () => items.find((item) => item.id === selectedId) ?? null,
    [items, selectedId]
  );

  const eligibleCounterAccounts = useMemo(
    () => accounts.filter((account) => account.id !== row?.counterpoiseAccountId),
    [accounts, row?.counterpoiseAccountId]
  );

  const loadAccounts = useCallback(async () => {
    try {
      const payload = await apiGet<unknown>(`/api/b/${bookId}/accounts?includeInactive=true`);
      const flat = flattenAccounts(Array.isArray(payload) ? payload : []);
      setAccounts(flat.sort((a, b) => a.name.localeCompare(b.name)));
    } catch {
      setAccounts([]);
    }
  }, [bookId]);

  const fetchQueue = useCallback(
    async (targetOffset: number, reset: boolean) => {
      if (plaidLinkId === null) return;

      if (reset) {
        setLoading(true);
        setError(null);
      } else {
        setLoadingMore(true);
      }

      try {
        const response = await apiGet<ReconciliationResponse>(
          `/api/b/${bookId}/sync/accounts/${plaidLinkId}/reconcile?limit=${PAGE_SIZE}&offset=${targetOffset}`
        );
        setItems((prev) => (reset ? response.items : [...prev, ...response.items]));
        setOffset(response.offset + response.items.length);
        setHasMore(response.hasMore);
        setTotalCount(response.totalCount);

        const firstId = response.items[0]?.id ?? null;
        if (reset) {
          setSelectedId(firstId);
        }
      } catch (queueError) {
        setError(toMessage(queueError, "Failed to load reconciliation queue"));
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [bookId, plaidLinkId]
  );

  useEffect(() => {
    if (!isOpen || plaidLinkId === null) {
      return;
    }

    setItems([]);
    setSelectedId(null);
    setOffset(0);
    setHasMore(false);
    setTotalCount(0);
    setSelectedCounterAccountId(null);
    setPayeeName("");
    setError(null);

    void Promise.all([loadAccounts(), fetchQueue(0, true)]);
  }, [fetchQueue, isOpen, loadAccounts, plaidLinkId]);

  useEffect(() => {
    if (!selectedItem) {
      setSelectedCounterAccountId(null);
      setPayeeName("");
      return;
    }

    setSelectedCounterAccountId(selectedItem.suggestedCounterAccountId);
    setPayeeName(selectedItem.merchantName ?? selectedItem.name);
  }, [selectedItem]);

  useEffect(() => {
    const query = payeeName.trim();
    if (!query) {
      setPayeeSuggestions([]);
      return;
    }

    const controller = new AbortController();
    const fetchSuggestions = async () => {
      try {
        const data = await apiGet<unknown>(
          `/api/b/${bookId}/payees?search=${encodeURIComponent(query)}&limit=8`,
          { signal: controller.signal }
        );
        setPayeeSuggestions(Array.isArray(data) ? data : []);
      } catch (error) {
        // The controller's own signal is the authoritative answer to "was this
        // cancelled?". Name matching alone misses a Firefox abort and a body
        // truncated mid-stream, both of which reject with TypeError.
        if (controller.signal.aborted) return;
        if (error instanceof DOMException && error.name === "AbortError") return;
        console.error("Failed to fetch payee suggestions", error);
      }
    };
    // setTimeout expects a void-returning callback; fetchSuggestions
    // already catches its own errors, so this cannot reject.
    const timeout = setTimeout(() => {
      void fetchSuggestions();
    }, 150);

    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [bookId, payeeName]);

  const resolveSelected = async (
    body:
      | { action: "match"; transactionId: number }
      | { action: "match_update_amount"; transactionId: number }
      | { action: "create"; counterAccountId: number; payeeName: string }
      | { action: "ignore" | "keep_local" | "unlink" }
  ) => {
    if (!row || !selectedItem) return;

    setSubmitting(true);
    if (body.action === "match" || body.action === "match_update_amount") {
      setMatchingAction({ transactionId: body.transactionId, action: body.action });
    }
    setError(null);

    try {
      const updatedItem = await apiPost<SyncReconciliationItem>(
        `/api/b/${bookId}/sync/accounts/${row.plaidLinkId}/reconcile`,
        { reconciliationId: selectedItem.id, ...body }
      );

      setItems((prev) => {
        const next = isUnresolved(updatedItem)
          ? prev.map((item) => (item.id === updatedItem.id ? updatedItem : item))
          : prev.filter((item) => item.id !== updatedItem.id);

        if (next.length === 0 && hasMore) {
          void fetchQueue(0, true);
          return next;
        }

        const nextSelected =
          next.find((item) => item.id === updatedItem.id)?.id ?? next[0]?.id ?? null;
        setSelectedId(nextSelected);
        return next;
      });

      if (!isUnresolved(updatedItem)) {
        setTotalCount((prev) => Math.max(0, prev - 1));
      }

      window.dispatchEvent(new CustomEvent(SYNC_QUEUE_CHANGED_EVENT));
      await onQueueChanged?.();
    } catch (resolveError) {
      setError(toMessage(resolveError, "Failed to resolve reconciliation"));
    } finally {
      setSubmitting(false);
      setMatchingAction(null);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={row ? `Reconcile ${row.plaidAccountName}` : "Reconcile"}
      size="xl"
    >
      {loading ? (
        <p className="text-sm text-fg-secondary">Loading reconciliation queue...</p>
      ) : error ? (
        <div className="space-y-3">
          <p className="text-sm text-fg-danger">{error}</p>
          <div className="flex justify-end">
            <Button variant="secondary" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-4">
          <div className="border border-border rounded-lg overflow-hidden">
            <div className="px-3 py-2 bg-surface-secondary border-b border-border text-xs text-fg-secondary">
              Queue ({items.length}/{totalCount})
            </div>
            <div className="max-h-[60vh] overflow-auto divide-y divide-border">
              {items.length === 0 ? (
                <p className="p-4 text-sm text-fg-tertiary">No pending reconciliation items.</p>
              ) : (
                items.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setSelectedId(item.id)}
                    className={`w-full text-left p-3 transition-colors ${
                      selectedId === item.id ? "bg-accent-subtle" : "hover:bg-surface-tertiary"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-medium text-fg truncate">{item.name}</p>
                      <span className="text-sm font-semibold text-fg">
                        {formatCurrency(item.amountCents)}
                      </span>
                    </div>
                    <p className="text-xs text-fg-tertiary mt-1">{formatDate(item.authorizedDate ?? item.date)}</p>
                    <p className="text-xs mt-1 text-fg-warning">{reviewLabel(item.reviewReason)}</p>
                  </button>
                ))
              )}
            </div>
            {hasMore && (
              <div className="p-3 border-t border-border">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void fetchQueue(offset, false)}
                  disabled={loadingMore}
                >
                  {loadingMore ? "Loading..." : "Load More"}
                </Button>
              </div>
            )}
          </div>

          <div className="border border-border rounded-lg p-4 min-h-[60vh]">
            {!selectedItem ? (
              <p className="text-sm text-fg-tertiary">Select a transaction to reconcile.</p>
            ) : (
              <div className="space-y-4">
                <div>
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-lg font-semibold text-fg">{selectedItem.name}</h3>
                    <span className="text-lg font-semibold text-fg">
                      {formatCurrency(selectedItem.amountCents)}
                    </span>
                  </div>
                  <p className="text-sm text-fg-secondary mt-1">
                    {formatDate(selectedItem.authorizedDate ?? selectedItem.date)}
                    {selectedItem.merchantName ? ` · ${selectedItem.merchantName}` : ""}
                  </p>
                  {selectedItem.reviewReason && (
                    <p className="text-sm text-fg-warning mt-2">{reviewLabel(selectedItem.reviewReason)}</p>
                  )}
                </div>

                <div>
                  <h4 className="text-sm font-semibold text-fg mb-2">Possible matches</h4>
                  {selectedItem.candidates.length === 0 ? (
                    <p className="text-sm text-fg-secondary">No likely matches found.</p>
                  ) : (
                    <div className="space-y-2">
                      {selectedItem.candidates.map((candidate) => {
                        const strong = isStrongMatch(candidate);
                        return (
                          <div
                            key={candidate.transactionId}
                            className={`rounded-lg p-3 ${
                              strong
                                ? "border-2 border-accent bg-accent-subtle"
                                : "border border-border"
                            }`}
                          >
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                  <p className="text-sm font-semibold text-fg truncate">
                                    {candidate.payeeName || candidate.description || "(No description)"}
                                  </p>
                                  {strong && (
                                    <span className="shrink-0 text-xs font-semibold text-accent px-1.5 py-0.5 rounded bg-accent-subtle border border-accent">
                                      Strong match
                                    </span>
                                  )}
                                </div>
                                <div className="flex items-center gap-1.5 mt-1.5 text-sm text-fg-secondary">
                                  <span>{formatDate(candidate.date)}</span>
                                  <span className="text-fg-tertiary">·</span>
                                  <span className={Math.abs(candidate.dayDelta) <= 1 ? "text-fg" : ""}>
                                    {formatDayDelta(candidate.dayDelta)}
                                  </span>
                                  <span className="text-fg-tertiary">·</span>
                                  <span className={candidate.amountDelta === 0 ? "text-fg" : ""}>
                                    delta {formatCurrency(candidate.amountDelta)}
                                  </span>
                                </div>
                                {candidate.counterpartAccountNames.length > 0 && (
                                  <p className="text-sm text-fg-secondary mt-1">
                                    Counterpart: {candidate.counterpartAccountNames.join(", ")}
                                  </p>
                                )}
                              </div>
                              <div className="flex flex-col gap-1.5 shrink-0">
                                <Button
                                  size="sm"
                                  onClick={() =>
                                    void resolveSelected({
                                      action: "match",
                                      transactionId: candidate.transactionId,
                                    })
                                  }
                                  disabled={submitting || candidate.alreadyLinked}
                                  title={
                                    candidate.alreadyLinked
                                      ? "Already matched to another synced transaction"
                                      : undefined
                                  }
                                >
                                  {matchingAction?.transactionId === candidate.transactionId &&
                                  matchingAction.action === "match"
                                    ? "Matching…"
                                    : "Match"}
                                </Button>
                                {candidate.amountDelta !== 0 && candidate.splitCount === 2 && (
                                  <Button
                                    size="sm"
                                    variant="secondary"
                                    onClick={() =>
                                      void resolveSelected({
                                        action: "match_update_amount",
                                        transactionId: candidate.transactionId,
                                      })
                                    }
                                    disabled={submitting || candidate.alreadyLinked}
                                    title={
                                      candidate.alreadyLinked
                                        ? "Already matched to another synced transaction"
                                        : undefined
                                    }
                                  >
                                    {matchingAction?.transactionId === candidate.transactionId &&
                                    matchingAction.action === "match_update_amount"
                                      ? "Matching…"
                                      : `Match & Update ${formatCurrency(Math.abs(candidate.expectedAmount))}`}
                                  </Button>
                                )}
                              </div>
                            </div>
                            {candidate.alreadyLinked && (
                              <p className="text-xs text-fg-tertiary mt-2">
                                Already matched to another synced transaction
                              </p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div className="border-t border-border pt-4">
                  <h4 className="text-sm font-semibold text-fg mb-2">Create new transaction</h4>
                  <div className="space-y-3">
                    <AccountAutocomplete
                      accounts={eligibleCounterAccounts}
                      value={selectedCounterAccountId}
                      onChange={setSelectedCounterAccountId}
                      label="Counter account"
                      placeholder="Search accounts..."
                    />
                    <PayeeAutocomplete
                      payees={payeeSuggestions}
                      textValue={payeeName}
                      onTextChange={setPayeeName}
                      label="Payee"
                      placeholder="Search for a payee..."
                    />
                  </div>
                  <div className="mt-3 flex justify-end">
                    <Button
                      onClick={() =>
                        selectedCounterAccountId &&
                        void resolveSelected({
                          action: "create",
                          counterAccountId: selectedCounterAccountId,
                          payeeName,
                        })
                      }
                      disabled={submitting || !selectedCounterAccountId}
                    >
                      Create
                    </Button>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 pt-2">
                  <Button
                    variant="secondary"
                    onClick={() => void resolveSelected({ action: "ignore" })}
                    disabled={submitting}
                  >
                    Ignore
                  </Button>
                  {selectedItem.reviewReason && (
                    <>
                      <Button
                        variant="secondary"
                        onClick={() => void resolveSelected({ action: "keep_local" })}
                        disabled={submitting}
                      >
                        Keep Local
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={() => void resolveSelected({ action: "unlink" })}
                        disabled={submitting}
                      >
                        Unlink
                      </Button>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
