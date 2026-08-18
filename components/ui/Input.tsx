"use client";

import { cn, selectInputContents } from "@/lib/utils";
import { InputHTMLAttributes, forwardRef } from "react";

interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  label?: string;
  error?: string;
  size?: "default" | "compact";
  /** Select the full value on focus — for amount-style fields where the
   *  common gesture is replace-the-whole-value. */
  selectOnFocus?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, label, error, id, size = "default", selectOnFocus, onFocus, ...props }, ref) => {
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
        <input
          ref={ref}
          id={id}
          onFocus={(e) => {
            if (selectOnFocus) selectInputContents(e.currentTarget);
            onFocus?.(e);
          }}
          className={cn(
            "block w-full border border-border bg-surface-inset text-fg placeholder:text-fg-tertiary focus:border-border-focus focus:outline-none focus:ring-1 focus:ring-border-focus text-sm",
            isCompact ? "rounded-md px-2 py-1" : "rounded-md px-3 py-2",
            error && "border-border-danger focus:border-border-danger focus:ring-border-danger",
            className
          )}
          {...props}
        />
        {error && <p className="mt-1 text-sm text-fg-danger">{error}</p>}
      </div>
    );
  }
);

Input.displayName = "Input";
