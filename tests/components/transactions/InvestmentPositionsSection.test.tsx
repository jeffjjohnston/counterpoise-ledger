import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { InvestmentPositionsSection } from "@/components/transactions/InvestmentPositionsSection";

const samplePositions = [
  {
    securityId: 1,
    securityName: "Acme Corp",
    securitySymbol: "ACME",
    sharesMicros: 2_000_000,
    costBasisCents: 12345,
    priceMicros: 2_500_000,
    priceDate: "2024-01-01",
    marketValueCents: 50000,
  },
];

describe("InvestmentPositionsSection", () => {
  it("renders nothing when not visible", () => {
    const { container } = render(
      <InvestmentPositionsSection
        isVisible={false}
        isLoading={false}
        positions={samplePositions}
      />
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("shows a loading skeleton when visible and loading", () => {
    render(
      <InvestmentPositionsSection
        isVisible
        isLoading
        positions={[]}
      />
    );

    expect(
      screen.getByTestId("investment-positions-loading")
    ).toBeInTheDocument();
  });

  it("renders the positions table when visible and not loading", () => {
    render(
      <InvestmentPositionsSection
        isVisible
        isLoading={false}
        positions={samplePositions}
      />
    );

    expect(screen.getByText("Positions")).toBeInTheDocument();
    expect(screen.getByText("Acme Corp")).toBeInTheDocument();
  });
});
