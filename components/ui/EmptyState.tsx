"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";
import type { HTMLAttributes } from "react";

interface EmptyStateProps extends HTMLAttributes<HTMLDivElement> {
  title: string;
  description?: string;
  action?: {
    label: string;
    onClick?: () => void;
    href?: string;
  };
}

export function EmptyState({
  title,
  description,
  action,
  className,
  ...props
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center py-16 px-6 text-center",
        className
      )}
      {...props}
    >
      <div className="w-12 h-12 rounded-full bg-surface-secondary flex items-center justify-center mb-4">
        <svg
          className="w-6 h-6 text-fg-tertiary"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
          />
        </svg>
      </div>
      <p className="text-fg font-medium">{title}</p>
      {description && (
        <p className="mt-1 text-sm text-fg-tertiary max-w-xs">{description}</p>
      )}
      {action &&
        (action.href ? (
          <Link
            href={action.href}
            className="mt-4 text-sm text-fg-accent hover:underline font-medium"
          >
            {action.label}
          </Link>
        ) : (
          <button
            type="button"
            onClick={action.onClick}
            className="mt-4 text-sm text-fg-accent hover:underline font-medium"
          >
            {action.label}
          </button>
        ))}
    </div>
  );
}
