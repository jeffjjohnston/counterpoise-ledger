"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { evaluateExpression } from "@/lib/expression";
import { resolveAmountOnBlur } from "@/lib/formatters";
import { toMessage } from "@/lib/api-client";

type PriceHistoryEditFormProps = {
  priceEntry: {
    priceDate: string;
    priceMicros: number;
    source: string | null;
  };
  onSubmit: (data: {
    priceDate: string;
    priceMicros: number;
    source: string | null;
  }) => Promise<void>;
  onDelete: () => Promise<void>;
  onCancel: () => void;
};

const MICROS_PER_DOLLAR = 1_000_000;

const formatPriceForInput = (priceMicros: number) => {
  return (priceMicros / MICROS_PER_DOLLAR).toFixed(2);
};

const parsePriceInput = (input: string): number | null => {
  const evaluated = evaluateExpression(input);
  if (evaluated === null || !Number.isFinite(evaluated) || evaluated <= 0) {
    return null;
  }
  return Math.round(evaluated * MICROS_PER_DOLLAR);
};

export function PriceHistoryEditForm({
  priceEntry,
  onSubmit,
  onDelete,
  onCancel,
}: PriceHistoryEditFormProps) {
  const [priceDate, setPriceDate] = useState(priceEntry.priceDate);
  const [priceInput, setPriceInput] = useState(formatPriceForInput(priceEntry.priceMicros));
  const [source, setSource] = useState(priceEntry.source ?? "");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!priceDate) {
      setError("Date is required");
      return;
    }

    const priceMicros = parsePriceInput(priceInput);
    if (priceMicros === null) {
      setError("Please enter a valid price greater than zero");
      return;
    }

    setIsSubmitting(true);
    try {
      await onSubmit({
        priceDate,
        priceMicros,
        source: source.trim() || null,
      });
    } catch (err) {
      setError(toMessage(err, "Failed to update price"));
      setIsSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm("Are you sure you want to delete this price entry?")) {
      return;
    }

    setIsDeleting(true);
    try {
      await onDelete();
    } catch (err) {
      setError(toMessage(err, "Failed to delete price"));
      setIsDeleting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && (
        <div className="bg-danger-subtle border border-border text-fg-danger px-4 py-3 rounded">
          {error}
        </div>
      )}

      <div>
        <label htmlFor="priceDate" className="block text-sm font-medium text-fg-secondary mb-1">
          Date
        </label>
        <Input
          id="priceDate"
          type="date"
          value={priceDate}
          onChange={(e) => setPriceDate(e.target.value)}
          required
        />
      </div>

      <div>
        <label htmlFor="price" className="block text-sm font-medium text-fg-secondary mb-1">
          Price
        </label>
        <Input
          id="price"
          type="text"
          value={priceInput}
          onChange={(e) => setPriceInput(e.target.value)}
          onBlur={() => setPriceInput(resolveAmountOnBlur(priceInput))}
          placeholder="0.00"
          required
          selectOnFocus
        />
      </div>

      <div>
        <label htmlFor="source" className="block text-sm font-medium text-fg-secondary mb-1">
          Source
        </label>
        <Input
          id="source"
          type="text"
          value={source}
          onChange={(e) => setSource(e.target.value)}
          placeholder="e.g., Yahoo Finance, manual entry"
        />
      </div>

      <div className="flex gap-2 pt-4 border-t">
        <Button type="submit" disabled={isSubmitting || isDeleting}>
          {isSubmitting ? "Saving..." : "Save"}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel} disabled={isSubmitting || isDeleting}>
          Cancel
        </Button>
        <div className="flex-1" />
        <Button
          type="button"
          variant="danger"
          onClick={handleDelete}
          disabled={isSubmitting || isDeleting}
        >
          {isDeleting ? "Deleting..." : "Delete"}
        </Button>
      </div>
    </form>
  );
}
