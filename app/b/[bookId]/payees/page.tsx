"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Input } from "@/components/ui/Input";
import { formatDate } from "@/lib/formatters";
import { useBookId } from "@/hooks/useBookId";
import { apiGet } from "@/lib/api-client";

type PayeeSummary = {
  id: number;
  name: string;
  lastTransactionDate: string | null;
  transactionCount: number;
};

type SortColumn = "name" | "lastTransactionDate" | "transactionCount";
type SortDirection = "asc" | "desc";

const compareNames = (a: string, b: string) =>
  a.localeCompare(b, undefined, { sensitivity: "base" });

export default function PayeesPage() {
  const bookId = useBookId();
  const [payees, setPayees] = useState<PayeeSummary[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [sortColumn, setSortColumn] = useState<SortColumn>("name");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchPayees = async () => {
      try {
        const data = await apiGet<PayeeSummary[]>(`/api/b/${bookId}/payees`);
        setPayees(Array.isArray(data) ? data : []);
        setError(null);
      } catch {
        setError("Could not load payees.");
      } finally {
        setLoading(false);
      }
    };

    void fetchPayees();
  }, [bookId]);

  const normalizedSearchTerm = searchTerm.trim().toLowerCase();
  const filteredPayees = payees
    .filter((payee) => payee.name.toLowerCase().includes(normalizedSearchTerm))
    .sort((a, b) => {
      if (sortColumn === "name") {
        const comparison = compareNames(a.name, b.name);
        return sortDirection === "asc" ? comparison : -comparison;
      }

      if (sortColumn === "transactionCount") {
        const comparison = a.transactionCount - b.transactionCount;
        if (comparison !== 0) {
          return sortDirection === "asc" ? comparison : -comparison;
        }
        return compareNames(a.name, b.name);
      }

      if (!a.lastTransactionDate && !b.lastTransactionDate) {
        return compareNames(a.name, b.name);
      }
      if (!a.lastTransactionDate) return 1;
      if (!b.lastTransactionDate) return -1;

      const comparison =
        sortDirection === "asc"
          ? a.lastTransactionDate.localeCompare(b.lastTransactionDate)
          : b.lastTransactionDate.localeCompare(a.lastTransactionDate);

      if (comparison !== 0) {
        return comparison;
      }
      return compareNames(a.name, b.name);
    });

  const handleSort = (column: SortColumn) => {
    if (sortColumn === column) {
      setSortDirection((currentDirection) =>
        currentDirection === "asc" ? "desc" : "asc"
      );
      return;
    }

    setSortColumn(column);
    setSortDirection("asc");
  };

  const getAriaSort = (column: SortColumn) => {
    if (sortColumn !== column) return "none";
    return sortDirection === "asc" ? "ascending" : "descending";
  };

  const getSortIndicator = (column: SortColumn) => {
    if (sortColumn !== column) return "↕";
    return sortDirection === "asc" ? "↑" : "↓";
  };

  if (error) {
    return (
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <p className="text-danger">{error}</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="animate-pulse space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-16 bg-surface-tertiary rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-fg">Payees</h1>
      </div>

      <div className="mb-4">
        <Input
          id="payee-search"
          label="Search payees"
          type="text"
          value={searchTerm}
          onChange={(event) => setSearchTerm(event.target.value)}
          placeholder="Filter by name..."
          autoCorrect="off"
          autoCapitalize="off"
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      {payees.length === 0 ? (
        <div className="bg-surface rounded-lg border border-border p-6 text-fg-tertiary">
          No payees yet.
        </div>
      ) : filteredPayees.length === 0 ? (
        <div className="bg-surface rounded-lg border border-border p-6 text-fg-tertiary">
          No payees match your search.
        </div>
      ) : (
        <div className="bg-surface rounded-lg border border-border overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="text-left text-xs font-medium text-fg-tertiary uppercase tracking-wider bg-surface-secondary">
                <th className="px-4 py-3" aria-sort={getAriaSort("name")}>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 hover:text-fg-secondary"
                    onClick={() => handleSort("name")}
                  >
                    Payee
                    <span aria-hidden>{getSortIndicator("name")}</span>
                  </button>
                </th>
                <th
                  className="px-4 py-3"
                  aria-sort={getAriaSort("lastTransactionDate")}
                >
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 hover:text-fg-secondary"
                    onClick={() => handleSort("lastTransactionDate")}
                  >
                    Last transaction
                    <span aria-hidden>
                      {getSortIndicator("lastTransactionDate")}
                    </span>
                  </button>
                </th>
                <th
                  className="px-4 py-3 text-right"
                  aria-sort={getAriaSort("transactionCount")}
                >
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 hover:text-fg-secondary"
                    onClick={() => handleSort("transactionCount")}
                  >
                    Transactions
                    <span aria-hidden>{getSortIndicator("transactionCount")}</span>
                  </button>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-secondary">
              {filteredPayees.map((payee) => (
                <tr key={payee.id} className="hover:bg-surface-tertiary">
                  <td className="px-4 py-3 text-sm text-fg">
                    <Link
                      href={`/b/${bookId}/payees/${payee.id}`}
                      className="text-fg-accent hover:text-fg-accent font-medium"
                    >
                      {payee.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-sm text-right text-fg-secondary">
                    {payee.lastTransactionDate
                      ? formatDate(payee.lastTransactionDate)
                      : "—"}
                  </td>
                  <td className="px-4 py-3 text-sm text-right text-fg-secondary">
                    {payee.transactionCount}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
