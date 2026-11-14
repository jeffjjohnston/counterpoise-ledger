"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useBookId } from "@/hooks/useBookId";
import { useLatestRequest } from "@/hooks/useLatestRequest";
import { useLiveReload } from "@/components/BookChangesProvider";
import { ReportConfigPanel, type ReportConfig } from "@/components/reports/ReportConfigPanel";
import { ReportChart } from "@/components/reports/ReportChart";
import { ReportTable } from "@/components/reports/ReportTable";
import {
  groupSplits,
  computeGrandTotal,
  isMixedReport,
  type ReportSplit,
  type ReportAccount,
} from "@/lib/reports";
import { apiGet } from "@/lib/api-client";
import type { AccountWithBalance } from "@/types";

// The tables that the report data reads: the splits, their transactions (date
// and description), the accounts and the payees.
const REPORT_TABLES = new Set(["transaction_splits", "transactions", "accounts", "payees"]);
// The account list of the autocomplete.
const ACCOUNT_TABLES = new Set(["accounts"]);

function getDefaultConfig(): ReportConfig {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return {
    startDate: `${year}-01-01`,
    endDate: `${year}-${month}-${day}`,
    accountTypes: ["income", "expense"],
    accountIds: [],
    groupings: ["month"],
    collapseToParent: false,
  };
}

export default function ReportsPage() {
  const bookId = useBookId();
  const [config, setConfig] = useState<ReportConfig>(getDefaultConfig);
  const [rawSplits, setRawSplits] = useState<ReportSplit[]>([]);
  const [reportAccounts, setReportAccounts] = useState<ReportAccount[]>([]);
  const [allAccounts, setAllAccounts] = useState<AccountWithBalance[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasRun, setHasRun] = useState(false);

  // A live update can start a request while another is in flight. Only the
  // latest request of each kind may publish its answer.
  const startAccountsRequest = useLatestRequest();
  const startReportRequest = useLatestRequest();
  // The query of the last report that the user asked for. A live reload runs
  // this query again, not the config that the user edits and did not apply.
  const reportQuery = useRef<string | null>(null);

  // Fetch accounts for autocomplete. A non-2xx JSON error body (e.g.
  // {error: "..."}) would otherwise parse without throwing and land in
  // state as a non-array — ReportConfigPanel/AccountAutocomplete call
  // .find/.filter on `accounts` unconditionally on every render, so that
  // would throw at render time instead of degrading quietly.
  const fetchAccounts = useCallback(() => {
    const isLatest = startAccountsRequest();
    apiGet<AccountWithBalance[]>(`/api/b/${bookId}/accounts`)
      .then((data) => { if (isLatest()) setAllAccounts(Array.isArray(data) ? data : []); })
      // The list starts empty. A failed reload keeps the list that is on the
      // screen, so the chosen accounts keep their names.
      .catch(() => {});
  }, [bookId, startAccountsRequest]);

  useEffect(() => {
    fetchAccounts();
  }, [fetchAccounts]);

  // Gets the report for `query`. A background request (a live reload) does
  // not show the loading state, so the report stays on the screen and the
  // scroll position does not change. If it fails, the old report stays.
  const loadReport = useCallback(async (query: string, background: boolean) => {
    const isLatest = startReportRequest();
    if (!background) setLoading(true);
    try {
      const data = await apiGet<{ splits: ReportSplit[]; accounts: ReportAccount[] }>(
        `/api/b/${bookId}/reports/data?${query}`
      );
      if (!isLatest()) return;
      setRawSplits(data.splits);
      setReportAccounts(data.accounts);
      setHasRun(true);
      setLoading(false);
    } catch (err) {
      if (!isLatest()) return;
      console.error("Failed to fetch report data:", err);
      setLoading(false);
    }
  }, [bookId, startReportRequest]);

  const fetchReport = useCallback(async () => {
    const params = new URLSearchParams();
    if (config.startDate) params.set("startDate", config.startDate);
    if (config.endDate) params.set("endDate", config.endDate);
    if (config.accountIds.length > 0) {
      params.set("accountIds", config.accountIds.join(","));
    }
    if (config.accountTypes.length > 0) {
      params.set("accountTypes", config.accountTypes.join(","));
    }
    reportQuery.current = params.toString();
    await loadReport(reportQuery.current, false);
  }, [loadReport, config.startDate, config.endDate, config.accountIds, config.accountTypes]);

  // Another client (an MCP tool, another tab, a scheduled job) changed the
  // book. The reload keeps the config and the report on the screen.
  useLiveReload(REPORT_TABLES, () => {
    if (reportQuery.current !== null) void loadReport(reportQuery.current, true);
  });
  useLiveReload(ACCOUNT_TABLES, fetchAccounts);

  // Auto-run on mount
  useEffect(() => {
    // fetchReport already catches its own errors (logged to console) in a
    // try/catch; it cannot reject.
    void fetchReport();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const accountMap = useMemo(() => {
    const map = new Map<number, ReportAccount>();
    for (const a of reportAccounts) {
      map.set(a.id, a);
    }
    return map;
  }, [reportAccounts]);

  const grouped = useMemo(() => {
    if (rawSplits.length === 0 || config.groupings.length === 0) return [];
    return groupSplits(rawSplits, config.groupings, accountMap, config.collapseToParent);
  }, [rawSplits, config.groupings, accountMap, config.collapseToParent]);

  const grandTotal = useMemo(() => computeGrandTotal(rawSplits), [rawSplits]);
  const mixed = useMemo(() => isMixedReport(rawSplits), [rawSplits]);

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      <h1 className="text-2xl font-bold text-fg">Reports</h1>

      <ReportConfigPanel
        config={config}
        onChange={setConfig}
        onGenerate={fetchReport}
        accounts={allAccounts}
        loading={loading}
      />

      {hasRun && !loading && (
        <>
          <ReportChart groups={grouped} dimensions={config.groupings} />
          <ReportTable
            groups={grouped}
            grandTotal={grandTotal}
            mixed={mixed}
            dimensions={config.groupings}
          />
        </>
      )}
    </div>
  );
}
