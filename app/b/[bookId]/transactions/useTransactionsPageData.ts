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
import { useBookChanges } from "@/components/BookChangesProvider";
import { useRouter } from "@/lib/navigation";
import { useToast } from "@/components/ui/ToastProvider";
import { flattenAccounts } from "@/lib/wasm-client";
import { toDateString } from "@/lib/wasm-client";
import { apiGet } from "@/lib/api-client";
import type { AccountMarketValue } from "@/lib/investments";
import type {
  AccountWithBalance,
  DisplayTransaction,
  TransactionWithSplits,
} from "@/types";

const PAGE_SIZE = 50;
// Covers the usual 250 ms server + 100 ms browser notification windows.
const REFRESH_COALESCE_MS = 400;

export interface UseTransactionsPageDataArgs {
  bookId: string;
  accountId: number | null;
  startDate: string;
  endDate: string;
  selectedPayeeId: number | null;
  showUpcoming: boolean;
  scrollTransactionsToTop: () => void;
  ensureIdRef: RefObject<number | null>;
  deferBackgroundRefresh?: boolean;
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

type PageContext = Parameters<UseTransactionsPageDataResult["fetchTransactionsPage"]>[2];
type PageResponse = { transactions?: TransactionWithSplits[]; startingBalance?: number; totalCount?: number };
type RefreshRequest = { showLoading: boolean; ensureId?: number | null; background: boolean; immediate?: boolean };
type RefreshContext = Pick<UseTransactionsPageDataArgs,
  "bookId" | "accountId" | "startDate" | "endDate" | "selectedPayeeId" | "showUpcoming">;
type RefreshScope = {
  key: string; active: boolean; paused: boolean; running: boolean; loadingPage: boolean;
  loadedCount: number; pending: RefreshRequest | null; controller: AbortController;
  promise: Promise<void>; frame?: number;
  wait?: { timer: ReturnType<typeof setTimeout>; resume: () => void };
};

function pageParams(offset: number, limit: number, context: PageContext) {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset), includeMeta: "true" });
  if (context.ensureId) params.set("ensureId", String(context.ensureId));
  if (context.selectedAccountId) {
    if (context.isInvestmentAccount && context.investmentCashAccountId) {
      params.set("accountIds", `${context.selectedAccountId},${context.investmentCashAccountId}`);
      params.set("balanceAccountId", String(context.investmentCashAccountId));
    } else params.set("accountId", String(context.selectedAccountId));
  }
  if (context.startDate) params.set("startDate", context.startDate);
  if (context.endDate) params.set("endDate", context.endDate);
  if (context.selectedPayeeId !== null) params.set("payeeId", String(context.selectedPayeeId));
  return params;
}

// Fetch a whole register snapshot before publishing any of it. Optional panels
// may fail independently; accounts and the transaction page remain required.
async function fetchRefreshSnapshot(context: RefreshContext, request: RefreshRequest, loadedCount: number, signal: AbortSignal) {
  const { bookId, accountId, startDate, endDate, selectedPayeeId, showUpcoming } = context;
  const today = toDateString(new Date());
  const prefix = `/api/b/${bookId}`;
  const init = { signal };
  const accountQuery = accountId ? `?accountId=${accountId}` : "";
  const [accountRows, values, payeeRows, projected, pending] = await Promise.all([
    apiGet<AccountWithBalance[]>(`${prefix}/accounts?includeInactive=true&asOfDate=${today}`, init),
    apiGet<AccountMarketValue[]>(`${prefix}/investments/account-values?asOfDate=${today}`, init).catch(() => []),
    apiGet<Array<{ id: number; name: string }>>(`${prefix}/payees`, init).catch(() => []),
    showUpcoming ? apiGet<DisplayTransaction[]>(`${prefix}/recurring/projected${accountQuery}`, init).catch(() => []) : Promise.resolve([]),
    apiGet<DisplayTransaction[]>(`${prefix}/sync/pending-transactions${accountQuery}`, init).catch(() => []),
  ]);
  const accounts = flattenAccounts(accountRows);
  const selected = accounts.find((a) => a.id === accountId);
  const investment = selected?.type === "asset" && selected.subtype === "investment";
  const cashId = investment ? accounts.find((a) => a.parentId === accountId && a.isInvestmentCash)?.id ?? null : null;
  const params = pageParams(0, request.background ? Math.max(PAGE_SIZE, loadedCount) : PAGE_SIZE, {
    selectedAccountId: accountId, isInvestmentAccount: investment,
    investmentCashAccountId: cashId, startDate, endDate, selectedPayeeId, ensureId: request.ensureId,
  });
  const page = await apiGet<PageResponse>(`${prefix}/transactions?${params}`, init);
  const transactions = page.transactions ?? [];
  return {
    accounts, transactions,
    marketValues: Array.isArray(values) ? values : [],
    payees: Array.isArray(payeeRows) ? payeeRows : [],
    projectedTransactions: Array.isArray(projected) ? projected : [],
    plaidPendingTransactions: Array.isArray(pending) ? pending : [],
    startingBalance: page.startingBalance ?? 0,
    totalCount: page.totalCount ?? transactions.length,
  };
}

