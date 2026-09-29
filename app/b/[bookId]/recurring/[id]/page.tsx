"use client";

import { useCallback, useEffect, useState } from "react";
import { Link, useParams, useRouter } from "@/lib/navigation";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { TransactionList } from "@/components/transactions/TransactionList";
import { TransactionForm } from "@/components/transactions/TransactionForm";
import { RecurringForm } from "@/components/recurring/RecurringForm";
import { formatCurrency, formatDate, toDateString } from "@/lib/wasm-client";
import { describeRecurrence, flattenAccounts } from "@/lib/wasm-client";
import {
  buildRuleRecurrenceConfig,
  isRecurringRuleDue,
  previewOccurrences,
} from "@/lib/wasm-client";
import { cn } from "@/lib/utils";
import { useBookId } from "@/hooks/useBookId";
import { useBookRole } from "@/components/BookRoleProvider";
import { apiDelete, apiGet, apiPost, apiPut, toMessage } from "@/lib/api-client";
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
  RecurringRuleWithSplits,
  SplitInput,
  TransactionWithSplits,
} from "@/types";

/**
 * Twelve, with a Load more rather than an infinite scroll. A rule's history is
 * a bounded list someone reads deliberately — unlike the payee page's register,
 * which is the whole point of that screen and scrolls.
 */
const HISTORY_PAGE_SIZE = 12;

const PREVIEW_COUNT = 3;

type ProcessResult = {
  transactionsCreated: number;
  skipped?: Array<{ ruleId: number; reason: string }>;
};

/** Mirrors the list page: "created 0" alone never says why. */
function describeProcessResult(data: ProcessResult): string {
  const created = `Created ${data.transactionsCreated} transaction(s)`;
  if (!data.skipped?.length) return created;

  const reasons = data.skipped.map((s) => `rule ${s.ruleId}: ${s.reason}`).join("\n");
  return `${created}\n\nSkipped ${data.skipped.length} rule(s) — these stay due until fixed:\n${reasons}`;
}

/**
 * The two schedule flags as sentences.
 *
 * They are stored as a boolean and a small integer and were legible only
 * inside the edit form, where each is a control rather than a statement.
 */
function describeBusinessDays(businessDaysOnly: boolean): string {
  return businessDaysOnly
    ? "An occurrence that lands on a weekend moves to the next business day."
    : "Occurrences keep their scheduled date, weekends included.";
}

function describeLeadTime(autoCreateDaysBefore: number): string {
  if (autoCreateDaysBefore <= 0) {
    return "The transaction is created on the day it is due.";
  }
  const days = autoCreateDaysBefore === 1 ? "1 day" : `${autoCreateDaysBefore} days`;
  return `The transaction is created up to ${days} before it is due.`;
}

function SectionCard({
  title,
  testId,
  children,
}: {
  title: string;
  testId?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      data-testid={testId}
      className="bg-surface rounded-lg border border-border shadow-soft overflow-hidden"
    >
      <div className="px-6 py-3 border-b border-border-secondary">
        <h2 className="text-sm font-semibold text-fg">{title}</h2>
      </div>
      <div className="px-6 py-4">{children}</div>
    </section>
  );
}

