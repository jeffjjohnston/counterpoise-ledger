"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useBookId } from "@/hooks/useBookId";
import { AccountCard } from "@/components/accounts/AccountCard";
import { Card, CardHeader } from "@/components/ui/Card";
import { formatCurrency, formatDate, getAccountShortName, toDateString } from "@/lib/formatters";
import { cn } from "@/lib/utils";
import {
  getDisplayBalance,
  BALANCE_SHEET_TYPES,
  flattenAccounts,
} from "@/lib/accounting";
import { apiGet } from "@/lib/api-client";
import type { AccountWithBalance, TransactionWithSplits } from "@/types";
import type { AccountMarketValue } from "@/lib/investments";

interface AccountSummary {
  type: string;
  accounts: AccountWithBalance[];
  total: number;
}

export default function HomePage() {
  const bookId = useBookId();
  const [accounts, setAccounts] = useState<AccountWithBalance[]>([]);
  const [transactions, setTransactions] = useState<TransactionWithSplits[]>([]);
  const [marketValues, setMarketValues] = useState<AccountMarketValue[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchDashboardData = useCallback(async () => {
    try {
      const today = toDateString(new Date());
      // apiGet throws on a non-2xx response instead of resolving it, so a
      // failure on any of these three rejects the whole Promise.all and
      // lands in the catch below — a non-2xx JSON error body (e.g.
      // {error: "..."}) can no longer parse successfully and leave
      // transactionsData as an object, which would otherwise make
      // transactions.slice/.length below throw outside this try/catch, at
      // render time.
      const [accountsData, transactionsData, marketValuesData] = await Promise.all([
        apiGet<AccountWithBalance[]>(
          `/api/b/${bookId}/accounts?includeInactive=true&asOfDate=${today}`
        ),
        apiGet<TransactionWithSplits[]>(
          `/api/b/${bookId}/transactions?limit=10&endDate=${today}`
        ),
        apiGet<AccountMarketValue[]>(
          `/api/b/${bookId}/investments/account-values?asOfDate=${today}`
        ),
      ]);

      // Flatten nested accounts
      const flatAccounts = flattenAccounts(accountsData);
      setAccounts(flatAccounts);
      setTransactions(Array.isArray(transactionsData) ? transactionsData : []);
      setMarketValues(Array.isArray(marketValuesData) ? marketValuesData : []);
      setError(null);
    } catch {
      setError("Could not load dashboard data.");
    } finally {
      setLoading(false);
    }
  }, [bookId]);

  useEffect(() => {
    void fetchDashboardData();
  }, [fetchDashboardData]);

  const activeAccounts = accounts.filter((a) => a.isActive);

  // Create market value map for investment accounts
  const marketValueMap = new Map(
    marketValues.map((mv) => [mv.accountId, mv.marketValueCents])
  );

  // Helper to get the effective balance for an account
  // For investment accounts, use market value + cash child balance
  const getEffectiveBalance = (account: AccountWithBalance): number => {
    if (account.subtype === "investment") {
      const marketValue = marketValueMap.get(account.id) ?? 0;
      // Find the investment cash child account
      const cashChild = accounts.find(
        (a) => a.parentId === account.id && a.isInvestmentCash
      );
      const cashBalance = cashChild?.balance ?? 0;
      return marketValue + cashBalance;
    }
    return account.balance;
  };

  const accountsByType = activeAccounts.reduce(
    (acc, account) => {
      if (!acc[account.type]) {
        acc[account.type] = {
          type: account.type,
          accounts: [],
          total: 0,
        };
      }
      acc[account.type].accounts.push(account);
      // Only add to total if not an investment cash account (its balance is
      // already included in the parent investment account's effective balance)
      if (!account.isInvestmentCash) {
        acc[account.type].total += getEffectiveBalance(account);
      }
      return acc;
    },
    {} as Record<string, AccountSummary>
  );

  // Calculate totals - use display balance for proper signs
  const assets = BALANCE_SHEET_TYPES.filter((t) => t === "asset")
    .map((t) => accountsByType[t])
    .filter(Boolean)
    .reduce((sum, g) => sum + getDisplayBalance(g.total, g.type), 0);

  const liabilities = BALANCE_SHEET_TYPES.filter((t) => t === "liability")
    .map((t) => accountsByType[t])
    .filter(Boolean)
    .reduce((sum, g) => sum + getDisplayBalance(g.total, g.type), 0);

  const netWorth = assets - liabilities;

  // Split balance sheet into left (assets) and right (liabilities + equity)
  const leftTypes = ["asset"].filter((t) => accountsByType[t]);
  const rightTypes = ["liability", "equity"].filter((t) => accountsByType[t]);

  if (error) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <p className="text-danger">{error}</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="animate-pulse space-y-8">
          <div className="h-32 bg-surface-tertiary rounded-lg" />
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-48 bg-surface-tertiary rounded-lg" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-8">
        <h1 className="text-xl md:text-2xl font-bold text-fg mb-4 md:mb-6">Dashboard</h1>

        {/* Three KPI cards as one matched set: identical white fill, distinguished
            only by a colored left border (category cue). Figures stay neutral so
            red/green is reserved for genuinely signed values — e.g. a negative net
            worth. (Findings #1 and #5.) */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 md:gap-6 mb-6 md:mb-8">
          <div className="bg-surface rounded-lg border border-border shadow-soft p-4 md:p-6 border-l-4 border-l-fg-success">
            <p className="text-xs md:text-sm font-medium text-fg-tertiary mb-1">Assets</p>
            <p className="text-xl md:text-2xl font-bold text-fg tabular-nums">
              {formatCurrency(assets)}
            </p>
          </div>
          <div className="bg-surface rounded-lg border border-border shadow-soft p-4 md:p-6 border-l-4 border-l-fg-danger">
            <p className="text-xs md:text-sm font-medium text-fg-tertiary mb-1">Liabilities</p>
            <p className="text-xl md:text-2xl font-bold text-fg tabular-nums">
              {formatCurrency(liabilities)}
            </p>
          </div>
          <div className="bg-surface rounded-lg border border-border shadow-soft p-4 md:p-6 border-l-4 border-l-accent">
            <p className="text-xs md:text-sm font-medium text-fg-tertiary mb-1">Net Worth</p>
            <p
              className={cn(
                "text-xl md:text-2xl font-bold tabular-nums",
                netWorth >= 0 ? "text-fg" : "text-fg-danger"
              )}
            >
              {formatCurrency(netWorth)}
            </p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 md:gap-8 mb-6 md:mb-8">
        <div>
          <h2 className="text-lg font-semibold text-fg mb-4">Assets</h2>
          <div className="space-y-4">
            {leftTypes.map((type) => (
              <AccountCard
                key={type}
                type={type}
                accounts={accountsByType[type].accounts}
                total={accountsByType[type].total}
                marketValueMap={marketValueMap}
                basePath={`/b/${bookId}/transactions`}
              />
            ))}
            {leftTypes.length === 0 && (
              <p className="text-fg-tertiary text-sm">No asset accounts</p>
            )}
          </div>
        </div>

        <div>
          <h2 className="text-lg font-semibold text-fg mb-4">
            Liabilities & Equity
          </h2>
          <div className="space-y-4">
            {rightTypes.map((type) => (
              <AccountCard
                key={type}
                type={type}
                accounts={accountsByType[type].accounts}
                total={accountsByType[type].total}
                marketValueMap={marketValueMap}
                basePath={`/b/${bookId}/transactions`}
              />
            ))}
            {rightTypes.length === 0 && (
              <p className="text-fg-tertiary text-sm">No liability or equity accounts</p>
            )}
          </div>
        </div>
      </div>

      <Card>
        <CardHeader
          action={
            <Link
              href={`/b/${bookId}/transactions`}
              className="text-sm text-fg-accent hover:text-fg-accent font-medium"
            >
              View All
            </Link>
          }
        >
          <h2 className="text-base md:text-lg font-semibold text-fg">
            Recent Transactions
          </h2>
        </CardHeader>
        <div className="divide-y divide-border-secondary">
          {transactions.length === 0 ? (
            <div className="px-6 py-8 text-center text-fg-tertiary">
              No transactions yet.{" "}
              <Link
                href={`/b/${bookId}/transactions`}
                className="text-fg-accent hover:underline"
              >
                Add your first transaction
              </Link>
            </div>
          ) : (
            transactions.slice(0, 5).map((transaction) => {
              const amount =
                transaction.splits.length > 0
                  ? Math.max(...transaction.splits.map((s) => Math.abs(s.amount)))
                  : 0;

              return (
                <Link
                  key={transaction.id}
                  href={`/b/${bookId}/transactions?highlight=${transaction.id}`}
                  className="px-3 md:px-6 py-3 md:py-4 flex items-center justify-between hover:bg-surface-tertiary transition-colors gap-3"
                >
                  <div className="flex items-center gap-3 md:gap-4 min-w-0">
                    <div className="hidden sm:block text-sm text-fg-tertiary w-20 tabular-nums flex-shrink-0">
                      {formatDate(transaction.date)}
                    </div>
                    <div className="min-w-0">
                      <p className={cn(
                        "text-sm font-medium truncate",
                        (transaction.payee?.name || transaction.description) ? "text-fg" : "text-fg-tertiary italic"
                      )}>
                        {transaction.payee?.name || transaction.description || "No description"}
                      </p>
                      <p className="text-13 text-fg-tertiary truncate">
                        <span className="sm:hidden">{formatDate(transaction.date)} &middot; </span>
                        {transaction.splits
                          .map((s) => getAccountShortName(s.account.name))
                          .join(" / ")}
                      </p>
                    </div>
                  </div>
                  <div className="text-sm font-medium text-fg tabular-nums flex-shrink-0">
                    {formatCurrency(amount)}
                  </div>
                </Link>
              );
            })
          )}
        </div>
      </Card>
    </div>
  );
}
