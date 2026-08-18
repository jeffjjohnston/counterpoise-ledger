"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { Input } from "@/components/ui/Input";
import { AccountAutocomplete } from "@/components/ui/AccountAutocomplete";
import { ACCOUNT_TYPE_LABELS } from "@/lib/accounting";
import type { AccountWithBalance } from "@/types";
import type { GroupDimension } from "@/lib/reports";

export type ReportConfig = {
  startDate: string;
  endDate: string;
  accountTypes: string[];
  accountIds: number[];
  groupings: GroupDimension[];
  collapseToParent: boolean;
};

type DatePreset = "ytd" | "last_year" | "last_month" | "current_month" | "last_12" | "custom";

const ACCOUNT_TYPES = ["income", "expense", "asset", "liability", "equity"] as const;

const DIMENSION_OPTIONS = [
  { value: "month", label: "Month" },
  { value: "year", label: "Year" },
  { value: "week", label: "Week" },
  { value: "payee", label: "Payee" },
  { value: "account", label: "Account" },
];

function formatDateInput(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getPresetDates(preset: DatePreset): { startDate: string; endDate: string } | null {
  const now = new Date();
  switch (preset) {
    case "ytd":
      return {
        startDate: formatDateInput(new Date(now.getFullYear(), 0, 1)),
        endDate: formatDateInput(now),
      };
    case "last_year": {
      const y = now.getFullYear() - 1;
      return {
        startDate: `${y}-01-01`,
        endDate: `${y}-12-31`,
      };
    }
    case "current_month":
      return {
        startDate: formatDateInput(new Date(now.getFullYear(), now.getMonth(), 1)),
        endDate: formatDateInput(now),
      };
    case "last_month": {
      const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const end = new Date(now.getFullYear(), now.getMonth(), 0);
      return {
        startDate: formatDateInput(start),
        endDate: formatDateInput(end),
      };
    }
    case "last_12": {
      const end = new Date(now);
      const start = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
      return {
        startDate: formatDateInput(start),
        endDate: formatDateInput(end),
      };
    }
    default:
      return null;
  }
}

interface ReportConfigPanelProps {
  config: ReportConfig;
  onChange: (config: ReportConfig) => void;
  onGenerate: () => void;
  accounts: AccountWithBalance[];
  loading: boolean;
}

export function ReportConfigPanel({
  config,
  onChange,
  onGenerate,
  accounts,
  loading,
}: ReportConfigPanelProps) {
  const [datePreset, setDatePreset] = useState<DatePreset>("ytd");

  const handlePreset = (preset: DatePreset) => {
    setDatePreset(preset);
    const dates = getPresetDates(preset);
    if (dates) {
      onChange({ ...config, ...dates });
    }
  };

  const toggleAccountType = (type: string) => {
    const types = config.accountTypes.includes(type)
      ? config.accountTypes.filter((t) => t !== type)
      : [...config.accountTypes, type];
    onChange({ ...config, accountTypes: types });
  };

  const addAccountFilter = (accountId: number | null) => {
    if (accountId && !config.accountIds.includes(accountId)) {
      onChange({ ...config, accountIds: [...config.accountIds, accountId] });
    }
  };

  const removeAccountFilter = (accountId: number) => {
    onChange({ ...config, accountIds: config.accountIds.filter((id) => id !== accountId) });
  };

  const setGrouping = (index: number, value: string) => {
    const newGroupings = [...config.groupings];
    newGroupings[index] = value as GroupDimension;
    onChange({ ...config, groupings: newGroupings });
  };

  const addGrouping = () => {
    if (config.groupings.length < 3) {
      const used = new Set(config.groupings);
      const next = DIMENSION_OPTIONS.find((d) => !used.has(d.value as GroupDimension));
      if (next) {
        onChange({ ...config, groupings: [...config.groupings, next.value as GroupDimension] });
      }
    }
  };

  const removeGrouping = (index: number) => {
    const newGroupings = config.groupings.filter((_, i) => i !== index);
    onChange({ ...config, groupings: newGroupings });
  };

  const presets: { key: DatePreset; label: string }[] = [
    { key: "ytd", label: "YTD" },
    { key: "last_year", label: "Last Year" },
    { key: "current_month", label: "This Month" },
    { key: "last_month", label: "Last Month" },
    { key: "last_12", label: "Last 12 Mo" },
    { key: "custom", label: "Custom" },
  ];

  return (
    <div className="bg-surface rounded-lg border border-border p-4 space-y-4">
      {/* Date range */}
      <div>
        <label className="block text-sm font-medium text-fg-secondary mb-1.5">Date Range</label>
        <div className="flex flex-wrap items-center gap-2">
          {presets.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => handlePreset(p.key)}
              className={`px-3 py-1 text-xs font-medium rounded-full border transition-colors ${
                datePreset === p.key
                  ? "bg-accent-subtle border-border-focus text-fg-accent"
                  : "border-border text-fg-secondary hover:bg-surface-tertiary"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 mt-2">
          <Input
            type="date"
            value={config.startDate}
            onChange={(e) => {
              setDatePreset("custom");
              onChange({ ...config, startDate: e.target.value });
            }}
            className="w-40"
          />
          <span className="text-fg-tertiary text-sm">to</span>
          <Input
            type="date"
            value={config.endDate}
            onChange={(e) => {
              setDatePreset("custom");
              onChange({ ...config, endDate: e.target.value });
            }}
            className="w-40"
          />
        </div>
      </div>

      {/* Account types */}
      <div>
        <label className="block text-sm font-medium text-fg-secondary mb-1.5">Account Types</label>
        <div className="flex flex-wrap gap-2">
          {ACCOUNT_TYPES.map((type) => (
            <button
              key={type}
              type="button"
              onClick={() => toggleAccountType(type)}
              className={`px-3 py-1 text-xs font-medium rounded-full border transition-colors ${
                config.accountTypes.includes(type)
                  ? "bg-accent-subtle border-border-focus text-fg-accent"
                  : "border-border text-fg-secondary hover:bg-surface-tertiary"
              }`}
            >
              {ACCOUNT_TYPE_LABELS[type]}
            </button>
          ))}
        </div>
      </div>

      {/* Account filter */}
      <div>
        <label className="block text-sm font-medium text-fg-secondary mb-1.5">
          Filter Accounts <span className="font-normal text-fg-tertiary">(optional)</span>
        </label>
        {config.accountIds.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {config.accountIds.map((id) => {
              const acct = accounts.find((a) => a.id === id);
              return (
                <span
                  key={id}
                  className="inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-surface-tertiary text-fg-secondary rounded-full"
                >
                  {acct?.name ?? `#${id}`}
                  <button
                    type="button"
                    onClick={() => removeAccountFilter(id)}
                    className="text-fg-tertiary hover:text-fg-secondary"
                  >
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </span>
              );
            })}
          </div>
        )}
        <AccountAutocomplete
          accounts={accounts}
          value={null}
          onChange={addAccountFilter}
          placeholder="Add account filter..."
          allowClear={false}
          size="compact"
        />
      </div>

      {/* Groupings */}
      <div>
        <label className="block text-sm font-medium text-fg-secondary mb-1.5">Group By</label>
        <div className="flex flex-wrap items-center gap-2">
          {config.groupings.map((dim, i) => (
            <div key={i} className="flex items-center gap-1">
              {i > 0 && <span className="text-xs text-fg-tertiary">then</span>}
              <Select
                value={dim}
                onChange={(e) => setGrouping(i, e.target.value)}
                options={DIMENSION_OPTIONS.map((d) => ({
                  ...d,
                  disabled: config.groupings.includes(d.value as GroupDimension) && d.value !== dim,
                }))}
                className="w-32"
              />
              {config.groupings.length > 1 && (
                <button
                  type="button"
                  onClick={() => removeGrouping(i)}
                  className="p-0.5 text-fg-tertiary hover:text-fg-secondary"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>
          ))}
          {config.groupings.length < 3 && (
            <Button variant="ghost" size="sm" onClick={addGrouping}>
              + Add level
            </Button>
          )}
        </div>
      </div>

      {/* Collapse + Generate */}
      <div className="flex items-center justify-between pt-2 border-t border-border-secondary">
        <label className="flex items-center gap-2 text-sm text-fg-secondary cursor-pointer">
          <input
            type="checkbox"
            checked={config.collapseToParent}
            onChange={(e) => onChange({ ...config, collapseToParent: e.target.checked })}
            className="rounded border-border text-accent focus:ring-border-focus"
          />
          Collapse child accounts to parent
        </label>
        <Button onClick={onGenerate} disabled={loading}>
          {loading ? "Loading..." : "Generate Report"}
        </Button>
      </div>
    </div>
  );
}