export default function RecurringRuleDetailPage() {
  const bookId = useBookId();
  const { canWrite } = useBookRole();
  const toast = useToast();
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const ruleId = Number(params.id);

  const [rule, setRule] = useState<RecurringRuleWithSplits | null>(null);
  const [accounts, setAccounts] = useState<AccountWithBalance[]>([]);
  const [transactions, setTransactions] = useState<TransactionWithSplits[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editingTransaction, setEditingTransaction] =
    useState<TransactionWithSplits | null>(null);
  const [deleting, setDeleting] = useState(false);

  const fetchHistoryPage = useCallback(
    async (offset: number, append: boolean) => {
      // The shared transactions endpoint, filtered by rule — the same one the
      // payee detail page pages through. There is no per-rule history route.
      const query = new URLSearchParams({
        recurringRuleId: ruleId.toString(),
        limit: HISTORY_PAGE_SIZE.toString(),
        offset: offset.toString(),
        includeMeta: "true",
      });

      const data = await apiGet<{
        transactions?: TransactionWithSplits[];
        totalCount?: number;
      }>(`/api/b/${bookId}/transactions?${query.toString()}`);

      const page = data.transactions ?? [];
      setTransactions((prev) => (append ? [...prev, ...page] : page));
      setTotalCount(data.totalCount ?? page.length);
    },
    [bookId, ruleId]
  );

  const refreshData = useCallback(
    async (showLoading: boolean) => {
      if (!Number.isFinite(ruleId)) {
        setLoading(false);
        return;
      }

      if (showLoading) setLoading(true);

      try {
        // Each read degrades on its own. A missing rule is "not found" (the
        // view below), and a missing account list only costs the edit form its
        // options — neither is the full-page error state.
        const [ruleData, accountsData] = await Promise.all([
          apiGet<RecurringRuleWithSplits>(`/api/b/${bookId}/recurring/${ruleId}`).catch(
            () => null
          ),
          apiGet<AccountWithBalance[]>(
            `/api/b/${bookId}/accounts?includeInactive=true`
          ).catch(() => null),
        ]);

        setRule(ruleData);
        setAccounts(accountsData ? flattenAccounts(accountsData) : []);

        // A rule deleted elsewhere still has transactions — recurringRuleId is
        // ON DELETE SET NULL — but nothing to show them under, and the history
        // read would 400 on an id this book no longer owns.
        if (ruleData) {
          await fetchHistoryPage(0, false);
        } else {
          setTransactions([]);
          setTotalCount(0);
        }
        setError(null);
      } catch {
        if (showLoading) {
          setError("Could not load this recurring rule.");
        } else {
          // The rule and history already on screen are still correct; keep
          // them rather than blanking the page.
          toast.error("Could not refresh this recurring rule.");
        }
      } finally {
        if (showLoading) setLoading(false);
      }
    },
    [bookId, fetchHistoryPage, ruleId, toast]
  );

  useEffect(() => {
    // refreshData catches its own errors into `error`; it cannot reject.
    void refreshData(true);
  }, [refreshData]);

  const handleLoadMore = async () => {
    if (loadingMore || transactions.length >= totalCount) return;

    setLoadingMore(true);
    try {
      await fetchHistoryPage(transactions.length, true);
    } catch (e) {
      // The rows already on screen stay; the button stays too, so the user can
      // try again without reloading the page.
      toast.error(toMessage(e, "Could not load more transactions"));
    } finally {
      setLoadingMore(false);
    }
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
    if (!editingTransaction) return;

    // Caught here rather than left to TransactionForm: its onSubmit prop is
    // called with no await and no catch of its own, so an uncaught rejection
    // would be an unhandled promise rejection.
    try {
      await putTransaction(bookId, editingTransaction, data);
      setEditingTransaction(null);
      await refreshData(false);
    } catch (e) {
      if (isTransactionConflict(e)) {
        toast.error(TRANSACTION_CONFLICT_MESSAGE);
        setEditingTransaction(null);
        await refreshData(false);
        return;
      }
      toast.error(toMessage(e, "Failed to update transaction"));
    }
  };

  const handleDeleteTransaction = async () => {
    if (!editingTransaction) return;
    if (!confirm("Are you sure you want to delete this transaction?")) return;

    try {
      await deleteTransactionRequest(bookId, editingTransaction);
      setEditingTransaction(null);
      await refreshData(false);
    } catch (e) {
      if (isTransactionConflict(e)) {
        toast.error(TRANSACTION_CONFLICT_MESSAGE);
        setEditingTransaction(null);
        await refreshData(false);
        return;
      }
      toast.error(toMessage(e, "Failed to delete transaction"));
    }
  };

  const handleProcess = async () => {
    try {
      const data = await apiPost<ProcessResult>(`/api/b/${bookId}/recurring/process`, {
        ruleId,
      });
      await refreshData(false);
      const message = describeProcessResult(data);
      if (data.skipped?.length) {
        toast.error(message);
      } else {
        toast.success(message);
      }
    } catch (e) {
      toast.error(toMessage(e, "Failed to process the rule"));
    }
  };

  const handleDelete = async () => {
    if (deleting) return;
    if (!confirm("Are you sure you want to delete this recurring rule?")) return;

    setDeleting(true);
    try {
      await apiDelete(`/api/b/${bookId}/recurring/${ruleId}`);
      // The rule is gone, so this page is about nothing. Its transactions
      // survive with a null link and stay reachable from the register.
      router.push(`/b/${bookId}/recurring`);
    } catch (e) {
      toast.error(toMessage(e, "Failed to delete recurring rule"));
      setDeleting(false);
    }
  };

  if (error) {
    return (
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <p className="text-danger">{error}</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-surface-tertiary rounded w-48" />
          <div className="h-64 bg-surface-tertiary rounded-lg" />
        </div>
      </div>
    );
  }

  if (!rule) {
    return (
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="bg-surface rounded-lg border border-border p-6 text-fg-tertiary">
          Recurring rule not found.
        </div>
        <div className="mt-4">
          <Link
            href={`/b/${bookId}/recurring`}
            className="text-fg-accent hover:text-fg-accent"
          >
            &larr; Back to Recurring
          </Link>
        </div>
      </div>
    );
  }

  const today = toDateString(new Date());
  const isDue =
    rule.isActive &&
    isRecurringRuleDue(
      rule.nextDate,
      today,
      rule.autoCreateDaysBefore ?? 0,
      rule.businessDaysOnly
    );
  const config = buildRuleRecurrenceConfig(rule);
  const recurrenceText = describeRecurrence({
    frequency: rule.frequency,
    interval: rule.interval ?? 1,
    daysOfWeek: config.daysOfWeek ?? null,
    weekOfMonth: config.weekOfMonth ?? null,
    daysOfMonth: config.daysOfMonth ?? null,
  });
  // Seeded from the stored nextDate rather than re-derived from startDate: the
  // stored date is what the processor will actually act on.
  const upcoming = previewOccurrences({
    config,
    startDate: rule.startDate,
    businessDaysOnly: rule.businessDaysOnly,
    seed: rule.nextDate,
    count: PREVIEW_COUNT,
  });

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-6">
        <p className="text-sm text-fg-tertiary">Recurring rule</p>
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-bold text-fg">{rule.name}</h1>
          <span
            className={cn(
              "text-xs px-2 py-0.5 rounded-full",
              rule.isActive
                ? "bg-accent-subtle text-fg-accent"
                : "bg-surface-tertiary text-fg-tertiary"
            )}
          >
            {rule.isActive ? "Active" : "Paused"}
          </span>
          {isDue && (
            <span className="text-xs px-2 py-0.5 bg-warning-subtle text-fg-warning rounded-full">
              Due
            </span>
          )}
        </div>
        {/* Payee and description are separate facts and each is often quoted
            on its own, so they get an element each rather than one run of
            text with a separator glued into the middle. */}
        <div className="mt-1 flex flex-wrap items-center gap-x-2 text-sm text-fg-tertiary">
          {rule.payee && <span className="text-fg-secondary">{rule.payee.name}</span>}
          {rule.payee && rule.templateDescription && <span aria-hidden>·</span>}
          {rule.templateDescription && <span>{rule.templateDescription}</span>}
        </div>
        <div className="mt-2 flex items-center justify-between gap-4">
          <Link
            href={`/b/${bookId}/recurring`}
            className="text-fg-accent hover:text-fg-accent"
          >
            &larr; Back to Recurring
          </Link>
          <div className="flex items-center gap-2">
            {canWrite && (
              <>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={handleProcess}
                  title={
                    isDue
                      ? "Create the transaction this rule is due for"
                      : "Create this rule's next occurrence now, before it is due"
                  }
                >
                  Process Now
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleDelete}
                  disabled={deleting}
                  className="text-fg-danger hover:text-fg-danger"
                >
                  {deleting ? "Deleting..." : "Delete"}
                </Button>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="space-y-6">
        <SectionCard title="Schedule" testId="rule-schedule">
          <p className="text-sm text-fg">{recurrenceText}</p>
          <dl className="mt-3 space-y-1 text-sm">
            <div className="flex gap-2">
              <dt className="text-fg-tertiary">Next {upcoming.length}:</dt>
              <dd className="text-fg-secondary flex flex-wrap gap-x-3">
                {upcoming.map((date) => (
                  <span key={date}>{formatDate(date)}</span>
                ))}
              </dd>
            </div>
            {rule.endDate && (
              <div className="flex gap-2">
                <dt className="text-fg-tertiary">Ends:</dt>
                <dd className="text-fg-secondary">{formatDate(rule.endDate)}</dd>
              </div>
            )}
          </dl>
          <ul className="mt-3 space-y-1 text-sm text-fg-tertiary">
            <li>{describeBusinessDays(rule.businessDaysOnly)}</li>
            <li>{describeLeadTime(rule.autoCreateDaysBefore ?? 0)}</li>
          </ul>
        </SectionCard>

        <SectionCard title="Template" testId="rule-template">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase text-fg-tertiary">
                <th className="pb-2 font-medium">Account</th>
                <th className="pb-2 font-medium text-right">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-secondary">
              {rule.templateSplits.map((split) => (
                <tr key={split.id}>
                  <td className="py-2 text-fg">{split.account.name}</td>
                  <td className="py-2 text-right text-fg tabular-nums">
                    {formatCurrency(split.amount)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </SectionCard>

        <section className="bg-surface rounded-lg border border-border shadow-soft overflow-hidden">
          <div className="px-6 py-3 border-b border-border-secondary flex items-center justify-between">
            <h2 className="text-sm font-semibold text-fg">History</h2>
            <span className="text-xs text-fg-tertiary">
              {totalCount} transaction{totalCount === 1 ? "" : "s"}
            </span>
          </div>
          {transactions.length === 0 ? (
            <div className="px-6 py-8 text-center text-sm text-fg-tertiary">
              This rule has not created any transactions yet.
            </div>
          ) : (
            <>
              <TransactionList
                transactions={transactions}
                accounts={accounts}
                selectedAccountId={null}
                onEdit={setEditingTransaction}
              />
              {transactions.length < totalCount && (
                <div className="px-6 py-4 border-t border-border flex justify-center">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={handleLoadMore}
                    disabled={loadingMore}
                  >
                    {loadingMore ? "Loading..." : "Load more"}
                  </Button>
                </div>
              )}
            </>
          )}
        </section>
      </div>

      <Modal
        isOpen={!!editingTransaction}
        onClose={() => setEditingTransaction(null)}
        title={canWrite ? "Edit Transaction" : "Transaction"}
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

      {/* The role can drop to viewer while the form is open: the role loads
          after the page, and an owner can demote a member at any time. A
          viewer must not keep an editable form. */}
      <Modal
        isOpen={editing && canWrite}
        onClose={() => setEditing(false)}
        title="Edit Recurring Transaction"
        size="lg"
      >
        {editing && canWrite && (
          <RecurringForm
            rule={rule}
            accounts={accounts}
            bookId={bookId}
            onSubmit={async (data) => {
              try {
                await apiPut(`/api/b/${bookId}/recurring/${ruleId}`, data);
                setEditing(false);
                await refreshData(false);
              } catch (e) {
                toast.error(toMessage(e, "Failed to update recurring rule"));
              }
            }}
            onCancel={() => setEditing(false)}
          />
        )}
      </Modal>
    </div>
  );
}
