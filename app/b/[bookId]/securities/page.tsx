"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { SecurityForm } from "@/components/securities/SecurityForm";
import { UpdatePricesModal } from "@/components/securities/UpdatePricesModal";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/formatters";
import { csvEscape, datedCsvFilename, triggerDownload } from "@/lib/csv";
import { useBookId } from "@/hooks/useBookId";
import { apiGet, apiPost, apiPut, apiDelete, toMessage } from "@/lib/api-client";
import { useToast } from "@/components/ui/ToastProvider";
import type { Security } from "@/db/schema";

const securityTypeLabels: Record<Security["securityType"], string> = {
  stock: "Stock",
  etf: "ETF",
  mutual_fund: "Mutual Fund",
};

type SecurityWithPosition = Security & {
  sharesMicros: number;
  costBasisCents: number;
  priceMicros: number | null;
  priceDate: string | null;
  marketValueCents: number | null;
  incomeCents: number;
};

const MICROS_PER_SHARE = 1_000_000;

export default function SecuritiesPage() {
  const bookId = useBookId();
  const toast = useToast();
  const [securities, setSecurities] = useState<SecurityWithPosition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [editingSecurity, setEditingSecurity] = useState<SecurityWithPosition | null>(null);
  const [showUpdatePricesModal, setShowUpdatePricesModal] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");

  const fetchSecurities = useCallback(async (showLoading: boolean) => {
    try {
      const data = await apiGet<SecurityWithPosition[]>(`/api/b/${bookId}/securities`);
      setSecurities(Array.isArray(data) ? data : []);
      setError(null);
    } catch {
      if (showLoading) {
        // Nothing has rendered yet — the full-page error state is correct.
        setError("Could not load securities.");
      } else {
        // A background refresh (after a create/update/delete or a price
        // update) failed. The already-rendered securities list is still
        // correct, so keep it on screen rather than blanking the page —
        // surface it the way this page already does for a failed write.
        toast.error("Could not refresh securities.");
      }
    } finally {
      if (showLoading) {
        setLoading(false);
      }
    }
  }, [bookId, toast]);

  const activeSecurities = securities.filter((s) => s.sharesMicros > 0);
  const inactiveSecurities = securities.filter((s) => s.sharesMicros === 0);

  const normalizedSearchTerm = searchTerm.trim().toLowerCase();
  const matchesSearch = (security: SecurityWithPosition) =>
    security.name.toLowerCase().includes(normalizedSearchTerm) ||
    security.symbol.toLowerCase().includes(normalizedSearchTerm);

  const filteredActiveSecurities = activeSecurities.filter(matchesSearch);
  const filteredInactiveSecurities = inactiveSecurities.filter(matchesSearch);

  const formatShares = (sharesMicros: number) => {
    const shares = sharesMicros / MICROS_PER_SHARE;
    return shares.toLocaleString("en-US", {
      minimumFractionDigits: 0,
      maximumFractionDigits: 6,
    });
  };

  const formatPrice = (priceMicros: number | null) => {
    if (priceMicros === null) return "—";
    return formatCurrency(Math.round((priceMicros / MICROS_PER_SHARE) * 100));
  };

  useEffect(() => {
    void fetchSecurities(true);
  }, [fetchSecurities]);

  const handleCreate = async (data: {
    name: string;
    symbol: string;
    securityType: Security["securityType"];
    fixedPriceMicros: number | null;
  }) => {
    try {
      await apiPost(`/api/b/${bookId}/securities`, data);
      setShowModal(false);
      void fetchSecurities(false);
    } catch (e) {
      // This site had no failure branch before this migration — a failed
      // create was silently swallowed (the modal just stayed open with no
      // explanation). This toast is what tells the user why nothing happened.
      toast.error(toMessage(e, "Failed to create security"));
    }
  };

  const handleUpdate = async (data: {
    name: string;
    symbol: string;
    securityType: Security["securityType"];
    fixedPriceMicros: number | null;
  }) => {
    if (!editingSecurity) return;

    try {
      await apiPut(`/api/b/${bookId}/securities/${editingSecurity.id}`, data);
      setEditingSecurity(null);
      void fetchSecurities(false);
    } catch (e) {
      // Same missing-failure-branch bug as handleCreate above.
      toast.error(toMessage(e, "Failed to update security"));
    }
  };

  const handleDownloadCsv = () => {
    const headers = [
      "Name",
      "Symbol",
      "Type",
      "Shares",
      "Cost Basis",
      "Current Price",
      "Price Date",
      "Income",
      "Market Value",
    ];
    const rows = activeSecurities.map((s) => [
      csvEscape(s.name),
      csvEscape(s.symbol),
      csvEscape(securityTypeLabels[s.securityType]),
      csvEscape((s.sharesMicros / MICROS_PER_SHARE).toFixed(6)),
      csvEscape((s.costBasisCents / 100).toFixed(2)),
      csvEscape(
        s.priceMicros === null
          ? null
          : (s.priceMicros / MICROS_PER_SHARE).toFixed(6)
      ),
      csvEscape(s.priceDate),
      csvEscape((s.incomeCents / 100).toFixed(2)),
      csvEscape(
        s.marketValueCents === null ? null : (s.marketValueCents / 100).toFixed(2)
      ),
    ]);
    const csv = [headers.map(csvEscape).join(","), ...rows.map((r) => r.join(","))].join("\n");
    triggerDownload(datedCsvFilename("active-securities"), csv);
  };

  const handleDelete = async (id: number) => {
    if (!confirm("Are you sure you want to delete this security?")) return;

    try {
      await apiDelete(`/api/b/${bookId}/securities/${id}`);
      void fetchSecurities(false);
    } catch (e) {
      toast.error(toMessage(e, "Failed to delete security"));
    }
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
          {[1, 2, 3].map((row) => (
            <div key={row} className="h-16 bg-surface-tertiary rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  // Calculate totals for the active securities currently shown
  const activeTotals = filteredActiveSecurities.reduce(
    (acc, s) => ({
      costBasisCents: acc.costBasisCents + s.costBasisCents,
      incomeCents: acc.incomeCents + s.incomeCents,
      marketValueCents: acc.marketValueCents + (s.marketValueCents ?? 0),
    }),
    { costBasisCents: 0, incomeCents: 0, marketValueCents: 0 }
  );

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-fg">Securities</h1>
        <div className="flex gap-3">
          {activeSecurities.length > 0 && (
            <>
              <Button variant="secondary" onClick={handleDownloadCsv}>
                Download CSV
              </Button>
              <Button variant="secondary" onClick={() => setShowUpdatePricesModal(true)}>
                Update Prices
              </Button>
            </>
          )}
          <Button onClick={() => setShowModal(true)}>Add Security</Button>
        </div>
      </div>

      {securities.length > 0 && (
        <div className="mb-4 max-w-md">
          <Input
            id="security-search"
            label="Search securities"
            type="text"
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            placeholder="Filter by name or symbol..."
            autoCorrect="off"
            autoCapitalize="off"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
      )}

      {/* Active Securities */}
      {filteredActiveSecurities.length > 0 && (
        <div className="mb-8">
          <h2 className="text-lg font-semibold text-fg mb-3">
            Active Securities
          </h2>
          <div className="bg-surface rounded-lg border border-border shadow-soft overflow-hidden">
            <div className="grid grid-cols-12 gap-4 px-6 py-3 border-b border-border text-xs font-semibold text-fg-tertiary uppercase tracking-wide">
              <div className="col-span-2">Name</div>
              <div className="col-span-2 text-right">Shares</div>
              <div className="col-span-2 text-right">Cost Basis</div>
              <div className="col-span-2 text-right">Current Price</div>
              <div className="col-span-2 text-right">Income</div>
              <div className="col-span-2 text-right">Market Value</div>
            </div>
            <div className="divide-y divide-border-secondary">
              {filteredActiveSecurities.map((security) => (
                <div
                  key={security.id}
                  data-testid="security-row"
                  className={cn(
                    "grid grid-cols-12 gap-4 px-6 py-4 items-center text-sm hover:bg-surface-tertiary"
                  )}
                >
                  <div className="col-span-2">
                    <Link href={`/b/${bookId}/securities/${security.id}`} className="group">
                      <p className="font-medium text-fg group-hover:text-fg-accent">
                        {security.name}
                      </p>
                      <p className="text-xs text-fg-tertiary mt-0.5 group-hover:text-fg-accent">
                        {security.symbol}
                      </p>
                    </Link>
                  </div>
                  <div className="col-span-2 text-right text-fg-secondary tabular-nums">
                    {formatShares(security.sharesMicros)}
                  </div>
                  <div className="col-span-2 text-right text-fg-secondary tabular-nums">
                    {formatCurrency(security.costBasisCents)}
                  </div>
                  <div className="col-span-2 text-right text-fg-secondary tabular-nums">
                    {formatPrice(security.priceMicros)}
                    {security.fixedPriceMicros !== null && (
                      // Without this the row reads as a price nobody has
                      // updated since January, rather than one that never moves.
                      <span className="ml-1.5 text-xs text-fg-tertiary">fixed</span>
                    )}
                  </div>
                  <div className="col-span-2 text-right text-fg-secondary tabular-nums">
                    {formatCurrency(security.incomeCents)}
                  </div>
                  <div className="col-span-2 text-right font-medium text-fg tabular-nums">
                    {security.marketValueCents !== null
                      ? formatCurrency(security.marketValueCents)
                      : "—"}
                  </div>
                </div>
              ))}
              {/* Totals Row */}
              <div className="grid grid-cols-12 gap-4 px-6 py-4 items-center text-sm bg-surface-secondary font-semibold">
                <div className="col-span-4 text-fg">Total</div>
                <div className="col-span-2 text-right text-fg tabular-nums">
                  {formatCurrency(activeTotals.costBasisCents)}
                </div>
                <div className="col-span-2"></div>
                <div className="col-span-2 text-right text-fg tabular-nums">
                  {formatCurrency(activeTotals.incomeCents)}
                </div>
                <div className="col-span-2 text-right text-fg tabular-nums">
                  {formatCurrency(activeTotals.marketValueCents)}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Inactive Securities */}
      {filteredInactiveSecurities.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold text-fg mb-3">
            Inactive Securities
          </h2>
          <div className="bg-surface rounded-lg border border-border shadow-soft overflow-hidden">
            <div className="grid grid-cols-12 gap-4 px-6 py-3 border-b border-border text-xs font-semibold text-fg-tertiary uppercase tracking-wide">
              <div className="col-span-5">Name</div>
              <div className="col-span-3">Symbol</div>
              <div className="col-span-2">Type</div>
              <div className="col-span-2 text-right">Actions</div>
            </div>
            <div className="divide-y divide-border-secondary">
              {filteredInactiveSecurities.map((security) => (
                <div
                  key={security.id}
                  data-testid="security-row"
                  className={cn(
                    "grid grid-cols-12 gap-4 px-6 py-4 items-center text-sm"
                  )}
                >
                  <div className="col-span-5">
                    <Link
                      href={`/b/${bookId}/securities/${security.id}`}
                      className="font-medium text-fg hover:text-fg-accent"
                    >
                      {security.name}
                    </Link>
                  </div>
                  <div className="col-span-3 text-fg-secondary">
                    {security.symbol}
                  </div>
                  <div className="col-span-2 text-fg-secondary">
                    {securityTypeLabels[security.securityType]}
                  </div>
                  <div className="col-span-2 flex items-center justify-end gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setEditingSecurity(security)}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDelete(security.id)}
                      className="text-fg-danger hover:text-fg-danger"
                    >
                      Delete
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* No Search Matches */}
      {securities.length > 0 &&
        filteredActiveSecurities.length === 0 &&
        filteredInactiveSecurities.length === 0 && (
          <div className="bg-surface rounded-lg border border-border p-6 text-fg-tertiary">
            No securities match your search.
          </div>
        )}

      {/* Empty State */}
      {securities.length === 0 && !loading && (
        <div className="bg-surface rounded-lg border border-border shadow-soft overflow-hidden">
          <div className="px-6 py-12 text-center text-sm text-fg-tertiary">
            No securities yet.{" "}
            <button
              onClick={() => setShowModal(true)}
              className="text-fg-accent hover:underline"
            >
              Add your first security
            </button>
            .
          </div>
        </div>
      )}

      <Modal
        isOpen={showModal}
        onClose={() => setShowModal(false)}
        title="Add Security"
      >
        <SecurityForm
          onSubmit={handleCreate}
          onCancel={() => setShowModal(false)}
        />
      </Modal>

      <Modal
        isOpen={!!editingSecurity}
        onClose={() => setEditingSecurity(null)}
        title="Edit Security"
      >
        {editingSecurity && (
          <SecurityForm
            security={editingSecurity}
            onSubmit={handleUpdate}
            onCancel={() => setEditingSecurity(null)}
          />
        )}
      </Modal>

      <UpdatePricesModal
        isOpen={showUpdatePricesModal}
        onClose={() => setShowUpdatePricesModal(false)}
        securities={activeSecurities}
        onUpdate={() => void fetchSecurities(false)}
      />
    </div>
  );
}
