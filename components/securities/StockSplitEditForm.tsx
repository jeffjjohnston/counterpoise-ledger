"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/ToastProvider";

type StockSplitEditFormProps = {
  split: {
    id: number;
    transactionId: number;
    transactionDate: string;
    transactionDescription: string | null;
    splitNumerator: number | null;
    splitDenominator: number | null;
  };
  onSubmit: (data: {
    date: string;
    description: string;
    splitNumerator: number;
    splitDenominator: number;
  }) => Promise<void>;
  onDelete: () => Promise<void>;
  onCancel: () => void;
};

export function StockSplitEditForm({
  split,
  onSubmit,
  onDelete,
  onCancel,
}: StockSplitEditFormProps) {
  const toast = useToast();
  const [date, setDate] = useState(split.transactionDate);
  const [description, setDescription] = useState(split.transactionDescription || "");
  const [numerator, setNumerator] = useState(
    split.splitNumerator?.toString() || ""
  );
  const [denominator, setDenominator] = useState(
    split.splitDenominator?.toString() || ""
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const numeratorNum = parseInt(numerator);
    const denominatorNum = parseInt(denominator);

    if (!date) {
      toast.error("Date is required");
      return;
    }

    if (!numeratorNum || !denominatorNum || numeratorNum <= 0 || denominatorNum <= 0) {
      toast.error("Split ratio must be positive numbers");
      return;
    }

    setIsSubmitting(true);
    try {
      await onSubmit({
        date,
        description,
        splitNumerator: numeratorNum,
        splitDenominator: denominatorNum,
      });
    } catch (error) {
      console.error("Error updating stock split:", error);
      toast.error("Failed to update stock split");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async () => {
    setIsDeleting(true);
    try {
      await onDelete();
    } catch (error) {
      console.error("Error deleting stock split:", error);
      toast.error("Failed to delete stock split");
      setIsDeleting(false);
    }
  };

  if (showDeleteConfirm) {
    return (
      <div className="space-y-4">
        <p className="text-fg-secondary">
          Are you sure you want to delete this stock split? This action cannot be undone.
        </p>
        <div className="flex gap-2 justify-end">
          <Button
            type="button"
            variant="secondary"
            onClick={() => setShowDeleteConfirm(false)}
            disabled={isDeleting}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="danger"
            onClick={handleDelete}
            disabled={isDeleting}
          >
            {isDeleting ? "Deleting..." : "Delete Stock Split"}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label htmlFor="date" className="block text-sm font-medium text-fg-secondary mb-1">
          Date
        </label>
        <Input
          id="date"
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          required
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label htmlFor="numerator" className="block text-sm font-medium text-fg-secondary mb-1">
            Numerator
          </label>
          <Input
            id="numerator"
            type="number"
            min="1"
            step="1"
            value={numerator}
            onChange={(e) => setNumerator(e.target.value)}
            placeholder="2"
            required
          />
        </div>
        <div>
          <label htmlFor="denominator" className="block text-sm font-medium text-fg-secondary mb-1">
            Denominator
          </label>
          <Input
            id="denominator"
            type="number"
            min="1"
            step="1"
            value={denominator}
            onChange={(e) => setDenominator(e.target.value)}
            placeholder="1"
            required
          />
        </div>
      </div>

      <div>
        <label htmlFor="description" className="block text-sm font-medium text-fg-secondary mb-1">
          Description
        </label>
        <Input
          id="description"
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Stock split description"
        />
      </div>

      <div className="flex gap-2 justify-between pt-4 border-t border-border">
        <Button
          type="button"
          variant="danger"
          onClick={() => setShowDeleteConfirm(true)}
          disabled={isSubmitting}
        >
          Delete
        </Button>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="secondary"
            onClick={onCancel}
            disabled={isSubmitting}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Saving..." : "Save Changes"}
          </Button>
        </div>
      </div>
    </form>
  );
}
