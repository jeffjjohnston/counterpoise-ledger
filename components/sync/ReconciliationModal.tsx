"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBookId } from "@/hooks/useBookId";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { AccountAutocomplete } from "@/components/ui/AccountAutocomplete";
import { PayeeAutocomplete } from "@/components/ui/PayeeAutocomplete";
import { flattenAccounts } from "@/lib/wasm-client";
import { formatCurrency, formatDate, formatDateShort } from "@/lib/wasm-client";
import { SYNC_QUEUE_CHANGED_EVENT } from "@/lib/events";
import { apiGet, apiPost, apiPut, toMessage } from "@/lib/api-client";
import { useTypeSafeSuggestion } from "@/hooks/useTypeSafeSuggestion";
import { TypeSafeSuggestion } from "@/components/sync/TypeSafeSuggestion";
import { cn } from "@/lib/utils";
import { useRegisterShortcuts } from "@/hooks/useRegisterShortcuts";
import type { ShortcutDef } from "@/components/KeyboardShortcutProvider";
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
  /** Every synced account link in the book. The queue can hold rows from all of them. */
  links: AssignedSyncAccount[];
  /** The link to show first. Null shows all accounts. */
  initialLinkId: number | null;
  onClose: () => void;
  onQueueChanged?: () => void | Promise<void>;
};

const PAGE_SIZE = 25;

/** The bank account as the bank names it, with the mask when there is one. */
function linkLabel(link: AssignedSyncAccount): string {
  return link.plaidAccountMask
    ? `${link.plaidAccountName} ••${link.plaidAccountMask}`
    : link.plaidAccountName;
}

function isUnresolved(item: SyncReconciliationItem): boolean {
  return item.resolutionStatus === "pending" || item.reviewReason !== null;
}

// The server already scores and ranks every candidate. These are the tags
// `score()` emits (rust-api/server/src/routes/reconcile.rs); anything not listed
// is deliberately not shown, because a tag with no plain-English reading is
// worse than no chip.
const SCORE_TAG_LABELS: Record<string, string> = {
  exact_amount: "exact amount",
  amount_close: "amount close",
  same_day: "same day",
  date_close: "date close",
  name_exact: "same payee",
  name_similar: "similar payee",
};

function candidateChips(candidate: SyncMatchCandidate): string[] {
  return candidate.scoreTags
    .map((tag) => SCORE_TAG_LABELS[tag])
    .filter((label): label is string => !!label);
}

/**
 * Plaid signs a charge positive; the ledger negates it
 * (rust-api/server/src/routes/reconcile.rs computes the expected amount as
 * -amount_cents, and the created split is -amount_cents). The queue must show what will be recorded,
 * or fixing the missing direction cue would introduce a fresh disagreement
 * instead of removing one.
 */
function signedAmount(amountCents: number): number {
  return -amountCents;
}

function queueReason(item: SyncReconciliationItem): { text: string; warn: boolean } {
  if (item.reviewReason === "plaid_modified") return { text: "changed at the bank", warn: true };
  if (item.reviewReason === "plaid_removed") return { text: "removed at the bank", warn: true };

  const best = item.candidates[0];
  if (!best) return { text: "no match", warn: false };
  if (best.scoreTags.includes("exact_amount") && best.scoreTags.includes("same_day")) {
    return { text: "exact match found", warn: false };
  }
  const n = item.candidates.length;
  return { text: `${n} possible ${n === 1 ? "match" : "matches"}`, warn: false };
}

// Matches the <kbd> styling already used by KeyboardShortcutOverlay.tsx and
// the two-key prefix indicator in KeyboardShortcutProvider.tsx, so a key hint
// on this screen looks like a key hint everywhere else. Existing tokens only
// — no new palette colours.
function KeyCap({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex items-center justify-center min-w-[1.5rem] h-6 px-1.5 font-mono text-xs font-semibold bg-surface-tertiary border border-border rounded text-fg">
      {children}
    </kbd>
  );
}

