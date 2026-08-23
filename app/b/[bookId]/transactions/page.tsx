"use client";

import { useEffect, useState, useCallback, useRef, useMemo, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useBookId } from "@/hooks/useBookId";
import {
  AccountList,
  DEFAULT_EXPANDED_TYPES,
  DEFAULT_EXPANDED_SUBTYPES,
} from "@/components/accounts/AccountList";
import { TransactionList } from "@/components/transactions/TransactionList";
import { TransactionForm } from "@/components/transactions/TransactionForm";
import type { TransactionFormHandle } from "@/components/transactions/TransactionForm";
import { InvestmentPositionsSection } from "@/components/transactions/InvestmentPositionsSection";
import { StaleSyncBanner } from "@/components/transactions/StaleSyncBanner";
import { PRICES_SAVED_EVENT } from "@/lib/events";
import { Modal } from "@/components/ui/Modal";
import { DateRangeFilter } from "@/components/ui/DateRangeFilter";
import { PayeeAutocomplete } from "@/components/ui/PayeeAutocomplete";
import {
  flattenAccounts,
  buildAccountTree,
  flattenAccountTreeWithDepth,
  ACCOUNT_TYPE_ORDER,
  getEffectiveDate,
  getNextBusinessDay,
} from "@/lib/accounting";
import { useRegisterShortcuts } from "@/hooks/useRegisterShortcuts";
import type { ShortcutDef } from "@/components/KeyboardShortcutProvider";
import { mergeTransactionsForDisplay } from "@/lib/merge-transactions";
import { toDateString, formatDate, isValidDateString } from "@/lib/formatters";
import { apiGet, apiPost, apiPut, apiDelete, toMessage } from "@/lib/api-client";
import { useToast } from "@/components/ui/ToastProvider";
import type { PositionSummary } from "@/lib/investments";
import type {
  InvestmentSplitInput,
  PlaidLinkData,
  SplitInput,
  TransactionWithSplits,
} from "@/types";
import { useTransactionsPageData } from "./useTransactionsPageData";

const TransactionsPageSkeleton = () => (
  <div className="h-[calc(100vh-3.5rem)] lg:h-[calc(100vh-4rem)] flex">
    <div className="hidden lg:block w-64 border-r border-border bg-surface p-4">
      <div className="animate-pulse space-y-4">
        {[1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="h-8 bg-surface-tertiary rounded" />
        ))}
      </div>
    </div>
    <div className="flex-1 animate-pulse p-4">
      <div className="h-96 bg-surface-tertiary rounded-lg" />
    </div>
  </div>
);

