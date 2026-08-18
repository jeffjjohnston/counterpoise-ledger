"use client";

import { useEffect, useMemo, useState } from "react";
import { useBookId } from "@/hooks/useBookId";
import { Button } from "@/components/ui/Button";
import { DateInput } from "@/components/ui/DateInput";
import { Select } from "@/components/ui/Select";
import { flattenAccounts } from "@/lib/accounting";
import { formatCurrency, formatDate } from "@/lib/formatters";
import { csvEscape, datedCsvFilename, triggerDownload } from "@/lib/csv";
import { cn } from "@/lib/utils";
import { apiGet } from "@/lib/api-client";
import type { AccountWithBalance } from "@/types";

type Term = "short" | "long" | "unknown";

type RealizedGainRow = {
  sellDate: string;
  transactionId: number;
  securityId: number;
  securitySymbol: string;
  securityName: string;
  accountId: number;
  accountName: string;
  sharesMicros: number;
  acquiredDate: string | null;
  proceedsCents: number;
  basisCents: number | null;
  gainCents: number | null;
  term: Term;
};

type RealizedGainsResult = {
  rows: RealizedGainRow[];
  totals: {
    shortTermGainCents: number;
    longTermGainCents: number;
    proceedsCents: number;
    basisCents: number;
    unknownBasisRows: number;
  };
};

const TERM_LABEL: Record<Term, string> = {
  short: "Short",
  long: "Long",
  unknown: "Basis unknown",
};

const TERM_BADGE_CLASS: Record<Term, string> = {
  short: "bg-surface-tertiary text-fg-secondary",
  long: "bg-accent-subtle text-fg-accent",
  unknown: "bg-warning-subtle text-fg-warning",
};

function currentTaxYear(): { startDate: string; endDate: string } {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return { startDate: `${year}-01-01`, endDate: `${year}-${month}-${day}` };
}

const formatShares = (micros: number) =>
  (micros / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 6 });

function gainClass(gainCents: number | null): string {
  if (gainCents === null) return "";
  if (gainCents < 0) return "text-fg-danger";
  if (gainCents > 0) return "text-fg-success";
  return "";
}

