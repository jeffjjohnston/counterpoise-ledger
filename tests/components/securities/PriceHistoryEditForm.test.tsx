import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PriceHistoryEditForm } from "@/components/securities/PriceHistoryEditForm";

describe("PriceHistoryEditForm", () => {
  const priceEntry = {
    priceDate: "2025-01-15",
    priceMicros: 12_340_000,
    source: "manual",
  };

  it("renders the existing price in dollar format", () => {
    render(
      <PriceHistoryEditForm
        priceEntry={priceEntry}
        onSubmit={vi.fn()}
        onDelete={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    expect(screen.getByLabelText("Price")).toHaveValue("12.34");
  });

  it("parses the price input back to micros on submit", async () => {
    const handleSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <PriceHistoryEditForm
        priceEntry={priceEntry}
        onSubmit={handleSubmit}
        onDelete={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    fireEvent.change(screen.getByLabelText("Price"), {
      target: { value: "$15.50" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(handleSubmit).toHaveBeenCalledWith({
        priceDate: "2025-01-15",
        priceMicros: 15_500_000,
        source: "manual",
      });
    });
  });

  it("shows a validation error for a non-positive price", async () => {
    render(
      <PriceHistoryEditForm
        priceEntry={priceEntry}
        onSubmit={vi.fn()}
        onDelete={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    fireEvent.change(screen.getByLabelText("Price"), {
      target: { value: "0" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(
        screen.getByText("Please enter a valid price greater than zero")
      ).toBeInTheDocument();
    });
  });
});