function TransactionsPageInner() {
  const [positions, setPositions] = useState<PositionSummary[]>([]);
  const [positionsLoading, setPositionsLoading] = useState(false);
  const [editingTransaction, setEditingTransaction] =
    useState<TransactionWithSplits | null>(null);
  const [editingPlaidData, setEditingPlaidData] = useState<PlaidLinkData | null>(null);
  const [favoriteUpdating, setFavoriteUpdating] = useState(false);
  const [showInactive, setShowInactive] = useState(false);
  const [showUpcoming, setShowUpcoming] = useState(() => {
    if (typeof window !== "undefined") {
      try {
        return localStorage.getItem("showUpcoming") === "true";
      } catch {
        return false;
      }
    }
    return false;
  });
  const [loadingMore, setLoadingMore] = useState(false);
  const searchParams = useSearchParams();
  // Seed the date filter from the URL so links (e.g. from the income
  // statement) arrive with the same date range already applied. Validate first:
  // these values flow into formatDate (which throws on an invalid date) and the
  // transactions API query, so a hand-edited param like ?startDate=abc must not
  // crash the page — fall back to no filter.
  const [startDate, setStartDate] = useState(() => {
    const param = searchParams.get("startDate") ?? "";
    return isValidDateString(param) ? param : "";
  });
  const [endDate, setEndDate] = useState(() => {
    const param = searchParams.get("endDate") ?? "";
    return isValidDateString(param) ? param : "";
  });
  const [selectedPayeeId, setSelectedPayeeId] = useState<number | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    if (typeof window !== "undefined") {
      try {
        const stored = localStorage.getItem("transactionsSidebarWidth");
        return stored ? parseInt(stored, 10) : 256;
      } catch {
        return 256;
      }
    }
    return 256;
  });
  const [isResizing, setIsResizing] = useState(false);
  const [newTransactionId, setNewTransactionId] = useState<number | null>(null);
  // Bumped when a reconcile toggle succeeds — that path only updates local
  // state (no refreshData), but the stale-sync banner must still re-check
  // since "mark reconciled to dismiss" is its documented dismissal
  const [reconcileVersion, setReconcileVersion] = useState(0);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [mobileCreateOpen, setMobileCreateOpen] = useState(false);
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const transactionFormRef = useRef<TransactionFormHandle>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const routerRef = useRef(router);
  const navIndexRef = useRef(-1);
  routerRef.current = router;

  const bookId = useBookId();
  const toast = useToast();

  // Sidebar resize handlers
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault(); // Prevent text selection from starting
    setIsResizing(true);
  }, []);

  const handleMouseUp = useCallback(() => {
    setIsResizing(false);
  }, []);

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isResizing) return;
      const newWidth = Math.max(200, Math.min(600, e.clientX));
      setSidebarWidth(newWidth);
      try {
        localStorage.setItem("transactionsSidebarWidth", newWidth.toString());
      } catch {
        // Ignore localStorage errors
      }
    },
    [isResizing]
  );

  useEffect(() => {
    if (isResizing) {
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "ew-resize";
      document.body.style.userSelect = "none";
      return () => {
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
    }
  }, [isResizing, handleMouseMove, handleMouseUp]);

  // Sidebar expanded state (lifted from AccountList for keyboard navigation)
  const [expandedTypes, setExpandedTypes] = useState<Set<string>>(
    () => new Set(DEFAULT_EXPANDED_TYPES)
  );
  const [expandedSubtypes, setExpandedSubtypes] = useState<Set<string>>(
    () => new Set(DEFAULT_EXPANDED_SUBTYPES)
  );

  const handleToggleType = useCallback((type: string) => {
    setExpandedTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) {
        next.delete(type);
      } else {
        next.add(type);
      }
      return next;
    });
  }, []);

  const handleToggleSubtype = useCallback((subtype: string) => {
    setExpandedSubtypes((prev) => {
      const next = new Set(prev);
      if (next.has(subtype)) {
        next.delete(subtype);
      } else {
        next.add(subtype);
      }
      return next;
    });
  }, []);

  const clearDateFilter = useCallback(() => {
    setStartDate("");
    setEndDate("");
  }, []);

  const highlightParam = searchParams.get("highlight");
  const parsedHighlight = highlightParam ? parseInt(highlightParam, 10) : null;
  const [highlightTransactionId, setHighlightTransactionId] = useState<number | null>(parsedHighlight);
  const ensureIdRef = useRef<number | null>(parsedHighlight);

  useEffect(() => {
    setHighlightTransactionId(parsedHighlight);
    ensureIdRef.current = parsedHighlight;
  }, [parsedHighlight]);

  const accountIdParam = searchParams.get("accountId");
  const parsedAccountId = accountIdParam ? Number(accountIdParam) : null;
  const selectedAccountId =
    parsedAccountId !== null && Number.isFinite(parsedAccountId)
      ? parsedAccountId
      : null;

  const scrollTransactionsToTop = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    if (typeof container.scrollTo === "function") {
      container.scrollTo({ top: 0, behavior: "auto" });
      return;
    }
    container.scrollTop = 0;
  }, []);

  const {
    accounts,
    payees,
    transactions,
    projectedTransactions,
    plaidPendingTransactions,
    marketValues,
    startingBalance,
    totalCount,
    positionsVersion,
    loading,
    error,
    transactionsLoading,
    loadMoreFailed,
    fetchTransactionsPage,
    refreshData,
    setTransactions,
    setAccounts,
    setLoadMoreFailed,
  } = useTransactionsPageData({
    bookId,
    accountId: selectedAccountId,
    startDate,
    endDate,
    selectedPayeeId,
    showUpcoming,
    scrollTransactionsToTop,
    ensureIdRef,
  });

  const selectedAccount = selectedAccountId
    ? accounts.find((account) => account.id === selectedAccountId)
    : null;
  const isInvestmentAccount =
    selectedAccount?.type === "asset" && selectedAccount?.subtype === "investment";
  const investmentCashAccount = isInvestmentAccount
    ? accounts.find(
        (account) =>
          account.parentId === selectedAccountId && account.isInvestmentCash
      )
    : null;
  const investmentCashBalance = investmentCashAccount?.balance ?? 0;
  const investmentCashAccountId = investmentCashAccount?.id ?? null;

  // Persist last selected account to localStorage (per book)
  useEffect(() => {
    if (selectedAccountId !== null) {
      try {
        localStorage.setItem(
          `lastSelectedAccountId:${bookId}`,
          selectedAccountId.toString()
        );
      } catch {
        // Ignore localStorage errors (private browsing, quota, etc.)
      }
    }
  }, [selectedAccountId, bookId]);

  // Prices saved from the navbar pill change market values in the
  // positions table, so refresh without a loading flash
  useEffect(() => {
    // addEventListener requires a void-returning listener; refreshData
    // already handles its own errors, so wrapping it is a safe
    // fire-and-forget subscription handler.
    const handler = () => {
      void refreshData(false);
    };
    window.addEventListener(PRICES_SAVED_EVENT, handler);
    return () => window.removeEventListener(PRICES_SAVED_EVENT, handler);
  }, [refreshData]);

  useEffect(() => {
    scrollTransactionsToTop();
  }, [selectedAccountId, scrollTransactionsToTop]);

  useEffect(() => {
    if (!selectedAccountId || !isInvestmentAccount) {
      setPositions([]);
      setPositionsLoading(false);
      return;
    }

    let isMounted = true;
    const fetchPositions = async () => {
      setPositionsLoading(true);
      try {
        const data = await apiGet<PositionSummary[]>(
          `/api/b/${bookId}/investments/positions?accountId=${selectedAccountId}`
        );
        if (isMounted) {
          setPositions(data);
        }
      } catch (error) {
        console.error("Error fetching investment positions:", error);
        if (isMounted) {
          setPositions([]);
        }
      } finally {
        if (isMounted) {
          setPositionsLoading(false);
        }
      }
    };

    // fetchPositions has its own try/catch/finally and cannot reject.
    void fetchPositions();

    return () => {
      isMounted = false;
    };
  }, [selectedAccountId, isInvestmentAccount, positionsVersion, bookId]);

  const handleLoadMore = useCallback(async () => {
    if (loadingMore) return;
    const nextOffset = transactions.length;
    if (nextOffset >= totalCount) return;

    setLoadingMore(true);
    // Clear any prior failure as this new attempt begins — whether it was
    // triggered automatically or via the "Try again" control.
    setLoadMoreFailed(false);
    try {
      await fetchTransactionsPage(nextOffset, true, {
        selectedAccountId,
        isInvestmentAccount,
        investmentCashAccountId,
        startDate,
        endDate,
        selectedPayeeId,
      });
    } catch {
      // A failed "load more" leaves the already-rendered list intact, so
      // surface it as a toast instead of the full-page error state. It also
      // sets loadMoreFailed, which the observer effect below checks before
      // auto-triggering again — without it, the observer effect re-runs
      // (loadingMore is one of its deps) and re-observes a sentinel that's
      // still on-screen, firing an immediate "intersecting" callback that
      // would otherwise retry forever. The user can still retry deliberately
      // via the "Try again" control, which clears the flag itself.
      toast.error("Could not load more transactions.");
      setLoadMoreFailed(true);
    } finally {
      setLoadingMore(false);
    }
  }, [
    loadingMore,
    transactions.length,
    totalCount,
    fetchTransactionsPage,
    selectedAccountId,
    isInvestmentAccount,
    investmentCashAccountId,
    startDate,
    endDate,
    selectedPayeeId,
    toast,
    setLoadMoreFailed,
  ]);

  // Infinite scroll using Intersection Observer
  useEffect(() => {
    // Check if IntersectionObserver is available (not available in test environment)
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
          void handleLoadMore();
        }
      },
      {
        root: null,
        rootMargin: "100px", // Start loading 100px before reaching the sentinel
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
  }, [handleLoadMore, loadingMore, loadMoreFailed, transactions.length, totalCount]);

  useEffect(() => {
    if (!editingTransaction) {
      setEditingPlaidData(null);
      return;
    }
    let cancelled = false;
    apiGet<PlaidLinkData | null>(
      `/api/b/${bookId}/transactions/${editingTransaction.id}/plaid`
    )
      .then((data) => {
        if (!cancelled) setEditingPlaidData(data);
      })
      .catch(() => {
        if (!cancelled) setEditingPlaidData(null);
      });
    return () => { cancelled = true; };
  }, [editingTransaction, bookId]);


  const handleCreateTransaction = async (data: {
    date: string;
    description: string;
    notes?: string;
    checkNumber?: string;
    payeeName?: string;
    isReconciled?: boolean;
    isFloating?: boolean;
    splits: SplitInput[];
    investmentSplits?: InvestmentSplitInput[];
  }) => {
    try {
      const created = await apiPost<TransactionWithSplits>(
        `/api/b/${bookId}/transactions`,
        data
      );
      setNewTransactionId(created.id);
      toast.success("Transaction added");
      scrollContainerRef.current?.scrollTo({ top: 0, behavior: "smooth" });
      void refreshData(false);
    } catch (e) {
      toast.error(toMessage(e, "Failed to create transaction"));
    }
  };

  const handleUpdateTransaction = async (data: {
    date: string;
    description: string;
    notes?: string;
    checkNumber?: string;
    payeeName?: string;
    isReconciled?: boolean;
    splits: SplitInput[];
    investmentSplits?: InvestmentSplitInput[];
  }) => {
    if (!editingTransaction) return;

    try {
      await apiPut(`/api/b/${bookId}/transactions/${editingTransaction.id}`, data);
      toast.success("Transaction updated");
      setEditingTransaction(null);
      void refreshData(false);
    } catch (e) {
      toast.error(toMessage(e, "Failed to update transaction"));
    }
  };

  const handleDeleteTransaction = async () => {
    if (!editingTransaction) return;

    if (!confirm("Are you sure you want to delete this transaction?")) return;

    try {
      await apiDelete(`/api/b/${bookId}/transactions/${editingTransaction.id}`);
      setEditingTransaction(null);
      void refreshData(false);
    } catch (e) {
      toast.error(toMessage(e, "Failed to delete transaction"));
    }
  };

  const handleToggleFavorite = useCallback(async () => {
    if (!selectedAccountId || !selectedAccount || favoriteUpdating) {
      return;
    }

    const nextFavoriteState = !selectedAccount.isFavorite;
    setFavoriteUpdating(true);
    setAccounts((prev) =>
      prev.map((account) =>
        account.id === selectedAccountId
          ? { ...account, isFavorite: nextFavoriteState }
          : account
      )
    );

    try {
      await apiPut(`/api/b/${bookId}/accounts/${selectedAccountId}`, {
        isFavorite: nextFavoriteState,
      });
    } catch (error) {
      console.error("Error updating favorite account:", error);
      setAccounts((prev) =>
        prev.map((account) =>
          account.id === selectedAccountId
            ? { ...account, isFavorite: !nextFavoriteState }
            : account
        )
      );
      toast.error(toMessage(error, "Failed to update favorite account"));
    } finally {
      setFavoriteUpdating(false);
    }
  }, [favoriteUpdating, selectedAccount, selectedAccountId, bookId, toast, setAccounts]);

  const handleToggleReconciled = useCallback(
    async (transactionId: number, isReconciled: boolean) => {
      const existing = transactions.find((tx) => tx.id === transactionId);
      const clearFloating = isReconciled && existing?.isFloating === true;
      const clearedDate = clearFloating ? toDateString(new Date()) : undefined;

      const payload: {
        isReconciled: boolean;
        isFloating?: boolean;
        date?: string;
      } = { isReconciled };
      if (clearFloating) {
        payload.isFloating = false;
        payload.date = clearedDate;
      }

      const previousSnapshot = existing
        ? {
            isReconciled: existing.isReconciled,
            isFloating: existing.isFloating,
            date: existing.date,
          }
        : null;

      // Optimistic update
      setTransactions((prev) =>
        prev.map((tx) =>
          tx.id === transactionId
            ? {
                ...tx,
                isReconciled,
                ...(clearFloating && { isFloating: false, date: clearedDate! }),
              }
            : tx
        )
      );

      try {
        await apiPut(`/api/b/${bookId}/transactions/${transactionId}`, payload);
        setReconcileVersion((v) => v + 1);
      } catch (error) {
        console.error("Error toggling reconciled:", error);
        // Revert optimistic update
        setTransactions((prev) =>
          prev.map((tx) =>
            tx.id === transactionId
              ? {
                  ...tx,
                  isReconciled: previousSnapshot?.isReconciled ?? !isReconciled,
                  ...(previousSnapshot && {
                    isFloating: previousSnapshot.isFloating,
                    date: previousSnapshot.date,
                  }),
                }
              : tx
          )
        );
      }
    },
    [bookId, transactions, setTransactions]
  );

  const handleMoveToNextBusinessDay = useCallback(
    async (transactionId: number) => {
      const existing = transactions.find((tx) => tx.id === transactionId);
      if (!existing || existing.isReconciled) return;

      // Base off the effective date: for floating transactions the stored date may
      // be stale (it auto-advances to today), so "next business day" means the next
      // one after today. Pinning requires clearing the float.
      const nextDate = getNextBusinessDay(getEffectiveDate(existing));
      const clearFloating = existing.isFloating === true;

      const payload: { date: string; isFloating?: boolean } = { date: nextDate };
      if (clearFloating) {
        payload.isFloating = false;
      }

      const previousSnapshot = {
        date: existing.date,
        isFloating: existing.isFloating,
      };

      // Optimistic update
      setTransactions((prev) =>
        prev.map((tx) =>
          tx.id === transactionId
            ? { ...tx, date: nextDate, ...(clearFloating && { isFloating: false }) }
            : tx
        )
      );

      try {
        await apiPut(`/api/b/${bookId}/transactions/${transactionId}`, payload);
        toast.success(`Moved to ${formatDate(nextDate)}`);
        // The date moved into the future, so balances as-of today changed —
        // refresh the sidebar/account balances and running balances like the
        // other date-changing paths do.
        void refreshData(false);
      } catch (error) {
        console.error("Error moving transaction to next business day:", error);
        // Revert optimistic update
        setTransactions((prev) =>
          prev.map((tx) =>
            tx.id === transactionId ? { ...tx, ...previousSnapshot } : tx
          )
        );
      }
    },
    [bookId, transactions, refreshData, toast, setTransactions]
  );

  const handleMakeRecurring = useCallback((transactionId: number) => {
    setEditingTransaction(null);
    router.push(`/b/${bookId}/recurring?fromTransaction=${transactionId}`);
  }, [router, bookId]);

  const handleNavigateToAccount = useCallback(
    (accountId: number, transactionId: number) => {
      scrollTransactionsToTop();
      const params = new URLSearchParams();
      params.set("accountId", accountId.toString());
      params.set("highlight", transactionId.toString());
      const targetUrl = `/b/${bookId}/transactions?${params.toString()}`;
      if (process.env.NODE_ENV !== "test" && typeof window !== "undefined") {
        window.location.assign(targetUrl);
        return;
      }
      router.push(targetUrl);
    },
    [bookId, router, scrollTransactionsToTop]
  );

  // Pending Plaid rows are fetched unfiltered; respect the page filters here.
  // They have no local payee, so any payee filter hides them entirely.
  const visiblePlaidPending = useMemo(() => {
    if (selectedPayeeId !== null) return [];
    return plaidPendingTransactions.filter(
      (tx) =>
        (!startDate || tx.date >= startDate) && (!endDate || tx.date <= endDate)
    );
  }, [plaidPendingTransactions, selectedPayeeId, startDate, endDate]);

  // Build navigable account list matching sidebar visual order
  const navigableAccounts = useMemo(() => {
    const flat = flattenAccounts(accounts);
    const filtered = flat.filter((a) => {
      if (!showInactive && !a.isActive) return false;
      return true;
    });

    const result: (number | null)[] = [];

    // 1. Favorites (sorted alphabetically, excluding investment cash)
    const favorites = filtered
      .filter((a) => a.isFavorite && !a.isInvestmentCash)
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const fav of favorites) {
      result.push(fav.id);
    }

    // 2. "All Accounts" (null)
    result.push(null);

    // 3. Accounts by type, respecting expanded state
    const grouped = filtered.reduce(
      (acc, account) => {
        if (!acc[account.type]) acc[account.type] = [];
        acc[account.type].push(account);
        return acc;
      },
      {} as Record<string, typeof filtered>
    );

    const sortedTypes = ACCOUNT_TYPE_ORDER.filter((t) => grouped[t]);
    for (const type of sortedTypes) {
      if (!expandedTypes.has(type)) continue;
      const typeAccounts = grouped[type];
      const treeAccounts = buildAccountTree(typeAccounts);
      const visibleRows = flattenAccountTreeWithDepth(treeAccounts).filter(
        ({ account }) => !account.isInvestmentCash
      );

      const shouldGroupBySubtype = visibleRows.some(({ account }) =>
        Boolean(account.subtype)
      );

      if (!shouldGroupBySubtype) {
        for (const { account } of visibleRows) {
          result.push(account.id);
        }
      } else {
        const accountsBySubtype = visibleRows.reduce(
          (acc, row) => {
            const subtype = row.account.subtype || "other";
            if (!acc[subtype]) acc[subtype] = [];
            acc[subtype].push(row);
            return acc;
          },
          {} as Record<string, typeof visibleRows>
        );

        for (const [subtype, rows] of Object.entries(accountsBySubtype)) {
          if (!expandedSubtypes.has(subtype)) continue;
          for (const { account } of rows) {
            result.push(account.id);
          }
        }
      }
    }

    return result;
  }, [accounts, showInactive, expandedTypes, expandedSubtypes]);

  // Resolve current position in navigableAccounts.
  // Uses the ref if it still points to the correct account (sequential j/k),
  // otherwise falls back to indexOf (e.g. after a manual sidebar click).
  const resolveNavIndex = useCallback(
    (accountId: number | null) => {
      const ref = navIndexRef.current;
      if (ref >= 0 && ref < navigableAccounts.length && navigableAccounts[ref] === accountId) {
        return ref;
      }
      return navigableAccounts.indexOf(accountId);
    },
    [navigableAccounts]
  );

  const navigateToIndex = useCallback(
    (idx: number) => {
      navIndexRef.current = idx;
      const id = navigableAccounts[idx];
      if (id === null) {
        routerRef.current.push(`/b/${bookId}/transactions`);
      } else {
        routerRef.current.push(`/b/${bookId}/transactions?accountId=${id}`);
      }
    },
    [navigableAccounts, bookId]
  );

  // Register page-specific keyboard shortcuts
  const pageShortcuts = useMemo<ShortcutDef[]>(
    () => [
      {
        id: "txn-new",
        keys: ["n"],
        description: "New transaction",
        category: "Page",
        action: () => transactionFormRef.current?.focus(),
      },
      {
        id: "txn-account-down",
        keys: ["j"],
        description: "Next account",
        category: "Page",
        action: () => {
          const currentIdx = resolveNavIndex(selectedAccountId);
          const nextIdx =
            currentIdx < navigableAccounts.length - 1 ? currentIdx + 1 : 0;
          navigateToIndex(nextIdx);
        },
      },
      {
        id: "txn-account-up",
        keys: ["k"],
        description: "Previous account",
        category: "Page",
        action: () => {
          const currentIdx = resolveNavIndex(selectedAccountId);
          const prevIdx =
            currentIdx > 0 ? currentIdx - 1 : navigableAccounts.length - 1;
          navigateToIndex(prevIdx);
        },
      },
    ],
    [navigableAccounts, selectedAccountId, resolveNavIndex, navigateToIndex]
  );

  useRegisterShortcuts(pageShortcuts);

  if (error) {
    return (
      <div className="h-[calc(100vh-3.5rem)] lg:h-[calc(100vh-4rem)] flex items-center justify-center">
        <p className="text-danger">{error}</p>
      </div>
    );
  }

  if (loading) {
    return <TransactionsPageSkeleton />;
  }

  // Create market value map for investment accounts
  const marketValueMap = new Map(
    marketValues.map((mv) => [mv.accountId, mv.marketValueCents])
  );

  // Label for the active date-range filter (shown as a clearable chip on
  // mobile, where the full DateRangeFilter control is hidden).
  const dateFilterLabel =
    startDate && endDate
      ? `${formatDate(startDate)} – ${formatDate(endDate)}`
      : startDate
        ? `From ${formatDate(startDate)}`
        : endDate
          ? `Until ${formatDate(endDate)}`
          : null;

  const sidebarContent = (
    <div className="p-4">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-fg">Accounts</h2>
        <label className="flex items-center gap-1.5 text-xs text-fg-tertiary">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
            className="rounded text-accent focus:ring-accent"
          />
          Inactive
        </label>
      </div>
      <AccountList
        accounts={accounts}
        selectedAccountId={selectedAccountId}
        basePath={`/b/${bookId}/transactions`}
        showInactive={showInactive}
        marketValueMap={marketValueMap}
        expandedTypes={expandedTypes}
        expandedSubtypes={expandedSubtypes}
        onToggleType={handleToggleType}
        onToggleSubtype={handleToggleSubtype}
        onAccountClick={() => setMobileSidebarOpen(false)}
      />
    </div>
  );

  return (
    <div className="h-[calc(100vh-3.5rem)] lg:h-[calc(100vh-4rem)] flex">
      {/* Desktop sidebar */}
      <div
        className="hidden lg:flex border-r border-border bg-surface relative flex-col"
        style={{ width: `${sidebarWidth}px`, minWidth: "200px", maxWidth: "600px" }}
      >
        <div className="overflow-y-auto flex-1 pr-2.5">
          {sidebarContent}
        </div>
        {/* Resize handle */}
        <div
          className={`absolute top-0 right-0 w-2.5 h-full cursor-ew-resize transition-colors select-none z-10 ${
            isResizing ? "bg-accent" : "bg-surface-tertiary hover:bg-accent"
          }`}
          onMouseDown={handleMouseDown}
        />
      </div>

      {/* Mobile sidebar drawer */}
      {mobileSidebarOpen && (
        <div className="fixed inset-0 z-40 lg:hidden" aria-modal="true">
          <div
            className="fixed inset-0 bg-black/40"
            onClick={() => setMobileSidebarOpen(false)}
          />
          <div className="fixed top-14 left-0 bottom-0 w-72 bg-surface border-r border-border shadow-xl overflow-y-auto animate-mobile-menu-in-left">
            {sidebarContent}
          </div>
        </div>
      )}

      <div className="flex-1 flex flex-col overflow-hidden">
        <div
          ref={scrollContainerRef}
          className="flex-1 overflow-y-auto bg-surface"
        >
          <div className="px-3 py-3 lg:px-6 lg:py-4 border-b border-border">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center min-w-0">
                {/* Mobile account picker button */}
                <button
                  type="button"
                  onClick={() => setMobileSidebarOpen(true)}
                  className="lg:hidden mr-2 p-1.5 text-fg-secondary hover:text-fg rounded-md hover:bg-surface-tertiary transition-colors flex-shrink-0"
                  aria-label="Open accounts"
                >
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h7" />
                  </svg>
                </button>
                <h1 className="text-lg lg:text-2xl font-bold text-fg truncate">
                  {selectedAccountId
                    ? selectedAccount?.name || "Transactions"
                    : "All Transactions"}
                </h1>
                {selectedAccount && (
                  <button
                    type="button"
                    onClick={handleToggleFavorite}
                    disabled={favoriteUpdating}
                    aria-label={
                      selectedAccount.isFavorite
                        ? "Remove from favorites"
                        : "Add to favorites"
                    }
                    className="ml-1 lg:ml-2 inline-flex h-8 w-8 items-center justify-center rounded-md text-yellow-500 transition-colors hover:bg-yellow-50 disabled:cursor-not-allowed disabled:opacity-50 flex-shrink-0"
                  >
                    <svg
                      className="h-5 w-5"
                      viewBox="0 0 20 20"
                      fill={selectedAccount.isFavorite ? "currentColor" : "none"}
                      stroke="currentColor"
                      strokeWidth={1.75}
                      aria-hidden="true"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M10 1.75 12.47 6.76l5.53.81-4 3.9.94 5.51L10 14.38 5.06 16.98 6 11.47l-4-3.9 5.53-.81L10 1.75Z"
                      />
                    </svg>
                  </button>
                )}
              </div>
              <div className="hidden lg:flex items-center gap-4">
                <label className="flex items-center gap-1.5 text-xs text-fg-tertiary">
                  <input
                    type="checkbox"
                    checked={showUpcoming}
                    onChange={(e) => {
                      setShowUpcoming(e.target.checked);
                      try {
                        localStorage.setItem("showUpcoming", String(e.target.checked));
                      } catch {
                        // Ignore localStorage errors
                      }
                    }}
                    className="rounded text-purple-600 focus:ring-purple-500"
                  />
                  Recurring
                </label>
                <PayeeAutocomplete
                  payees={payees}
                  value={selectedPayeeId}
                  onChange={setSelectedPayeeId}
                  placeholder="Filter by payee..."
                  className="min-w-[9rem]"
                />
                <DateRangeFilter
                  startDate={startDate}
                  endDate={endDate}
                  onStartDateChange={setStartDate}
                  onEndDateChange={setEndDate}
                  onClear={clearDateFilter}
                />
              </div>
            </div>
            {/* Mobile-only active date-filter chip (the full filter control
                is desktop-only, so this is the only way to see/clear a date
                range applied via a link, e.g. from the income statement). */}
            {dateFilterLabel && (
              <div className="lg:hidden mt-2">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-tertiary px-2.5 py-1 text-xs text-fg-secondary">
                  <span className="tabular-nums">{dateFilterLabel}</span>
                  <button
                    type="button"
                    onClick={clearDateFilter}
                    aria-label="Clear date filter"
                    className="text-fg-tertiary hover:text-fg transition-colors"
                  >
                    <svg
                      className="w-3.5 h-3.5"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M6 18L18 6M6 6l12 12"
                      />
                    </svg>
                  </button>
                </span>
              </div>
            )}
          </div>
          <div className="hidden lg:block border-b border-border bg-surface px-4 py-3">
            <TransactionForm
              ref={transactionFormRef}
              accounts={accounts}
              selectedAccountId={selectedAccountId}
              isInvestmentAccountSelected={isInvestmentAccount}
              onSubmit={handleCreateTransaction}
              onAccountsUpdate={() => refreshData(false)}
            />
          </div>
          <StaleSyncBanner
            bookId={bookId}
            // positionsVersion bumps on every refreshData (create/update/
            // delete), reconcileVersion on reconcile toggles — both can
            // change which transactions the banner should flag
            refreshKey={`${selectedAccountId}:${positionsVersion}:${reconcileVersion}`}
            className="mx-4 mt-3"
          />
          <InvestmentPositionsSection
            isVisible={isInvestmentAccount}
            isLoading={positionsLoading}
            positions={positions}
            cashBalanceCents={investmentCashBalance}
            bookId={bookId}
          />
          <TransactionList
            isLoading={transactionsLoading}
            transactions={mergeTransactionsForDisplay(
              projectedTransactions,
              [...visiblePlaidPending, ...transactions]
            )}
            accounts={accounts}
            selectedAccountId={selectedAccountId}
            balanceAccountId={investmentCashAccount?.id ?? null}
            startingBalance={startingBalance}
            onEdit={setEditingTransaction}
            onProjectedClick={(ruleId) =>
              router.push(`/b/${bookId}/recurring?highlightRule=${ruleId}`)
            }
            onPlaidPendingClick={() => router.push(`/b/${bookId}/sync`)}
            onToggleReconciled={handleToggleReconciled}
            onMoveToNextBusinessDay={handleMoveToNextBusinessDay}
            newTransactionId={newTransactionId}
            onNewTransactionAnimated={() => setNewTransactionId(null)}
            highlightTransactionId={highlightTransactionId}
            onNavigateToAccount={handleNavigateToAccount}
            onHighlightAnimated={() => {
              setHighlightTransactionId(null);
              // Clean up URL param
              const params = new URLSearchParams(searchParams.toString());
              params.delete("highlight");
              const qs = params.toString();
              router.replace(`/b/${bookId}/transactions${qs ? `?${qs}` : ""}`, { scroll: false });
            }}
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

      </div>

      {/* Mobile FAB for new transaction */}
      <button
        type="button"
        onClick={() => setMobileCreateOpen(true)}
        className="lg:hidden fixed bottom-6 right-4 z-30 w-14 h-14 bg-accent hover:bg-accent-hover text-fg-on-accent rounded-full shadow-lg flex items-center justify-center transition-colors active:scale-95"
        style={{ bottom: "calc(1.5rem + env(safe-area-inset-bottom, 0px))" }}
        aria-label="New transaction"
      >
        <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
        </svg>
      </button>

      {/* Mobile create transaction modal */}
      <Modal
        isOpen={mobileCreateOpen}
        onClose={() => setMobileCreateOpen(false)}
        title="New Transaction"
        size="lg"
      >
        <TransactionForm
          accounts={accounts}
          selectedAccountId={selectedAccountId}
          isInvestmentAccountSelected={isInvestmentAccount}
          fullLayout
          onSubmit={async (data) => {
            await handleCreateTransaction(data);
            setMobileCreateOpen(false);
          }}
          onCancel={() => setMobileCreateOpen(false)}
          onAccountsUpdate={() => refreshData(false)}
        />
      </Modal>

      <Modal
        isOpen={!!editingTransaction}
        onClose={() => setEditingTransaction(null)}
        title="Edit Transaction"
        size="lg"
      >
        {editingTransaction && (
          <TransactionForm
            accounts={accounts}
            selectedAccountId={selectedAccountId}
            isInvestmentAccountSelected={isInvestmentAccount}
            editingTransaction={editingTransaction}
            plaidData={editingPlaidData}
            onPlaidUnlinked={() => {
              setEditingPlaidData(null);
              toast.success("Transaction unlinked from Plaid");
            }}
            onSubmit={handleUpdateTransaction}
            onCancel={() => setEditingTransaction(null)}
            onDelete={handleDeleteTransaction}
            onMakeRecurring={handleMakeRecurring}
            onAccountsUpdate={() => refreshData(false)}
          />
        )}
      </Modal>
    </div>
  );
}

export default function TransactionsPage() {
  return (
    <Suspense fallback={<TransactionsPageSkeleton />}>
      <TransactionsPageInner />
    </Suspense>
  );
}
