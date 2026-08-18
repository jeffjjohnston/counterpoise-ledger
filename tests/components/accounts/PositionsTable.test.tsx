import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PositionsTable } from "@/components/accounts/PositionsTable";

describe("PositionsTable", () => {
  it("renders investment, cash, and total account value lines", () => {
    render(
      <PositionsTable
        positions={[
          {
            securityId: 1,
            securityName: "Vanguard Total Stock Market",
            securitySymbol: "VTI",
            sharesMicros: 1_000_000,
            costBasisCents: 10000,
            priceMicros: 12_000_000,
            priceDate: "2024-01-01",
            marketValueCents: 12000,
          },
        ]}
        cashBalanceCents={5000}
      />
    );

    expect(screen.getByText("Investment total")).toBeInTheDocument();
    expect(screen.getAllByText("$120.00")).toHaveLength(2);
    expect(screen.getByText("Cash balance")).toBeInTheDocument();
    expect(screen.getByText("$50.00")).toBeInTheDocument();
    expect(screen.getByText("Total account value")).toBeInTheDocument();
    expect(screen.getByText("$170.00")).toBeInTheDocument();
  });

  it("renders empty state inside the table when totals are shown", () => {
    render(<PositionsTable positions={[]} cashBalanceCents={2500} />);

    expect(screen.getByText("No positions yet.")).toBeInTheDocument();
    expect(screen.getByText("Cash balance")).toBeInTheDocument();
    expect(screen.getAllByText("$25.00")).toHaveLength(2);
  });

  const samplePosition = {
    securityId: 7,
    securityName: "Vanguard Total Stock Market",
    securitySymbol: "VTI",
    sharesMicros: 1_000_000,
    costBasisCents: 10000,
    priceMicros: 12_000_000,
    priceDate: "2024-01-01",
    marketValueCents: 12000,
  };

  it("links the security name to the security detail page when bookId is provided", () => {
    render(<PositionsTable positions={[samplePosition]} bookId="3" />);

    const link = screen.getByRole("link", { name: "Vanguard Total Stock Market" });
    expect(link).toHaveAttribute("href", "/b/3/securities/7");
  });

  it("renders the security name as plain text when bookId is absent", () => {
    render(<PositionsTable positions={[samplePosition]} />);

    expect(
      screen.queryByRole("link", { name: "Vanguard Total Stock Market" })
    ).not.toBeInTheDocument();
    expect(screen.getByText("Vanguard Total Stock Market")).toBeInTheDocument();
  });
});
