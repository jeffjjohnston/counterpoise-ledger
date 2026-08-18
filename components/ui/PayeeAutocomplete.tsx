"use client";

import { useState, useRef, useEffect, useId, forwardRef } from "react";
import { cn } from "@/lib/utils";

interface PayeeAutocompleteBaseProps {
  payees: Array<{ id: number; name: string }>;
  placeholder?: string;
  className?: string;
  dropUp?: boolean;
  size?: "default" | "compact";
  label?: string;
  allowClear?: boolean;
}

interface PayeeAutocompleteIdProps extends PayeeAutocompleteBaseProps {
  /** ID-based selection mode (for filters) */
  value: number | null;
  onChange: (payeeId: number | null) => void;
  textValue?: undefined;
  onTextChange?: undefined;
}

interface PayeeAutocompleteTextProps extends PayeeAutocompleteBaseProps {
  /** Text-based input mode (for forms — allows free text) */
  textValue: string;
  onTextChange: (value: string) => void;
  value?: undefined;
  onChange?: undefined;
}

type PayeeAutocompleteProps = PayeeAutocompleteIdProps | PayeeAutocompleteTextProps;

export const PayeeAutocomplete = forwardRef<HTMLInputElement, PayeeAutocompleteProps>(
  function PayeeAutocomplete(props, forwardedRef) {
    const {
      payees,
      placeholder = "Search for a payee...",
      className,
      dropUp = false,
      size = "default",
      label,
      allowClear = true,
    } = props;

    const isTextMode = props.textValue !== undefined;
    const isCompact = size === "compact";

    const [searchTerm, setSearchTerm] = useState("");
    const [isOpen, setIsOpen] = useState(false);
    const [highlightedIndex, setHighlightedIndex] = useState(0);
    const internalInputRef = useRef<HTMLInputElement>(null);
    const dropdownRef = useRef<HTMLDivElement>(null);
    const blurTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const reactId = useId();
    const inputId = `payee-autocomplete-${reactId}`;

    // Merge forwarded ref with internal ref
    const setInputRef = (el: HTMLInputElement | null) => {
      (internalInputRef as React.MutableRefObject<HTMLInputElement | null>).current = el;
      if (typeof forwardedRef === "function") {
        forwardedRef(el);
      } else if (forwardedRef) {
        (forwardedRef as React.MutableRefObject<HTMLInputElement | null>).current = el;
      }
    };

    // --- ID mode helpers ---
    const selectedPayee = !isTextMode ? payees.find((p) => p.id === props.value) : null;

    // --- Filtering ---
    const filterTerm = isTextMode ? props.textValue : searchTerm;
    const filteredPayees = payees.filter((payee) =>
      payee.name.toLowerCase().includes(filterTerm.toLowerCase())
    );

    // --- Input display value ---
    const inputValue = isTextMode
      ? props.textValue
      : searchTerm || (selectedPayee ? selectedPayee.name : "");

    const showClear = isTextMode
      ? allowClear && !!props.textValue
      : allowClear && !!selectedPayee && !searchTerm;

    useEffect(() => {
      return () => {
        if (blurTimeoutRef.current) clearTimeout(blurTimeoutRef.current);
      };
    }, []);

    useEffect(() => {
      const handleClickOutside = (event: MouseEvent) => {
        if (
          dropdownRef.current &&
          !dropdownRef.current.contains(event.target as Node) &&
          internalInputRef.current &&
          !internalInputRef.current.contains(event.target as Node)
        ) {
          setIsOpen(false);
          if (!isTextMode) setSearchTerm("");
        }
      };

      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }, [isTextMode]);

    const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value;
      if (isTextMode) {
        props.onTextChange(val);
      } else {
        setSearchTerm(val);
      }
      setIsOpen(true);
      setHighlightedIndex(0);
    };

    const handleSelect = (payee: { id: number; name: string }) => {
      if (isTextMode) {
        props.onTextChange(payee.name);
      } else {
        props.onChange(payee.id);
        setSearchTerm("");
      }
      setIsOpen(false);
    };

    const handleClear = () => {
      if (isTextMode) {
        props.onTextChange("");
      } else {
        props.onChange(null);
        setSearchTerm("");
      }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
      if (!isOpen && e.key !== "Escape") {
        setIsOpen(true);
        return;
      }

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setHighlightedIndex((prev) =>
            prev < filteredPayees.length - 1 ? prev + 1 : prev
          );
          break;
        case "ArrowUp":
          e.preventDefault();
          setHighlightedIndex((prev) => (prev > 0 ? prev - 1 : 0));
          break;
        case "Enter":
          if (e.metaKey || e.ctrlKey) {
            setIsOpen(false);
            if (!isTextMode) setSearchTerm("");
            return; // Let event propagate to form handler
          }
          e.preventDefault();
          if (filteredPayees[highlightedIndex]) {
            handleSelect(filteredPayees[highlightedIndex]);
          }
          break;
        case "Escape":
          e.preventDefault();
          setIsOpen(false);
          if (!isTextMode) setSearchTerm("");
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
            ref={setInputRef}
            id={inputId}
            type="text"
            className={cn(
              "block w-full border border-border bg-surface-inset text-fg placeholder:text-fg-tertiary focus:border-border-focus focus:outline-none focus:ring-1 focus:ring-border-focus text-sm",
              isCompact ? "rounded-md px-2 py-1" : "rounded-md px-3 py-2"
            )}
            placeholder={placeholder}
            autoCorrect="off"
            autoCapitalize="off"
            autoComplete="off"
            spellCheck={false}
            value={inputValue}
            onChange={handleInputChange}
            onFocus={() => {
              if (blurTimeoutRef.current) {
                clearTimeout(blurTimeoutRef.current);
                blurTimeoutRef.current = null;
              }
              setIsOpen(true);
            }}
            onBlur={() => {
              // Delay closing to allow click events on dropdown items to fire
              blurTimeoutRef.current = setTimeout(() => {
                blurTimeoutRef.current = null;
                setIsOpen(false);
                if (!isTextMode) setSearchTerm("");
              }, 200);
            }}
            onKeyDown={handleKeyDown}
            style={{ paddingRight: showClear ? "2rem" : undefined }}
          />
          {showClear && (
            <button
              type="button"
              className="absolute inset-y-0 right-0 flex items-center pr-2 text-fg-tertiary hover:text-fg-secondary"
              onClick={(e) => {
                e.stopPropagation();
                handleClear();
              }}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        {isOpen && filteredPayees.length > 0 && (
          <div
            ref={dropdownRef}
            className={cn(
              "absolute z-50 w-full min-w-[16rem] bg-surface-elevated rounded-lg border border-border shadow-lg max-h-80 overflow-y-auto",
              dropUp ? "bottom-full mb-1" : "mt-1"
            )}
          >
            {filteredPayees.map((payee, index) => {
              const isHighlighted = index === highlightedIndex;
              const isSelected = !isTextMode && payee.id === props.value;

              return (
                <button
                  key={payee.id}
                  type="button"
                  className={cn(
                    "w-full text-left px-3 py-2 text-sm transition-colors",
                    isHighlighted && "bg-accent-subtle",
                    isSelected && "bg-accent-subtle font-medium",
                    !isHighlighted && !isSelected && "hover:bg-surface-tertiary"
                  )}
                  onClick={() => handleSelect(payee)}
                  onMouseEnter={() => setHighlightedIndex(index)}
                >
                  {payee.name}
                </button>
              );
            })}
          </div>
        )}
      </div>
    );
  }
);
