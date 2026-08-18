"use client";

import { useState } from "react";
import Link from "next/link";
import { formatCurrency, getAccountShortName } from "@/lib/formatters";
import {
  ACCOUNT_TYPE_LABELS,
  ACCOUNT_SUBTYPE_LABELS,
  ACCOUNT_TYPE_ORDER,
  getDisplayBalance,
  BALANCE_SHEET_TYPES,
  buildAccountTree,
  flattenAccountTreeWithDepth,
  flattenAccounts,
} from "@/lib/accounting";
import { cn } from "@/lib/utils";
import type { AccountWithBalance } from "@/types";

interface AccountListProps {
  accounts: AccountWithBalance[];
  selectedAccountId: number | null;
  basePath?: string;
  showInactive?: boolean;
  balanceSheetOnly?: boolean;
  marketValueMap?: Map<number, number>;
  expandedTypes?: Set<string>;
  expandedSubtypes?: Set<string>;
  onToggleType?: (type: string) => void;
  onToggleSubtype?: (subtype: string) => void;
  onAccountClick?: () => void;
}

export const DEFAULT_EXPANDED_TYPES = new Set(["asset", "liability"]);
export const DEFAULT_EXPANDED_SUBTYPES = new Set([
  "bank",
  "investment",
  "credit_card",
  "loan",
  "cash",
  "other",
]);

