"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { evaluateExpression } from "@/lib/expression";
import { formatPriceMicrosInput } from "@/lib/formatters";
import type { Security } from "@/db/schema";

interface SecurityFormProps {
  security?: Security;
  onSubmit: (data: {
    name: string;
    symbol: string;
    securityType: Security["securityType"];
    fixedPriceMicros: number | null;
  }) => void;
  onCancel: () => void;
}

const MICROS_PER_SHARE = 1_000_000;

const securityTypeOptions = [
  { value: "stock", label: "Stock" },
  { value: "etf", label: "ETF" },
  { value: "mutual_fund", label: "Mutual Fund" },
];

export function SecurityForm({ security, onSubmit, onCancel }: SecurityFormProps) {
  const [name, setName] = useState(security?.name ?? "");
  const [symbol, setSymbol] = useState(security?.symbol ?? "");
  const [securityType, setSecurityType] = useState<Security["securityType"]>(
    security?.securityType ?? "stock"
  );
  const [hasFixedPrice, setHasFixedPrice] = useState(
    security?.fixedPriceMicros != null
  );
  const [fixedPrice, setFixedPrice] = useState(
    security?.fixedPriceMicros != null
      ? formatPriceMicrosInput(security.fixedPriceMicros)
      : ""
  );

  const [fixedPriceError, setFixedPriceError] = useState<string | null>(null);

  const parsedFixedPrice = evaluateExpression(fixedPrice);
  const fixedPriceMicros =
    hasFixedPrice && parsedFixedPrice !== null && parsedFixedPrice > 0
      ? Math.round(parsedFixedPrice * MICROS_PER_SHARE)
      : null;

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();

    // A ticked box with no usable price must not submit as "not fixed": on an
    // edit that silently unsets the security's fixed price while the form still
    // shows the box ticked. Unticking the box is the way to clear it.
    if (hasFixedPrice && fixedPriceMicros === null) {
      setFixedPriceError("Enter a price above zero, or untick Fixed price.");
      return;
    }

    setFixedPriceError(null);
    onSubmit({ name, symbol, securityType, fixedPriceMicros });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <Input
        id="security-name"
        label="Security Name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="e.g., Vanguard Total Stock Market"
        required
      />
      <Input
        id="security-symbol"
        label="Symbol"
        value={symbol}
        onChange={(event) => setSymbol(event.target.value)}
        placeholder="e.g., VTI"
        required
      />
      <Select
        id="security-type"
        label="Security Type"
        value={securityType}
        onChange={(event) =>
          setSecurityType(event.target.value as Security["securityType"])
        }
        options={securityTypeOptions}
      />

      <div className="space-y-2">
        <label className="flex items-center gap-2 text-sm text-fg">
          <input
            type="checkbox"
            checked={hasFixedPrice}
            onChange={(event) => {
              setHasFixedPrice(event.target.checked);
              setFixedPriceError(null);
            }}
            className="h-4 w-4 text-fg-accent focus:ring-fg-accent border-border rounded"
          />
          <span>Fixed price</span>
        </label>
        {hasFixedPrice && (
          <div className="pl-6 space-y-1">
            <Input
              id="security-fixed-price"
              label="Price"
              type="text"
              inputMode="decimal"
              value={fixedPrice}
              onChange={(event) => {
                setFixedPrice(event.target.value);
                setFixedPriceError(null);
              }}
              placeholder="e.g., 1.00"
              error={fixedPriceError ?? undefined}
            />
            <p className="text-xs text-fg-tertiary">
              This price is used for every valuation. The security is never
              fetched and never appears in the prices due list.
            </p>
          </div>
        )}
      </div>

      <div className="flex justify-end gap-3 pt-4">
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit">
          {security ? "Save Changes" : "Add Security"}
        </Button>
      </div>
    </form>
  );
}
