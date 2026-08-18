"use client";

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { AccountAutocomplete } from "@/components/ui/AccountAutocomplete";
import {
  formatCurrency,
  parseStrictCurrency,
  resolveAmountOnBlur,
} from "@/lib/formatters";
import { evaluateExpression } from "@/lib/expression";
import type { AccountWithBalance } from "@/types";
import type { SplitInput } from "@/types";

interface SplitEditorProps {
  splits: SplitInput[];
  onChange: (splits: SplitInput[]) => void;
  accounts: AccountWithBalance[];
  onPendingChange?: (hasPending: boolean) => void;
}

export function SplitEditor({ splits, onChange, accounts, onPendingChange }: SplitEditorProps) {
  const [draftValues, setDraftValues] = useState(() =>
    splits.map((split) => ({
      debit: split.amount > 0 ? (split.amount / 100).toFixed(2) : "",
      credit: split.amount < 0 ? (-split.amount / 100).toFixed(2) : "",
    }))
  );
  const skipSyncRef = useRef(false);

  useEffect(() => {
    if (skipSyncRef.current) {
      skipSyncRef.current = false;
      return;
    }
    setDraftValues(
      splits.map((split) => ({
        debit: split.amount > 0 ? (split.amount / 100).toFixed(2) : "",
        credit: split.amount < 0 ? (-split.amount / 100).toFixed(2) : "",
      }))
    );
  }, [splits]);

  const updateSplit = (
    index: number,
    field: keyof SplitInput,
    value: SplitInput[keyof SplitInput]
  ) => {
    skipSyncRef.current = true;
    const newSplits = [...splits];
    newSplits[index] = { ...newSplits[index], [field]: value };
    onChange(newSplits);
  };

  const addSplit = () => {
    if (draftValues.some((draft) => isInvalidDraftAmount(draft.debit || draft.credit))) {
      return;
    }

    // Compute total from draft values (not committed splits) to avoid stale
    // closure when blur and click fire in the same event loop tick
    const currentTotal = draftValues.reduce((sum, draft) => {
      const debitVal = draft.debit ? (parseDraftAmount(draft.debit) ?? 0) : 0;
      const creditVal = draft.credit ? (parseDraftAmount(draft.credit) ?? 0) : 0;
      return sum + debitVal - creditVal;
    }, 0);
    const newAmount = -currentTotal;
    skipSyncRef.current = true;
    // Also recompute committed splits from drafts so they're in sync
    const syncedSplits = splits.map((split, i) => {
      const draft = draftValues[i];
      if (!draft) return split;
      const debitVal = draft.debit ? (parseDraftAmount(draft.debit) ?? 0) : 0;
      const creditVal = draft.credit ? (parseDraftAmount(draft.credit) ?? 0) : 0;
      const amount = debitVal > 0 ? debitVal : creditVal > 0 ? -creditVal : 0;
      return { ...split, amount };
    });
    setDraftValues((current) => [
      ...current,
      {
        debit: newAmount > 0 ? (newAmount / 100).toFixed(2) : "",
        credit: newAmount < 0 ? (-newAmount / 100).toFixed(2) : "",
      },
    ]);
    onChange([
      ...syncedSplits,
      {
        accountId: 0,
        amount: newAmount,
      },
    ]);
  };

  const removeSplit = (index: number) => {
    if (splits.length <= 2) return;
    skipSyncRef.current = true;
    setDraftValues((current) => current.filter((_, i) => i !== index));
    const newSplits = splits.filter((_, i) => i !== index);
    onChange(newSplits);
  };

  const handleAmountChange = (
    index: number,
    field: "debit" | "credit",
    value: string
  ) => {
    // Allow digits, decimal point, and math expression characters while typing
    const normalized = value.replace(/[^0-9.+\-*/() ]/g, "");
    skipSyncRef.current = true;
    setDraftValues((current) => {
      const next = [...current];
      const otherField = field === "debit" ? "credit" : "debit";
      next[index] = {
        ...(next[index] ?? { debit: "", credit: "" }),
        [field]: normalized,
        [otherField]: "",
      };
      return next;
    });

    const parsedValue = parseDraftAmount(normalized);
    updateSplit(index, "amount", field === "debit" ? (parsedValue ?? 0) : -(parsedValue ?? 0));
  };

  const handleAmountBlur = (index: number, field: "debit" | "credit") => {
    const draft = draftValues[index]?.[field] ?? "";
    if (!draft.trim()) return;
    const resolved = resolveAmountOnBlur(draft);
    if (resolved !== draft) {
      skipSyncRef.current = true;
      setDraftValues((current) => {
        const next = [...current];
        next[index] = {
          ...(next[index] ?? { debit: "", credit: "" }),
          [field]: resolved,
        };
        return next;
      });
    }
    const parsedValue = parseDraftAmount(resolved);
    updateSplit(index, "amount", field === "debit" ? (parsedValue ?? 0) : -(parsedValue ?? 0));
  };

  const handleAmountKeyDown = (
    e: React.KeyboardEvent,
    index: number,
    field: "debit" | "credit"
  ) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleAmountBlur(index, field);
    }
  };

  const total = splits.reduce((sum, s) => sum + s.amount, 0);
  const isBalanced = total === 0;

  // Check if any draft field still contains an invalid amount.
  const hasPendingExpression = draftValues.some((draft) => {
    const value = draft.debit || draft.credit;
    return isInvalidDraftAmount(value);
  });

  useEffect(() => {
    onPendingChange?.(hasPendingExpression);
  }, [hasPendingExpression, onPendingChange]);

  const handleContainerKeyDown = (e: React.KeyboardEvent) => {
    if (e.altKey && e.key === "Enter") {
      e.preventDefault();
      addSplit();
    }
  };

  return (
    <div className="space-y-3" onKeyDown={handleContainerKeyDown}>
      <div className="grid grid-cols-12 gap-2 text-xs font-medium text-fg-tertiary uppercase">
        <div className="col-span-5">Account</div>
        <div className="col-span-3">Debit</div>
        <div className="col-span-3">Credit</div>
        <div className="col-span-1"></div>
      </div>
      {splits.map((split, index) => (
        <div key={index} className="grid grid-cols-12 gap-2 items-center">
          <div className="col-span-5">
            <AccountAutocomplete
              accounts={accounts}
              value={split.accountId}
              onChange={(accountId) => {
                if (accountId !== null) {
                  updateSplit(index, "accountId", accountId);
                }
              }}
              placeholder="Search for account..."
              showHierarchy={true}
              allowClear={false}
            />
          </div>
          <div className="col-span-3">
            <Input
              type="text"
              value={draftValues[index]?.debit ?? ""}
              onChange={(e) => handleAmountChange(index, "debit", e.target.value)}
              onBlur={() => handleAmountBlur(index, "debit")}
              onKeyDown={(e) => handleAmountKeyDown(e, index, "debit")}
              placeholder="0.00"
              className="text-right"
              selectOnFocus
            />
          </div>
          <div className="col-span-3">
            <Input
              type="text"
              value={draftValues[index]?.credit ?? ""}
              onChange={(e) => handleAmountChange(index, "credit", e.target.value)}
              onBlur={() => handleAmountBlur(index, "credit")}
              onKeyDown={(e) => handleAmountKeyDown(e, index, "credit")}
              placeholder="0.00"
              className="text-right"
              selectOnFocus
            />
          </div>
          <div className="col-span-1 flex justify-center">
            {splits.length > 2 && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => removeSplit(index)}
                className="text-fg-tertiary hover:text-fg-danger p-1"
              >
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </Button>
            )}
          </div>
        </div>
      ))}

      <div className="flex items-center justify-between pt-2 border-t">
        <Button type="button" variant="ghost" size="sm" onClick={addSplit}>
          + Add Line
          <span className="ml-1.5 text-xs opacity-60" aria-hidden="true">
            Alt+↵
          </span>
        </Button>
        <div className="text-sm flex items-center gap-4">
          <span className="text-fg-tertiary">
            Debits: {formatCurrency(splits.filter((s) => s.amount > 0).reduce((sum, s) => sum + s.amount, 0))}
          </span>
          <span className="text-fg-tertiary">
            Credits: {formatCurrency(Math.abs(splits.filter((s) => s.amount < 0).reduce((sum, s) => sum + s.amount, 0)))}
          </span>
          <span
            className={cn(
              "font-medium",
              hasPendingExpression
                ? "text-fg-tertiary"
                : isBalanced
                  ? "text-fg-success"
                  : "text-fg-danger"
            )}
          >
            {hasPendingExpression
              ? "Resolve amounts"
              : isBalanced
                ? "Balanced"
                : `Off by ${formatCurrency(Math.abs(total))}`}
          </span>
        </div>
      </div>
    </div>
  );
}

/** Parse a draft string (plain number or expression) into non-negative cents. */
function parseDraftAmount(value: string): number | null {
  if (!value.trim()) return 0;
  const evaluated = evaluateExpression(value);
  if (evaluated !== null) {
    if (evaluated < 0) return null;
    return Math.round(evaluated * 100);
  }

  const parsed = parseStrictCurrency(value);
  if (parsed === null || parsed < 0) return null;
  return parsed;
}

function isInvalidDraftAmount(value: string): boolean {
  if (!value.trim()) return false;
  return parseDraftAmount(value) === null;
}

function cn(...classes: (string | boolean | undefined)[]) {
  return classes.filter(Boolean).join(" ");
}
