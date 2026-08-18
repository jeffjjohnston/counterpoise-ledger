"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { TransactionList } from "@/components/transactions/TransactionList";
import { TransactionForm } from "@/components/transactions/TransactionForm";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { flattenAccounts } from "@/lib/accounting";
import { useBookId } from "@/hooks/useBookId";
import { apiGet, apiPut, apiDelete, toMessage } from "@/lib/api-client";
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

export default function PayeeDetailPage() {
  const bookId = useBookId();
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
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // Set when a "load more" fetch fails; stops the IntersectionObserver
  // effect from immediately re-triggering (see handleLoadMore) so a failure
  // doesn't become an unbounded retry loop. Cleared on the next successful
  // page-0 refresh (refreshData) and at the start of the next attempt.
  const [loadMoreFailed, setLoadMoreFailed] = useState(false);
  const loadMoreRef = useRef<HTMLDivElement>(null);

  const fetchTransactionsPage = useCallback(
    async (pageOffset: number, append: boolean) => {
      const params = new URLSearchParams({
        payeeId: payeeId.toString(),
        limit: PAGE_SIZE.toString(),
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
      setTransactions((prev) =>
        append ? [...prev, ...pageTransactions] : pageTransactions
      );
      setTotalCount(transactionsData.totalCount || pageTransactions.length);
    },
    [bookId, payeeId]
  );

  const refreshData = useCallback(async (showLoading: boolean) => {
    if (!Number.isFinite(payeeId)) {
      setLoading(false);
      return;
    }

    if (showLoading) {
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
        apiGet<PayeeDetail>(`/api/b/${bookId}/payees/${payeeId}`).catch(() => null),
        apiGet<AccountWithBalance[]>(`/api/b/${bookId}/accounts?includeInactive=true`).catch(
          () => null
        ),
      ]);

      setPayee(payeeData);
      setAccounts(accountsData ? flattenAccounts(accountsData) : []);

      await fetchTransactionsPage(0, false);
      setLoadMoreFailed(false);
      setError(null);
    } catch {
      if (showLoading) {
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
      if (showLoading) {
        setLoading(false);
      }
    }
  }, [bookId, fetchTransactionsPage, payeeId]);

  const handleLoadMore = useCallback(async () => {
    if (loadingMore || transactions.length >= totalCount) {
      return;
    }

    setLoadingMore(true);
    // Clear any prior failure as this new attempt begins — whether it was
    // triggered automatically or via the "Try again" control.
    setLoadMoreFailed(false);
    try {
      await fetchTransactionsPage(transactions.length, true);
    } catch {
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
  }, [fetchTransactionsPage, loadingMore, totalCount, transactions.length]);

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

  const handleUpdateTransaction = async (data: {
    date: string;
    description: string;
    notes?: string;
    checkNumber?: string;
    payeeName?: string;
    splits: SplitInput[];
    investmentSplits?: InvestmentSplitInput[];
  }) => {
    if (!editingTransaction) return;

    // Caught here (rather than left to TransactionForm): its onSubmit prop is
    // called synchronously with no await and no catch of its own, so an
    // uncaught rejection here would be an unhandled promise rejection.
    try {
      await apiPut(`/api/b/${bookId}/transactions/${editingTransaction.id}`, data);
      setEditingTransaction(null);
      await refreshData(false);
    } catch (e) {
      toast.error(toMessage(e, "Failed to update transaction"));
    }
  };

  const handleDeleteTransaction = async () => {
    if (!editingTransaction) return;

    if (!confirm("Are you sure you want to delete this transaction?")) return;

    // Caught here — see handleUpdateTransaction above: TransactionForm calls
    // onDelete directly from a button's onClick with no await and no catch.
    try {
      await apiDelete(`/api/b/${bookId}/transactions/${editingTransaction.id}`);
      setEditingTransaction(null);
      await refreshData(false);
    } catch (e) {
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
          {payee.transactionCount === 0 && (
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
          />
        )}
      </Modal>
    </div>
  );
}
