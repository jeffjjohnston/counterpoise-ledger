"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Tabs } from "@/components/ui/Tabs";
import { SecurityForm } from "@/components/securities/SecurityForm";
import { StockSplitEditForm } from "@/components/securities/StockSplitEditForm";
import { PriceHistoryEditForm } from "@/components/securities/PriceHistoryEditForm";
import { SecurityLotsTable, type OpenLot } from "@/components/securities/SecurityLotsTable";
import { formatCurrency, formatDate } from "@/lib/formatters";
import { useBookId } from "@/hooks/useBookId";
import { apiGet, apiPut, apiDelete, toMessage } from "@/lib/api-client";
import { useToast } from "@/components/ui/ToastProvider";
import type { Security } from "@/db/schema";

type SecurityDetail = Security & {
  latestPriceMicros: number | null;
  latestPriceDate: string | null;
};

type PositionByAccount = {
  accountId: number;
  accountName: string;
  isActive: boolean;
  sharesMicros: number;
  costBasisCents: number;
  marketValueCents: number | null;
};

type SecuritySplit = {
  id: number;
  transactionId: number;
  transactionDate: string;
  transactionDescription: string | null;
  accountId: number | null;
  accountName: string;
  action: "buy" | "sell" | "dividend" | "capGain" | "fee" | "split";
  sharesMicros: number;
  priceMicros: number;
  feesCents: number;
  splitNumerator: number | null;
  splitDenominator: number | null;
  cashAmountCents?: number;
};

type SecurityPriceHistoryRow = {
  priceDate: string;
  priceMicros: number;
  source: string | null;
};

const PAGE_SIZE = 50;
const MICROS_PER_SHARE = 1_000_000;

const securityTypeLabels: Record<Security["securityType"], string> = {
  stock: "Stock",
  etf: "ETF",
  mutual_fund: "Mutual Fund",
};

const formatShares = (sharesMicros: number) =>
  (sharesMicros / MICROS_PER_SHARE).toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 6,
  });

const formatPriceMicros = (priceMicros: number) =>
  formatCurrency(Math.round((priceMicros / MICROS_PER_SHARE) * 100));

const gainColorClass = (gainCents: number) =>
  gainCents > 0
    ? "text-fg-success"
    : gainCents < 0
      ? "text-fg-danger"
      : "text-fg-secondary";

const formatSplitAction = (split: SecuritySplit) => {
  if (split.action !== "split") {
    if (split.action === "capGain") {
      return "Capital Gain";
    }
    return split.action.charAt(0).toUpperCase() + split.action.slice(1);
  }

  const numerator = split.splitNumerator ?? 0;
  const denominator = split.splitDenominator ?? 0;
  if (numerator > 0 && denominator > 0) {
    return `Split (${numerator}-for-${denominator})`;
  }
  return "Split";
};

const calculateAmount = (split: SecuritySplit): number | null => {
  // Stock splits don't have an amount
  if (split.action === "split") {
    return null;
  }

  // For dividends and capital gains, use the cash amount from transaction splits
  if (split.action === "dividend" || split.action === "capGain") {
    return split.cashAmountCents ?? null;
  }

  // For buy, sell, and fee actions: calculate shares * price + fees
  const sharesValueCents = Math.round(
    (split.sharesMicros * split.priceMicros) / (MICROS_PER_SHARE * MICROS_PER_SHARE) * 100
  );
  return sharesValueCents + split.feesCents;
};

