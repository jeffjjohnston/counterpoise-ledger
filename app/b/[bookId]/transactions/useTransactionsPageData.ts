"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/ui/ToastProvider";
import { flattenAccounts } from "@/lib/accounting";
import { toDateString } from "@/lib/formatters";
import { apiGet } from "@/lib/api-client";
import type { AccountMarketValue } from "@/lib/investments";
import type {
  AccountWithBalance,
  DisplayTransaction,
  TransactionWithSplits,
} from "@/types";

const PAGE_SIZE = 50;

export interface UseTransactionsPageDataArgs {
  bookId: string;
  accountId: number | null;
  startDate: string;
  endDate: string;
  selectedPayeeId: number | null;
  showUpcoming: boolean;
  scrollTransactionsToTop: () => void;
  ensureIdRef: RefObject<number | null>;
}

export interface UseTransactionsPageDataResult {
  accounts: AccountWithBalance[];
  payees: Array<{ id: number; name: string }>;
  transactions: TransactionWithSplits[];
  projectedTransactions: DisplayTransaction[];
  plaidPendingTransactions: DisplayTransaction[];
  marketValues: AccountMarketValue[];
  startingBalance: number;
  totalCount: number;
  positionsVersion: number;
  loading: boolean;
  error: string | null;
  transactionsLoading: boolean;
  loadMoreFailed: boolean;

  fetchAccounts: () => Promise<AccountWithBalance[]>;
  fetchPayees: () => Promise<void>;
  fetchMarketValues: () => Promise<void>;
  fetchProjectedTransactions: () => Promise<void>;
  fetchPlaidPendingTransactions: () => Promise<void>;
  fetchTransactionsPage: (
    pageOffset: number,
    append: boolean,
    context: {
      selectedAccountId: number | null;
      isInvestmentAccount: boolean;
      investmentCashAccountId: number | null;
      startDate: string;
      endDate: string;
      selectedPayeeId: number | null;
      ensureId?: number | null;
    }
  ) => Promise<void>;
  refreshData: (showLoading: boolean, ensureId?: number | null) => Promise<void>;

  setTransactions: Dispatch<SetStateAction<TransactionWithSplits[]>>;
  setAccounts: Dispatch<SetStateAction<AccountWithBalance[]>>;
  setLoadMoreFailed: Dispatch<SetStateAction<boolean>>;
}

