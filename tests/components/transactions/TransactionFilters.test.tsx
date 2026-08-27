import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TransactionFilters } from "@/components/transactions/TransactionFilters";

const payees = [
  { id: 1, name: "Shell" },
  { id: 2, name: "Trader Joe's" },
];

const baseProps = {
  startDate: "",
  endDate: "",
  onStartDateChange: vi.fn(),
  onEndDateChange: vi.fn(),
  onClearDates: vi.fn(),
  dateFilterLabel: null,
  payees,
  selectedPayeeId: null,
  onPayeeChange: vi.fn(),
  showUpcoming: false,
  onShowUpcomingChange: vi.fn(),
};

describe("TransactionFilters", () => {
  it("shows only a Filters button when nothing is filtered", () => {
    render(<TransactionFilters {...baseProps} />);

    expect(screen.getByRole("button", { name: /Filters/ })).toBeInTheDocument();
    // No chips: an unfiltered register says nothing rather than parking empty
    // date inputs across the header.
    expect(screen.queryByRole("button", { name: /^Clear/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("names each active filter in a chip", () => {
    render(
      <TransactionFilters
        {...baseProps}
        dateFilterLabel="Dec 1, 2025 – Dec 31, 2025"
        selectedPayeeId={1}
        showUpcoming
      />
    );

    expect(screen.getByText("Dec 1, 2025 – Dec 31, 2025")).toBeInTheDocument();
    expect(screen.getByText("Shell")).toBeInTheDocument();
    expect(screen.getByText("Recurring")).toBeInTheDocument();
  });

  it("clears a filter from its own chip", () => {
    const onClearDates = vi.fn();
    const onPayeeChange = vi.fn();
    const onShowUpcomingChange = vi.fn();
    render(
      <TransactionFilters
        {...baseProps}
        dateFilterLabel="Dec 1, 2025 – Dec 31, 2025"
        selectedPayeeId={1}
        showUpcoming
        onClearDates={onClearDates}
        onPayeeChange={onPayeeChange}
        onShowUpcomingChange={onShowUpcomingChange}
      />
    );

    fireEvent.click(screen.getByLabelText("Clear Dec 1, 2025 – Dec 31, 2025 filter"));
    expect(onClearDates).toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText("Clear Shell filter"));
    expect(onPayeeChange).toHaveBeenCalledWith(null);

    fireEvent.click(screen.getByLabelText("Clear Recurring filter"));
    expect(onShowUpcomingChange).toHaveBeenCalledWith(false);
  });

  it("opens the controls in a popover and closes on Escape", () => {
    render(<TransactionFilters {...baseProps} />);

    fireEvent.click(screen.getByRole("button", { name: /Filters/ }));
    const dialog = screen.getByRole("dialog", { name: "Transaction filters" });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByLabelText("From")).toBeInTheDocument();
    expect(screen.getByLabelText("To")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("closes the popover on an outside click", () => {
    render(
      <div>
        <TransactionFilters {...baseProps} />
        <button type="button">elsewhere</button>
      </div>
    );

    fireEvent.click(screen.getByRole("button", { name: /Filters/ }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByRole("button", { name: "elsewhere" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("reports date edits from the popover", () => {
    const onStartDateChange = vi.fn();
    render(<TransactionFilters {...baseProps} onStartDateChange={onStartDateChange} />);

    fireEvent.click(screen.getByRole("button", { name: /Filters/ }));
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2025-12-01" } });
    expect(onStartDateChange).toHaveBeenCalledWith("2025-12-01");
  });
});
