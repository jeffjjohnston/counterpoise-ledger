"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams, useRouter } from "@/lib/navigation";
import { PayeeSpendingChart } from "@/components/payees/PayeeSpendingChart";
import { TransactionList } from "@/components/transactions/TransactionList";
import { TransactionForm } from "@/components/transactions/TransactionForm";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { flattenAccounts } from "@/lib/wasm-client";
import { useBookId } from "@/hooks/useBookId";
import { useLatestRequest, useReloadsInFlight } from "@/hooks/useLatestRequest";
import { useLiveReload } from "@/components/BookChangesProvider";
import { useBookRole } from "@/components/BookRoleProvider";
import { ApiError, apiGet, apiDelete, toMessage } from "@/lib/api-client";
import {
  putTransaction,
  deleteTransactionRequest,
  isTransactionConflict,
  TRANSACTION_CONFLICT_MESSAGE,
} from "@/lib/transaction-requests";
import { useToast } from "@/components/ui/ToastProvider";
import type {
  AccountWithBalance,
  InvestmentSplitInput,
  SplitInput,
  TransactionWithSplits,
} from "@/types";

type PayeeDetail = {
  id: number;
  name: string;
  transactionCount: number;
};

const PAGE_SIZE = 50;

// The tables whose rows the page shows: the payee and its count, its
// transactions with their splits, accounts and securities, and the account
// list of the editor. The chart reads the same tables.
const PAYEE_TABLES = new Set([
  "payees", "transactions", "transaction_splits", "accounts", "investment_splits", "securities",
]);

