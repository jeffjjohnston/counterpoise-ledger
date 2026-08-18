"use client";

import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";

interface DateRangeFilterProps {
  startDate: string;
  endDate: string;
  onStartDateChange: (date: string) => void;
  onEndDateChange: (date: string) => void;
  onClear: () => void;
}

export function DateRangeFilter({
  startDate,
  endDate,
  onStartDateChange,
  onEndDateChange,
  onClear,
}: DateRangeFilterProps) {
  const hasFilter = startDate || endDate;

  return (
    <div className="flex items-center gap-2">
      <Input
        type="date"
        value={startDate}
        onChange={(e) => onStartDateChange(e.target.value)}
        placeholder="Start date"
        className="w-40"
      />
      <span className="text-fg-tertiary">to</span>
      <Input
        type="date"
        value={endDate}
        onChange={(e) => onEndDateChange(e.target.value)}
        placeholder="End date"
        className="w-40"
      />
      {hasFilter && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onClear}
        >
          Clear
        </Button>
      )}
    </div>
  );
}
