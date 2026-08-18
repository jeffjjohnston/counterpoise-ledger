"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useBookId } from "@/hooks/useBookId";
import { DateRangeFilter } from "@/components/ui/DateRangeFilter";
import { formatCurrency, formatDate } from "@/lib/formatters";
import { cn } from "@/lib/utils";
import { apiGet } from "@/lib/api-client";

type SearchSplit = {
  accountId: number;
  accountName: string;
  amount: number;
  isFavorite: boolean;
  subtype: string | null;
  isInvestmentCash: boolean;
};

type SearchTransaction = {
  id: number;
  date: string;
  description: string | null;
  checkNumber: string | null;
  payee: { id: number; name: string } | null;
  splits: SearchSplit[];
};

type SearchAccount = {
  id: number;
  name: string;
  type: string;
  subtype: string | null;
  isFavorite: boolean;
};

type SearchPayee = {
  id: number;
  name: string;
};

type SearchRecurringRule = {
  id: number;
  name: string;
  frequency: string;
  nextDate: string;
  isActive: boolean;
};

type SearchResults = {
  transactions: SearchTransaction[];
  accounts: SearchAccount[];
  payees: SearchPayee[];
  recurringRules: SearchRecurringRule[];
};

function pickBestAccount(splits: SearchSplit[]): number | null {
  if (splits.length === 0) return null;

  // Priority: favorite > bank/credit_card > not investment cash > first
  const favorite = splits.find((s) => s.isFavorite);
  if (favorite) return favorite.accountId;

  const bankOrCC = splits.find(
    (s) => s.subtype === "bank" || s.subtype === "credit_card"
  );
  if (bankOrCC) return bankOrCC.accountId;

  const nonInvestmentCash = splits.find((s) => !s.isInvestmentCash);
  if (nonInvestmentCash) return nonInvestmentCash.accountId;

  return splits[0].accountId;
}

