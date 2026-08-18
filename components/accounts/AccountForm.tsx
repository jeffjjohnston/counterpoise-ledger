"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { AccountAutocomplete } from "@/components/ui/AccountAutocomplete";
import { IconPicker } from "@/components/accounts/IconPicker";
import { CategoryIcon } from "@/components/ui/CategoryIcon";
import { buildCategoryLabelMap, isDescendantOf, resolveAccountIconSource } from "@/lib/accounting";
import { getAccountShortName } from "@/lib/formatters";
import type { Account } from "@/db/schema";
import type { AccountWithBalance } from "@/types";

interface AccountFormProps {
  account?: Account;
  accounts?: AccountWithBalance[];
  onSubmit: (data: {
    name: string;
    type: Account["type"];
    subtype?: string | null;
    parentId?: number | null;
    isActive?: boolean;
    icon?: string | null;
  }) => void;
  onCancel: () => void;
}

const accountTypes = [
  { value: "asset", label: "Asset" },
  { value: "liability", label: "Liability" },
  { value: "equity", label: "Equity" },
  { value: "income", label: "Income" },
  { value: "expense", label: "Expense" },
];

const assetSubtypes = [
  { value: "", label: "No subtype" },
  { value: "bank", label: "Bank Account" },
  { value: "cash", label: "Cash" },
  { value: "investment", label: "Investment" },
  { value: "other", label: "Other" },
];

const liabilitySubtypes = [
  { value: "", label: "No subtype" },
  { value: "credit_card", label: "Credit Card" },
  { value: "loan", label: "Loan" },
  { value: "other", label: "Other" },
];

export function AccountForm({
  account,
  accounts = [],
  onSubmit,
  onCancel,
}: AccountFormProps) {
  const [name, setName] = useState(account?.name || "");
  const [type, setType] = useState<Account["type"]>(
    account?.type || "asset"
  );
  const [subtype, setSubtype] = useState(account?.subtype || "");
  const [parentId, setParentId] = useState<number | null>(
    account?.parentId || null
  );
  const [isActive, setIsActive] = useState(account?.isActive ?? true);
  const [icon, setIcon] = useState<string | null>(account?.icon ?? null);

  const subtypeOptions =
    type === "asset"
      ? assetSubtypes
      : type === "liability"
        ? liabilitySubtypes
        : [];

  // For income/expense, allow any account of same type as parent (not just top-level)
  // For other types, only allow top-level accounts as parents
  const allowAnyParent = type === "income" || type === "expense";

  const parentOptions = [
    { value: "", label: "No parent (top level)" },
    ...accounts
      .filter((a) => {
        if (a.type !== type) return false;
        if (a.id === account?.id) return false;
        if (!allowAnyParent && a.parentId) return false; // Only top-level for asset/liability/equity
        return true;
      })
      .map((a) => {
        // Show hierarchy for child accounts
        if (a.parentId) {
          const parent = accounts.find((p) => p.id === a.parentId);
          return {
            value: a.id,
            label: parent ? `${parent.name} : ${a.name}` : a.name,
          };
        }
        return { value: a.id, label: a.name };
      }),
  ];

  const isCategory = type === "income" || type === "expense";

  const parentAccount = parentId
    ? accounts.find((candidate) => candidate.id === parentId)
    : undefined;

  // What this account shows with no icon of its own, and who supplies it.
  // Resolved from the parent, not from the account, so an existing own icon
  // does not mask it. One call walks the tree once, so the icon and its
  // source name can never name different ancestors.
  const resolvedParentIcon = parentAccount
    ? resolveAccountIconSource(parentAccount, accounts)
    : null;
  const inheritedIcon = resolvedParentIcon?.icon ?? null;
  const inheritedFrom = resolvedParentIcon?.sourceName ?? null;

  // The preview runs the real display rule, so on a book with nothing
  // assigned it shows the full-path fallback rather than a bare leaf.
  const previewLabel = (() => {
    if (!isCategory || !name) return null;
    const draft = {
      id: account?.id ?? -1,
      name: parentAccount ? `${parentAccount.name}:${getAccountShortName(name)}` : name,
      type,
      icon,
      parentId,
    };
    const others = accounts.filter((candidate) => candidate.id !== draft.id);
    return buildCategoryLabelMap([...others, draft]).get(draft.id) ?? null;
  })();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit({
      name,
      type,
      subtype: subtype || null,
      parentId,
      isActive,
      // `undefined`, not `null`, on a non-category: the PUT route only
      // touches the column when `icon !== undefined`, so an icon set on a
      // bank account through the API (or a future MCP tool) survives an
      // edit made here instead of being silently cleared. The column
      // accepts any account type by design — see spec decision 5.
      icon: isCategory ? icon : undefined,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <Input
        label="Account Name"
        id="name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="e.g., Chase Checking"
        required
      />

      {isCategory && (
        <IconPicker
          value={icon}
          onChange={setIcon}
          inheritedIcon={inheritedIcon}
          inheritedFrom={inheritedFrom}
        />
      )}

      {previewLabel && (
        <div className="rounded-md border border-dashed border-border px-3 py-2">
          <span className="block text-[10px] uppercase tracking-wide text-fg-tertiary mb-1">
            Preview in the ledger
          </span>
          <span className="text-sm text-fg-secondary">
            Chase Checking <span className="text-fg-tertiary">→</span>{" "}
            <CategoryIcon icon={previewLabel.icon} />
            {previewLabel.text}
          </span>
        </div>
      )}

      <Select
        label="Account Type"
        id="type"
        value={type}
        onChange={(e) => {
          setType(e.target.value as Account["type"]);
          setSubtype("");
          setParentId(null);
        }}
        options={accountTypes}
        disabled={!!account}
      />

      {subtypeOptions.length > 0 && (
        <Select
          label="Subtype"
          id="subtype"
          value={subtype}
          onChange={(e) => setSubtype(e.target.value)}
          options={subtypeOptions}
        />
      )}

      {parentOptions.length > 1 && (
        <>
          {allowAnyParent ? (
            <AccountAutocomplete
              label="Parent Account (optional)"
              accounts={accounts.filter(
                (a) =>
                  a.type === type &&
                  a.id !== account?.id &&
                  // Excluding only the account itself is not enough: picking
                  // one of its descendants makes the two point at each other,
                  // which the live preview below walks during render and the
                  // PUT route would happily persist.
                  !(account && isDescendantOf(a, account.id, accounts))
              )}
              value={parentId}
              onChange={(id) => setParentId(id)}
              placeholder="No parent (top level)"
              showHierarchy={true}
              allowClear={true}
            />
          ) : (
            <Select
              label="Parent Account"
              id="parent"
              value={parentId || ""}
              onChange={(e) =>
                setParentId(e.target.value ? parseInt(e.target.value) : null)
              }
              options={parentOptions}
            />
          )}
        </>
      )}

      {account && (
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={isActive}
            onChange={(e) => setIsActive(e.target.checked)}
            className="rounded border-border text-fg-accent focus:ring-border-focus"
          />
          <span className="text-sm text-fg-secondary">Active</span>
        </label>
      )}

      <div className="flex justify-end gap-3 pt-4">
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit">
          {account ? "Save Changes" : "Create Account"}
        </Button>
      </div>
    </form>
  );
}