export function AccountList({
  accounts,
  selectedAccountId,
  basePath = "/transactions",
  showInactive = false,
  balanceSheetOnly = false,
  marketValueMap,
  expandedTypes: externalExpandedTypes,
  expandedSubtypes: externalExpandedSubtypes,
  onToggleType,
  onToggleSubtype,
  onAccountClick,
}: AccountListProps) {
  const [internalExpandedTypes, setInternalExpandedTypes] =
    useState<Set<string>>(DEFAULT_EXPANDED_TYPES);
  const [internalExpandedSubtypes, setInternalExpandedSubtypes] =
    useState<Set<string>>(DEFAULT_EXPANDED_SUBTYPES);

  const expandedTypes = externalExpandedTypes ?? internalExpandedTypes;
  const expandedSubtypes = externalExpandedSubtypes ?? internalExpandedSubtypes;

  const flatAccounts = flattenAccounts(accounts);

  const filteredAccounts = flatAccounts.filter((a) => {
    if (!showInactive && !a.isActive) return false;
    if (balanceSheetOnly && !BALANCE_SHEET_TYPES.includes(a.type)) return false;
    return true;
  });
  const favoriteAccounts = filteredAccounts
    .filter((account) => account.isFavorite && !account.isInvestmentCash)
    .sort((a, b) => a.name.localeCompare(b.name));

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

  // Helper to get the effective balance for an account
  // For investment accounts, use market value + cash child balance
  const getEffectiveBalance = (account: AccountWithBalance): number => {
    if (account.subtype === "investment" && marketValueMap) {
      const marketValue = marketValueMap.get(account.id) ?? 0;
      // Find the investment cash child account
      const cashChild = flatAccounts.find(
        (a) => a.parentId === account.id && a.isInvestmentCash
      );
      const cashBalance = cashChild?.balance ?? 0;
      return marketValue + cashBalance;
    }
    return account.balance;
  };
  const getFavoriteDisplayBalances = (account: AccountWithBalance) => {
    const cashChild =
      account.subtype === "investment"
        ? flatAccounts.find((a) => a.parentId === account.id && a.isInvestmentCash)
        : null;
    const isInvestment = account.subtype === "investment";
    const marketValue = marketValueMap?.get(account.id);
    const totalBalance =
      isInvestment && marketValueMap
        ? (marketValue ?? 0) + (cashChild?.balance ?? 0)
        : account.balance + (cashChild?.balance ?? 0);

    return {
      displayBalance: getDisplayBalance(totalBalance, account.type),
      cashDisplayBalance: cashChild
        ? getDisplayBalance(cashChild.balance, cashChild.type)
        : null,
    };
  };

  const toggleType = (type: string) => {
    if (onToggleType) {
      onToggleType(type);
    } else {
      const newExpanded = new Set(internalExpandedTypes);
      if (newExpanded.has(type)) {
        newExpanded.delete(type);
      } else {
        newExpanded.add(type);
      }
      setInternalExpandedTypes(newExpanded);
    }
  };

  const toggleSubtype = (subtype: string) => {
    if (onToggleSubtype) {
      onToggleSubtype(subtype);
    } else {
      const newExpanded = new Set(internalExpandedSubtypes);
      if (newExpanded.has(subtype)) {
        newExpanded.delete(subtype);
      } else {
        newExpanded.add(subtype);
      }
      setInternalExpandedSubtypes(newExpanded);
    }
  };

  return (
    <div className="space-y-1">
      {favoriteAccounts.length > 0 && (
        <div className="space-y-0.5 pb-2">
          <h3 className="px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-fg-tertiary">
            Favorites
          </h3>
          {favoriteAccounts.map((account) => {
            const { displayBalance, cashDisplayBalance } =
              getFavoriteDisplayBalances(account);

            return (
              <Link
                key={`favorite-${account.id}`}
                href={`${basePath}?accountId=${account.id}`}
                onClick={onAccountClick}
                className={cn(
                  "w-full px-3 py-1.5 flex items-center justify-between text-sm rounded-lg transition-colors",
                  selectedAccountId === account.id
                    ? "bg-accent-subtle text-fg-accent"
                    : "text-fg-secondary hover:bg-surface-tertiary",
                  !account.isActive && "opacity-50"
                )}
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <svg
                    className="h-3.5 w-3.5 shrink-0 text-fg-warning"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                    aria-hidden="true"
                  >
                    <path d="M10 1.75 12.47 6.76l5.53.81-4 3.9.94 5.51L10 14.38 5.06 16.98 6 11.47l-4-3.9 5.53-.81L10 1.75Z" />
                  </svg>
                  <span className="truncate">
                    {account.parentId ? getAccountShortName(account.name) : account.name}
                  </span>
                </span>
                <span className="ml-2 shrink-0 text-right">
                  <span
                    className={cn(
                      "block text-xs tabular-nums",
                      displayBalance < 0 && "text-fg-danger"
                    )}
                  >
                    {formatCurrency(displayBalance)}
                  </span>
                  {cashDisplayBalance !== null && (
                    <span className="block text-[11px] text-fg-tertiary tabular-nums">
                      Cash {formatCurrency(cashDisplayBalance)}
                    </span>
                  )}
                </span>
              </Link>
            );
          })}
        </div>
      )}
      <Link
        href={basePath}
        onClick={onAccountClick}
        className={cn(
          "block w-full px-3 py-2 text-left text-sm font-medium rounded-lg transition-colors",
          selectedAccountId === null
            ? "bg-accent-subtle text-fg-accent"
            : "text-fg-secondary hover:bg-surface-tertiary"
        )}
      >
        All Accounts
      </Link>

      {sortedTypes.map((type) => {
        const typeAccounts: AccountWithBalance[] = groupedAccounts[type] ?? [];
        const treeAccounts = buildAccountTree(typeAccounts);
        const visibleRows = flattenAccountTreeWithDepth(treeAccounts).filter(
          ({ account }) => !account.isInvestmentCash
        );
        const isExpanded = expandedTypes.has(type);
        // Calculate type total using effective balances (market value for investments)
        // Skip investment cash accounts as they're included in parent's effective balance
        const typeTotal = typeAccounts.reduce((sum, a) => {
          if (a.isInvestmentCash) return sum;
          return sum + getEffectiveBalance(a);
        }, 0);
        const displayTotal = getDisplayBalance(typeTotal, type);

        return (
          <div key={type}>
            <button
              onClick={() => toggleType(type)}
              className="w-full px-3 py-2 flex items-center justify-between text-sm font-medium text-fg-secondary hover:bg-surface-tertiary rounded-lg transition-colors"
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
                <span>{ACCOUNT_TYPE_LABELS[type] || type}</span>
              </div>
              <span
                className={cn(
                  "text-xs tabular-nums",
                  displayTotal >= 0 ? "text-fg-tertiary" : "text-fg-danger"
                )}
              >
                {formatCurrency(displayTotal)}
              </span>
            </button>

            {isExpanded && (() => {
              const shouldGroupBySubtype = visibleRows.some(({ account }) =>
                Boolean(account.subtype)
              );
              const renderAccountRow = ({
                account,
                depth,
              }: (typeof visibleRows)[number]) => {
                const cashAccount =
                  account.subtype === "investment"
                    ? account.children?.find((child) => child.isInvestmentCash)
                    : null;
                // For investment accounts, use market value if available
                const isInvestment = account.subtype === "investment";
                const marketValue = marketValueMap?.get(account.id);
                const totalBalance =
                  isInvestment && marketValueMap
                    ? (marketValue ?? 0) + (cashAccount?.balance ?? 0)
                    : account.balance + (cashAccount?.balance ?? 0);
                const displayBalance = getDisplayBalance(totalBalance, account.type);
                const cashDisplayBalance = cashAccount
                  ? getDisplayBalance(cashAccount.balance, cashAccount.type)
                  : null;
                return (
                  <Link
                    key={account.id}
                    href={`${basePath}?accountId=${account.id}`}
                    onClick={onAccountClick}
                    className={cn(
                      "w-full px-3 py-1.5 flex items-center justify-between text-sm rounded-lg transition-colors",
                      selectedAccountId === account.id
                        ? "bg-accent-subtle text-fg-accent"
                        : "text-fg-secondary hover:bg-surface-tertiary",
                      !account.isActive && "opacity-50"
                    )}
                    style={{ paddingLeft: `${12 + depth * 16}px` }}
                  >
                    <span className="truncate">
                      {account.parentId ? getAccountShortName(account.name) : account.name}
                    </span>
                    <span className="ml-2 shrink-0 text-right">
                      <span
                        className={cn(
                          "block text-xs tabular-nums",
                          displayBalance < 0 && "text-fg-danger"
                        )}
                      >
                        {formatCurrency(displayBalance)}
                      </span>
                      {cashDisplayBalance !== null && (
                        <span className="block text-[11px] text-fg-tertiary tabular-nums">
                          Cash {formatCurrency(cashDisplayBalance)}
                        </span>
                      )}
                    </span>
                  </Link>
                );
              };

              if (!shouldGroupBySubtype) {
                return (
                  <div className="ml-2 space-y-0.5">
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

              return (
                <div className="ml-2 space-y-0.5">
                  {Object.entries(accountsBySubtype).map(([subtype, rows]) => {
                    const isSubtypeExpanded = expandedSubtypes.has(subtype);
                    return (
                      <div key={subtype}>
                        <button
                          onClick={() => toggleSubtype(subtype)}
                          className="w-full px-2 py-1.5 flex items-center justify-between text-xs font-medium text-fg-secondary hover:bg-surface-tertiary rounded-lg transition-colors"
                        >
                          <div className="flex items-center gap-1.5">
                            <svg
                              className={cn(
                                "w-3 h-3 transition-transform",
                                isSubtypeExpanded && "rotate-90"
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
                            <span className="text-[11px]">
                              {ACCOUNT_SUBTYPE_LABELS[subtype] || subtype}
                            </span>
                          </div>
                          <span className="text-[10px] text-fg-tertiary">
                            {rows.length}
                          </span>
                        </button>
                        {isSubtypeExpanded && (
                          <div className="ml-2 space-y-0.5">
                            {rows.map(renderAccountRow)}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })()}
          </div>
        );
      })}
    </div>
  );
}
