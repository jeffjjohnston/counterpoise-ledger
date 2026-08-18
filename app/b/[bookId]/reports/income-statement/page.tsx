"use client";

import { useEffect, useMemo, useState } from "react";
import { useBookId } from "@/hooks/useBookId";
import { AccountCard } from "@/components/accounts/AccountCard";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { formatCurrency } from "@/lib/formatters";
import { getDisplayBalance, flattenAccounts } from "@/lib/accounting";
import { csvEscape, datedCsvFilename, triggerDownload } from "@/lib/csv";
import { apiGet } from "@/lib/api-client";
import type { AccountWithBalance } from "@/types";

interface AccountSummary {
  type: string;
  accounts: AccountWithBalance[];
  total: number;
}

type IncomePeriod =
  | "all"
  | "current_month"
  | "last_month"
  | "current_year"
  | "last_year"
  | "custom";

type IncomeStatementAccountSummary = {
  accountId: number;
  name: string;
  type: "income" | "expense";
  balance: number;
};

const INCOME_PERIOD_OPTIONS = [
  { value: "all", label: "All time" },
  { value: "current_month", label: "Current month" },
  { value: "last_month", label: "Last month" },
  { value: "current_year", label: "Current year" },
  { value: "last_year", label: "Last year" },
  { value: "custom", label: "Custom" },
];

const formatDateInput = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const getIncomePeriodRange = (
  period: IncomePeriod,
  customStartDate: string,
  customEndDate: string
) => {
  const now = new Date();

  switch (period) {
    case "current_month": {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      return {
        startDate: formatDateInput(start),
        endDate: formatDateInput(now),
      };
    }
    case "last_month": {
      const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const end = new Date(now.getFullYear(), now.getMonth(), 0);
      return {
        startDate: formatDateInput(start),
        endDate: formatDateInput(end),
      };
    }
    case "current_year": {
      const start = new Date(now.getFullYear(), 0, 1);
      return {
        startDate: formatDateInput(start),
        endDate: formatDateInput(now),
      };
    }
    case "last_year": {
      const start = new Date(now.getFullYear() - 1, 0, 1);
      const end = new Date(now.getFullYear() - 1, 11, 31);
      return {
        startDate: formatDateInput(start),
        endDate: formatDateInput(end),
      };
    }
    case "custom": {
      if (!customStartDate || !customEndDate) {
        return { startDate: null, endDate: null };
      }
      return { startDate: customStartDate, endDate: customEndDate };
    }
    default:
      return { startDate: null, endDate: null };
  }
};

