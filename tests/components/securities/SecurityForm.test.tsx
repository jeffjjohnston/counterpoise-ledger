import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SecurityForm } from "@/components/securities/SecurityForm";
import type { Security } from "@/db/schema";

describe("SecurityForm", () => {
  it("renders empty fields by default", () => {
    render(<SecurityForm onSubmit={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.getByLabelText("Security Name")).toHaveValue("");
    expect(screen.getByLabelText("Symbol")).toHaveValue("");
    expect(screen.getByLabelText("Security Type")).toHaveValue("stock");
  });

  it("prefills values when editing", () => {
    const security: Security = {
      id: 12,
      bookId: 1,
      name: "Vanguard Total Stock Market",
      symbol: "VTI",
      securityType: "etf",
      fetchPrices: true,
      fixedPriceMicros: null,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
    };

    render(
      <SecurityForm
        security={security}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    expect(screen.getByLabelText("Security Name")).toHaveValue(security.name);
    expect(screen.getByLabelText("Symbol")).toHaveValue(security.symbol);
    expect(screen.getByLabelText("Security Type")).toHaveValue("etf");
  });

  it("submits updated values", () => {
    const handleSubmit = vi.fn();
    render(<SecurityForm onSubmit={handleSubmit} onCancel={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Security Name"), {
      target: { value: "Apple Inc." },
    });
    fireEvent.change(screen.getByLabelText("Symbol"), {
      target: { value: "AAPL" },
    });
    fireEvent.change(screen.getByLabelText("Security Type"), {
      target: { value: "stock" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Add Security" }));

    expect(handleSubmit).toHaveBeenCalledWith({
      name: "Apple Inc.",
      symbol: "AAPL",
      securityType: "stock",
      fixedPriceMicros: null,
    });
  });

  it("submits the entered fixed price in micros", () => {
    const handleSubmit = vi.fn();
    render(<SecurityForm onSubmit={handleSubmit} onCancel={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Security Name"), {
      target: { value: "Vanguard Federal Money Market" },
    });
    fireEvent.change(screen.getByLabelText("Symbol"), {
      target: { value: "VMFXX" },
    });
    fireEvent.click(screen.getByLabelText("Fixed price"));
    fireEvent.change(screen.getByLabelText("Price"), {
      target: { value: "1.00" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Add Security" }));

    expect(handleSubmit).toHaveBeenCalledWith({
      name: "Vanguard Federal Money Market",
      symbol: "VMFXX",
      securityType: "stock",
      fixedPriceMicros: 1_000_000,
    });
  });

  it("hides the price field until the fixed-price toggle is on", () => {
    render(<SecurityForm onSubmit={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.queryByLabelText("Price")).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Fixed price"));

    expect(screen.getByLabelText("Price")).toBeInTheDocument();
  });

  it("prefills the fixed price when editing a fixed-price security", () => {
    const security: Security = {
      id: 13,
      bookId: 1,
      name: "Vanguard Federal Money Market",
      symbol: "VMFXX",
      securityType: "mutual_fund",
      fetchPrices: false,
      fixedPriceMicros: 1_000_000,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
    };

    render(<SecurityForm security={security} onSubmit={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.getByLabelText("Fixed price")).toBeChecked();
    expect(screen.getByLabelText("Price")).toHaveValue("1.00");
  });

  it("clears the fixed price when the toggle is switched off", () => {
    const handleSubmit = vi.fn();
    const security: Security = {
      id: 13,
      bookId: 1,
      name: "Vanguard Federal Money Market",
      symbol: "VMFXX",
      securityType: "mutual_fund",
      fetchPrices: false,
      fixedPriceMicros: 1_000_000,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
    };

    render(
      <SecurityForm security={security} onSubmit={handleSubmit} onCancel={vi.fn()} />
    );

    fireEvent.click(screen.getByLabelText("Fixed price"));
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    expect(handleSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ fixedPriceMicros: null })
    );
  });

  it("prefills a sub-cent fixed price without rounding it", () => {
    // Rounding here would send the rounded value back on the next save, so
    // editing only the name would silently change the security's valuation.
    const security: Security = {
      id: 14,
      bookId: 1,
      name: "Odd NAV Fund",
      symbol: "ODDNV",
      securityType: "mutual_fund",
      fetchPrices: false,
      fixedPriceMicros: 1_002_500,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
    };

    render(<SecurityForm security={security} onSubmit={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.getByLabelText("Price")).toHaveValue("1.0025");
  });

  it("blocks submission when the fixed-price box is checked but no price is entered", () => {
    // Submitting null here would say "not fixed" while the form still shows the
    // box ticked — on edit that silently unsets the security's fixed price.
    const handleSubmit = vi.fn();
    const security: Security = {
      id: 15,
      bookId: 1,
      name: "Vanguard Federal Money Market",
      symbol: "VMFXX",
      securityType: "mutual_fund",
      fetchPrices: false,
      fixedPriceMicros: 1_000_000,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
    };

    render(
      <SecurityForm security={security} onSubmit={handleSubmit} onCancel={vi.fn()} />
    );

    fireEvent.change(screen.getByLabelText("Price"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    expect(handleSubmit).not.toHaveBeenCalled();
    expect(screen.getByText("Enter a price above zero, or untick Fixed price.")).toBeInTheDocument();
  });
});
