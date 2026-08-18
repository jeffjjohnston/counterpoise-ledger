import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DateRangeFilter } from "@/components/ui/DateRangeFilter";

describe("DateRangeFilter", () => {
  it("renders date inputs", () => {
    const onStartDateChange = vi.fn();
    const onEndDateChange = vi.fn();
    const onClear = vi.fn();

    render(
      <DateRangeFilter
        startDate=""
        endDate=""
        onStartDateChange={onStartDateChange}
        onEndDateChange={onEndDateChange}
        onClear={onClear}
      />
    );

    const dateInputs = screen.getAllByPlaceholderText(/date/i);
    expect(dateInputs).toHaveLength(2);
  });

  it("calls onStartDateChange when start date changes", () => {
    const onStartDateChange = vi.fn();
    const onEndDateChange = vi.fn();
    const onClear = vi.fn();

    render(
      <DateRangeFilter
        startDate=""
        endDate=""
        onStartDateChange={onStartDateChange}
        onEndDateChange={onEndDateChange}
        onClear={onClear}
      />
    );

    const startInput = screen.getByPlaceholderText("Start date");
    fireEvent.change(startInput, { target: { value: "2024-01-01" } });

    expect(onStartDateChange).toHaveBeenCalledWith("2024-01-01");
  });

  it("calls onEndDateChange when end date changes", () => {
    const onStartDateChange = vi.fn();
    const onEndDateChange = vi.fn();
    const onClear = vi.fn();

    render(
      <DateRangeFilter
        startDate=""
        endDate=""
        onStartDateChange={onStartDateChange}
        onEndDateChange={onEndDateChange}
        onClear={onClear}
      />
    );

    const endInput = screen.getByPlaceholderText("End date");
    fireEvent.change(endInput, { target: { value: "2024-12-31" } });

    expect(onEndDateChange).toHaveBeenCalledWith("2024-12-31");
  });

  it("shows clear button when dates are set", () => {
    const onStartDateChange = vi.fn();
    const onEndDateChange = vi.fn();
    const onClear = vi.fn();

    render(
      <DateRangeFilter
        startDate="2024-01-01"
        endDate=""
        onStartDateChange={onStartDateChange}
        onEndDateChange={onEndDateChange}
        onClear={onClear}
      />
    );

    const clearButton = screen.getByText("Clear");
    expect(clearButton).toBeInTheDocument();
  });

  it("calls onClear when clear button is clicked", () => {
    const onStartDateChange = vi.fn();
    const onEndDateChange = vi.fn();
    const onClear = vi.fn();

    render(
      <DateRangeFilter
        startDate="2024-01-01"
        endDate="2024-12-31"
        onStartDateChange={onStartDateChange}
        onEndDateChange={onEndDateChange}
        onClear={onClear}
      />
    );

    const clearButton = screen.getByText("Clear");
    fireEvent.click(clearButton);

    expect(onClear).toHaveBeenCalled();
  });

  it("hides clear button when no dates are set", () => {
    const onStartDateChange = vi.fn();
    const onEndDateChange = vi.fn();
    const onClear = vi.fn();

    render(
      <DateRangeFilter
        startDate=""
        endDate=""
        onStartDateChange={onStartDateChange}
        onEndDateChange={onEndDateChange}
        onClear={onClear}
      />
    );

    const clearButton = screen.queryByText("Clear");
    expect(clearButton).not.toBeInTheDocument();
  });
});