function preferredAccountId(accounts: AccountWithBalance[], bookId: string): number | null {
  try {
    const stored = Number(localStorage.getItem(`lastSelectedAccountId:${bookId}`));
    if (accounts.some((a) => a.id === stored && a.isActive)) return stored;
  } catch { /* Storage may be unavailable. */ }
  return accounts.filter((a) => a.isFavorite && a.isActive && !a.isInvestmentCash)
    .sort((a, b) => a.name.localeCompare(b.name))[0]?.id ?? null;
}

export function useTransactionsPageData(args: UseTransactionsPageDataArgs): UseTransactionsPageDataResult {
  const { bookId, accountId, startDate, endDate, selectedPayeeId, showUpcoming,
    scrollTransactionsToTop, ensureIdRef, deferBackgroundRefresh = false } = args;
  const toast = useToast();
  const router = useRouter();
  // Refs hold the callbacks, because a caller can pass a new identity on each
  // render. If drain depended on them, each new identity would start a new
  // scope, and the new scope's fetch would render again, without end.
  const routerRef = useRef(router);
  const toastRef = useRef(toast);
  const scrollRef = useRef(scrollTransactionsToTop);
  useEffect(() => {
    routerRef.current = router;
    toastRef.current = toast;
    scrollRef.current = scrollTransactionsToTop;
  }, [router, toast, scrollTransactionsToTop]);
  const [accounts, setAccounts] = useState<AccountWithBalance[]>([]);
  const [payees, setPayees] = useState<Array<{ id: number; name: string }>>([]);
  const [transactions, setTransactions] = useState<TransactionWithSplits[]>([]);
  const [projectedTransactions, setProjectedTransactions] = useState<DisplayTransaction[]>([]);
  const [plaidPendingTransactions, setPlaidPendingTransactions] = useState<DisplayTransaction[]>([]);
  const [marketValues, setMarketValues] = useState<AccountMarketValue[]>([]);
  const [startingBalance, setStartingBalance] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [positionsVersion, setPositionsVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [transactionsLoading, setTransactionsLoading] = useState(false);
  const [loadMoreFailed, setLoadMoreFailed] = useState(false);
  const initialLoad = useRef(true);
  const autoSelectDone = useRef(false);

  // A fresh scope fences every response to the book/filter that requested it.
  // No old response can publish after cleanup, even if fetch ignores abort.
  const contextKey = JSON.stringify([bookId, accountId, startDate, endDate, selectedPayeeId, showUpcoming]);
  const scopeRef = useRef<RefreshScope | null>(null);

  const applySnapshot = useCallback((snapshot: Awaited<ReturnType<typeof fetchRefreshSnapshot>>) => {
    setAccounts(snapshot.accounts); setMarketValues(snapshot.marketValues);
    setPayees(snapshot.payees); setProjectedTransactions(snapshot.projectedTransactions);
    setPlaidPendingTransactions(snapshot.plaidPendingTransactions);
    setTransactions(snapshot.transactions);
    setStartingBalance(snapshot.startingBalance); setTotalCount(snapshot.totalCount);
    setPositionsVersion((v) => v + 1);
    setLoadMoreFailed(false); setError(null);
  }, []);

  const autoSelectAccount = useCallback((accounts: AccountWithBalance[]) => {
    if (autoSelectDone.current) return;
    autoSelectDone.current = true;
    if (accountId) return;
    const target = preferredAccountId(accounts, bookId);
    if (target !== null) routerRef.current.replace(`/b/${bookId}/transactions?accountId=${target}`, { scroll: false });
  }, [accountId, bookId]);

  const drain = useCallback((): Promise<void> => {
    const scope = scopeRef.current;
    if (!scope || scope.key !== contextKey) return Promise.resolve();
    if (!scope.active || scope.running || scope.loadingPage || !scope.pending ||
        (scope.paused && scope.pending.background)) return scope.promise;
    scope.running = true;
    scope.promise = (async () => {
      try {
        while (scope.active && scope.pending && !(scope.paused && scope.pending.background)) {
          // Merge local refresh calls and notification echoes before taking a
          // snapshot. This is a fixed window, never a post-fetch suppression:
          // every hint received during a fetch still gets a trailing fetch.
          if (!scope.pending.immediate && !scope.pending.showLoading) {
            await new Promise<void>((resume) => {
              scope.wait = { timer: setTimeout(resume, REFRESH_COALESCE_MS), resume };
            });
            scope.wait = undefined;
          }
          if (!scope.active || !scope.pending || (scope.paused && scope.pending.background)) break;
          const request = scope.pending;
          scope.pending = null;
          if (request.showLoading) setLoading(true);
          try {
            const snapshot = await fetchRefreshSnapshot({ bookId, accountId, startDate, endDate, selectedPayeeId, showUpcoming },
              request, scope.loadedCount, scope.controller.signal);
            if (!scope.active) return;
            // An editor opened while the requests were in flight. Discard the
            // snapshot and fetch again on close, retaining an explicit request.
            if (request.background && scope.paused) {
              scope.pending ??= request;
              continue;
            }
            applySnapshot(snapshot);
            scope.loadedCount = snapshot.transactions.length;
            if (!request.background) {
              scope.frame = requestAnimationFrame(() => { if (scope.active) scrollRef.current(); });
            }
            autoSelectAccount(snapshot.accounts);
          } catch {
            if (scope.active) {
              if (request.showLoading) setError("Could not load transactions.");
              else toastRef.current.error("Could not refresh transactions.");
            }
          } finally {
            if (scope.active) {
              initialLoad.current = false;
              setTransactionsLoading(false);
              setLoading(false);
            }
          }
        }
      } finally { scope.running = false; }
    })();
    return scope.promise;
  }, [contextKey, bookId, accountId, startDate, endDate, selectedPayeeId, showUpcoming, applySnapshot, autoSelectAccount]);

  const enqueue = useCallback((request: RefreshRequest) => {
    const scope = scopeRef.current;
    if (!scope || scope.key !== contextKey || !scope.active) return Promise.resolve();
    const previous = scope.pending;
    scope.pending = {
      showLoading: request.showLoading || (previous?.showLoading ?? false),
      ensureId: request.ensureId ?? previous?.ensureId,
      background: request.background && (previous?.background ?? true),
      immediate: request.immediate || previous?.immediate,
    };
    return drain();
  }, [contextKey, drain]);
  const refreshData = useCallback((showLoading: boolean, ensureId?: number | null) =>
    enqueue({ showLoading, ensureId, background: false }), [enqueue]);

  useEffect(() => {
    const scope: NonNullable<typeof scopeRef.current> = {
      key: contextKey, active: true, paused: false, running: false, loadingPage: false,
      loadedCount: PAGE_SIZE, pending: null as RefreshRequest | null,
      controller: new AbortController(), promise: Promise.resolve(), frame: undefined as number | undefined,
    };
    scopeRef.current = scope;
    const showLoading = initialLoad.current;
    const ensureId = ensureIdRef.current;
    ensureIdRef.current = null;
    setTransactionsLoading(true);
    setTransactions([]); setProjectedTransactions([]); setPlaidPendingTransactions([]);
    setStartingBalance(0); setTotalCount(0);
    void enqueue({ showLoading, ensureId, background: false, immediate: true });
    return () => {
      scope.active = false; scope.pending = null;
      scope.controller.abort();
      if (scope.wait) {
        clearTimeout(scope.wait.timer);
        scope.wait.resume();
      }
      if (scope.frame !== undefined) cancelAnimationFrame(scope.frame);
    };
  }, [contextKey, enqueue, ensureIdRef]);

  useEffect(() => {
    const scope = scopeRef.current;
    if (!scope) return;
    scope.paused = deferBackgroundRefresh;
    if (!scope.paused) void drain();
  }, [contextKey, deferBackgroundRefresh, drain]);
  useBookChanges(() => { void enqueue({ showLoading: false, background: true }); });

  const fetchTransactionsPage = useCallback(async (offset: number, append: boolean, context: PageContext) => {
    const scope = scopeRef.current;
    if (!scope || scope.key !== contextKey) return;
    // Let a refresh complete before appending a page to that snapshot.
    await scope.promise;
    if (!scope.active) return;
    // A reset may have changed pagination while the caller waited.
    if (append && offset !== scope.loadedCount) return;
    scope.loadingPage = true;
    try {
      const page = await apiGet<PageResponse>(`/api/b/${bookId}/transactions?${pageParams(offset, PAGE_SIZE, context)}`,
        { signal: scope.controller.signal });
      if (!scope.active) return;
      const rows = page.transactions ?? [];
      setTransactions((old) => append ? [...old, ...rows] : rows);
      scope.loadedCount = append ? scope.loadedCount + rows.length : rows.length;
      setStartingBalance(page.startingBalance ?? 0);
      setTotalCount(page.totalCount ?? rows.length);
      if (!append) scrollRef.current();
    } finally {
      scope.loadingPage = false;
      if (scope.active) void drain();
    }
  }, [contextKey, bookId, drain]);

  return { accounts, payees, transactions, projectedTransactions, plaidPendingTransactions,
    marketValues, startingBalance, totalCount, positionsVersion, loading, error, transactionsLoading,
    loadMoreFailed, fetchTransactionsPage, refreshData, setTransactions, setAccounts, setLoadMoreFailed };
}