export default function SecurityDetailPage() {
  const bookId = useBookId();
  const toast = useToast();
  const params = useParams<{ id: string }>();
  const securityId = Number(params.id);
  const [security, setSecurity] = useState<SecurityDetail | null>(null);
  const [positionsByAccount, setPositionsByAccount] = useState<PositionByAccount[]>([]);
  const [splits, setSplits] = useState<SecuritySplit[]>([]);
  const [totalSplitsCount, setTotalSplitsCount] = useState(0);
  const [priceHistory, setPriceHistory] = useState<SecurityPriceHistoryRow[]>([]);
  const [totalPriceCount, setTotalPriceCount] = useState(0);
  const [lots, setLots] = useState<OpenLot[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMorePrices, setLoadingMorePrices] = useState(false);
  const [loadingMoreSplits, setLoadingMoreSplits] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showEditModal, setShowEditModal] = useState(false);
  const [editingSplit, setEditingSplit] = useState<SecuritySplit | null>(null);
  const [editingPrice, setEditingPrice] = useState<SecurityPriceHistoryRow | null>(null);
  const [activeTab, setActiveTab] = useState<string>("priceHistory");
  const loadMorePricesRef = useRef<HTMLDivElement>(null);
  const loadMoreSplitsRef = useRef<HTMLDivElement>(null);

  const fetchSecurityDetail = useCallback(async () => {
    const data = await apiGet<{
      security: SecurityDetail;
      positionsByAccount?: PositionByAccount[];
    }>(`/api/b/${bookId}/securities/${securityId}/detail`);

    setSecurity(data.security);
    setPositionsByAccount(data.positionsByAccount ?? []);
  }, [bookId, securityId]);

  const fetchPriceHistory = useCallback(
    async (offset: number, append: boolean) => {
      const data = await apiGet<{
        prices?: SecurityPriceHistoryRow[];
        totalCount?: number;
      }>(
        `/api/b/${bookId}/securities/${securityId}/prices?limit=${PAGE_SIZE}&offset=${offset}`
      );

      const nextPrices: SecurityPriceHistoryRow[] = Array.isArray(data.prices)
        ? data.prices
        : [];

      setPriceHistory((current) => (append ? [...current, ...nextPrices] : nextPrices));
      setTotalPriceCount(data.totalCount ?? nextPrices.length);
    },
    [bookId, securityId]
  );

  const fetchSplits = useCallback(
    async (offset: number, append: boolean) => {
      const data = await apiGet<{
        splits?: SecuritySplit[];
        totalCount?: number;
      }>(
        `/api/b/${bookId}/securities/${securityId}/splits?limit=${PAGE_SIZE}&offset=${offset}`
      );

      const nextSplits: SecuritySplit[] = Array.isArray(data.splits)
        ? data.splits
        : [];

      setSplits((current) => (append ? [...current, ...nextSplits] : nextSplits));
      setTotalSplitsCount(data.totalCount ?? nextSplits.length);
    },
    [bookId, securityId]
  );

  const fetchLots = useCallback(async () => {
    const data = await apiGet<OpenLot[]>(`/api/b/${bookId}/securities/${securityId}/lots`);
    setLots(Array.isArray(data) ? data : []);
  }, [bookId, securityId]);

  useEffect(() => {
    if (!Number.isFinite(securityId)) {
      setError("Invalid security id.");
      setLoading(false);
      return;
    }

    let isMounted = true;
    const fetchAll = async () => {
      setLoading(true);
      setError(null);

      try {
        await Promise.all([
          fetchSecurityDetail(),
          fetchPriceHistory(0, false),
          fetchSplits(0, false),
          fetchLots(),
        ]);
      } catch (fetchError) {
        console.error("Error loading security detail:", fetchError);
        if (isMounted) {
          setError(toMessage(fetchError, "Failed to load security"));
        }
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    };

    // fetchAll already catches every failure into `error` and resolves
    // `loading` in its finally, so it cannot reject.
    void fetchAll();

    return () => {
      isMounted = false;
    };
  }, [securityId, fetchSecurityDetail, fetchPriceHistory, fetchSplits, fetchLots]);

  const hasMorePrices = priceHistory.length < totalPriceCount;
  const hasMoreSplits = splits.length < totalSplitsCount;

  const handleLoadMorePrices = useCallback(async () => {
    if (loadingMorePrices || !hasMorePrices) {
      return;
    }

    setLoadingMorePrices(true);
    try {
      await fetchPriceHistory(priceHistory.length, true);
    } catch (fetchError) {
      console.error("Error loading additional prices:", fetchError);
    } finally {
      setLoadingMorePrices(false);
    }
  }, [fetchPriceHistory, hasMorePrices, loadingMorePrices, priceHistory.length]);

  const handleLoadMoreSplits = useCallback(async () => {
    if (loadingMoreSplits || !hasMoreSplits) {
      return;
    }

    setLoadingMoreSplits(true);
    try {
      await fetchSplits(splits.length, true);
    } catch (fetchError) {
      console.error("Error loading additional splits:", fetchError);
    } finally {
      setLoadingMoreSplits(false);
    }
  }, [fetchSplits, hasMoreSplits, loadingMoreSplits, splits.length]);

  useEffect(() => {
    if (
      activeTab !== "priceHistory" ||
      !hasMorePrices ||
      typeof IntersectionObserver === "undefined"
    ) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const target = entries[0];
        if (target.isIntersecting && !loadingMorePrices) {
          // handleLoadMorePrices already catches its own errors in a
          // try/finally; it cannot reject.
          void handleLoadMorePrices();
        }
      },
      {
        root: null,
        rootMargin: "100px",
        threshold: 0.1,
      }
    );

    const currentRef = loadMorePricesRef.current;
    if (currentRef) {
      observer.observe(currentRef);
    }

    return () => {
      if (currentRef) {
        observer.unobserve(currentRef);
      }
    };
  }, [activeTab, handleLoadMorePrices, hasMorePrices, loadingMorePrices]);

  useEffect(() => {
    if (
      activeTab !== "transactions" ||
      !hasMoreSplits ||
      typeof IntersectionObserver === "undefined"
    ) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const target = entries[0];
        if (target.isIntersecting && !loadingMoreSplits) {
          // handleLoadMoreSplits already catches its own errors in a
          // try/finally; it cannot reject.
          void handleLoadMoreSplits();
        }
      },
      {
        root: null,
        rootMargin: "100px",
        threshold: 0.1,
      }
    );

    const currentRef = loadMoreSplitsRef.current;
    if (currentRef) {
      observer.observe(currentRef);
    }

    return () => {
      if (currentRef) {
        observer.unobserve(currentRef);
      }
    };
  }, [activeTab, handleLoadMoreSplits, hasMoreSplits, loadingMoreSplits]);

  const handleUpdate = async (data: {
    name: string;
    symbol: string;
    securityType: Security["securityType"];
  }) => {
    if (!security) {
      return;
    }

    try {
      await apiPut(`/api/b/${bookId}/securities/${security.id}`, data);
      setShowEditModal(false);
      await fetchSecurityDetail();
    } catch (e) {
      // Modal deliberately stays open on failure so the user can retry.
      toast.error(toMessage(e, "Failed to update security"));
    }
  };

  const handleUpdateStockSplit = async (data: {
    date: string;
    description: string;
    splitNumerator: number;
    splitDenominator: number;
  }) => {
    if (!editingSplit) {
      return;
    }

    // Deliberately not caught here: StockSplitEditForm's own try/catch around
    // this call is what clears its `isSubmitting` state and shows the
    // failure. Catching (and not rethrowing) at this level would resolve the
    // child's await instead of rejecting it, so its catch would never run and
    // the form would stay disabled forever with no way to retry.
    await apiPut(`/api/b/${bookId}/transactions/${editingSplit.transactionId}`, {
      date: data.date,
      description: data.description,
      investmentSplits: [
        {
          securityId: security?.id,
          action: "split",
          sharesMicros: 0,
          priceMicros: 0,
          feesCents: 0,
          splitNumerator: data.splitNumerator,
          splitDenominator: data.splitDenominator,
        },
      ],
    });

    setEditingSplit(null);
    await Promise.all([fetchSecurityDetail(), fetchSplits(0, false)]);
  };

  const handleDeleteStockSplit = async () => {
    if (!editingSplit) {
      return;
    }

    // Deliberately not caught here — see handleUpdateStockSplit above.
    // StockSplitEditForm.handleDelete's own catch clears `isDeleting`.
    await apiDelete(`/api/b/${bookId}/transactions/${editingSplit.transactionId}`);
    setEditingSplit(null);
    await Promise.all([fetchSecurityDetail(), fetchSplits(0, false)]);
  };

  const handleUpdatePrice = async (data: {
    priceDate: string;
    priceMicros: number;
    source: string | null;
  }) => {
    if (!editingPrice) {
      return;
    }

    // Deliberately not caught here — see handleUpdateStockSplit above.
    // PriceHistoryEditForm's own catch clears `isSubmitting` and renders the
    // error inline next to the field.
    await apiPut(
      `/api/b/${bookId}/securities/${securityId}/prices/${editingPrice.priceDate}`,
      data
    );

    setEditingPrice(null);
    await Promise.all([fetchSecurityDetail(), fetchPriceHistory(0, false)]);
  };

  const handleDeletePrice = async () => {
    if (!editingPrice) {
      return;
    }

    // Deliberately not caught here — see handleUpdateStockSplit above.
    // PriceHistoryEditForm.handleDelete's own catch clears `isDeleting` and
    // renders the error inline.
    await apiDelete(
      `/api/b/${bookId}/securities/${securityId}/prices/${editingPrice.priceDate}`
    );

    setEditingPrice(null);
    await Promise.all([fetchSecurityDetail(), fetchPriceHistory(0, false)]);
  };

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="animate-pulse space-y-4">
          <div className="h-8 w-48 bg-surface-tertiary rounded" />
          <div className="h-32 bg-surface-tertiary rounded-lg" />
          <div className="h-64 bg-surface-tertiary rounded-lg" />
          <div className="h-64 bg-surface-tertiary rounded-lg" />
        </div>
      </div>
    );
  }

  if (error || !security) {
    return (
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-4">
        <div className="bg-surface rounded-lg border border-border p-6 text-fg-secondary">
          {error || "Security not found."}
        </div>
        <Link href={`/b/${bookId}/securities`} className="text-fg-accent hover:text-fg-accent">
          ← Back to Securities
        </Link>
      </div>
    );
  }

  const positionsHaveMissingMarketValue = positionsByAccount.some(
    (p) => p.marketValueCents === null
  );
  const totalGainCents = positionsByAccount.reduce(
    (sum, p) => sum + (p.marketValueCents ?? 0) - p.costBasisCents,
    0
  );

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <Link href={`/b/${bookId}/securities`} className="text-sm text-fg-accent hover:text-fg-accent">
            ← Back to Securities
          </Link>
          <h1 className="text-2xl font-bold text-fg mt-2">{security.name}</h1>
          <p className="text-sm text-fg-tertiary">
            {security.symbol} • {securityTypeLabels[security.securityType]}
          </p>
        </div>
        <Button onClick={() => setShowEditModal(true)}>Edit Security</Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <div className="bg-surface rounded-lg border border-border p-4">
          <p className="text-xs uppercase tracking-wide text-fg-tertiary">Current Price</p>
          <p className="mt-1 text-lg font-semibold text-fg tabular-nums">
            {security.latestPriceMicros !== null
              ? formatPriceMicros(security.latestPriceMicros)
              : "—"}
          </p>
          <p className="text-xs text-fg-tertiary">
            {security.latestPriceDate ? formatDate(security.latestPriceDate) : "No price recorded"}
          </p>
        </div>
        <div className="bg-surface rounded-lg border border-border p-4">
          <p className="text-xs uppercase tracking-wide text-fg-tertiary">Open Positions</p>
          <p className="mt-1 text-lg font-semibold text-fg">
            {positionsByAccount.length.toLocaleString("en-US")}
          </p>
          <p className="text-xs text-fg-tertiary">Accounts holding this security</p>
        </div>
        <div className="bg-surface rounded-lg border border-border p-4">
          <p className="text-xs uppercase tracking-wide text-fg-tertiary">Total Shares</p>
          <p className="mt-1 text-lg font-semibold text-fg tabular-nums">
            {formatShares(
              positionsByAccount.reduce((total, position) => total + position.sharesMicros, 0)
            )}
          </p>
          <p className="text-xs text-fg-tertiary">Across all accounts</p>
        </div>
      </div>

      <section className="bg-surface rounded-lg border border-border shadow-soft overflow-hidden">
        <div className="px-6 py-4 border-b border-border">
          <h2 className="text-lg font-semibold text-fg">Positions by Account</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-surface-secondary text-fg-secondary">
              <tr>
                <th className="px-6 py-3 text-left font-medium">Account</th>
                <th className="px-6 py-3 text-right font-medium">Shares</th>
                <th className="px-6 py-3 text-right font-medium">Cost Basis</th>
                <th className="px-6 py-3 text-right font-medium">Gain</th>
                <th className="px-6 py-3 text-right font-medium">Market Value</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-secondary">
              {positionsByAccount.length === 0 ? (
                <tr>
                  <td className="px-6 py-8 text-center text-fg-tertiary" colSpan={5}>
                    No open positions for this security.
                  </td>
                </tr>
              ) : (
                <>
                  {positionsByAccount.map((position) => (
                    <tr key={position.accountId}>
                      <td className="px-6 py-4 text-fg">
                        <Link
                          href={`/b/${bookId}/transactions?accountId=${position.accountId}`}
                          className="text-fg-accent hover:text-fg-accent hover:underline"
                        >
                          {position.accountName}
                        </Link>
                        {!position.isActive && (
                          <span className="ml-2 text-xs text-fg-tertiary">(inactive)</span>
                        )}
                      </td>
                      <td className="px-6 py-4 text-right text-fg-secondary tabular-nums">
                        {formatShares(position.sharesMicros)}
                      </td>
                      <td className="px-6 py-4 text-right text-fg-secondary tabular-nums">
                        {formatCurrency(position.costBasisCents)}
                      </td>
                      <td
                        className={`px-6 py-4 text-right tabular-nums ${
                          position.marketValueCents === null
                            ? "text-fg-secondary"
                            : gainColorClass(position.marketValueCents - position.costBasisCents)
                        }`}
                      >
                        {position.marketValueCents === null
                          ? "—"
                          : formatCurrency(position.marketValueCents - position.costBasisCents)}
                      </td>
                      <td className="px-6 py-4 text-right font-medium text-fg tabular-nums">
                        {position.marketValueCents === null
                          ? "—"
                          : formatCurrency(position.marketValueCents)}
                      </td>
                    </tr>
                  ))}
                  <tr className="border-t-2 border-border bg-surface-secondary font-semibold">
                    <td className="px-6 py-4 text-fg">Total</td>
                    <td className="px-6 py-4 text-right text-fg tabular-nums">
                      {formatShares(
                        positionsByAccount.reduce((sum, p) => sum + p.sharesMicros, 0)
                      )}
                    </td>
                    <td className="px-6 py-4 text-right text-fg tabular-nums">
                      {formatCurrency(
                        positionsByAccount.reduce((sum, p) => sum + p.costBasisCents, 0)
                      )}
                    </td>
                    <td className="px-6 py-4 text-right text-fg tabular-nums">
                      {positionsHaveMissingMarketValue ? (
                        "—"
                      ) : (
                        <span className={gainColorClass(totalGainCents)}>
                          {formatCurrency(totalGainCents)}
                        </span>
                      )}
                    </td>
                    <td className="px-6 py-4 text-right text-fg tabular-nums">
                      {positionsHaveMissingMarketValue
                        ? "—"
                        : formatCurrency(
                            positionsByAccount.reduce((sum, p) => sum + (p.marketValueCents ?? 0), 0)
                          )}
                    </td>
                  </tr>
                </>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {splits.some((s) => s.action === "split") && (
        <section className="bg-surface rounded-lg border border-border shadow-soft overflow-hidden">
          <div className="px-6 py-4 border-b border-border">
            <h2 className="text-lg font-semibold text-fg">Stock Splits</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-surface-secondary text-fg-secondary">
                <tr>
                  <th className="px-6 py-3 text-left font-medium">Date</th>
                  <th className="px-6 py-3 text-left font-medium">Split Ratio</th>
                  <th className="px-6 py-3 text-left font-medium">Account</th>
                  <th className="px-6 py-3 text-left font-medium">Transaction</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-secondary">
                {splits
                  .filter((s) => s.action === "split")
                  .map((split) => (
                    <tr
                      key={split.id}
                      onClick={() => setEditingSplit(split)}
                      className="cursor-pointer hover:bg-surface-secondary transition-colors"
                    >
                      <td className="px-6 py-4 text-fg-secondary">{formatDate(split.transactionDate)}</td>
                      <td className="px-6 py-4 text-fg font-medium">
                        {split.splitNumerator && split.splitDenominator
                          ? `${split.splitNumerator}-for-${split.splitDenominator}`
                          : "—"}
                      </td>
                      <td className="px-6 py-4 text-fg-secondary">{split.accountName}</td>
                      <td className="px-6 py-4 text-fg-secondary">
                        {split.transactionDescription || "No description"}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <Tabs
        activeTab={activeTab}
        onTabChange={setActiveTab}
        tabs={[
          {
            id: "priceHistory",
            label: "Price History",
            content: (
              <>
                <div className="overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <thead className="bg-surface-secondary text-fg-secondary">
                      <tr>
                        <th className="px-6 py-3 text-left font-medium">Date</th>
                        <th className="px-6 py-3 text-right font-medium">Price</th>
                        <th className="px-6 py-3 text-right font-medium">Source</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border-secondary">
                      {priceHistory.length === 0 ? (
                        <tr>
                          <td className="px-6 py-8 text-center text-fg-tertiary" colSpan={3}>
                            No historical prices available.
                          </td>
                        </tr>
                      ) : (
                        priceHistory.map((price) => (
                          <tr
                            key={price.priceDate}
                            onClick={() => setEditingPrice(price)}
                            className="cursor-pointer hover:bg-surface-secondary transition-colors"
                          >
                            <td className="px-6 py-4 text-fg-secondary">{formatDate(price.priceDate)}</td>
                            <td className="px-6 py-4 text-right text-fg font-medium tabular-nums">
                              {formatPriceMicros(price.priceMicros)}
                            </td>
                            <td className="px-6 py-4 text-right text-fg-secondary">
                              {price.source ?? "—"}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
                {priceHistory.length > 0 && hasMorePrices && (
                  <div
                    ref={loadMorePricesRef}
                    className="px-6 py-4 border-t border-border text-center"
                  >
                    {loadingMorePrices ? (
                      <div className="inline-flex items-center gap-2 text-sm text-fg-tertiary">
                        <div className="w-4 h-4 border-2 border-border border-t-accent rounded-full animate-spin" />
                        <span>Loading more prices...</span>
                      </div>
                    ) : (
                      <span className="text-sm text-fg-tertiary">Scroll for more</span>
                    )}
                  </div>
                )}
              </>
            ),
          },
          {
            id: "transactions",
            label: "Transactions",
            content: (
              <>
                <div className="overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <thead className="bg-surface-secondary text-fg-secondary">
                      <tr>
                        <th className="px-6 py-3 text-left font-medium">Date</th>
                        <th className="px-6 py-3 text-left font-medium">Account</th>
                        <th className="px-6 py-3 text-left font-medium">Action</th>
                        <th className="px-6 py-3 text-right font-medium">Shares</th>
                        <th className="px-6 py-3 text-right font-medium">Price</th>
                        <th className="px-6 py-3 text-right font-medium">Fees</th>
                        <th className="px-6 py-3 text-right font-medium">Amount</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border-secondary">
                      {splits.length === 0 ? (
                        <tr>
                          <td className="px-6 py-8 text-center text-fg-tertiary" colSpan={7}>
                            No transactions available for this security.
                          </td>
                        </tr>
                      ) : (
                        splits.map((split) => {
                          const amount = calculateAmount(split);
                          return (
                            <tr key={split.id}>
                              <td className="px-6 py-4 text-fg-secondary">
                                {formatDate(split.transactionDate)}
                              </td>
                              <td className="px-6 py-4 text-fg-secondary">{split.accountName}</td>
                              <td className="px-6 py-4 text-fg">{formatSplitAction(split)}</td>
                              <td className="px-6 py-4 text-right text-fg-secondary tabular-nums">
                                {split.action === "split" || split.action === "dividend" || split.action === "capGain"
                                  ? "—"
                                  : formatShares(split.sharesMicros)}
                              </td>
                              <td className="px-6 py-4 text-right text-fg-secondary tabular-nums">
                                {split.action === "split" || split.action === "dividend" || split.action === "capGain"
                                  ? "—"
                                  : formatPriceMicros(split.priceMicros)}
                              </td>
                              <td className="px-6 py-4 text-right text-fg-secondary tabular-nums">
                                {split.feesCents > 0 ? formatCurrency(split.feesCents) : "—"}
                              </td>
                              <td className="px-6 py-4 text-right text-fg font-medium tabular-nums">
                                {amount !== null ? formatCurrency(amount) : "—"}
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
                {splits.length > 0 && hasMoreSplits && (
                  <div
                    ref={loadMoreSplitsRef}
                    className="px-6 py-4 border-t border-border text-center"
                  >
                    {loadingMoreSplits ? (
                      <div className="inline-flex items-center gap-2 text-sm text-fg-tertiary">
                        <div className="w-4 h-4 border-2 border-border border-t-accent rounded-full animate-spin" />
                        <span>Loading more transactions...</span>
                      </div>
                    ) : (
                      <span className="text-sm text-fg-tertiary">Scroll for more</span>
                    )}
                  </div>
                )}
              </>
            ),
          },
          {
            id: "lots",
            label: "Lots",
            content: (
              <SecurityLotsTable lots={lots} latestPriceMicros={security.latestPriceMicros} />
            ),
          },
        ]}
      />

      <Modal
        isOpen={showEditModal}
        onClose={() => setShowEditModal(false)}
        title="Edit Security"
      >
        <SecurityForm
          security={security}
          onSubmit={handleUpdate}
          onCancel={() => setShowEditModal(false)}
        />
      </Modal>

      <Modal
        isOpen={editingSplit !== null}
        onClose={() => setEditingSplit(null)}
        title="Edit Stock Split"
      >
        {editingSplit && (
          <StockSplitEditForm
            split={editingSplit}
            onSubmit={handleUpdateStockSplit}
            onDelete={handleDeleteStockSplit}
            onCancel={() => setEditingSplit(null)}
          />
        )}
      </Modal>

      <Modal
        isOpen={editingPrice !== null}
        onClose={() => setEditingPrice(null)}
        title="Edit Price Entry"
      >
        {editingPrice && (
          <PriceHistoryEditForm
            priceEntry={editingPrice}
            onSubmit={handleUpdatePrice}
            onDelete={handleDeletePrice}
            onCancel={() => setEditingPrice(null)}
          />
        )}
      </Modal>
    </div>
  );
}
