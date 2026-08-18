"use client";

import { useState, useCallback } from "react";
import { formatCurrency, formatDate } from "@/lib/formatters";
import { Button } from "@/components/ui/Button";
import type { ReportGroupNode, ReportSplit } from "@/lib/reports";

interface ReportTableProps {
  groups: ReportGroupNode[];
  grandTotal: number;
  dimensions: string[];
}

export function ReportTable({ groups, grandTotal, dimensions }: ReportTableProps) {
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());

  const toggle = useCallback((key: string) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const expandAll = useCallback(() => {
    const keys = new Set<string>();
    function walk(nodes: ReportGroupNode[]) {
      for (const node of nodes) {
        keys.add(node.key);
        walk(node.children);
      }
    }
    walk(groups);
    setExpandedKeys(keys);
  }, [groups]);

  const collapseAll = useCallback(() => {
    setExpandedKeys(new Set());
  }, []);

  const isLeafLevel = (node: ReportGroupNode) => node.children.length === 0;

  const renderLeafSplits = (splits: ReportSplit[], depth: number) => {
    return splits.map((split) => (
      <tr key={split.splitId} className="text-sm text-fg-tertiary hover:bg-surface-tertiary">
        <td
          className="py-1.5 px-3"
          style={{ paddingLeft: 16 + depth * 24 }}
        >
          <span className="text-fg-tertiary">{formatDate(split.date)}</span>
          {split.payeeName && (
            <span className="ml-2 text-fg-secondary">{split.payeeName}</span>
          )}
        </td>
        <td className="py-1.5 px-3 text-fg-tertiary text-xs">{split.accountName}</td>
        <td className="py-1.5 px-3 text-right tabular-nums">
          {formatCurrency(Math.abs(split.amount))}
        </td>
      </tr>
    ));
  };

  const renderGroup = (node: ReportGroupNode): React.ReactNode => {
    const isExpanded = expandedKeys.has(node.key);
    const hasChildren = node.children.length > 0;
    const isLeaf = isLeafLevel(node);

    return (
      <tbody key={node.key}>
        <tr
          className="cursor-pointer hover:bg-surface-tertiary group"
          onClick={() => toggle(node.key)}
        >
          <td
            className="py-2 px-3 font-medium text-fg"
            style={{ paddingLeft: 8 + node.depth * 24 }}
          >
            <span className="inline-flex items-center gap-1.5">
              <svg
                className={`w-3.5 h-3.5 text-fg-tertiary transition-transform ${isExpanded ? "rotate-90" : ""}`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
              {node.label}
            </span>
          </td>
          <td className="py-2 px-3" />
          <td className="py-2 px-3 text-right font-medium tabular-nums text-fg">
            {formatCurrency(node.total)}
          </td>
        </tr>
        {isExpanded && hasChildren && node.children.map(renderGroup)}
        {isExpanded && isLeaf && (
          <>{renderLeafSplits(node.splits, node.depth + 1)}</>
        )}
      </tbody>
    );
  };

  if (groups.length === 0) {
    return (
      <div className="text-center py-12 text-fg-tertiary">
        No data found for the selected filters. Try adjusting your date range or account types.
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm text-fg-tertiary">
          {groups.length} group{groups.length !== 1 ? "s" : ""}
        </div>
        <div className="flex gap-1">
          <Button variant="ghost" size="sm" onClick={expandAll}>
            Expand All
          </Button>
          <Button variant="ghost" size="sm" onClick={collapseAll}>
            Collapse All
          </Button>
        </div>
      </div>
      <div className="border border-border rounded-lg overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="bg-surface-secondary border-b border-border text-left text-xs font-medium text-fg-tertiary uppercase tracking-wider">
              <th className="py-2.5 px-3">{dimensions[0] || "Group"}</th>
              <th className="py-2.5 px-3">Account</th>
              <th className="py-2.5 px-3 text-right">Amount</th>
            </tr>
          </thead>
          {groups.map(renderGroup)}
          <tfoot>
            <tr className="bg-surface-secondary border-t border-border font-semibold text-fg">
              <td className="py-2.5 px-3">Total</td>
              <td className="py-2.5 px-3" />
              <td className="py-2.5 px-3 text-right tabular-nums">
                {formatCurrency(grandTotal)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
