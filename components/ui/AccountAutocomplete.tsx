"use client";

import { useState, useRef, useEffect, useId, useMemo } from "react";
import { cn } from "@/lib/utils";
import { ACCOUNT_TYPE_LABELS, buildCategoryLabelMap } from "@/lib/accounting";
import { CategoryIcon } from "@/components/ui/CategoryIcon";
import type { AccountWithBalance } from "@/types";

interface AccountAutocompleteProps {
  accounts: AccountWithBalance[];
  value: number | null;
  onChange: (accountId: number | null) => void;
  label?: string;
  placeholder?: string;
  className?: string;
  showHierarchy?: boolean;
  filterType?: string | null;
  excludeId?: number;
  allowClear?: boolean;
  dropUp?: boolean;
  size?: "default" | "compact";
  warning?: boolean;
}

export function AccountAutocomplete({
  accounts,
  value,
  onChange,
  label,
  placeholder = "Search for an account...",
  className,
  showHierarchy = true,
  filterType = null,
  excludeId,
  allowClear = true,
  dropUp = false,
  size = "default",
  warning = false,
}: AccountAutocompleteProps) {
  const isCompact = size === "compact";
  const [searchTerm, setSearchTerm] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const reactId = useId();
  const inputId = `account-autocomplete-${reactId}`;

  const selectedAccount = accounts.find((a) => a.id === value);

  // Filter accounts based on search term and type
  // Always include the selected account even if inactive, but filter inactive from dropdown
  // Returns both the filtered list and the set of IDs that directly matched the search
  const { filtered: filteredAccounts, matchedIds } = (() => {
    const searchLower = (searchTerm ?? "").toLowerCase();
    const matched = accounts.filter((account) => {
      if (excludeId && account.id === excludeId) return false;
      if (filterType && account.type !== filterType) return false;

      const matchesSearch =
        account.name.toLowerCase().includes(searchLower) ||
        account.type.toLowerCase().includes(searchLower) ||
        (account.subtype && account.subtype.toLowerCase().includes(searchLower));

      // Include if matches search and either active OR is the currently selected account
      return matchesSearch && (account.isActive || account.id === value);
    });

    const directMatchIds = new Set(matched.map((a) => a.id));

    // When searching, also include parent accounts of matched children so hierarchy is visible
    if (searchLower) {
      const allIds = new Set(directMatchIds);
      const parentsToAdd = matched
        .filter((a) => a.parentId && !allIds.has(a.parentId))
        .map((a) => accounts.find((p) => p.id === a.parentId))
        .filter((p): p is AccountWithBalance => !!p && (!filterType || p.type === filterType));
      parentsToAdd.forEach((p) => {
        if (!allIds.has(p.id)) {
          matched.push(p);
          allIds.add(p.id);
        }
      });
    }

    return { filtered: matched, matchedIds: directMatchIds };
  })();

  const categoryLabels = useMemo(
    () => buildCategoryLabelMap(accounts),
    [accounts]
  );

  // Build account hierarchy display
  const buildAccountDisplay = (account: AccountWithBalance, context: "input" | "dropdown" = "dropdown"): string => {
    let display = "";
    if (!showHierarchy || !account.parentId) {
      display = account.name;
    } else if (context === "dropdown") {
      // In dropdown, children are already indented under their parent, so just show short name
      const lastColonIndex = account.name.lastIndexOf(":");
      display = lastColonIndex === -1 ? account.name : account.name.substring(lastColonIndex + 1).trim();
    } else {
      // In input field, show full context: "Parent : Child"
      const parent = accounts.find((a) => a.id === account.parentId);
      if (parent) {
        const lastColonIndex = account.name.lastIndexOf(":");
        const shortName = lastColonIndex === -1 ? account.name : account.name.substring(lastColonIndex + 1).trim();
        display = `${parent.name} : ${shortName}`;
      } else {
        display = account.name;
      }
    }

    if (context === "input" && !account.isActive) {
      display += " (inactive)";
    }

    return display;
  };

  // Group accounts by type for display
  interface AccountGroup {
    type: string;
    label: string;
    accounts: AccountWithBalance[];
  }

  const groupedAccounts: AccountGroup[] = useMemo(() => {
    const groups: AccountGroup[] = [];
    const typeMap = new Map<string, AccountWithBalance[]>();

    filteredAccounts.forEach((account) => {
      if (!typeMap.has(account.type)) {
        typeMap.set(account.type, []);
      }
      typeMap.get(account.type)!.push(account);
    });

    typeMap.forEach((accts, type) => {
      // Build tree: parents alphabetical, children alphabetical under their parent
      const parents = accts
        .filter((a) => !a.parentId)
        .sort((a, b) => a.name.localeCompare(b.name));
      const childrenByParent = new Map<number, AccountWithBalance[]>();
      accts
        .filter((a) => a.parentId)
        .forEach((a) => {
          const list = childrenByParent.get(a.parentId!) ?? [];
          list.push(a);
          childrenByParent.set(a.parentId!, list);
        });
      childrenByParent.forEach((list) =>
        list.sort((a, b) => a.name.localeCompare(b.name))
      );

      const ordered: AccountWithBalance[] = [];
      parents.forEach((parent) => {
        ordered.push(parent);
        const children = childrenByParent.get(parent.id);
        if (children) ordered.push(...children);
      });
      // Also include orphan children whose parent was filtered out
      accts
        .filter((a) => a.parentId && !parents.some((p) => p.id === a.parentId))
        .sort((a, b) => a.name.localeCompare(b.name))
        .forEach((a) => {
          if (!ordered.includes(a)) ordered.push(a);
        });

      groups.push({
        type,
        label: ACCOUNT_TYPE_LABELS[type] || type,
        accounts: ordered,
      });
    });

    return groups;
  }, [filteredAccounts]);

  // Flatten for keyboard navigation
  const flatAccounts: AccountWithBalance[] = useMemo(
    () => groupedAccounts.flatMap((group) => group.accounts),
    [groupedAccounts]
  );

  // When search term changes, highlight the first account that directly matched
  // (skip context-only parents that were added for hierarchy visibility)
  const prevSearchRef = useRef(searchTerm);
  useEffect(() => {
    if (prevSearchRef.current === searchTerm) return;

    prevSearchRef.current = searchTerm;
    const firstMatch = searchTerm
      ? flatAccounts.findIndex((a) => matchedIds.has(a.id))
      : 0;

    if (firstMatch >= 0 && firstMatch !== highlightedIndex) {
      setHighlightedIndex(firstMatch);
    }
  }, [flatAccounts, highlightedIndex, matchedIds, searchTerm]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node) &&
        inputRef.current &&
        !inputRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!isOpen && e.key !== "Escape") {
      setIsOpen(true);
      return;
    }

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setHighlightedIndex((prev) =>
          prev < flatAccounts.length - 1 ? prev + 1 : prev
        );
        break;
      case "ArrowUp":
        e.preventDefault();
        setHighlightedIndex((prev) => (prev > 0 ? prev - 1 : 0));
        break;
      case "Enter":
        if (e.metaKey || e.ctrlKey) {
          setIsOpen(false);
          setSearchTerm(null);
          return; // Let event propagate to form handler
        }
        e.preventDefault();
        if (flatAccounts[highlightedIndex]) {
          onChange(flatAccounts[highlightedIndex].id);
          setIsOpen(false);
          setSearchTerm(null);
        }
        break;
      case "Escape":
        e.preventDefault();
        setIsOpen(false);
        setSearchTerm(null);
        break;
    }
  };

  return (
    <div className={cn("relative", className)}>
      {label && (
        <label
          htmlFor={inputId}
          className={cn(
            "block",
            isCompact
              ? "text-xs font-medium text-fg-tertiary mb-0 leading-tight"
              : "text-sm font-medium text-fg-secondary mb-1"
          )}
        >
          {label}
        </label>
      )}
      <div className="relative">
        <input
          ref={inputRef}
          id={inputId}
          type="text"
          className={cn(
            "block w-full border border-border bg-surface-inset text-fg placeholder:text-fg-tertiary focus:border-border-focus focus:outline-none focus:ring-1 focus:ring-border-focus text-sm",
            isCompact ? "rounded-md px-2 py-1" : "rounded-md px-3 py-2",
            warning && "border-fg-warning ring-1 ring-fg-warning"
          )}
          placeholder={placeholder}
          autoCorrect="off"
          autoCapitalize="off"
          autoComplete="off"
          spellCheck={false}
          value={searchTerm ?? (selectedAccount ? buildAccountDisplay(selectedAccount, "input") : "")}
          onChange={(e) => {
            setSearchTerm(e.target.value);
            setIsOpen(true);
          }}
          onFocus={() => setIsOpen(true)}
          onBlur={() => {
            // Delay closing to allow click events on dropdown items to fire
            setTimeout(() => {
              setIsOpen(false);
              setSearchTerm(null);
            }, 200);
          }}
          onKeyDown={handleKeyDown}
          style={{ paddingRight: selectedAccount && allowClear && searchTerm === null ? "2rem" : undefined }}
        />
        {selectedAccount && allowClear && searchTerm === null && (
          <button
            type="button"
            className="absolute inset-y-0 right-0 flex items-center pr-2 text-fg-tertiary hover:text-fg-secondary"
            onClick={(e) => {
              e.stopPropagation();
              onChange(null);
              setSearchTerm(null);
            }}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

      {isOpen && (
        <div
          ref={dropdownRef}
          className={cn(
            "absolute z-50 w-full min-w-[16rem] bg-surface-elevated rounded-lg border border-border shadow-lg max-h-80 overflow-y-auto",
            dropUp ? "bottom-full mb-1" : "mt-1"
          )}
        >
          {groupedAccounts.length === 0 ? (
            <div className="px-3 py-2 text-sm text-fg-secondary">
              No accounts found
            </div>
          ) : (
            groupedAccounts.map((group) => (
              <div key={group.type}>
                <div className="px-3 py-1.5 text-xs font-semibold text-fg-secondary uppercase bg-surface-secondary sticky top-0">
                  {group.label}
                </div>
                {group.accounts.map((account) => {
                  const globalIdx = flatAccounts.indexOf(account);
                  const isHighlighted = globalIdx === highlightedIndex;
                  const isSelected = account.id === value;

                  return (
                    <button
                      key={account.id}
                      type="button"
                      className={cn(
                        "w-full text-left px-3 py-2 text-sm transition-colors",
                        isHighlighted && "bg-accent-subtle",
                        isSelected && "bg-accent-subtle font-medium",
                        !isHighlighted && !isSelected && "hover:bg-surface-tertiary",
                        account.parentId && "pl-6"
                      )}
                      onClick={() => {
                        onChange(account.id);
                        setIsOpen(false);
                        setSearchTerm(null);
                      }}
                      onMouseEnter={() => setHighlightedIndex(globalIdx)}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex-1">
                          {account.parentId && (
                            <span className="text-fg-tertiary mr-1">&darr;</span>
                          )}
                          <CategoryIcon icon={categoryLabels.get(account.id)?.icon ?? null} />
                          {buildAccountDisplay(account)}
                          {!account.isActive && (
                            <span className="text-xs text-fg-tertiary ml-1">(inactive)</span>
                          )}
                        </div>
                        {account.subtype && (
                          <span className="text-xs text-fg-tertiary ml-2">
                            {account.subtype}
                          </span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
