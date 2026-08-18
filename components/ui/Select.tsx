"use client";

import { cn } from "@/lib/utils";
import { SelectHTMLAttributes, forwardRef } from "react";

interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> {
  label?: string;
  error?: string;
  options: Array<{ value: string | number; label: string; disabled?: boolean }>;
  placeholder?: string;
  size?: "default" | "compact";
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, label, error, id, options, placeholder, size = "default", ...props }, ref) => {
    const isCompact = size === "compact";
    return (
      <div className="w-full">
        {label && (
          <label
            htmlFor={id}
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
        <select
          ref={ref}
          id={id}
          className={cn(
            "block w-full rounded-md border border-border text-fg bg-surface-inset focus:border-border-focus focus:outline-none focus:ring-1 focus:ring-border-focus text-sm",
            isCompact ? "px-2 py-0 h-[30px]" : "px-3 py-2",
            error && "border-border-danger focus:border-border-danger focus:ring-border-danger",
            className
          )}
          {...props}
        >
          {placeholder && (
            <option value="" disabled>
              {placeholder}
            </option>
          )}
          {options.map((option) => (
            <option
              key={`${option.value}-${option.label}`}
              value={option.value}
              disabled={option.disabled}
            >
              {option.label}
            </option>
          ))}
        </select>
        {error && <p className="mt-1 text-sm text-fg-danger">{error}</p>}
      </div>
    );
  }
);

Select.displayName = "Select";
