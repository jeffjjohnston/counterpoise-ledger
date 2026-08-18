import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StockSplitEditForm } from "@/components/securities/StockSplitEditForm";
import { ToastProvider } from "@/components/ui/ToastProvider";

const renderWithToast = (ui: React.ReactElement) =>
  render(<ToastProvider>{ui}</ToastProvider>);

describe("StockSplitEditForm", () => {
  const split = {
    id: 1,
    transactionId: 10,
    transactionDate: "2025-01-15",
    transactionDescription: "2-for-1 split",
    splitNumerator: 2,
    splitDenominator: 1,
  };

  it("submits parsed split values", async () => {
    const handleSubmit = vi.fn().mockResolvedValue(undefined);
    renderWithToast(
      <StockSplitEditForm
        split={split}
        onSubmit={handleSubmit}
        onDelete={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    fireEvent.change(screen.getByLabelText("Numerator"), {
      target: { value: "3" },
    });
    fireEvent.change(screen.getByLabelText("Denominator"), {
      target: { value: "2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => {
      expect(handleSubmit).toHaveBeenCalledWith({
        date: "2025-01-15",
        description: "2-for-1 split",
        splitNumerator: 3,
        splitDenominator: 2,
      });
    });
  });

  it("alerts when the split ratio is invalid", async () => {
    renderWithToast(
      <StockSplitEditForm
        split={split}
        onSubmit={vi.fn()}
        onDelete={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    fireEvent.change(screen.getByLabelText("Numerator"), {
      target: { value: "0" },
    });
    fireEvent.submit(screen.getByRole("button", { name: "Save Changes" }).closest("form")!);

    expect(
      await screen.findByText("Split ratio must be positive numbers")
    ).toBeInTheDocument();
  });

  it("shows a second confirmation step before deleting", async () => {
    const handleDelete = vi.fn().mockResolvedValue(undefined);
    renderWithToast(
      <StockSplitEditForm
        split={split}
        onSubmit={vi.fn()}
        onDelete={handleDelete}
        onCancel={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(
      screen.getByText(/Are you sure you want to delete this stock split/i)
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Delete Stock Split" }));

    await waitFor(() => {
      expect(handleDelete).toHaveBeenCalled();
    });
  });
});
