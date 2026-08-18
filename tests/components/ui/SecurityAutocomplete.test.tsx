import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SecurityAutocomplete } from "@/components/ui/SecurityAutocomplete";

const securities = [
  { id: 1, name: "Vanguard Total Stock Market ETF", symbol: "VTI", securityType: "etf" },
  { id: 2, name: "Vanguard Total Intl Stock ETF", symbol: "VXUS", securityType: "etf" },
  { id: 3, name: "Vanguard Total Bond Fund", symbol: "BND", securityType: "mutual_fund" },
];

describe("SecurityAutocomplete", () => {
  it("renders with default placeholder", () => {
    render(
      <SecurityAutocomplete securities={securities} value={null} onChange={vi.fn()} />
    );
    expect(screen.getByPlaceholderText("Search by name or symbol...")).toBeInTheDocument();
  });

  it("shows selected security name and symbol", () => {
    render(
      <SecurityAutocomplete securities={securities} value={1} onChange={vi.fn()} />
    );
    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input.value).toContain("VTI");
    expect(input.value).toContain("Vanguard Total Stock Market ETF");
  });

  it("filters by name", () => {
    render(
      <SecurityAutocomplete securities={securities} value={null} onChange={vi.fn()} />
    );
    const input = screen.getByRole("textbox");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Bond" } });

    expect(screen.getByText("BND")).toBeInTheDocument();
    expect(screen.queryByText("VTI")).not.toBeInTheDocument();
  });

  it("filters by symbol", () => {
    render(
      <SecurityAutocomplete securities={securities} value={null} onChange={vi.fn()} />
    );
    const input = screen.getByRole("textbox");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "vxus" } });

    expect(screen.getByText("VXUS")).toBeInTheDocument();
    expect(screen.queryByText("VTI")).not.toBeInTheDocument();
  });

  it("calls onChange with security id on selection", () => {
    const onChange = vi.fn();
    render(
      <SecurityAutocomplete securities={securities} value={null} onChange={onChange} />
    );
    const input = screen.getByRole("textbox");
    fireEvent.focus(input);

    // The dropdown renders symbol as a span with font-medium inside a button
    // Filter to BND only to avoid ambiguity, then click its button
    fireEvent.change(input, { target: { value: "BND" } });
    const bndButton = screen.getByRole("button", { name: /BND/ });
    fireEvent.click(bndButton);

    expect(onChange).toHaveBeenCalledWith(3);
  });

  it("shows type group headers", () => {
    render(
      <SecurityAutocomplete securities={securities} value={null} onChange={vi.fn()} />
    );
    const input = screen.getByRole("textbox");
    fireEvent.focus(input);

    expect(screen.getByText("ETF")).toBeInTheDocument();
    expect(screen.getByText("Mutual Fund")).toBeInTheDocument();
  });

  it("shows 'No securities found' when search has no matches", () => {
    render(
      <SecurityAutocomplete securities={securities} value={null} onChange={vi.fn()} />
    );
    const input = screen.getByRole("textbox");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "ZZZZZ" } });

    expect(screen.getByText("No securities found")).toBeInTheDocument();
  });

  it("renders label when provided", () => {
    render(
      <SecurityAutocomplete
        securities={securities}
        value={null}
        onChange={vi.fn()}
        label="Security"
      />
    );
    expect(screen.getByText("Security")).toBeInTheDocument();
  });
});
