import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { SecurityLotsTable, type OpenLot } from "@/components/securities/SecurityLotsTable";

const M = 1_000_000;

const baseLot: OpenLot = {
  lotId: 1,
  accountId: 1,
  accountName: "Brokerage",
  acquiredDate: "2020-01-01",
  sharesMicros: 10 * M,
  basisCents: 10_000,
};

describe("SecurityLotsTable", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("term boundary", () => {
    // Pinned with local-time Date constructor args (not a UTC ISO string) so
    // toDateString(new Date()) — which reads local getters — resolves to the
    // same calendar date regardless of the machine/CI runner's timezone.
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(2027, 7, 12, 12, 0, 0)); // August 12, 2027, local noon
    });

    it("renders Short for a lot acquired exactly one year ago", () => {
      render(
        <SecurityLotsTable
          lots={[{ ...baseLot, acquiredDate: "2026-08-12" }]}
          latestPriceMicros={null}
        />
      );

      expect(screen.getByText("Short")).toBeInTheDocument();
      expect(screen.queryByText("Long")).not.toBeInTheDocument();
    });

    it("renders Long for a lot acquired one year and one day ago", () => {
      render(
        <SecurityLotsTable
          lots={[{ ...baseLot, acquiredDate: "2026-08-11" }]}
          latestPriceMicros={null}
        />
      );

      expect(screen.getByText("Long")).toBeInTheDocument();
      expect(screen.queryByText("Short")).not.toBeInTheDocument();
    });
  });

  it("guards Basis/Share against division by zero", () => {
    render(
      <SecurityLotsTable
        lots={[{ ...baseLot, sharesMicros: 0, basisCents: 10_000 }]}
        latestPriceMicros={null}
      />
    );

    // Cost Basis still renders the real amount; Basis/Share must fall back to
    // an em dash rather than Infinity/NaN from a divide-by-zero.
    expect(screen.getByText("$100.00")).toBeInTheDocument();
    const dashes = screen.getAllByText("—");
    expect(dashes.length).toBeGreaterThan(0);
  });

  it("renders an em dash for Value and Unrealized when no price is known", () => {
    render(<SecurityLotsTable lots={[baseLot]} latestPriceMicros={null} />);

    // Value and Unrealized columns; neither should render $0.00 or NaN.
    const dashes = screen.getAllByText("—");
    expect(dashes.length).toBe(2);
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
    expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();
  });

  it("renders an empty state when there are no open lots", () => {
    render(<SecurityLotsTable lots={[]} latestPriceMicros={null} />);

    expect(screen.getByText("No open lots.")).toBeInTheDocument();
  });
});