export default function PayeeDetailPage() {
  const bookId = useBookId();
  const { canWrite } = useBookRole();
  const toast = useToast();
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const payeeId = Number(params.id);
  const [deleting, setDeleting] = useState(false);
  const [payee, setPayee] = useState<PayeeDetail | null>(null);
  const [transactions, setTransactions] = useState<TransactionWithSplits[]>([]);
  const [accounts, setAccounts] = useState<AccountWithBalance[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [editingTransaction, setEditingTransaction] =
    useState<TransactionWithSplits | null>(null);
  const [loading, setLoading] = useState(true);
  const [chartVersion, setChartVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // Set when a "load more" fetch fails; stops the IntersectionObserver
  // effect from immediately re-triggering (see handleLoadMore) so a failure
  // doesn't become an unbounded retry loop. Cleared on the next successful
  // page-0 refresh (refreshData) and at the start of the next attempt.
  const [loadMoreFailed, setLoadMoreFailed] = useState(false);
  const loadMoreRef = useRef<HTMLDivElement>(null);
  // A live update can start a reload while another is in flight. Only the
  // latest reload may publish its answer.
  const nextRequest = useLatestRequest();
  // Counts the reloads. A "load more" page that started before a reload
  // belongs to the old list, so it must not go on the end of the new list.
  const reloads = useRef(0);
  // Whether a reload is in flight. A "load more" waits for it.
  const inFlight = useReloadsInFlight();
  // Whether this payee has rendered. A live reload can overtake the first
  // load, so the first answer, not the first request, decides between the
  // full-page error and a quiet failure.
  const shown = useRef(false);

  const fetchTransactionsPage = useCallback(
    async (pageOffset: number, limit: number = PAGE_SIZE) => {
      const params = new URLSearchParams({
        payeeId: payeeId.toString(),
        limit: limit.toString(),
        offset: pageOffset.toString(),
        includeMeta: "true",
      });

      // apiGet throws on a non-ok response (rather than resolving), so the
      // callers' catch blocks run: both refreshData's full-page/background-
      // refresh handling and handleLoadMore's loadMoreFailed guard depend on
      // this rejecting — an HTTP error that silently resolved would
      // otherwise sail through as an empty page and defeat both.
      const transactionsData = await apiGet<{
        transactions?: TransactionWithSplits[];
        totalCount?: number;
      }>(`/api/b/${bookId}/transactions?${params.toString()}`);
      const pageTransactions: TransactionWithSplits[] = transactionsData.transactions ?? [];
      return {
        transactions: pageTransactions,
        totalCount: transactionsData.totalCount || pageTransactions.length,
      };
    },
    [bookId, payeeId]
  );

  // `limit` is the number of transactions to load from the start. A live
  // reload gives the number that the list shows, so that the list keeps its
  // length and the scroll position stays.
  const refreshData = useCallback(async (showLoading: boolean, limit: number = PAGE_SIZE) => {
    if (!Number.isFinite(payeeId)) {
      setLoading(false);
      return;
    }

    const isLatest = nextRequest();
    reloads.current += 1;
    const end = inFlight.begin();
    if (showLoading) {
      shown.current = false;
      setLoading(true);
    }

    try {
      // Each request degrades independently on failure rather than throwing
      // to the outer catch: a missing payee means "not found" (payee stays
      // null, driving the not-found view below), and a missing account list
      // just leaves the split editor without options — neither should turn
      // into the full-page error state fetchTransactionsPage below is
      // allowed to trigger.
      const [payeeData, accountsData] = await Promise.all([
        apiGet<PayeeDetail>(`/api/b/${bookId}/payees/${payeeId}`).catch((e: unknown) => {
          // After the first answer, only a 404 means "not found" (for
          // example, another client deleted the payee). A failure of another
          // kind then keeps the payee on the screen.
          if (!shown.current || (e instanceof ApiError && e.status === 404)) return null;
          throw e;
        }),
        apiGet<AccountWithBalance[]>(`/api/b/${bookId}/accounts?includeInactive=true`).catch(
          () => null
        ),
      ]);

      // The transaction list refuses the id of a payee that does not exist,
      // so do not ask for it. The page then shows its not-found state.
      const page = payeeData
        ? await fetchTransactionsPage(0, limit)
        : { transactions: [], totalCount: 0 };
      if (!isLatest()) return;
      setPayee(payeeData);
      setAccounts(accountsData ? flattenAccounts(accountsData) : []);
      setTransactions(page.transactions);
      setTotalCount(page.totalCount);
      setLoadMoreFailed(false);
      setError(null);
      shown.current = true;
      setLoading(false);
    } catch {
      if (!isLatest()) return;
      if (!shown.current) {
        // Nothing has rendered yet — the full-page error state is correct.
        setError("Could not load payee.");
      } else {
        // A background refresh (after an edit or delete) failed. The
        // already-rendered payee and transaction list are still correct, so
        // keep them on screen; unlike the other write failures on this page,
        // this one stays console-only rather than surfacing a toast, the
        // same way the load-more failure below does.
        console.error("Could not refresh payee data.");
      }
    } finally {
      end();
    }
  }, [bookId, fetchTransactionsPage, inFlight, nextRequest, payeeId]);

  const handleLoadMore = useCallback(async () => {
    if (loadingMore || transactions.length >= totalCount) {
      return;
    }

    // A reload is in flight: its list replaces the list on the screen. Wait
    // for it, and add nothing. The end of the wait changes `loadingMore`, so
    // the observer below tries again with the new list.
    const reload = inFlight.settled();
    if (reload) {
      setLoadingMore(true);
      await reload;
      setLoadingMore(false);
      return;
    }
    setLoadingMore(true);
    // Clear any prior failure as this new attempt begins — whether it was
    // triggered automatically or via the "Try again" control.
    setLoadMoreFailed(false);
    const started = reloads.current;
    try {
      const page = await fetchTransactionsPage(transactions.length);
      if (reloads.current !== started) return;
      setTransactions((prev) => [...prev, ...page.transactions]);
      setTotalCount(page.totalCount);
    } catch {
      if (reloads.current !== started) return;
      // A failed "load more" leaves the already-rendered list intact; this
      // page has no toast system, so log it. It also sets loadMoreFailed,
      // which the observer effect below checks before auto-triggering
      // again — without it, the observer effect re-runs (loadingMore is one
      // of its deps) and re-observes a sentinel that's still on-screen,
      // firing an immediate "intersecting" callback that would otherwise
      // retry forever. The user can still retry deliberately via the
      // "Try again" control, which clears the flag itself.
      console.error("Failed to load more transactions");
      setLoadMoreFailed(true);
    } finally {
      setLoadingMore(false);
    }
  }, [fetchTransactionsPage, inFlight, loadingMore, totalCount, transactions.length]);

  useEffect(() => {
    const fetchPayee = async () => {
      await refreshData(true);
    };

    // refreshData already catches its own errors into `error`, so this
    // cannot reject.
    void fetchPayee();
  }, [refreshData]);

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      (entries) => {
        const target = entries[0];
        if (
          target.isIntersecting &&
          !loadingMore &&
          !loadMoreFailed &&
          transactions.length < totalCount
        ) {
          // handleLoadMore already catches its own errors in a
          // try/finally; it cannot reject.
          void handleLoadMore();
        }
      },
      {
        root: null,
        rootMargin: "100px",
        threshold: 0.1,
      }
    );

    const currentRef = loadMoreRef.current;
    if (currentRef) {
      observer.observe(currentRef);
    }

    return () => {
      if (currentRef) {
        observer.unobserve(currentRef);
      }
    };
  }, [handleLoadMore, loadingMore, loadMoreFailed, totalCount, transactions.length]);

  // Another client (an MCP tool, another tab, a scheduled job) changed the
  // book. While the editor is open, the reload waits until it closes, so that
  // the reload does not replace the draft.
  useLiveReload(
    PAYEE_TABLES,
    () => {
      setChartVersion((version) => version + 1);
      void refreshData(false, Math.max(PAGE_SIZE, transactions.length));
    },
    { paused: editingTransaction !== null },
  );

  // A save or a delete changes the monthly totals, so the chart fetches them again.
  const refreshAfterChange = async () => {
    setChartVersion((version) => version + 1);
    await refreshData(false);
  };

  const handleUpdateTransaction = async (data: {
    date: string;
    description: string;
    notes?: string;
    checkNumber?: string;
    payeeName?: string;
    splits: SplitInput[];
    investmentSplits?: InvestmentSplitInput[];
  }) => {
    if (!editingTransaction) return false;

    // Caught here (rather than left to TransactionForm): its onSubmit prop is
    // called synchronously with no await and no catch of its own, so an
    // uncaught rejection here would be an unhandled promise rejection.
    try {
      await putTransaction(bookId, editingTransaction, data);
      setEditingTransaction(null);
      await refreshAfterChange();
      return true;
    } catch (e) {
      if (isTransactionConflict(e)) {
        toast.error(TRANSACTION_CONFLICT_MESSAGE);
        setEditingTransaction(null);
        await refreshAfterChange();
        return false;
      }
      toast.error(toMessage(e, "Failed to update transaction"));
      return false;
    }
  };

  const handleDeleteTransaction = async () => {
    if (!editingTransaction) return;

    if (!confirm("Are you sure you want to delete this transaction?")) return;

    // Caught here — see handleUpdateTransaction above: TransactionForm calls
    // onDelete directly from a button's onClick with no await and no catch.
    try {
      await deleteTransactionRequest(bookId, editingTransaction);
      setEditingTransaction(null);
      await refreshAfterChange();
    } catch (e) {
      if (isTransactionConflict(e)) {
        toast.error(TRANSACTION_CONFLICT_MESSAGE);
        setEditingTransaction(null);
        await refreshAfterChange();
        return;
      }
      toast.error(toMessage(e, "Failed to delete transaction"));
    }
  };

  const handleDeletePayee = async () => {
    if (!confirm("Are you sure you want to delete this payee?")) return;

    setDeleting(true);
    try {
      await apiDelete(`/api/b/${bookId}/payees/${payeeId}`);
      router.push(`/b/${bookId}/payees`);
    } catch (e) {
      toast.error(toMessage(e, "Failed to delete payee"));
      setDeleting(false);
    }
  };

  if (error) {
    return (
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <p className="text-danger">{error}</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-surface-tertiary rounded w-48" />
          <div className="h-64 bg-surface-tertiary rounded-lg" />
        </div>
      </div>
    );
  }

  if (!payee) {
    return (
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="bg-surface rounded-lg border border-border p-6 text-fg-tertiary">
          Payee not found.
        </div>
        <div className="mt-4">
          <Link href={`/b/${bookId}/payees`} className="text-fg-accent hover:text-fg-accent">
            &larr; Back to Payees
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <p className="text-sm text-fg-tertiary">Payee</p>
          <h1 className="text-2xl font-bold text-fg">{payee.name}</h1>
          <div className="mt-2">
            <Link href={`/b/${bookId}/payees`} className="text-fg-accent hover:text-fg-accent">
              &larr; Back to Payees
            </Link>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-sm text-fg-tertiary">
            {payee.transactionCount} transaction
            {payee.transactionCount === 1 ? "" : "s"}
          </div>
          {canWrite && payee.transactionCount === 0 && (
            <Button
              variant="danger"
              size="sm"
              onClick={handleDeletePayee}
              disabled={deleting}
            >
              {deleting ? "Deleting..." : "Delete Payee"}
            </Button>
          )}
        </div>
      </div>

      <div className="mb-6">
        <PayeeSpendingChart bookId={bookId} payeeId={payeeId} refreshKey={chartVersion} />
      </div>

      <div className="bg-surface rounded-lg border border-border overflow-hidden">
        <TransactionList
          transactions={transactions}
          accounts={accounts}
          selectedAccountId={null}
          onEdit={setEditingTransaction}
        />
        {transactions.length > 0 && transactions.length < totalCount && (
          <div
            ref={loadMoreRef}
            className="px-6 py-4 border-t border-border flex justify-center"
          >
            {loadingMore ? (
              <div className="flex items-center gap-2 text-sm text-fg-tertiary">
                <div className="w-4 h-4 border-2 border-border border-t-accent rounded-full animate-spin" />
                <span>Loading more transactions...</span>
              </div>
            ) : loadMoreFailed ? (
              <button
                type="button"
                onClick={() => void handleLoadMore()}
                className="text-sm text-fg-accent hover:underline"
              >
                Could not load more transactions. Try again.
              </button>
            ) : (
              <div className="text-sm text-fg-tertiary">Scroll for more</div>
            )}
          </div>
        )}
      </div>

      <Modal
        isOpen={!!editingTransaction}
        onClose={() => setEditingTransaction(null)}
        title="Edit Transaction"
        size="lg"
      >
        {editingTransaction && (
          <TransactionForm
            accounts={accounts}
            selectedAccountId={null}
            editingTransaction={editingTransaction}
            onSubmit={handleUpdateTransaction}
            onCancel={() => setEditingTransaction(null)}
            onDelete={handleDeleteTransaction}
            onAccountsUpdate={() => refreshData(false)}
            readOnly={!canWrite}
          />
        )}
      </Modal>
    </div>
  );
}