export default function IncomeStatementPage() {
  const bookId = useBookId();
  const [accounts, setAccounts] = useState<AccountWithBalance[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [incomePeriod, setIncomePeriod] = useState<IncomePeriod>("current_year");
  const [customStartDate, setCustomStartDate] = useState("");
  const [customEndDate, setCustomEndDate] = useState("");
  const [incomeStatementAccounts, setIncomeStatementAccounts] = useState<
    IncomeStatementAccountSummary[]
  >([]);
  const [incomeStatementLoading, setIncomeStatementLoading] = useState(false);

  useEffect(() => {
    const fetchAccounts = async () => {
      try {
        const data = await apiGet<AccountWithBalance[]>(
          `/api/b/${bookId}/accounts?includeInactive=true`
        );
        const flatAccounts = flattenAccounts(data);
        setAccounts(flatAccounts);
        setError(null);
      } catch {
        setError("Could not load accounts.");
      } finally {
        setLoading(false);
      }
    };

    void fetchAccounts();
  }, [bookId]);

  useEffect(() => {
    if (incomePeriod !== "custom") return;

    const now = new Date();
    if (!customStartDate) {
      setCustomStartDate(
        formatDateInput(new Date(now.getFullYear(), now.getMonth(), 1))
      );
    }
    if (!customEndDate) {
      setCustomEndDate(formatDateInput(now));
    }
  }, [incomePeriod, customStartDate, customEndDate]);

  const incomePeriodRange = useMemo(
    () => getIncomePeriodRange(incomePeriod, customStartDate, customEndDate),
    [incomePeriod, customStartDate, customEndDate]
  );

  useEffect(() => {
    if (incomePeriod === "all") {
      setIncomeStatementAccounts([]);
      setIncomeStatementLoading(false);
      return;
    }

    if (!incomePeriodRange.startDate || !incomePeriodRange.endDate) {
      setIncomeStatementAccounts([]);
      setIncomeStatementLoading(false);
      return;
    }

    const params = new URLSearchParams({
      startDate: incomePeriodRange.startDate,
      endDate: incomePeriodRange.endDate,
    });

    const controller = new AbortController();
    setIncomeStatementLoading(true);
    apiGet<{ accounts?: IncomeStatementAccountSummary[] }>(
      `/api/b/${bookId}/reports/income-statement?${params.toString()}`,
      { signal: controller.signal }
    )
      .then((data) => {
        // apiGet now throws on a non-ok response instead of resolving one,
        // so this fallback is only reachable on a malformed 2xx body — kept
        // rather than restructured around, per the migration plan.
        setIncomeStatementAccounts(data.accounts || []);
        setIncomeStatementLoading(false);
      })
      .catch((error) => {
        // The controller's own signal is the authoritative answer to "was this
        // cancelled?". Name matching alone misses a Firefox abort and a body
        // truncated mid-stream, both of which reject with TypeError.
        if (controller.signal.aborted) return;
        if ((error as { name?: string })?.name === "AbortError") return;
        console.error("Failed to load income statement:", error);
        setIncomeStatementAccounts([]);
        setIncomeStatementLoading(false);
      });

    return () => controller.abort();
  }, [bookId, incomePeriod, incomePeriodRange.startDate, incomePeriodRange.endDate]);

  const activeAccounts = accounts.filter((a) => a.isActive);

  // Build account groups from account balances (all-time) or API data (filtered)
  const accountsByType = activeAccounts.reduce(
    (acc, account) => {
      if (account.type !== "income" && account.type !== "expense") return acc;
      if (!acc[account.type]) {
        acc[account.type] = {
          type: account.type,
          accounts: [],
          total: 0,
        };
      }
      acc[account.type].accounts.push(account);
      acc[account.type].total += account.balance;
      return acc;
    },
    {} as Record<string, AccountSummary>
  );

  const incomeStatementGroups = (() => {
    if (incomePeriod === "all") {
      return accountsByType;
    }

    const balances = new Map<number, number>(
      incomeStatementAccounts.map((account) => [account.accountId, account.balance])
    );

    const groups: Record<string, AccountSummary> = {};
    for (const account of activeAccounts) {
      if (account.type !== "income" && account.type !== "expense") continue;
      const balance = balances.get(account.id) ?? 0;
      if (!groups[account.type]) {
        groups[account.type] = {
          type: account.type,
          accounts: [],
          total: 0,
        };
      }
      groups[account.type].accounts.push({ ...account, balance });
      groups[account.type].total += balance;
    }

    return groups;
  })();

  const incomeStatementTypes = ["income", "expense"].filter(
    (t) => incomeStatementGroups[t]
  );

  // Calculate summary values
  const totalIncome = incomeStatementGroups["income"]
    ? getDisplayBalance(incomeStatementGroups["income"].total, "income")
    : 0;
  const totalExpenses = incomeStatementGroups["expense"]
    ? getDisplayBalance(incomeStatementGroups["expense"].total, "expense")
    : 0;
  const netIncome = totalIncome - totalExpenses;

  const handleDownloadCsv = () => {
    const periodLabel =
      INCOME_PERIOD_OPTIONS.find((o) => o.value === incomePeriod)?.label ??
      "All time";
    const { startDate, endDate } = incomePeriodRange;
    const rangeSuffix = startDate && endDate ? ` (${startDate} to ${endDate})` : "";

    const sectionLabels: Record<string, string> = {
      income: "Income",
      expense: "Expense",
    };

    const toAmount = (cents: number) => (cents / 100).toFixed(2);

    const lines: string[] = [
      csvEscape("Income Statement"),
      csvEscape(`Period: ${periodLabel}${rangeSuffix}`),
      "",
      ["Section", "Account", "Amount"].map(csvEscape).join(","),
    ];

    for (const type of incomeStatementTypes) {
      const group = incomeStatementGroups[type];
      if (!group) continue;
      const label = sectionLabels[type] ?? type;
      for (const account of group.accounts) {
        lines.push(
          [
            csvEscape(label),
            csvEscape(account.name),
            csvEscape(toAmount(getDisplayBalance(account.balance, type))),
          ].join(",")
        );
      }
      lines.push(
        [
          csvEscape(label),
          csvEscape(`Total ${label}`),
          csvEscape(toAmount(getDisplayBalance(group.total, type))),
        ].join(",")
      );
    }

    lines.push(
      [csvEscape("Summary"), csvEscape("Net Income"), csvEscape(toAmount(netIncome))].join(
        ","
      )
    );

    triggerDownload(datedCsvFilename("income-statement"), lines.join("\n"));
  };

  if (error) {
    return (
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <p className="text-danger">{error}</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="animate-pulse space-y-8">
          <div className="h-8 w-48 bg-surface-tertiary rounded" />
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-24 bg-surface-tertiary rounded-lg" />
            ))}
          </div>
          <div className="h-64 bg-surface-tertiary rounded-lg" />
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-fg">Income Statement</h1>
        <div className="flex items-center gap-3">
          <Button
            variant="secondary"
            onClick={handleDownloadCsv}
            disabled={incomeStatementLoading || incomeStatementTypes.length === 0}
          >
            Download CSV
          </Button>
          <div className="w-44">
            <Select
              id="incomePeriod"
              value={incomePeriod}
              onChange={(e) => setIncomePeriod(e.target.value as IncomePeriod)}
              options={INCOME_PERIOD_OPTIONS}
            />
          </div>
        </div>
      </div>

      {incomePeriod === "custom" && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6 max-w-md">
          <Input
            id="incomeStartDate"
            type="date"
            label="Start date"
            value={customStartDate}
            onChange={(e) => setCustomStartDate(e.target.value)}
          />
          <Input
            id="incomeEndDate"
            type="date"
            label="End date"
            value={customEndDate}
            onChange={(e) => setCustomEndDate(e.target.value)}
          />
        </div>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
        <div className="bg-surface rounded-lg border border-border shadow-soft p-6 border-l-4 border-l-fg-success">
          <p className="text-sm font-medium text-fg-tertiary mb-1">Total Income</p>
          <p className="text-2xl font-bold text-fg-success tabular-nums">
            {formatCurrency(totalIncome)}
          </p>
        </div>
        <div className="bg-surface rounded-lg border border-border shadow-soft p-6 border-l-4 border-l-fg-danger">
          <p className="text-sm font-medium text-fg-tertiary mb-1">Total Expenses</p>
          <p className="text-2xl font-bold text-fg-danger tabular-nums">
            {formatCurrency(totalExpenses)}
          </p>
        </div>
        <div className="bg-gradient-to-r from-accent to-accent-hover rounded-lg shadow-soft p-6">
          <p className="text-sm font-medium text-fg-on-accent/70 mb-1">Net Income</p>
          <p className="text-2xl font-bold text-fg-on-accent tabular-nums">
            {formatCurrency(netIncome)}
          </p>
        </div>
      </div>

      {incomeStatementLoading ? (
        <div className="text-sm text-fg-tertiary">Loading income statement...</div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {incomeStatementTypes.map((type) => {
            const group = incomeStatementGroups[type];
            if (!group) return null;
            return (
              <AccountCard
                key={type}
                type={type}
                accounts={group.accounts}
                total={group.total}
                basePath={`/b/${bookId}/transactions`}
                linkParams={{
                  startDate: incomePeriodRange.startDate ?? undefined,
                  endDate: incomePeriodRange.endDate ?? undefined,
                }}
              />
            );
          })}
          {incomeStatementTypes.length === 0 && (
            <p className="text-fg-tertiary text-sm">
              No income or expense accounts found.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
