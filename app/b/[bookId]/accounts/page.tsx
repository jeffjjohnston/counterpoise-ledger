"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { EmptyState } from "@/components/ui/EmptyState";
import { AccountForm } from "@/components/accounts/AccountForm";
import { CategoryIcon } from "@/components/ui/CategoryIcon";
import { formatCurrency, getAccountShortName } from "@/lib/formatters";
import {
  ACCOUNT_TYPE_LABELS,
  ACCOUNT_TYPE_ORDER,
  ACCOUNT_SUBTYPE_LABELS,
  buildAccountTree,
  buildCategoryLabelMap,
  flattenAccountTreeWithDepth,
  flattenAccounts,
  getDisplayBalance,
} from "@/lib/accounting";
import { cn } from "@/lib/utils";
import { useBookId } from "@/hooks/useBookId";
import { apiGet, apiPost, apiPut, apiDelete, toMessage } from "@/lib/api-client";
import { useToast } from "@/components/ui/ToastProvider";
import type { AccountMarketValue } from "@/lib/investments";
import type { AccountWithBalance } from "@/types";

export default function AccountsPage() {
  const bookId = useBookId();
  const toast = useToast();
  const [accounts, setAccounts] = useState<AccountWithBalance[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [editingAccount, setEditingAccount] =
    useState<AccountWithBalance | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [marketValues, setMarketValues] = useState<AccountMarketValue[]>([]);
  const [expandedSubtypes, setExpandedSubtypes] = useState<Set<string>>(
    new Set(["bank", "investment", "credit_card", "loan", "cash", "other"])
  );

  const fetchAccounts = useCallback(
    async (showLoading: boolean) => {
      try {
        const data = await apiGet<AccountWithBalance[]>(
          `/api/b/${bookId}/accounts?includeInactive=true`
        );
        setAccounts(flattenAccounts(data));
        setError(null);
      } catch {
        // No AbortController on this page, so every rejection here is a real
        // failure. Pages that DO abort (search, reports, TransactionForm,
        // ReconciliationModal) keep their `err.name === "AbortError"` early
        // return above this branch — a cancelled request is not an error.
        if (showLoading) {
          // Nothing has rendered yet — the full-page error state is correct.
          setError("Could not load accounts.");
        } else {
          // A background refresh (after a create/update/delete/toggle) failed.
          // The already-rendered account list is still correct, so keep it on
          // screen and surface the failure without blanking the page.
          toast.error("Could not refresh accounts.");
        }
      } finally {
        // Always — this is what stops a failed initial request from hanging
        // the page on its skeleton.
        if (showLoading) {
          setLoading(false);
        }
      }
    },
    [bookId, toast]
  );

  const fetchMarketValues = useCallback(async () => {
    try {
      const data = await apiGet<AccountMarketValue[]>(
        `/api/b/${bookId}/investments/account-values`
      );
      setMarketValues(Array.isArray(data) ? data : []);
    } catch {
      // Market values are supplementary; the page is useful without them.
      setMarketValues([]);
    }
  }, [bookId]);

  useEffect(() => {
    void fetchAccounts(true);
    void fetchMarketValues();
  }, [fetchAccounts, fetchMarketValues]);

  const handleCreate = async (data: {
    name: string;
    type: string;
    subtype?: string | null;
    parentId?: number | null;
    icon?: string | null;
  }) => {
    try {
      await apiPost(`/api/b/${bookId}/accounts`, data);
      setShowModal(false);
      void fetchAccounts(false);
    } catch (e) {
      toast.error(toMessage(e, "Failed to create account"));
    }
  };

  const handleUpdate = async (data: {
    name: string;
    type: string;
    subtype?: string | null;
    parentId?: number | null;
    isActive?: boolean;
    icon?: string | null;
  }) => {
    if (!editingAccount) return;
    try {
      await apiPut(`/api/b/${bookId}/accounts/${editingAccount.id}`, data);
      setEditingAccount(null);
      void fetchAccounts(false);
    } catch (e) {
      toast.error(toMessage(e, "Failed to update account"));
    }
  };

  const handleDelete = async (id: number) => {
    // confirm() is deliberately unchanged — see the plan's Global Constraints.
    if (!confirm("Are you sure you want to delete this account?")) return;
    try {
      await apiDelete(`/api/b/${bookId}/accounts/${id}`);
      void fetchAccounts(false);
    } catch (e) {
      toast.error(toMessage(e, "Failed to delete account"));
    }
  };

  const handleToggleActive = async (account: AccountWithBalance) => {
    try {
      await apiPut(`/api/b/${bookId}/accounts/${account.id}`, {
        name: account.name,
        type: account.type,
        subtype: account.subtype,
        parentId: account.parentId,
        isActive: !account.isActive,
      });
      void fetchAccounts(false);
      void fetchMarketValues();
    } catch (e) {
      toast.error(toMessage(e, "Failed to update account"));
    }
  };

  const filteredAccounts = showInactive
    ? accounts
    : accounts.filter((a) => a.isActive);

  const groupedAccounts = filteredAccounts.reduce(
    (acc, account) => {
      if (!acc[account.type]) {
        acc[account.type] = [];
      }
      acc[account.type].push(account);
      return acc;
    },
    {} as Record<string, AccountWithBalance[]>
  );

  const sortedTypes = ACCOUNT_TYPE_ORDER.filter((t) => groupedAccounts[t]);

  // Create market value map for investment accounts
  const marketValueMap = new Map(
    marketValues.map((mv) => [mv.accountId, mv.marketValueCents])
  );

  const categoryLabels = buildCategoryLabelMap(accounts);

  const toggleSubtype = (subtype: string) => {
    const newExpanded = new Set(expandedSubtypes);
    if (newExpanded.has(subtype)) {
      newExpanded.delete(subtype);
    } else {
      newExpanded.add(subtype);
    }
    setExpandedSubtypes(newExpanded);
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
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-24 bg-surface-tertiary rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="flex items-center justify-between mb-6 gap-3">
        <h1 className="text-xl md:text-2xl font-bold text-fg">Chart of Accounts</h1>
        <div className="flex items-center gap-2 md:gap-4">
          <label className="hidden sm:flex items-center gap-2 text-sm text-fg-secondary">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
              className="rounded text-fg-accent focus:ring-border-focus"
            />
            Show Inactive
          </label>
          <Button onClick={() => setShowModal(true)} size="sm">New Account</Button>
        </div>
      </div>

      <div className="space-y-6">
        {sortedTypes.map((type) => {
          const typeAccounts: AccountWithBalance[] = groupedAccounts[type] ?? [];
          const treeAccounts = buildAccountTree(typeAccounts);
          const visibleRows = flattenAccountTreeWithDepth(treeAccounts).filter(
            ({ account }) => !account.isInvestmentCash
          );

          return (
            <div
              key={type}
              className="bg-surface rounded-lg border border-border shadow-soft overflow-hidden"
            >
              <div
                className={cn("px-4 md:px-6 py-3 md:py-4 border-b border-border border-l-4", {
                  "bg-success-subtle border-l-fg-success": type === "asset" || type === "income",
                  "bg-danger-subtle border-l-fg-danger": type === "liability",
                  "bg-accent-subtle border-l-fg-accent": type === "equity",
                  "bg-warning-subtle border-l-fg-warning": type === "expense",
                })}
              >
                <h2 className="text-lg font-semibold text-fg">
                  {ACCOUNT_TYPE_LABELS[type] || type}
                </h2>
              </div>
              <div>
                {(() => {
                  const shouldGroupBySubtype = visibleRows.some(({ account }) =>
                    Boolean(account.subtype)
                  );
                  const renderAccountRow = ({
                    account,
                    depth,
                  }: (typeof visibleRows)[number]) => {
                    const cashAccount =
                      account.subtype === "investment"
                        ? account.children?.find((child) => child.isInvestmentCash) ??
                          null
                        : null;
                    // For investment accounts, use market value if available
                    const isInvestment = account.subtype === "investment";
                    const marketValue = marketValueMap.get(account.id);
                    const totalBalance =
                      isInvestment
                        ? (marketValue ?? 0) + (cashAccount?.balance ?? 0)
                        : account.balance + (cashAccount?.balance ?? 0);
                    const displayBalance = getDisplayBalance(totalBalance, account.type);
                    const cashDisplayBalance = cashAccount
                      ? getDisplayBalance(cashAccount.balance, cashAccount.type)
                      : null;

                    return (
                      <div
                        key={account.id}
                        data-testid="account-row"
                        className={cn(
                          "group py-3 md:py-4 flex items-center hover:bg-surface-tertiary transition-colors",
                          !account.isActive && "opacity-50"
                        )}
                      >
                        <div
                          className="flex-1 flex items-center gap-3 min-w-0"
                          style={{ paddingLeft: `${16 + depth * 12}px` }}
                        >
                          <div className="min-w-0 flex-1">
                            <Link
                              href={`/b/${bookId}/transactions?accountId=${account.id}`}
                              className={cn(
                                "hover:underline truncate block",
                                depth === 0 && account.children && account.children.some(c => !c.isInvestmentCash)
                                  ? "text-fg-secondary font-normal text-sm"
                                  : "text-fg font-medium text-sm md:text-base"
                              )}
                            >
                              <CategoryIcon icon={categoryLabels.get(account.id)?.icon ?? null} />
                              {account.parentId ? getAccountShortName(account.name) : account.name}
                            </Link>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 md:gap-4 shrink-0 pr-3 md:pr-6">
                          <label
                            className="hidden md:flex items-center gap-2 cursor-pointer shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                            title={account.isActive ? "Mark as inactive" : "Mark as active"}
                          >
                            <input
                              type="checkbox"
                              checked={!account.isActive}
                              onChange={() => handleToggleActive(account)}
                              className="rounded text-fg-secondary focus:ring-border-focus"
                            />
                            <span className="text-xs text-fg-secondary">Inactive</span>
                          </label>
                          <div className="text-right">
                            <span
                              className={cn(
                                "font-medium tabular-nums text-sm",
                                displayBalance >= 0
                                  ? "text-fg"
                                  : "text-fg-danger"
                              )}
                            >
                              {formatCurrency(displayBalance)}
                            </span>
                            {cashDisplayBalance !== null && (
                              <span className="block text-xs text-fg-tertiary tabular-nums">
                                Cash {formatCurrency(cashDisplayBalance)}
                              </span>
                            )}
                          </div>
                          <div className="hidden md:flex items-center gap-2 w-36">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setEditingAccount(account)}
                            >
                              Edit
                            </Button>
                            {!account.hasTransactions &&
                              (!account.children || account.children.length === 0) && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => handleDelete(account.id)}
                                  className="text-fg-danger hover:text-fg-danger"
                                >
                                  Delete
                                </Button>
                              )}
                          </div>
                          {/* Mobile edit button */}
                          <button
                            onClick={() => setEditingAccount(account)}
                            className="md:hidden p-1.5 text-fg-tertiary hover:text-fg-secondary rounded-md"
                            aria-label="Edit account"
                          >
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                            </svg>
                          </button>
                        </div>
                      </div>
                    );
                  };

                  if (!shouldGroupBySubtype) {
                    return (
                      <div className="divide-y divide-border-secondary">
                        {visibleRows.map(renderAccountRow)}
                      </div>
                    );
                  }

                  // Group accounts by subtype
                  const accountsBySubtype = visibleRows.reduce(
                    (acc, row) => {
                      const subtype = row.account.subtype || "other";
                      if (!acc[subtype]) {
                        acc[subtype] = [];
                      }
                      acc[subtype].push(row);
                      return acc;
                    },
                    {} as Record<string, typeof visibleRows>
                  );

                  return Object.entries(accountsBySubtype).map(([subtype, rows]) => {
                    const isExpanded = expandedSubtypes.has(subtype);
                    return (
                      <div key={subtype} className="border-b border-border-secondary last:border-b-0">
                        <button
                          onClick={() => toggleSubtype(subtype)}
                          className="w-full px-4 md:px-6 py-3 flex items-center justify-between text-sm font-medium text-fg-secondary hover:bg-surface-tertiary transition-colors"
                        >
                          <div className="flex items-center gap-2">
                            <svg
                              className={cn(
                                "w-4 h-4 transition-transform",
                                isExpanded && "rotate-90"
                              )}
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M9 5l7 7-7 7"
                              />
                            </svg>
                            <span>{ACCOUNT_SUBTYPE_LABELS[subtype] || subtype}</span>
                          </div>
                          <span className="text-xs text-fg-tertiary">
                            {rows.length} {rows.length === 1 ? "account" : "accounts"}
                          </span>
                        </button>
                        {isExpanded && (
                          <div className="divide-y divide-border-secondary">
                            {rows.map(renderAccountRow)}
                          </div>
                        )}
                      </div>
                    );
                  });
                })()}
              </div>
            </div>
          );
        })}

        {sortedTypes.length === 0 && (
          <EmptyState
            title="No accounts yet"
            description="Create your chart of accounts to start tracking finances."
            action={{ label: "Create your first account", onClick: () => setShowModal(true) }}
          />
        )}
      </div>

      <Modal
        isOpen={showModal}
        onClose={() => setShowModal(false)}
        title="New Account"
      >
        <AccountForm
          accounts={accounts}
          onSubmit={handleCreate}
          onCancel={() => setShowModal(false)}
        />
      </Modal>

      <Modal
        isOpen={!!editingAccount}
        onClose={() => setEditingAccount(null)}
        title="Edit Account"
      >
        {editingAccount && (
          <AccountForm
            account={editingAccount}
            accounts={accounts}
            onSubmit={handleUpdate}
            onCancel={() => setEditingAccount(null)}
          />
        )}
      </Modal>
    </div>
  );
}
