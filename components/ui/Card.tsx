"use client";

import { cn } from "@/lib/utils";
import { HTMLAttributes } from "react";

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
}

export function Card({ className, children, ...props }: CardProps) {
  return (
    <div
      className={cn(
        "bg-surface rounded-lg border border-border shadow-soft",
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}

interface CardHeaderProps extends HTMLAttributes<HTMLDivElement> {
  /** Optional right-aligned slot (e.g. a "View All" link or action button). */
  action?: React.ReactNode;
}

/**
 * Canonical card header: a hairline divider, no fill, responsive padding, and an
 * optional right-aligned action slot. Every card surface should consume this rather
 * than hand-rolling its own header. (Finding #7.)
 */
export function CardHeader({
  className,
  children,
  action,
  ...props
}: CardHeaderProps) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 px-4 md:px-6 py-3 md:py-4 border-b border-border-secondary",
        className
      )}
      {...props}
    >
      {action !== undefined ? (
        <>
          <div className="min-w-0">{children}</div>
          {action}
        </>
      ) : (
        children
      )}
    </div>
  );
}

export function CardTitle({
  className,
  children,
  ...props
}: HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3
      className={cn("text-lg font-semibold text-fg", className)}
      {...props}
    >
      {children}
    </h3>
  );
}

export function CardContent({
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("p-6", className)} {...props}>
      {children}
    </div>
  );
}
