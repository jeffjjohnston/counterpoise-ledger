"use client";

import { cn } from "@/lib/utils";
import { TextareaHTMLAttributes, forwardRef } from "react";

interface TextareaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "size"> {
  label?: string;
  error?: string;
  size?: "default" | "compact";
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, label, error, id, size = "default", ...props }, ref) => {
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
        <textarea
          ref={ref}
          id={id}
          className={cn(
            "block w-full border border-border bg-surface-inset text-fg placeholder:text-fg-tertiary focus:border-border-focus focus:outline-none focus:ring-1 focus:ring-border-focus text-sm resize-y",
            isCompact ? "rounded-md px-2 py-1" : "rounded-md px-3 py-2",
            error && "border-border-danger focus:border-border-danger focus:ring-border-danger",
            className
          )}
          rows={2}
          {...props}
        />
        {error && <p className="mt-1 text-sm text-fg-danger">{error}</p>}
      </div>
    );
  }
);

Textarea.displayName = "Textarea";
