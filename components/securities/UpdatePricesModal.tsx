"use client";

import { useState, useEffect } from "react";
import { useBookId } from "@/hooks/useBookId";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { formatCurrency, toDateString, formatDate, resolveAmountOnBlur } from "@/lib/formatters";
import { evaluateExpression } from "@/lib/expression";
import { apiPost, apiPut, toMessage } from "@/lib/api-client";
import { useToast } from "@/components/ui/ToastProvider";

const MICROS_PER_SHARE = 1_000_000;

type SecurityWithPrice = {
  id: number;
  name: string;
  symbol: string;
  sharesMicros: number;
  priceMicros: number | null;
  priceDate: string | null;
  fetchPrices: boolean;
  fixedPriceMicros: number | null;
};

type PriceUpdate = {
  securityId: number;
  newPrice: string;
  newDate: string;
};

type FetchState = Record<number, boolean>;

interface UpdatePricesModalProps {
  isOpen: boolean;
  onClose: () => void;
  securities: SecurityWithPrice[];
  onUpdate: () => void;
}

function getDefaultPriceDate(): string {
  // Derive the date from Eastern Time calendar parts so the default price
  // date reflects the US market calendar regardless of the user's timezone.
  const etParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const part = (type: string) =>
    parseInt(etParts.find((p) => p.type === type)!.value, 10);
  const etYear = part("year");
  const etMonth = part("month");
  const etDay = part("day");
  // Some runtimes report hour as 24 at midnight even with hour12: false.
  const etHour = part("hour") % 24;
  const etMinute = part("minute");

  // Use local date constructor — toDateString() uses local getters.
  const date = new Date(etYear, etMonth - 1, etDay);

  // Before market open (9:30 AM ET), use the previous day
  if (etHour < 9 || (etHour === 9 && etMinute < 30)) {
    date.setDate(date.getDate() - 1);
  }

  // Skip weekends: Saturday → Friday, Sunday → Friday
  const dayOfWeek = date.getDay();
  if (dayOfWeek === 6) {
    date.setDate(date.getDate() - 1);
  } else if (dayOfWeek === 0) {
    date.setDate(date.getDate() - 2);
  }

  return toDateString(date);
}