export function useTransactionsPageData(
  args: UseTransactionsPageDataArgs
): UseTransactionsPageDataResult {
  const {
    bookId,
    accountId: selectedAccountId,
    startDate,
    endDate,
    selectedPayeeId,
    showUpcoming,
    scrollTransactionsToTop,
    ensureIdRef,
  } = args;

  const toast = useToast();
  const router = useRouter();
  const routerRef = useRef(router);
  routerRef.current = router;

  const [accounts, setAccounts] = useState<AccountWithBalance[]>([]);
  const [transactions, setTransactions] = useState<TransactionWithSplits[]>([]);
  const [startingBalance, setStartingBalance] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [marketValues, setMarketValues] = useState<AccountMarketValue[]>([]);
  const [projectedTransactions, setProjectedTransactions] = useState<
    DisplayTransaction[]
  >([]);
  const [plaidPendingTransactions, setPlaidPendingTransactions] = useState<
    DisplayTransaction[]
  >([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [transactionsLoading, setTransactionsLoading] = useState(false);
  // Set when a "load more" fetch fails; stops the IntersectionObserver
  // effect from immediately re-triggering (see handleLoadMore) so a failure
  // doesn't become an unbounded retry loop. Cleared on the next successful
  // page-0 refresh (refreshData) and at the start of the next attempt.
  const [loadMoreFailed, setLoadMoreFailed] = useState(false);
  const [payees, setPayees] = useState<Array<{ id: number; name: string }>>([]);
  const [positionsVersion, setPositionsVersion] = useState(0);

  const autoSelectDoneRef = useRef(false);
  const initialLoadRef = useRef(true);

  // Track previous account ID to detect changes and clear stale data
  const prevAccountIdRef = useRef<number | null | undefined>(undefined);
  useEffect(() => {
    if (prevAccountIdRef.current === undefined) {
      // Initial render — just record it
      prevAccountIdRef.current = selectedAccountId;
      return;
    }
    if (prevAccountIdRef.current !== selectedAccountId) {
      prevAccountIdRef.current = selectedAccountId;
      // Immediately clear stale transactions and show loading
      setTransactions([]);
      setProjectedTransactions([]);
      setStartingBalance(0);
      setTotalCount(0);
      setTransactionsLoading(true);
    }
  }, [selectedAccountId]);

  const fetchAccounts = useCallback(async () => {
    const today = toDateString(new Date());
    // apiGet throws on a non-ok response, so refreshData's catch runs
    // instead of writing a parsed error body into state — see the comment
    // above fetchTransactionsPage's matching call below.
    const accountsData = await apiGet<AccountWithBalance[]>(
      `/api/b/${bookId}/accounts?includeInactive=true&asOfDate=${today}`
    );

    // Flatten nested accounts
    const flatAccounts = flattenAccounts(accountsData);

    setAccounts(flatAccounts);
    return flatAccounts;
  }, [bookId]);

  const fetchPayees = useCallback(async () => {
    try {
      const data = await apiGet<Array<{ id: number; name: string }>>(
        `/api/b/${bookId}/payees`
      );
      setPayees(Array.isArray(data) ? data : []);
    } catch (error) {
      console.error("Error fetching payees:", error);
      setPayees([]);
    }
  }, [bookId]);

  const fetchMarketValues = useCallback(async () => {
    try {
      const today = toDateString(new Date());
      const data = await apiGet<AccountMarketValue[]>(
        `/api/b/${bookId}/investments/account-values?asOfDate=${today}`
      );
      setMarketValues(Array.isArray(data) ? data : []);
    } catch (error) {
      console.error("Error fetching market values:", error);
      setMarketValues([]);
    }
  }, [bookId]);

  const fetchProjectedTransactions = useCallback(async () => {
    if (!showUpcoming) {
      setProjectedTransactions([]);
      return;
    }
    try {
      const params = new URLSearchParams();
      if (selectedAccountId) {
        params.set("accountId", selectedAccountId.toString());
      }
      const data = await apiGet<DisplayTransaction[]>(
        `/api/b/${bookId}/recurring/projected?${params.toString()}`
      );
      setProjectedTransactions(Array.isArray(data) ? data : []);
    } catch (error) {
      console.error("Error fetching projected transactions:", error);
      setProjectedTransactions([]);
    }
  }, [bookId, showUpcoming, selectedAccountId]);

  const fetchPlaidPendingTransactions = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (selectedAccountId) {
        params.set("accountId", selectedAccountId.toString());
      }
      const data = await apiGet<DisplayTransaction[]>(
        `/api/b/${bookId}/sync/pending-transactions?${params.toString()}`
      );
      setPlaidPendingTransactions(Array.isArray(data) ? data : []);
    } catch (error) {
      console.error("Error fetching pending Plaid transactions:", error);
      setPlaidPendingTransactions([]);
    }
  }, [bookId, selectedAccountId]);

  const fetchTransactionsPage = useCallback(
    async (
      pageOffset: number,
      append: boolean,
      context: {
        selectedAccountId: number | null;
        isInvestmentAccount: boolean;
        investmentCashAccountId: number | null;
        startDate: string;
        endDate: string;
        selectedPayeeId: number | null;
        ensureId?: number | null;
      }
    ) => {
      const {
        selectedAccountId: contextAccountId,
        isInvestmentAccount: contextIsInvestment,
        investmentCashAccountId: contextCashAccountId,
        startDate: contextStartDate,
        endDate: contextEndDate,
        selectedPayeeId: contextPayeeId,
        ensureId: contextEnsureId,
      } = context;
      const params = new URLSearchParams({
        limit: PAGE_SIZE.toString(),
        offset: pageOffset.toString(),
        includeMeta: "true",
      });

      if (contextEnsureId) {
        params.set("ensureId", contextEnsureId.toString());
      }

      if (contextAccountId) {
        if (contextIsInvestment && contextCashAccountId) {
          params.set(
            "accountIds",
            `${contextAccountId},${contextCashAccountId}`
          );
          params.set("balanceAccountId", contextCashAccountId.toString());
        } else {
          params.set("accountId", contextAccountId.toString());
        }
      }

      if (contextStartDate) {
        params.set("startDate", contextStartDate);
      }

      if (contextEndDate) {
        params.set("endDate", contextEndDate);
      }

      if (contextPayeeId !== null) {
        params.set("payeeId", contextPayeeId.toString());
      }

      // apiGet throws (rather than parsing the error body as a page) so both
      // callers' catch blocks actually run: refreshData's
      // full-page/background-refresh handling and handleLoadMore's
      // loadMoreFailed guard both depend on this rejecting — otherwise a
      // non-2xx response parses as an empty page, totalCount drops to 0,
      // the load-more sentinel disappears, and the user has no retry.
      const transactionsData = await apiGet<{
        transactions?: TransactionWithSplits[];
        startingBalance?: number;
        totalCount?: number;
      }>(`/api/b/${bookId}/transactions?${params.toString()}`);

      const pageTransactions: TransactionWithSplits[] =
        transactionsData.transactions || [];

      setTransactions((prev) =>
        append ? [...prev, ...pageTransactions] : pageTransactions
      );
      if (!append) {
        requestAnimationFrame(() => {
          scrollTransactionsToTop();
        });
      }
      setStartingBalance(transactionsData.startingBalance || 0);
      setTotalCount(transactionsData.totalCount || pageTransactions.length);
    },
    [bookId, scrollTransactionsToTop]
  );

  const refreshData = useCallback(async (showLoading: boolean, ensureId?: number | null) => {
    if (showLoading) {
      setLoading(true);
    }
    try {
      const [flatAccounts] = await Promise.all([
        fetchAccounts(),
        fetchMarketValues(),
        fetchPayees(),
      ]);
      const selected = selectedAccountId
        ? flatAccounts.find((account) => account.id === selectedAccountId)
        : null;
      const isSelectedInvestment =
        selected?.type === "asset" && selected?.subtype === "investment";
      const cashAccountId = isSelectedInvestment
        ? flatAccounts.find(
            (account) =>
              account.parentId === selectedAccountId && account.isInvestmentCash
          )?.id ?? null
        : null;
      await fetchTransactionsPage(0, false, {
        selectedAccountId,
        isInvestmentAccount: isSelectedInvestment,
        investmentCashAccountId: cashAccountId,
        startDate,
        endDate,
        selectedPayeeId,
        ensureId,
      });
      setPositionsVersion((v) => v + 1);
      setLoadMoreFailed(false);
      setError(null);

      // Auto-select account on initial page load (no accountId in URL)
      if (!autoSelectDoneRef.current && !selectedAccountId) {
        autoSelectDoneRef.current = true;

        // 1. Try localStorage for last selected account
        let targetAccountId: number | null = null;
        try {
          const stored = localStorage.getItem(`lastSelectedAccountId:${bookId}`);
          if (stored) {
            const storedId = Number(stored);
            if (Number.isFinite(storedId) && flatAccounts.some((a) => a.id === storedId && a.isActive)) {
              targetAccountId = storedId;
            }
          }
        } catch {
          // Ignore localStorage errors
        }

        // 2. Fall back to first favorite account
        if (targetAccountId === null) {
          const firstFavorite = flatAccounts
            .filter((a) => a.isFavorite && a.isActive && !a.isInvestmentCash)
            .sort((a, b) => a.name.localeCompare(b.name))[0];
          if (firstFavorite) {
            targetAccountId = firstFavorite.id;
          }
        }

        // 3. Redirect (replace, not push, to avoid back-button issues)
        if (targetAccountId !== null) {
          routerRef.current.replace(`/b/${bookId}/transactions?accountId=${targetAccountId}`, { scroll: false });
          return; // refreshData will re-run with the new accountId
        }
      }

      // Mark auto-select as done even if we had a selectedAccountId
      if (!autoSelectDoneRef.current) {
        autoSelectDoneRef.current = true;
      }
    } catch {
      if (showLoading) {
        // Nothing has rendered yet — the full-page error state is correct.
        setError("Could not load transactions.");
      } else {
        // A background refresh (after a write, a filter change, etc.)
        // failed. The already-rendered accounts/transactions are still
        // correct, so keep them on screen and surface the failure via the
        // existing toast instead of blanking the page — same reasoning as
        // a failed "load more" below.
        toast.error("Could not refresh transactions.");
      }
    } finally {
      setTransactionsLoading(false);
      if (showLoading) {
        setLoading(false);
      }
    }
  }, [fetchAccounts, fetchMarketValues, fetchPayees, fetchTransactionsPage, selectedAccountId, startDate, endDate, selectedPayeeId, bookId, toast]);

  useEffect(() => {
    const showLoading = initialLoadRef.current;
    const ensureId = ensureIdRef.current;
    ensureIdRef.current = null;
    const run = async () => {
      await refreshData(showLoading, ensureId);
      initialLoadRef.current = false;
    };
    // refreshData handles its own errors internally, so run() cannot reject.
    void run();
  }, [refreshData, ensureIdRef]);

  useEffect(() => {
    // fetchProjectedTransactions catches its own errors and degrades to [].
    void fetchProjectedTransactions();
  }, [fetchProjectedTransactions]);

  useEffect(() => {
    // fetchPlaidPendingTransactions catches its own errors and degrades to [].
    void fetchPlaidPendingTransactions();
  }, [fetchPlaidPendingTransactions]);

  return {
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

    fetchAccounts,
    fetchPayees,
    fetchMarketValues,
    fetchProjectedTransactions,
    fetchPlaidPendingTransactions,
    fetchTransactionsPage,
    refreshData,

    setTransactions,
    setAccounts,
    setLoadMoreFailed,
  };
}
