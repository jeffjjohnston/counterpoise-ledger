"use client";

import { useState, useRef, useEffect, useId } from "react";
import { cn } from "@/lib/utils";

interface Security {
  id: number;
  name: string;
  symbol: string;
  securityType: string;
}

interface SecurityAutocompleteProps {
  securities: Security[];
  value: number | null;
  onChange: (securityId: number | null) => void;
  label?: string;
  placeholder?: string;
  className?: string;
  allowClear?: boolean;
  dropUp?: boolean;
  size?: "default" | "compact";
}

const securityTypeLabels: Record<string, string> = {
  etf: "ETF",
  mutual_fund: "Mutual Fund",
  stock: "Stock",
};

export function SecurityAutocomplete({
  securities,
  value,
  onChange,
  label,
  placeholder = "Search by name or symbol...",
  className,
  allowClear = true,
  dropUp = false,
  size = "default",
}: SecurityAutocompleteProps) {
  const isCompact = size === "compact";
  const [searchTerm, setSearchTerm] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [isEditing, setIsEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const reactId = useId();
  const inputId = `security-autocomplete-${reactId}`;

  const selectedSecurity = securities.find((s) => s.id === value);

  // Filter securities based on search term (match against name and symbol)
  const filteredSecurities = securities.filter((security) => {
    const searchLower = searchTerm.toLowerCase();
    const matchesName = security.name.toLowerCase().includes(searchLower);
    const matchesSymbol = security.symbol.toLowerCase().includes(searchLower);
    return matchesName || matchesSymbol;
  });

  // Build security display string
  const buildSecurityDisplay = (security: Security): string => {
    return `${security.name} (${security.symbol})`;
  };

  // Group securities by type for display
  interface SecurityGroup {
    type: string;
    label: string;
    securities: Security[];
  }

  const groupedSecurities: SecurityGroup[] = [];
  const typeMap = new Map<string, Security[]>();

  filteredSecurities.forEach((security) => {
    if (!typeMap.has(security.securityType)) {
      typeMap.set(security.securityType, []);
    }
    typeMap.get(security.securityType)!.push(security);
  });

  typeMap.forEach((securities, type) => {
    groupedSecurities.push({
      type,
      label: securityTypeLabels[type] || type,
      securities: securities.sort((a, b) => a.symbol.localeCompare(b.symbol)),
    });
  });

  // Flatten for keyboard navigation
  const flatSecurities: Security[] = [];
  groupedSecurities.forEach((group) => {
    flatSecurities.push(...group.securities);
  });

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
          prev < flatSecurities.length - 1 ? prev + 1 : prev
        );
        break;
      case "ArrowUp":
        e.preventDefault();
        setHighlightedIndex((prev) => (prev > 0 ? prev - 1 : 0));
        break;
      case "Enter":
        if (e.metaKey || e.ctrlKey) {
          setIsOpen(false);
          setIsEditing(false);
          setSearchTerm("");
          return; // Let event propagate to form handler
        }
        e.preventDefault();
        if (flatSecurities[highlightedIndex]) {
          onChange(flatSecurities[highlightedIndex].id);
          setIsOpen(false);
          setIsEditing(false);
          setSearchTerm("");
        }
        break;
      case "Escape":
        e.preventDefault();
        setIsOpen(false);
        setIsEditing(false);
        setSearchTerm("");
        break;
    }
  };

  return (
    <div className={cn("relative", className)}>
      {label && (
        <label htmlFor={inputId} className={cn(
          "block",
          isCompact
            ? "text-xs font-medium text-fg-tertiary mb-0 leading-tight"
            : "text-sm font-medium text-fg-secondary mb-1"
        )}>
          {label}
        </label>
      )}
      <div className="relative">
        <input
          ref={inputRef}
          id={inputId}
          type="text"
          className={cn(
            "block w-full rounded-md border border-border bg-surface-inset text-fg placeholder:text-fg-tertiary focus:border-border-focus focus:outline-none focus:ring-1 focus:ring-border-focus text-sm",
            isCompact ? "px-2 py-1" : "px-3 py-2"
          )}
          placeholder={placeholder}
          autoCorrect="off"
          autoCapitalize="off"
          autoComplete="off"
          spellCheck={false}
          value={isEditing ? searchTerm : (selectedSecurity ? buildSecurityDisplay(selectedSecurity) : "")}
          onChange={(e) => {
            setSearchTerm(e.target.value);
            setIsEditing(true);
            setIsOpen(true);
            setHighlightedIndex(0);
          }}
          onFocus={() => {
            setIsEditing(true);
            setSearchTerm("");
            setIsOpen(true);
          }}
          onBlur={() => {
            // Delay closing to allow click events on dropdown items to fire
            setTimeout(() => {
              setIsOpen(false);
              setIsEditing(false);
              setSearchTerm("");
            }, 200);
          }}
          onKeyDown={handleKeyDown}
          style={{ paddingRight: selectedSecurity && allowClear && !isEditing ? "2rem" : undefined }}
        />
        {selectedSecurity && allowClear && !isEditing && (
          <button
            type="button"
            className="absolute inset-y-0 right-0 flex items-center pr-2 text-fg-tertiary hover:text-fg-secondary"
            onClick={(e) => {
              e.stopPropagation();
              onChange(null);
              setSearchTerm("");
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
            "absolute z-50 w-full bg-surface-elevated rounded-lg border border-border shadow-lg max-h-80 overflow-y-auto",
            dropUp ? "bottom-full mb-1" : "mt-1"
          )}
        >
          {groupedSecurities.length === 0 ? (
            <div className="px-3 py-2 text-sm text-fg-secondary">
              No securities found
            </div>
          ) : (
            groupedSecurities.map((group) => (
              <div key={group.type}>
                <div className="px-3 py-1.5 text-xs font-semibold text-fg-secondary uppercase bg-surface-secondary sticky top-0">
                  {group.label}
                </div>
                {group.securities.map((security) => {
                  const globalIdx = flatSecurities.indexOf(security);
                  const isHighlighted = globalIdx === highlightedIndex;
                  const isSelected = security.id === value;

                  return (
                    <button
                      key={security.id}
                      type="button"
                      className={cn(
                        "w-full text-left px-3 py-2 text-sm transition-colors",
                        isHighlighted && "bg-accent-subtle",
                        isSelected && "bg-accent-subtle font-medium",
                        !isHighlighted && !isSelected && "hover:bg-surface-tertiary"
                      )}
                      onClick={() => {
                        onChange(security.id);
                        setIsOpen(false);
                        setIsEditing(false);
                        setSearchTerm("");
                      }}
                      onMouseEnter={() => setHighlightedIndex(globalIdx)}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex-1">
                          <span className="font-medium">{security.symbol}</span>
                          <span className="text-fg-secondary ml-2">{security.name}</span>
                        </div>
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
