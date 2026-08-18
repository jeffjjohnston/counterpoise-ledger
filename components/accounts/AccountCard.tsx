"use client";

import { useState } from "react";
import Link from "next/link";
import { formatCurrency, getAccountShortName } from "@/lib/formatters";
import {
  ACCOUNT_TYPE_LABELS,
  ACCOUNT_SUBTYPE_LABELS,
  buildAccountTree,
  flattenAccountTreeWithDepth,
  flattenAccounts,
  getDisplayBalance,
} from "@/lib/accounting";
import { cn } from "@/lib/utils";
import { Card, CardHeader } from "@/components/ui/Card";
import type { AccountWithBalance } from "@/types";

interface AccountCardProps {
  type: string;
  accounts: AccountWithBalance[];
  total: number;
  marketValueMap?: Map<number, number>;
  basePath?: string;
  /**
   * Extra query params merged into each account link (in addition to
   * `accountId`). Used, e.g., to carry the income statement's date range
   * onto the transaction list. Falsy values are omitted.
   */
  linkParams?: Record<string, string | undefined>;
}

export function AccountCard({
  type,
  accounts,
  total,
  marketValueMap,
  basePath = "/transactions",
  linkParams,
}: AccountCardProps) {
  const buildAccountHref = (accountId: number) => {
    const params = new URLSearchParams({ accountId: String(accountId) });
    for (const [key, value] of Object.entries(linkParams ?? {})) {
      if (value) params.set(key, value);
    }
    return `${basePath}?${params.toString()}`;
  };
  const [expandedSubtypes, setExpandedSubtypes] = useState<Set<string>>(
    new Set(["bank", "investment", "credit_card", "loan", "cash", "other"])
  );
  const [expandedParents, setExpandedParents] = useState<Set<number>>(
    new Set()
  );

  const flatAccounts = flattenAccounts(accounts);
  const activeAccounts = flatAccounts.filter((a) => a.isActive);
  const treeAccounts = buildAccountTree(activeAccounts);
  const visibleRows = flattenAccountTreeWithDepth(treeAccounts).filter(
    ({ account }) => !account.isInvestmentCash
  );
  const displayTotal = getDisplayBalance(total, type);
  const shouldGroupBySubtype = visibleRows.some(({ account }) =>
    Boolean(account.subtype)
  );

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

  const parentSubtotals = (() => {
    const subtotals = new Map<number, number>();
    const computeSubtotal = (account: AccountWithBalance): number => {
      let subtotal = account.balance;
      if (account.children) {
        for (const child of account.children) {
          subtotal += computeSubtotal(child);
        }
      }
      subtotals.set(account.id, subtotal);
      return subtotal;
    };
    for (const root of treeAccounts) {
      computeSubtotal(root);
    }
    return subtotals;
  })();

  const toggleParent = (parentId: number) => {
    const newExpanded = new Set(expandedParents);
    if (newExpanded.has(parentId)) {
      newExpanded.delete(parentId);
    } else {
      newExpanded.add(parentId);
    }
    setExpandedParents(newExpanded);
  };

  const renderAccountRow = ({
    account,
    depth,
  }: (typeof visibleRows)[number]) => {
    const cashAccount = account.children?.find((child) => child.isInvestmentCash);
    // For investment accounts, use market value if available
    const isInvestment = account.subtype === "investment";
    const marketValue = marketValueMap?.get(account.id);
    const investmentBalance =
      isInvestment && marketValueMap
        ? (marketValue ?? 0) + (cashAccount?.balance ?? 0)
        : account.balance + (cashAccount?.balance ?? 0);
    const displayTotalBalance = getDisplayBalance(investmentBalance, account.type);
    const cashDisplayBalance = cashAccount
      ? getDisplayBalance(cashAccount.balance, cashAccount.type)
      : null;
    return (
      <div
        key={account.id}
        className="py-2.5 pr-4 flex items-center justify-between bg-surface hover:bg-surface-tertiary transition-colors"
        style={{ paddingLeft: `${24 + depth * 16}px` }}
      >
        <Link
          href={buildAccountHref(account.id)}
          className="text-sm text-fg-secondary hover:text-fg hover:underline"
        >
          {account.parentId ? getAccountShortName(account.name) : account.name}
        </Link>
        <span className="text-right">
          <span
            className={cn(
              "block text-sm font-medium tabular-nums",
              displayTotalBalance >= 0 ? "text-fg" : "text-fg-danger"
            )}
          >
            {formatCurrency(displayTotalBalance)}
          </span>
          {cashDisplayBalance !== null && (
            <span className="block text-13 text-fg-tertiary tabular-nums">
              Cash {formatCurrency(cashDisplayBalance)}
            </span>
          )}
        </span>
      </div>
    );
  };

  const toggleSubtype = (subtype: string) => {
    const newExpanded = new Set(expandedSubtypes);
    if (newExpanded.has(subtype)) {
      newExpanded.delete(subtype);
    } else {
      newExpanded.add(subtype);
    }
    setExpandedSubtypes(newExpanded);
  };

  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <h3 className="font-semibold text-fg">
          {ACCOUNT_TYPE_LABELS[type] || type}
        </h3>
      </CardHeader>
      <div>
        {visibleRows.length === 0 ? (
          <div className="px-4 py-3 text-sm text-fg-secondary">No accounts</div>
        ) : !shouldGroupBySubtype ? (
          (() => {
            // Group rows by their top-level parent using DFS order
            const groups: { parent: (typeof visibleRows)[number]; children: typeof visibleRows }[] = [];
            for (const row of visibleRows) {
              if (row.depth === 0) {
                groups.push({ parent: row, children: [] });
              } else if (groups.length > 0) {
                groups[groups.length - 1].children.push(row);
              }
            }

            return (
              <div>
                {groups.map(({ parent, children }) => {
                  const { account } = parent;
                  if (children.length === 0) {
                    // Leaf account at depth 0 — render normally
                    return (
                      <div key={account.id} className="border-b border-border-secondary last:border-b-0">
                        {renderAccountRow(parent)}
                      </div>
                    );
                  }

                  // Parent with children — render collapsible
                  const isExpanded = expandedParents.has(account.id);
                  const subtotal = parentSubtotals.get(account.id) ?? 0;
                  const displaySubtotal = getDisplayBalance(subtotal, type);
                  return (
                    <div key={account.id} className="border-b border-border-secondary last:border-b-0">
                      <button
                        onClick={() => toggleParent(account.id)}
                        className="w-full px-4 py-2.5 flex items-center justify-between text-sm hover:bg-surface-tertiary transition-colors"
                      >
                        <div className="flex items-center gap-2">
                          <svg
                            className={cn(
                              "w-3 h-3 text-fg-tertiary transition-transform",
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
                          <span className="font-medium text-fg">{account.name}</span>
                        </div>
                        <span
                          className={cn(
                            "font-medium tabular-nums",
                            displaySubtotal >= 0 ? "text-fg" : "text-fg-danger"
                          )}
                        >
                          {formatCurrency(displaySubtotal)}
                        </span>
                      </button>
                      {isExpanded && (
                        <div className="divide-y divide-border-secondary">
                          {children.map(renderAccountRow)}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })()
        ) : (
          Object.entries(accountsBySubtype).map(([subtype, rows]) => {
            const isExpanded = expandedSubtypes.has(subtype);
            return (
              <div key={subtype} className="border-b border-border-secondary last:border-b-0">
                <button
                  onClick={() => toggleSubtype(subtype)}
                  className="w-full px-4 py-2 flex items-center justify-between text-xs font-medium text-fg-secondary hover:bg-surface-tertiary transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <svg
                      className={cn(
                        "w-3 h-3 transition-transform",
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
          })
        )}
      </div>
      <div className="px-4 md:px-6 py-3 md:py-4 border-t border-border-secondary flex items-center justify-between">
        <span className="text-sm font-medium text-fg-secondary">Total</span>
        <span
          className={cn(
            "text-sm font-bold tabular-nums",
            displayTotal >= 0 ? "text-fg" : "text-fg-danger"
          )}
        >
          {formatCurrency(displayTotal)}
        </span>
      </div>
    </Card>
  );
}