export function UpdatePricesModal({
  isOpen,
  onClose,
  securities,
  onUpdate,
}: UpdatePricesModalProps) {
  const bookId = useBookId();
  const toast = useToast();
  const [priceUpdates, setPriceUpdates] = useState<Record<number, PriceUpdate>>({});
  const [fetchState, setFetchState] = useState<FetchState>({});
  const [saving, setSaving] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [defaultDate, setDefaultDate] = useState("");

  // Initialize default date when modal opens
  useEffect(() => {
    if (isOpen) {
      const date = getDefaultPriceDate();
      setDefaultDate(date);

      // Initialize price updates with default date
      const initialUpdates: Record<number, PriceUpdate> = {};
      securities.forEach((security) => {
        initialUpdates[security.id] = {
          securityId: security.id,
          newPrice: "",
          newDate: date,
        };
      });
      setPriceUpdates(initialUpdates);
      setFetchState((prev) => {
        const next: FetchState = {};
        securities.forEach((security) => {
          next[security.id] = prev[security.id] ?? security.fetchPrices ?? true;
        });
        return next;
      });
    }
  }, [isOpen, securities]);

  const handlePriceChange = (securityId: number, price: string) => {
    setPriceUpdates((prev) => ({
      ...prev,
      [securityId]: {
        ...prev[securityId],
        newPrice: price,
      },
    }));
  };

  const handleDateChange = (securityId: number, date: string) => {
    setPriceUpdates((prev) => ({
      ...prev,
      [securityId]: {
        ...prev[securityId],
        newDate: date,
      },
    }));
  };

  const handleFetchToggle = async (securityId: number, currentValue: boolean) => {
    const nextValue = !currentValue;
    setFetchState((prev) => ({
      ...prev,
      [securityId]: nextValue,
    }));

    try {
      await apiPut(`/api/b/${bookId}/securities/${securityId}`, {
        fetchPrices: nextValue,
      });
    } catch (error) {
      console.error("Error updating fetch preference:", error);
      setFetchState((prev) => ({
        ...prev,
        [securityId]: !nextValue,
      }));
      toast.error(toMessage(error, "Failed to update fetch preference"));
    }
  };

  const handleRetrievePrices = async () => {
    setFetching(true);
    try {
      // Get symbols for securities that should be fetched
      // A fixed-price security has no feed behind it, whatever its fetchPrices
      // flag says — its price lives on the security row.
      const symbolsToFetch = securities
        .filter((s) => s.fixedPriceMicros === null)
        .filter((s) => (fetchState[s.id] ?? s.fetchPrices ?? true))
        .map((s) => s.symbol);

      if (symbolsToFetch.length === 0) {
        toast.error("Please select at least one security to fetch prices for");
        return;
      }

      const data = await apiPost<{
        prices: { symbol: string; price: number; date: string }[];
        errors: { symbol: string; error: string }[];
      }>(`/api/b/${bookId}/security-prices/tiingo`, { symbols: symbolsToFetch });

      // apiPost resolves with whatever the response carried, including null for
      // an ok response with an unparseable body. Anything this code cannot read
      // has to fail here, inside the try, where the catch below turns it into a
      // message — see the setPriceUpdates comment.
      if (!Array.isArray(data?.prices) || !Array.isArray(data?.errors)) {
        throw new Error("The price service returned an unexpected response");
      }
      const { prices, errors } = data;

      // Resolved before the state update, not inside it: React runs a setState
      // updater outside this try/catch, so a throw in there is an unhandled
      // error that unmounts the modal rather than a toast the user can act on.
      // The updater below only copies already-computed values.
      const fetched = prices.flatMap((priceData) => {
        const security = securities.find(
          (s) => s.symbol.toUpperCase() === priceData.symbol.toUpperCase()
        );
        if (!security || !(fetchState[security.id] ?? security.fetchPrices ?? true)) {
          return [];
        }
        return [
          {
            securityId: security.id,
            newPrice: priceData.price.toFixed(2),
            newDate: priceData.date,
          },
        ];
      });

      setPriceUpdates((prev) => {
        const updated = { ...prev };
        for (const { securityId, newPrice, newDate } of fetched) {
          updated[securityId] = { ...updated[securityId], newPrice, newDate };
        }
        return updated;
      });

      // Show errors if any
      if (errors.length > 0) {
        const errorMessage = errors
          .map((e: { symbol: string; error: string }) => `${e.symbol}: ${e.error}`)
          .join("\n");
        toast.error(`Some prices could not be fetched:\n\n${errorMessage}`);
      }
    } catch (error) {
      console.error("Error fetching prices:", error);
      toast.error(toMessage(error, "Failed to fetch prices"));
    } finally {
      setFetching(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      // Parse every non-empty price entry, collecting any that fail to parse.
      // Invalid entries must surface as an error rather than being silently
      // dropped — otherwise a typo like "1+" closes the modal as if it saved.
      const updates: { securityId: number; priceMicros: number; priceDate: string }[] = [];
      const invalid: string[] = [];

      for (const update of Object.values(priceUpdates)) {
        if (update.newPrice.trim() === "") continue;
        const priceFloat = evaluateExpression(update.newPrice);
        if (priceFloat === null || priceFloat <= 0) {
          const security = securities.find((s) => s.id === update.securityId);
          invalid.push(`${security?.symbol ?? `#${update.securityId}`}: "${update.newPrice}"`);
          continue;
        }
        updates.push({
          securityId: update.securityId,
          priceMicros: Math.round(priceFloat * MICROS_PER_SHARE),
          priceDate: update.newDate,
        });
      }

      if (invalid.length > 0) {
        toast.error(
          `These prices are not valid numbers and were not saved:\n\n${invalid.join("\n")}`
        );
        return;
      }

      if (updates.length === 0) {
        onClose();
        return;
      }

      await apiPost(`/api/b/${bookId}/security-prices/bulk`, { priceUpdates: updates });
      onUpdate();
      onClose();
    } catch (error) {
      console.error("Error updating prices:", error);
      toast.error(toMessage(error, "Failed to update prices"));
    } finally {
      setSaving(false);
    }
  };

  const formatPrice = (priceMicros: number | null) => {
    if (priceMicros === null) return "—";
    return formatCurrency(Math.round((priceMicros / MICROS_PER_SHARE) * 100));
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Update Security Prices" size="xl">
      <div className="space-y-4">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-border">
            <thead className="bg-surface-secondary">
              <tr>
                <th className="px-4 py-3 text-center text-xs font-semibold text-fg-tertiary uppercase tracking-wide">
                  Fetch
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-fg-tertiary uppercase tracking-wide">
                  Security
                </th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-fg-tertiary uppercase tracking-wide">
                  Current Price
                </th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-fg-tertiary uppercase tracking-wide">
                  Price Date
                </th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-fg-tertiary uppercase tracking-wide">
                  New Price
                </th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-fg-tertiary uppercase tracking-wide">
                  New Date
                </th>
              </tr>
            </thead>
            <tbody className="bg-surface divide-y divide-border">
              {securities.map((security) => (
                <tr key={security.id} className="hover:bg-surface-secondary">
                  <td className="px-4 py-3 text-center">
                    {security.fixedPriceMicros === null ? (
                      <input
                        type="checkbox"
                        checked={fetchState[security.id] ?? security.fetchPrices ?? true}
                        onChange={() =>
                          handleFetchToggle(
                            security.id,
                            fetchState[security.id] ?? security.fetchPrices ?? true
                          )
                        }
                        disabled={fetching}
                        className="h-4 w-4 text-fg-accent focus:ring-fg-accent border-border rounded"
                      />
                    ) : (
                      <span className="text-sm text-fg-tertiary">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-sm font-medium text-fg">
                      {security.name}
                    </div>
                    <div className="text-xs text-fg-tertiary">{security.symbol}</div>
                  </td>
                  <td className="px-4 py-3 text-right text-sm text-fg-secondary">
                    {formatPrice(security.priceMicros)}
                  </td>
                  <td className="px-4 py-3 text-right text-sm text-fg-secondary">
                    {security.priceDate ? formatDate(security.priceDate) : "—"}
                  </td>
                  {security.fixedPriceMicros !== null ? (
                    // The price is a property of the security, changed on the
                    // security itself — there is no new value to enter here.
                    <td
                      className="px-4 py-3 text-right text-sm text-fg-tertiary"
                      colSpan={2}
                    >
                      Fixed at {formatPrice(security.fixedPriceMicros)}
                    </td>
                  ) : (
                    <>
                      <td className="px-4 py-3">
                        <Input
                          type="text"
                          inputMode="decimal"
                          placeholder="0.00"
                          className="text-right"
                          value={priceUpdates[security.id]?.newPrice || ""}
                          onChange={(e) => handlePriceChange(security.id, e.target.value)}
                          onBlur={(e) =>
                            handlePriceChange(security.id, resolveAmountOnBlur(e.target.value))
                          }
                          disabled={fetching}
                          selectOnFocus
                        />
                      </td>
                      <td className="px-4 py-3">
                        <Input
                          type="date"
                          value={priceUpdates[security.id]?.newDate || defaultDate}
                          onChange={(e) => handleDateChange(security.id, e.target.value)}
                          disabled={fetching}
                        />
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex justify-between items-center gap-3 pt-4 border-t border-border">
          <Button
            variant="secondary"
            onClick={handleRetrievePrices}
            disabled={fetching || saving}
          >
            {fetching ? (
              <span className="flex items-center gap-2">
                <svg
                  className="animate-spin h-4 w-4"
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  />
                </svg>
                Retrieving...
              </span>
            ) : (
              "Retrieve Latest Prices"
            )}
          </Button>
          <div className="flex gap-3">
            <Button variant="secondary" onClick={onClose} disabled={saving || fetching}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={saving || fetching}>
              {saving ? "Saving..." : "Save"}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