export default function RealizedGainsPage() {
  const bookId = useBookId();
  const [range, setRange] = useState(currentTaxYear);
  const [accountId, setAccountId] = useState("");
  const [accounts, setAccounts] = useState<AccountWithBalance[]>([]);
  const [result, setResult] = useState<RealizedGainsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Investment accounts only — lots exist nowhere else, so offering any other
  // account would be an option guaranteed to return nothing. Inactive accounts
  // are included: an archived brokerage can still hold historical disposals,
  // and excluding it would silently drop them from a tax-year total.
  useEffect(() => {
    const controller = new AbortController();
    apiGet<AccountWithBalance[]>(`/api/b/${bookId}/accounts?includeInactive=true`, {
      signal: controller.signal,
    })
      .then((data) =>
        setAccounts(
          flattenAccounts(data).filter(
            (a) => a.type === "asset" && a.subtype === "investment"
          )
        )
      )
      .catch((err) => {
        // The controller's own signal is the authoritative answer to "was this
        // cancelled?". Name matching alone misses a Firefox abort and a body
        // truncated mid-stream, both of which reject with TypeError.
        if (controller.signal.aborted) return;
        if ((err as { name?: string })?.name === "AbortError") return;
        // A missing account list only costs the filter, not the report — leave
        // it empty rather than blocking the page on it.
        console.error("Failed to load accounts for the realized gains filter:", err);
      });
    return () => controller.abort();
  }, [bookId]);

  const accountOptions = useMemo(
    () => [
      { value: "", label: "All accounts" },
      ...accounts.map((a) => ({ value: String(a.id), label: a.name })),
    ],
    [accounts]
  );

  // Mirrors the AbortController pattern in income-statement/page.tsx: editing "From"
  // and then quickly editing "To" fires overlapping requests, and without a signal a
  // slow first response can resolve after a fast second one and silently overwrite
  // the current range's totals with the previous range's numbers. Aborting the
  // in-flight request on cleanup (and ignoring the resulting AbortError) guarantees
  // only the latest range's response is ever applied to state.
  useEffect(() => {
    const params = new URLSearchParams({
      startDate: range.startDate,
      endDate: range.endDate,
    });
    if (accountId) params.set("accountId", accountId);

    const controller = new AbortController();
    setLoading(true);
    setError(null);
    apiGet<RealizedGainsResult>(
      `/api/b/${bookId}/reports/realized-gains?${params.toString()}`,
      { signal: controller.signal }
    )
      .then((data) => {
        setResult(data);
        setLoading(false);
      })
      .catch((err) => {
        // The controller's own signal is the authoritative answer to "was this
        // cancelled?". Name matching alone misses a Firefox abort and a body
        // truncated mid-stream, both of which reject with TypeError.
        if (controller.signal.aborted) return;
        if ((err as { name?: string })?.name === "AbortError") return;
        console.error("Failed to load realized gains:", err);
        setResult(null);
        setError("Failed to load realized gains. Please try again.");
        setLoading(false);
      });

    return () => controller.abort();
  }, [bookId, range.startDate, range.endDate, accountId]);

  const exportCsv = () => {
    if (!result) return;
    const header = [
      "Sell Date", "Security", "Account", "Shares", "Acquired",
      "Proceeds", "Cost Basis", "Gain/Loss", "Term",
    ];
    const lines = result.rows.map((row) =>
      [
        row.sellDate,
        row.securitySymbol,
        row.accountName,
        formatShares(row.sharesMicros),
        row.acquiredDate ?? "",
        (row.proceedsCents / 100).toFixed(2),
        row.basisCents === null ? "" : (row.basisCents / 100).toFixed(2),
        row.gainCents === null ? "" : (row.gainCents / 100).toFixed(2),
        TERM_LABEL[row.term],
      ]
        .map(csvEscape)
        .join(",")
    );
    triggerDownload(
      datedCsvFilename("realized-gains"),
      [header.map(csvEscape).join(","), ...lines].join("\n")
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-fg">Realized Gains</h1>
          <p className="text-sm text-fg-secondary mt-1">
            One row per lot disposed of, matching how a 1099-B reports sales.
          </p>
        </div>
        <div className="flex items-end gap-3">
          <div className="min-w-[12rem]">
            <Select
              id="realized-gains-account"
              label="Account"
              size="compact"
              options={accountOptions}
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
            />
          </div>
          <DateInput
            id="realized-gains-start-date"
            label="From"
            size="compact"
            value={range.startDate}
            onChange={(startDate) => setRange((r) => ({ ...r, startDate }))}
          />
          <DateInput
            id="realized-gains-end-date"
            label="To"
            size="compact"
            value={range.endDate}
            onChange={(endDate) => setRange((r) => ({ ...r, endDate }))}
          />
          <Button onClick={exportCsv} variant="secondary" disabled={!result?.rows.length}>
            Export CSV
          </Button>
        </div>
      </div>

      {error && (
        <div className="bg-danger-subtle border border-border text-fg-danger px-4 py-3 rounded-lg text-sm">
          {error}
        </div>
      )}

      {result && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <SummaryCard
            label="Short-term gain"
            testId="short-term-total"
            value={result.totals.shortTermGainCents}
            colorize
          />
          <SummaryCard
            label="Long-term gain"
            testId="long-term-total"
            value={result.totals.longTermGainCents}
            colorize
          />
          <SummaryCard label="Proceeds" testId="proceeds-total" value={result.totals.proceedsCents} />
          <SummaryCard label="Cost basis" testId="basis-total" value={result.totals.basisCents} />
        </div>
      )}

      {result && result.totals.unknownBasisRows > 0 && (
        <div className="rounded-lg border border-border bg-warning-subtle px-4 py-3 text-sm text-fg">
          {result.totals.unknownBasisRows} disposal
          {result.totals.unknownBasisRows === 1 ? "" : "s"} could not be matched to a lot.
          Their proceeds are shown but excluded from the totals above.
        </div>
      )}

      <section className="bg-surface rounded-lg border border-border shadow-soft overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-surface-secondary text-fg-secondary">
              <tr>
                <th className="px-4 py-3 text-left font-medium">Sell date</th>
                <th className="px-4 py-3 text-left font-medium">Security</th>
                <th className="px-4 py-3 text-left font-medium">Account</th>
                <th className="px-4 py-3 text-right font-medium">Shares</th>
                <th className="px-4 py-3 text-left font-medium">Acquired</th>
                <th className="px-4 py-3 text-right font-medium">Proceeds</th>
                <th className="px-4 py-3 text-right font-medium">Basis</th>
                <th className="px-4 py-3 text-right font-medium">Gain/Loss</th>
                <th className="px-4 py-3 text-left font-medium">Term</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-secondary">
              {loading ? (
                <tr>
                  <td className="px-4 py-8 text-center text-fg-tertiary" colSpan={9}>
                    Loading…
                  </td>
                </tr>
              ) : error ? (
                <tr>
                  <td className="px-4 py-8 text-center text-fg-tertiary" colSpan={9}>
                    Unable to load realized gains.
                  </td>
                </tr>
              ) : !result || result.rows.length === 0 ? (
                <tr>
                  <td className="px-4 py-8 text-center text-fg-tertiary" colSpan={9}>
                    No disposals in this date range.
                  </td>
                </tr>
              ) : (
                result.rows.map((row, index) => (
                  <tr
                    key={`${row.transactionId}-${row.securityId}-${index}`}
                    className={row.term === "unknown" ? "bg-warning-subtle/40" : undefined}
                  >
                    <td className="px-4 py-3 text-fg-secondary">{formatDate(row.sellDate)}</td>
                    <td className="px-4 py-3 text-fg">{row.securitySymbol}</td>
                    <td className="px-4 py-3 text-fg-secondary">{row.accountName}</td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {formatShares(row.sharesMicros)}
                    </td>
                    <td className="px-4 py-3 text-fg-secondary">
                      {row.acquiredDate ? formatDate(row.acquiredDate) : "—"}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {formatCurrency(row.proceedsCents)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {row.basisCents === null ? "—" : formatCurrency(row.basisCents)}
                    </td>
                    <td className={cn("px-4 py-3 text-right tabular-nums", gainClass(row.gainCents))}>
                      {row.gainCents === null ? "—" : formatCurrency(row.gainCents)}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={cn(
                          "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
                          TERM_BADGE_CLASS[row.term]
                        )}
                      >
                        {TERM_LABEL[row.term]}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  testId,
  colorize = false,
}: {
  label: string;
  value: number;
  testId: string;
  colorize?: boolean;
}) {
  const valueClass = colorize
    ? value < 0
      ? "text-fg-danger"
      : value > 0
        ? "text-fg-success"
        : "text-fg"
    : "text-fg";
  return (
    <div className="bg-surface rounded-lg border border-border shadow-soft px-4 py-3">
      <div className="text-xs text-fg-secondary">{label}</div>
      <div className={cn("text-lg font-semibold tabular-nums", valueClass)} data-testid={testId}>
        {formatCurrency(value)}
      </div>
    </div>
  );
}