// The disclosure chevron used to fold the "other candidates" list and the
// Create form. Matches the toggle already shipped in
// components/transactions/PlaidBanner.tsx, so a folded section on this
// screen looks like a folded section everywhere else.
function DisclosureChevron({ expanded }: { expanded: boolean }) {
  return (
    <svg
      className={cn("h-3.5 w-3.5 flex-none transition-transform", expanded && "rotate-180")}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      aria-hidden="true"
    >
      <path d="M5 7.5 10 12.5 15 7.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ReconciliationModal({
  isOpen,
  links,
  initialLinkId,
  onClose,
  onQueueChanged,
}: Props) {
  const bookId = useBookId();

  // The filter starts from initialLinkId each time the modal opens. It is set
  // during render, not in an effect, so the first fetch after opening already
  // uses the new filter and no fetch goes out with the previous one.
  const [filterLinkId, setFilterLinkId] = useState<number | null>(initialLinkId);
  const [wasOpen, setWasOpen] = useState(false);
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen);
    if (isOpen) setFilterLinkId(initialLinkId);
  }

  const linksById = useMemo(
    () => new Map(links.map((link) => [link.plaidLinkId, link])),
    [links]
  );
  const filterLink = filterLinkId === null ? null : linksById.get(filterLinkId) ?? null;
  const showAccountTags = filterLinkId === null;

  // Each queue fetch that starts a new list gets a number. A response for an
  // older number is discarded, so a slow response for the previous filter
  // cannot replace the list for the current one.
  const queueRequest = useRef(0);

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

  // The top-ranked candidate gets its own decision block; everything else
  // folds into a disclosure. Both are recomputed straight from the selected
  // item -- cheap slices, not worth memoizing on their own.
  const [showOthers, setShowOthers] = useState(false);
  const [showCreate, setShowCreate] = useState(false);

  const selectedItem = useMemo(
    () => items.find((item) => item.id === selectedId) ?? null,
    [items, selectedId]
  );

  const bestMatch = selectedItem?.candidates[0] ?? null;
  const otherCandidates = selectedItem?.candidates.slice(1) ?? [];
  const canReview = selectedItem?.reviewReason != null;
  const position = items.findIndex((item) => item.id === selectedId) + 1;
  const selectedLinkId = selectedItem?.plaidAccountLinkId ?? null;
  const selectedLink = selectedLinkId === null ? null : linksById.get(selectedLinkId) ?? null;
  const typesafe = useTypeSafeSuggestion(bookId, selectedLinkId, selectedItem?.id ?? null,
    isOpen && !submitting && !!selectedItem && selectedItem.resolutionStatus === "pending" && !selectedItem.reviewReason && !selectedItem.pending);
  const typesafeObservation = typesafe.observation;

  const eligibleCounterAccounts = useMemo(
    () => accounts.filter((account) => account.id !== selectedLink?.counterpoiseAccountId),
    [accounts, selectedLink?.counterpoiseAccountId]
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
      const request = reset ? ++queueRequest.current : queueRequest.current;

      if (reset) {
        setLoading(true);
        setError(null);
      } else {
        setLoadingMore(true);
      }

      try {
        const filter = filterLinkId === null ? "" : `&linkId=${filterLinkId}`;
        const response = await apiGet<ReconciliationResponse>(
          `/api/b/${bookId}/sync/reconcile?limit=${PAGE_SIZE}&offset=${targetOffset}${filter}`
        );
        if (request !== queueRequest.current) return;
        setItems((prev) => (reset ? response.items : [...prev, ...response.items]));
        setOffset(response.offset + response.items.length);
        setHasMore(response.hasMore);
        setTotalCount(response.totalCount);

        const firstId = response.items[0]?.id ?? null;
        if (reset) {
          setSelectedId(firstId);
        }
      } catch (queueError) {
        if (request !== queueRequest.current) return;
        setError(toMessage(queueError, "Failed to load reconciliation queue"));
      } finally {
        if (request === queueRequest.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [bookId, filterLinkId]
  );

  // The account list does not change with the filter, so it loads once for
  // each time the modal opens.
  useEffect(() => {
    if (isOpen) void loadAccounts();
  }, [isOpen, loadAccounts]);

  useEffect(() => {
    if (!isOpen) {
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

    void fetchQueue(0, true);
  }, [fetchQueue, isOpen]);

  useEffect(() => {
    if (!selectedItem) {
      setSelectedCounterAccountId(null);
      setPayeeName("");
      return;
    }

    setSelectedCounterAccountId(selectedItem.suggestedCounterAccountId);
    setPayeeName(selectedItem.merchantName ?? selectedItem.name);
  }, [selectedItem]);

  // A row with nothing to match against has only one path forward, so open
  // Create for it automatically. Every other row starts with both
  // disclosures folded, so a fresh selection always looks the same.
  //
  // This is set during render, not in an effect. An effect runs after the
  // paint, so when a new list arrives, the first row is painted for one
  // frame with the disclosures of the empty selection before it (Create
  // open). A filter change causes that each time.
  const [disclosuresFor, setDisclosuresFor] = useState<SyncReconciliationItem | null>(null);
  if (selectedItem !== disclosuresFor) {
    setDisclosuresFor(selectedItem);
    setShowOthers(false);
    setShowCreate((selectedItem?.candidates.length ?? 0) === 0);
  }

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

  const resolveSelected = useCallback(
    async (
      body:
        | { action: "typesafe"; evaluationId: number; kind: "match" | "create" }
        | { action: "match"; transactionId: number }
        | { action: "match_update_amount"; transactionId: number }
        | { action: "create"; counterAccountId: number; payeeName: string }
        | { action: "ignore" | "keep_local" | "unlink" }
    ) => {
      if (!selectedItem) return;
      const linkId = selectedItem.plaidAccountLinkId;

      setSubmitting(true);
      if (body.action === "match" || body.action === "match_update_amount") {
        setMatchingAction({ transactionId: body.transactionId, action: body.action });
      }
      setError(null);

      try {
        const observation = typesafeObservation();
        const updatedItem = body.action === "typesafe" ? await apiPut<SyncReconciliationItem>(
          `/api/b/${bookId}/sync/accounts/${linkId}/reconcile/suggestion`,
          { evaluationId: body.evaluationId, kind: body.kind, activeReviewMs: observation.activeReviewMs }
        ) : await apiPost<SyncReconciliationItem>(
          `/api/b/${bookId}/sync/accounts/${linkId}/reconcile`,
          { reconciliationId: selectedItem.id, ...body, ...(observation.evaluationId ? { typesafe: observation } : {}) }
        );

        // Computed outside setItems on purpose. A state updater has to be
        // pure: React re-invokes it under StrictMode and may replay it while
        // rendering concurrently, so a fetch fired from inside would issue two
        // competing GETs whose responses both land in setItems.
        const next = isUnresolved(updatedItem)
          ? items.map((item) => (item.id === updatedItem.id ? updatedItem : item))
          : items.filter((item) => item.id !== updatedItem.id);

        setItems(next);

        if (next.length === 0 && hasMore) {
          // The page drained; fetchQueue picks the new selection itself.
          void fetchQueue(0, true);
        } else {
          setSelectedId(
            next.find((item) => item.id === updatedItem.id)?.id ?? next[0]?.id ?? null
          );
        }

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
    },
    [selectedItem, bookId, items, hasMore, fetchQueue, onQueueChanged, typesafeObservation]
  );

  const moveSelection = useCallback(
    (delta: number) => {
      if (items.length === 0) return;
      const current = items.findIndex((item) => item.id === selectedId);
      const next = Math.min(
        items.length - 1,
        Math.max(0, (current === -1 ? 0 : current) + delta)
      );
      setSelectedId(items[next].id);
    },
    [items, selectedId]
  );

  const shortcuts = useMemo<ShortcutDef[]>(() => {
    // Registered only while the modal is open, so these keys do not shadow
    // the page behind it. The array identity has to stay stable across
    // renders, or useRegisterShortcuts re-registers on every one (see
    // PriceEntryPill.tsx).
    if (!isOpen) return [];

    return [
      {
        id: "recon-next",
        keys: ["ArrowDown"],
        description: "Next transaction",
        category: "Sync",
        action: () => moveSelection(1),
      },
      {
        id: "recon-prev",
        keys: ["ArrowUp"],
        description: "Previous transaction",
        category: "Sync",
        action: () => moveSelection(-1),
      },
      {
        id: "recon-match",
        keys: ["Enter"],
        description: "Match the best candidate",
        category: "Sync",
        action: () => {
          if (!bestMatch || bestMatch.alreadyLinked || submitting) return;
          void resolveSelected({ action: "match", transactionId: bestMatch.transactionId });
        },
      },
      {
        id: "recon-ignore",
        keys: ["i"],
        description: "Ignore this transaction",
        category: "Sync",
        action: () => {
          if (!submitting) void resolveSelected({ action: "ignore" });
        },
      },
      {
        id: "recon-keep",
        keys: ["k"],
        description: "Keep the local transaction",
        category: "Sync",
        action: () => {
          if (canReview && !submitting) void resolveSelected({ action: "keep_local" });
        },
      },
      {
        id: "recon-unlink",
        keys: ["u"],
        description: "Unlink this transaction",
        category: "Sync",
        action: () => {
          if (canReview && !submitting) void resolveSelected({ action: "unlink" });
        },
      },
      {
        id: "recon-create",
        keys: ["c"],
        description: "Create a transaction",
        category: "Sync",
        action: () => setShowCreate(true),
      },
    ];
  }, [bestMatch, canReview, isOpen, moveSelection, resolveSelected, submitting]);

  useRegisterShortcuts(shortcuts);

  // Links with nothing to review are left out, except the current filter,
  // which must stay selectable after its last row is resolved.
  const filterOptions = useMemo(() => {
    const queued = links.filter(
      (link) => link.pendingCount + link.reviewCount > 0 || link.plaidLinkId === filterLinkId
    );
    const total = links.reduce((sum, link) => sum + link.pendingCount + link.reviewCount, 0);
    return [
      { value: "", label: `All accounts (${total})` },
      ...queued.map((link) => ({
        value: link.plaidLinkId,
        label: `${linkLabel(link)} (${link.pendingCount + link.reviewCount})`,
      })),
    ];
  }, [filterLinkId, links]);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={filterLink ? `Reconcile ${linkLabel(filterLink)}` : "Reconcile all accounts"}
      size="xl"
    >
      <div className="mb-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-64">
              <Select
                id="reconcile-account-filter"
                aria-label="Account"
                size="compact"
                value={filterLinkId ?? ""}
                options={filterOptions}
                disabled={submitting}
                onChange={(event) =>
                  setFilterLinkId(event.target.value === "" ? null : Number(event.target.value))
                }
              />
            </div>
            <span className="text-xs text-fg-tertiary tabular-nums">
              {items.length > 0 ? `${position} of ${totalCount}` : ""}
            </span>
          </div>
          {items.length > 0 && (
            <div className="hidden sm:flex items-center gap-1.5 text-xs text-fg-tertiary">
              <KeyCap>↑</KeyCap>
              <KeyCap>↓</KeyCap>
              <span>move</span>
              <KeyCap>⏎</KeyCap>
              <span>match</span>
            </div>
          )}
        </div>
        <div className="mt-1 h-[3px] w-full overflow-hidden rounded-full bg-surface-tertiary">
          <div
            className="h-full rounded-full bg-accent transition-all"
            style={{ width: `${totalCount > 0 ? (position / totalCount) * 100 : 0}%` }}
          />
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-fg-secondary">Loading reconciliation queue…</p>
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
        <div className="space-y-4">
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
                      data-testid={`queue-item-${item.id}`}
                      aria-current={selectedId === item.id ? "true" : undefined}
                      onClick={() => setSelectedId(item.id)}
                      className={`w-full text-left p-3 transition-colors ${
                        selectedId === item.id ? "bg-accent-subtle" : "hover:bg-surface-tertiary"
                      }`}
                    >
                      <div className="flex items-start gap-2">
                        {item.reviewReason !== null && (
                          <span
                            aria-hidden="true"
                            className="mt-1.5 h-1.5 w-1.5 flex-none rounded-full bg-(--fg-warning)"
                          />
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-2">
                            <p className="text-sm font-medium text-fg truncate">{item.name}</p>
                            <span className="text-sm font-semibold text-fg tabular-nums">
                              {formatCurrency(signedAmount(item.amountCents))}
                            </span>
                          </div>
                          {showAccountTags && linksById.has(item.plaidAccountLinkId) && (
                            <p
                              data-testid={`queue-item-account-${item.id}`}
                              className="mt-0.5 text-xs text-fg-secondary truncate"
                            >
                              {linkLabel(linksById.get(item.plaidAccountLinkId)!)}
                            </p>
                          )}
                          {(() => {
                            const reason = queueReason(item);
                            return (
                              <p
                                className={cn(
                                  "mt-0.5 text-xs",
                                  reason.warn ? "text-fg-warning" : "text-fg-tertiary"
                                )}
                              >
                                {formatDateShort(item.authorizedDate ?? item.date)} · {reason.text}
                              </p>
                            );
                          })()}
                        </div>
                      </div>
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
                    {loadingMore ? "Loading…" : "Load more"}
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
                      <span className="text-lg font-semibold text-fg tabular-nums">
                        {formatCurrency(signedAmount(selectedItem.amountCents))}
                      </span>
                    </div>
                    <p className="text-sm text-fg-secondary mt-1">
                      {formatDate(selectedItem.authorizedDate ?? selectedItem.date)}
                      {selectedItem.merchantName ? ` · ${selectedItem.merchantName}` : ""}
                    </p>
                    {selectedLink && (
                      <p
                        data-testid="selected-account"
                        className="text-xs text-fg-tertiary mt-1"
                      >
                        {linkLabel(selectedLink)} → {selectedLink.counterpoiseAccountName}
                      </p>
                    )}
                    {selectedItem.reviewReason && (
                      <p className="text-sm text-fg-warning mt-2">{queueReason(selectedItem).text}</p>
                    )}
                  </div>

                  <TypeSafeSuggestion result={typesafe.result} loading={typesafe.loading} candidates={selectedItem.candidates}
                    submitting={submitting} onRefresh={typesafe.refresh}
                    onMatch={(evaluationId) => void resolveSelected({ action: "typesafe", evaluationId, kind: "match" })}
                    onCreate={(evaluationId) => void resolveSelected({ action: "typesafe", evaluationId, kind: "create" })}
                    onEdit={(proposal) => {
                      // Edit copies the proposal into the ordinary Create form.
                      // The user's Create click then sends the TypeSafe
                      // observation, and the server records what was kept.
                      setSelectedCounterAccountId(proposal.category.accountId);
                      setPayeeName(proposal.payee.name);
                      setShowCreate(true);
                    }} />

                  {bestMatch && (
                    <div data-testid="best-match" className="overflow-hidden rounded-lg border border-accent">
                      <div className="flex flex-wrap items-center gap-2 border-b border-accent bg-accent-subtle px-3.5 py-2">
                        <span className="text-xs font-semibold uppercase tracking-wider text-fg-accent">
                          Best match
                        </span>
                        {candidateChips(bestMatch).map((chip) => (
                          <span
                            key={chip}
                            className="inline-flex items-center rounded-full bg-success-subtle px-2 py-0.5 text-xs font-medium text-fg-success"
                          >
                            {chip}
                          </span>
                        ))}
                      </div>
                      <div className="flex items-center gap-4 p-3.5">
                        <div className="min-w-0 flex-1">
                          <p className="text-[15px] font-semibold text-fg">
                            {bestMatch.payeeName || bestMatch.description || "(No description)"}
                          </p>
                          <p className="mt-0.5 text-13 text-fg-secondary">
                            {formatDate(bestMatch.date)}
                            {bestMatch.counterpartAccountNames.length > 0
                              ? ` · ${bestMatch.counterpartAccountNames.join(", ")}`
                              : ""}
                            {" · "}
                            <span className="tabular-nums">{formatCurrency(bestMatch.linkedSplitAmount)}</span>
                          </p>
                        </div>
                        <div className="flex flex-col gap-1.5 shrink-0">
                          <Button
                            disabled={submitting || bestMatch.alreadyLinked}
                            title={bestMatch.alreadyLinked ? "Already matched to another synced transaction" : undefined}
                            onClick={() =>
                              void resolveSelected({ action: "match", transactionId: bestMatch.transactionId })
                            }
                          >
                            {matchingAction?.transactionId === bestMatch.transactionId &&
                            matchingAction.action === "match"
                              ? "Matching…"
                              : "Match"}
                          </Button>
                          {bestMatch.amountDelta !== 0 && bestMatch.splitCount === 2 && (
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={submitting || bestMatch.alreadyLinked}
                              title={
                                bestMatch.alreadyLinked
                                  ? "Already matched to another synced transaction"
                                  : undefined
                              }
                              onClick={() =>
                                void resolveSelected({
                                  action: "match_update_amount",
                                  transactionId: bestMatch.transactionId,
                                })
                              }
                            >
                              {matchingAction?.transactionId === bestMatch.transactionId &&
                              matchingAction.action === "match_update_amount"
                                ? "Matching…"
                                : `Match & Update ${formatCurrency(Math.abs(bestMatch.expectedAmount))}`}
                            </Button>
                          )}
                        </div>
                      </div>
                    </div>
                  )}

                  {selectedItem.candidates.length === 0 && (
                    <p className="text-sm text-fg-secondary">No likely matches found.</p>
                  )}

                  {otherCandidates.length > 0 && (
                    <div>
                      <button
                        type="button"
                        aria-expanded={showOthers}
                        onClick={() => setShowOthers((prev) => !prev)}
                        className="flex w-full items-center gap-2 rounded-lg border border-border px-3 py-2 text-left text-sm hover:bg-surface-tertiary"
                      >
                        <DisclosureChevron expanded={showOthers} />
                        <span className="font-medium text-fg">
                          {otherCandidates.length} other candidate{otherCandidates.length === 1 ? "" : "s"}
                        </span>
                        <span className="ml-auto text-xs text-fg-tertiary">
                          closest is {Math.abs(otherCandidates[0].dayDelta)} day
                          {Math.abs(otherCandidates[0].dayDelta) === 1 ? "" : "s"} out,{" "}
                          {formatCurrency(otherCandidates[0].amountDelta)} apart
                        </span>
                      </button>
                      {showOthers && (
                        <div className="mt-2 space-y-2">
                          {otherCandidates.map((candidate) => {
                            const chips = candidateChips(candidate);
                            return (
                              <div
                                key={candidate.transactionId}
                                className="rounded-lg border border-border p-3"
                              >
                                <div className="flex items-start justify-between gap-2">
                                  <div className="min-w-0 flex-1">
                                    <p className="text-sm font-semibold text-fg truncate">
                                      {candidate.payeeName || candidate.description || "(No description)"}
                                    </p>
                                    <div className="flex flex-wrap items-center gap-1.5 mt-1.5 text-sm text-fg-secondary">
                                      <span>{formatDate(candidate.date)}</span>
                                      {chips.length > 0 && (
                                        <>
                                          <span className="text-fg-tertiary">·</span>
                                          <span>{chips.join(" · ")}</span>
                                        </>
                                      )}
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
                  )}

                  <div>
                    <button
                      type="button"
                      aria-expanded={showCreate}
                      onClick={() => setShowCreate((prev) => !prev)}
                      className="flex w-full items-center gap-2 rounded-lg border border-border px-3 py-2 text-left text-sm hover:bg-surface-tertiary"
                    >
                      <DisclosureChevron expanded={showCreate} />
                      <span className="font-medium text-fg">Create new transaction</span>
                    </button>
                    {showCreate && (
                      <div className="mt-2 space-y-3 rounded-lg border border-border p-3">
                        <AccountAutocomplete
                          accounts={eligibleCounterAccounts}
                          value={selectedCounterAccountId}
                          onChange={setSelectedCounterAccountId}
                          label="Counter account"
                          placeholder="Search accounts…"
                        />
                        <PayeeAutocomplete
                          payees={payeeSuggestions}
                          textValue={payeeName}
                          onTextChange={setPayeeName}
                          label="Payee"
                          placeholder="Search for a payee…"
                        />
                        <div className="flex justify-end">
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
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div
            data-testid="resolve-footer"
            className="flex flex-wrap items-center gap-2 border-t border-border pt-4"
          >
            <Button
              variant="secondary"
              disabled={submitting}
              onClick={() => void resolveSelected({ action: "ignore" })}
            >
              Ignore
            </Button>
            <Button
              variant="secondary"
              disabled={submitting || !canReview}
              onClick={() => void resolveSelected({ action: "keep_local" })}
            >
              Keep local
            </Button>
            <Button
              variant="secondary"
              disabled={submitting || !canReview}
              onClick={() => void resolveSelected({ action: "unlink" })}
            >
              Unlink
            </Button>
            <span className="ml-auto text-xs text-fg-tertiary">
              Keep local and Unlink apply to rows the bank changed
            </span>
          </div>
        </div>
      )}
    </Modal>
  );
}