function SearchPageInner() {
  const bookId = useBookId();
  const searchParams = useSearchParams();
  const router = useRouter();
  const prefix = `/b/${bookId}`;

  const initialQuery = searchParams.get("q") || "";
  const [query, setQuery] = useState(initialQuery);
  const [startDate, setStartDate] = useState(
    searchParams.get("startDate") || ""
  );
  const [endDate, setEndDate] = useState(searchParams.get("endDate") || "");
  const [results, setResults] = useState<SearchResults | null>(null);
  const [loading, setLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const doSearch = useCallback(
    async (q: string, sd: string, ed: string) => {
      const trimmed = q.trim();

      // Update URL
      const params = new URLSearchParams();
      if (trimmed) params.set("q", trimmed);
      if (sd) params.set("startDate", sd);
      if (ed) params.set("endDate", ed);
      const qs = params.toString();
      router.replace(`${prefix}/search${qs ? `?${qs}` : ""}`, {
        scroll: false,
      });

      if (!trimmed) {
        setResults(null);
        setHasSearched(false);
        return;
      }

      // Cancel previous request
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setLoading(true);
      setHasSearched(true);
      try {
        const searchParams = new URLSearchParams({ q: trimmed });
        if (sd) searchParams.set("startDate", sd);
        if (ed) searchParams.set("endDate", ed);

        const data = await apiGet<SearchResults>(
          `/api/b/${bookId}/search?${searchParams.toString()}`,
          { signal: controller.signal }
        );
        setResults(data);
      } catch (e) {
        // The controller's own signal is the authoritative answer to "was this
        // cancelled?". Name matching alone misses a Firefox abort and a body
        // truncated mid-stream, both of which reject with TypeError.
        if (controller.signal.aborted) return;
        if (e instanceof DOMException && e.name === "AbortError") return;
      } finally {
        setLoading(false);
      }
    },
    [bookId, prefix, router]
  );

  // Debounced search on query/date changes
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      // doSearch already catches its own errors (including abort) in a
      // try/finally; it cannot reject.
      void doSearch(query, startDate, endDate);
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, startDate, endDate, doSearch]);

  // Autofocus
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (debounceRef.current) clearTimeout(debounceRef.current);
    // doSearch already catches its own errors (including abort) in a
    // try/finally; it cannot reject.
    void doSearch(query, startDate, endDate);
  };

  const totalResults = results
    ? results.transactions.length +
      results.accounts.length +
      results.payees.length +
      results.recurringRules.length
    : 0;

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <h1 className="text-2xl font-bold text-fg mb-6">Search</h1>

      <form onSubmit={handleSubmit} className="space-y-4 mb-8">
        <div className="relative">
          <svg
            className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-fg-tertiary"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search transactions, accounts, payees, recurring rules..."
            spellCheck={false}
            autoComplete="off"
            className="block w-full rounded-lg border border-border bg-surface-inset text-fg pl-10 pr-4 py-2.5 text-sm focus:border-border-focus focus:outline-none focus:ring-1 focus:ring-border-focus"
          />
        </div>
        <DateRangeFilter
          startDate={startDate}
          endDate={endDate}
          onStartDateChange={setStartDate}
          onEndDateChange={setEndDate}
          onClear={() => {
            setStartDate("");
            setEndDate("");
          }}
        />
      </form>

      {loading && (
        <div className="text-center py-8 text-fg-tertiary">Searching...</div>
      )}

      {!loading && hasSearched && totalResults === 0 && (
        <div className="text-center py-12 text-fg-tertiary">
          No results found for &ldquo;{query.trim()}&rdquo;
        </div>
      )}

      {!loading && results && totalResults > 0 && (
        <div className="space-y-8">
          {/* Transactions */}
          {results.transactions.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold text-fg-tertiary uppercase tracking-wide mb-3">
                Transactions ({results.transactions.length})
              </h2>
              <div className="bg-surface rounded-lg border border-border shadow-soft overflow-hidden">
                <table className="min-w-full divide-y divide-border">
                  <thead className="bg-surface-secondary">
                    <tr>
                      <th className="px-4 py-2.5 text-left text-xs font-medium text-fg-tertiary uppercase">
                        Date
                      </th>
                      <th className="px-4 py-2.5 text-left text-xs font-medium text-fg-tertiary uppercase">
                        Description / Payee
                      </th>
                      <th className="px-4 py-2.5 text-left text-xs font-medium text-fg-tertiary uppercase">
                        Account(s)
                      </th>
                      <th className="px-4 py-2.5 text-right text-xs font-medium text-fg-tertiary uppercase">
                        Amount
                      </th>
                      <th className="px-4 py-2.5 text-left text-xs font-medium text-fg-tertiary uppercase">
                        Check #
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border-secondary">
                    {results.transactions.map((txn) => {
                      const bestAccountId = pickBestAccount(txn.splits);
                      const maxAmount = txn.splits.reduce(
                        (max, s) => Math.max(max, Math.abs(s.amount)),
                        0
                      );
                      return (
                        <tr key={txn.id} className="hover:bg-surface-tertiary">
                          <td className="px-4 py-2.5 text-sm text-fg-secondary whitespace-nowrap">
                            <Link
                              href={`${prefix}/transactions?accountId=${bestAccountId}&highlight=${txn.id}`}
                              className="hover:text-fg-accent"
                            >
                              {formatDate(txn.date)}
                            </Link>
                          </td>
                          <td className="px-4 py-2.5 text-sm text-fg">
                            <Link
                              href={`${prefix}/transactions?accountId=${bestAccountId}&highlight=${txn.id}`}
                              className="hover:text-fg-accent"
                            >
                              {txn.payee?.name || txn.description || "—"}
                              {txn.payee && txn.description && (
                                <span className="text-fg-tertiary ml-1">
                                  — {txn.description}
                                </span>
                              )}
                            </Link>
                          </td>
                          <td className="px-4 py-2.5 text-sm text-fg-tertiary max-w-48 truncate">
                            {txn.splits
                              .map((s) => shortName(s.accountName))
                              .join(", ")}
                          </td>
                          <td className="px-4 py-2.5 text-sm text-right font-medium text-fg whitespace-nowrap tabular-nums">
                            {formatCurrency(maxAmount)}
                          </td>
                          <td className="px-4 py-2.5 text-sm text-fg-tertiary">
                            {txn.checkNumber || ""}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* Accounts */}
          {results.accounts.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold text-fg-tertiary uppercase tracking-wide mb-3">
                Accounts ({results.accounts.length})
              </h2>
              <div className="bg-surface rounded-lg border border-border shadow-soft overflow-hidden">
                <table className="min-w-full divide-y divide-border">
                  <thead className="bg-surface-secondary">
                    <tr>
                      <th className="px-4 py-2.5 text-left text-xs font-medium text-fg-tertiary uppercase">
                        Name
                      </th>
                      <th className="px-4 py-2.5 text-left text-xs font-medium text-fg-tertiary uppercase">
                        Type
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border-secondary">
                    {results.accounts.map((acct) => (
                      <tr key={acct.id} className="hover:bg-surface-tertiary">
                        <td className="px-4 py-2.5 text-sm text-fg">
                          <Link
                            href={`${prefix}/accounts?highlight=${acct.id}`}
                            className="hover:text-fg-accent"
                          >
                            {acct.name}
                          </Link>
                        </td>
                        <td className="px-4 py-2.5 text-sm text-fg-tertiary capitalize">
                          {acct.type}
                          {acct.subtype && ` (${acct.subtype.replace("_", " ")})`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* Payees */}
          {results.payees.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold text-fg-tertiary uppercase tracking-wide mb-3">
                Payees ({results.payees.length})
              </h2>
              <div className="bg-surface rounded-lg border border-border shadow-soft overflow-hidden">
                <table className="min-w-full divide-y divide-border">
                  <thead className="bg-surface-secondary">
                    <tr>
                      <th className="px-4 py-2.5 text-left text-xs font-medium text-fg-tertiary uppercase">
                        Name
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border-secondary">
                    {results.payees.map((payee) => (
                      <tr key={payee.id} className="hover:bg-surface-tertiary">
                        <td className="px-4 py-2.5 text-sm text-fg">
                          <Link
                            href={`${prefix}/transactions?payeeId=${payee.id}`}
                            className="hover:text-fg-accent"
                          >
                            {payee.name}
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* Recurring Rules */}
          {results.recurringRules.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold text-fg-tertiary uppercase tracking-wide mb-3">
                Recurring Rules ({results.recurringRules.length})
              </h2>
              <div className="bg-surface rounded-lg border border-border shadow-soft overflow-hidden">
                <table className="min-w-full divide-y divide-border">
                  <thead className="bg-surface-secondary">
                    <tr>
                      <th className="px-4 py-2.5 text-left text-xs font-medium text-fg-tertiary uppercase">
                        Name
                      </th>
                      <th className="px-4 py-2.5 text-left text-xs font-medium text-fg-tertiary uppercase">
                        Frequency
                      </th>
                      <th className="px-4 py-2.5 text-left text-xs font-medium text-fg-tertiary uppercase">
                        Next Date
                      </th>
                      <th className="px-4 py-2.5 text-left text-xs font-medium text-fg-tertiary uppercase">
                        Status
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border-secondary">
                    {results.recurringRules.map((rule) => (
                      <tr key={rule.id} className="hover:bg-surface-tertiary">
                        <td className="px-4 py-2.5 text-sm text-fg">
                          <Link
                            href={`${prefix}/recurring?highlightRule=${rule.id}`}
                            className="hover:text-fg-accent"
                          >
                            {rule.name}
                          </Link>
                        </td>
                        <td className="px-4 py-2.5 text-sm text-fg-tertiary capitalize">
                          {rule.frequency}
                        </td>
                        <td className="px-4 py-2.5 text-sm text-fg-tertiary">
                          {formatDate(rule.nextDate)}
                        </td>
                        <td className="px-4 py-2.5 text-sm">
                          <span
                            className={cn(
                              "px-2 py-0.5 rounded-full text-xs",
                              rule.isActive
                                ? "bg-success-subtle text-fg-success"
                                : "bg-surface-tertiary text-fg-tertiary"
                            )}
                          >
                            {rule.isActive ? "Active" : "Inactive"}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function shortName(fullName: string): string {
  const lastColon = fullName.lastIndexOf(":");
  return lastColon === -1 ? fullName : fullName.substring(lastColon + 1);
}

export default function SearchPage() {
  return (
    <Suspense
      fallback={
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="animate-pulse space-y-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-24 bg-surface-tertiary rounded-lg" />
            ))}
          </div>
        </div>
      }
    >
      <SearchPageInner />
    </Suspense>
  );
}
