"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import { useBookId } from "@/hooks/useBookId";
import { ReportConfigPanel, type ReportConfig } from "@/components/reports/ReportConfigPanel";
import { ReportTable } from "@/components/reports/ReportTable";
import {
  groupSplits,
  computeGrandTotal,
  type ReportSplit,
  type ReportAccount,
} from "@/lib/reports";
import { apiGet } from "@/lib/api-client";
import type { AccountWithBalance } from "@/types";

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

  // Fetch accounts for autocomplete. A non-2xx JSON error body (e.g.
  // {error: "..."}) would otherwise parse without throwing and land in
  // state as a non-array — ReportConfigPanel/AccountAutocomplete call
  // .find/.filter on `accounts` unconditionally on every render, so that
  // would throw at render time instead of degrading quietly.
  useEffect(() => {
    apiGet<AccountWithBalance[]>(`/api/b/${bookId}/accounts`)
      .then((data) => setAllAccounts(Array.isArray(data) ? data : []))
      .catch(() => setAllAccounts([]));
  }, [bookId]);

  const fetchReport = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (config.startDate) params.set("startDate", config.startDate);
      if (config.endDate) params.set("endDate", config.endDate);
      if (config.accountIds.length > 0) {
        params.set("accountIds", config.accountIds.join(","));
      }
      if (config.accountTypes.length > 0) {
        params.set("accountTypes", config.accountTypes.join(","));
      }

      const data = await apiGet<{ splits: ReportSplit[]; accounts: ReportAccount[] }>(
        `/api/b/${bookId}/reports/data?${params}`
      );
      setRawSplits(data.splits);
      setReportAccounts(data.accounts);
      setHasRun(true);
    } catch (err) {
      console.error("Failed to fetch report data:", err);
    } finally {
      setLoading(false);
    }
  }, [bookId, config.startDate, config.endDate, config.accountIds, config.accountTypes]);

  // Auto-run on mount
  useEffect(() => {
    // fetchReport already catches its own errors (logged to console) in a
    // try/finally; it cannot reject.
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

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-fg">Reports</h1>

      <ReportConfigPanel
        config={config}
        onChange={setConfig}
        onGenerate={fetchReport}
        accounts={allAccounts}
        loading={loading}
      />

      {hasRun && !loading && (
        <ReportTable
          groups={grouped}
          grandTotal={grandTotal}
          dimensions={config.groupings}
        />
      )}
    </div>
  );
}
