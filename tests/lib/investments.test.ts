import { describe, it, expect } from "vitest";
import {
  aggregatePositions,
  aggregateMarketValuesByAccount,
  calculateValueCents,
} from "@/lib/investments";
import { getInvestmentGrossAmountCents } from "@/lib/accounting";

describe("calculateValueCents", () => {
  // 25 shares at $0.0014 is exactly 3.5 cents. Computing it as
  // (25000000/1e6) * (1400/1e6) * 100 lands just under 3.5 — 0.0014 has no
  // exact binary representation — so Math.round takes it down to 3.
  it("rounds a half-cent tie up rather than down", () => {
    expect(calculateValueCents(25_000_000, 1400)).toBe(4);
  });

  // Both functions answer the same question (shares x price, in cents), so a
  // disagreement is a bug in whichever one differs, wherever it appears.
  it("agrees with getInvestmentGrossAmountCents on half-cent ties", () => {
    const ties: Array<[number, number]> = [
      [25_000_000, 1400],
      [50_000_000, 700],
      [100_000_000, 350],
      [125_000_000, 280],
      [200_000_000, 175],
    ];
    for (const [sharesMicros, priceMicros] of ties) {
      expect(calculateValueCents(sharesMicros, priceMicros)).toBe(
        getInvestmentGrossAmountCents(sharesMicros, priceMicros)
      );
    }
  });

  it("stays exact when shares x price exceeds 2^53", () => {
    // 426,354.381896 shares at $3,225.163023 — the product is ~1.4e21, far
    // past the largest integer a double represents exactly.
    expect(calculateValueCents(426_354_381_896, 3_225_163_023)).toBe(137_506_238_718);
  });
});

describe("aggregatePositions", () => {
  it("aggregates shares, cost basis, and latest prices by security", () => {
    const positions = aggregatePositions({
      splits: [
        {
          securityId: 1,
          sharesMicros: 1_000_000,
          priceMicros: 12_000_000,
          feesCents: 0,
          action: "sell",
          transactionDate: "2024-03-01",
        },
        {
          securityId: 1,
          sharesMicros: 2_000_000,
          priceMicros: 10_000_000,
          feesCents: 100,
          action: "buy",
          transactionDate: "2024-01-05",
        },
        {
          securityId: 1,
          sharesMicros: 0,
          priceMicros: 0,
          feesCents: 0,
          action: "split",
          splitNumerator: 2,
          splitDenominator: 1,
          transactionDate: "2024-02-01",
        },
        {
          securityId: 2,
          sharesMicros: 3_000_000,
          priceMicros: 5_000_000,
          feesCents: 0,
          action: "buy",
          transactionDate: "2024-01-10",
        },
      ],
      securities: [
        { id: 1, name: "Acme Corp", symbol: "ACME" },
        { id: 2, name: "Beta Fund", symbol: "BETA" },
      ],
      prices: [
        { securityId: 1, priceMicros: 11_000_000, priceDate: "2024-01-10" },
        { securityId: 1, priceMicros: 12_000_000, priceDate: "2024-02-10" },
      ],
    });

    expect(positions).toEqual([
      {
        securityId: 1,
        securityName: "Acme Corp",
        securitySymbol: "ACME",
        sharesMicros: 3_000_000,
        costBasisCents: 1575,
        priceMicros: 12_000_000,
        priceDate: "2024-02-10",
        marketValueCents: 3600,
      },
      {
        securityId: 2,
        securityName: "Beta Fund",
        securitySymbol: "BETA",
        sharesMicros: 3_000_000,
        costBasisCents: 1500,
        priceMicros: null,
        priceDate: null,
        marketValueCents: null,
      },
    ]);
  });

  it("reduces cost basis by average cost on sales", () => {
    const positions = aggregatePositions({
      splits: [
        {
          securityId: 1,
          sharesMicros: 2_000_000,
          priceMicros: 10_000_000,
          feesCents: 0,
          action: "buy",
          transactionDate: "2024-01-05",
        },
        {
          securityId: 1,
          sharesMicros: 1_000_000,
          priceMicros: 20_000_000,
          feesCents: 0,
          action: "sell",
          transactionDate: "2024-02-05",
        },
      ],
      securities: [{ id: 1, name: "Acme Corp", symbol: "ACME" }],
      prices: [],
    });

    expect(positions).toEqual([
      {
        securityId: 1,
        securityName: "Acme Corp",
        securitySymbol: "ACME",
        sharesMicros: 1_000_000,
        costBasisCents: 1000,
        priceMicros: null,
        priceDate: null,
        marketValueCents: null,
      },
    ]);
  });

  it("handles reverse stock splits without changing cost basis", () => {
    const positions = aggregatePositions({
      splits: [
        {
          securityId: 1,
          sharesMicros: 4_000_000,
          priceMicros: 10_000_000,
          feesCents: 0,
          action: "buy",
          transactionDate: "2024-01-02",
        },
        {
          securityId: 1,
          sharesMicros: 0,
          priceMicros: 0,
          feesCents: 0,
          action: "split",
          splitNumerator: 1,
          splitDenominator: 2,
          transactionDate: "2024-02-02",
        },
      ],
      securities: [{ id: 1, name: "Acme Corp", symbol: "ACME" }],
      prices: [],
    });

    expect(positions).toEqual([
      {
        securityId: 1,
        securityName: "Acme Corp",
        securitySymbol: "ACME",
        sharesMicros: 2_000_000,
        costBasisCents: 4000,
        priceMicros: null,
        priceDate: null,
        marketValueCents: null,
      },
    ]);
  });
});

describe("aggregateMarketValuesByAccount", () => {
  it("returns market values grouped by accountId", () => {
    const result = aggregateMarketValuesByAccount({
      splits: [
        {
          accountId: 10,
          securityId: 1,
          sharesMicros: 5_000_000,
          priceMicros: 10_000_000,
          feesCents: 0,
          action: "buy",
          transactionDate: "2024-01-05",
        },
        {
          accountId: 20,
          securityId: 2,
          sharesMicros: 3_000_000,
          priceMicros: 8_000_000,
          feesCents: 0,
          action: "buy",
          transactionDate: "2024-01-10",
        },
      ],
      prices: [
        { securityId: 1, priceMicros: 12_000_000, priceDate: "2024-02-01" },
        { securityId: 2, priceMicros: 9_000_000, priceDate: "2024-02-01" },
      ],
    });

    // Account 10: 5 shares × $12 = $60 = 6000 cents
    // Account 20: 3 shares × $9 = $27 = 2700 cents
    expect(result).toEqual([
      { accountId: 10, marketValueCents: 6000 },
      { accountId: 20, marketValueCents: 2700 },
    ]);
  });

  it("applies global stock splits (null accountId) to all accounts", () => {
    const result = aggregateMarketValuesByAccount({
      splits: [
        {
          accountId: 10,
          securityId: 1,
          sharesMicros: 2_000_000,
          priceMicros: 10_000_000,
          feesCents: 0,
          action: "buy",
          transactionDate: "2024-01-05",
        },
        {
          accountId: null,
          securityId: 1,
          sharesMicros: 0,
          priceMicros: 0,
          feesCents: 0,
          action: "split",
          splitNumerator: 2,
          splitDenominator: 1,
          transactionDate: "2024-02-01",
        },
      ],
      prices: [
        { securityId: 1, priceMicros: 6_000_000, priceDate: "2024-03-01" },
      ],
    });

    // 2 shares → 2:1 split → 4 shares × $6 = $24 = 2400 cents
    expect(result).toEqual([{ accountId: 10, marketValueCents: 2400 }]);
  });

  it("excludes fully sold positions", () => {
    const result = aggregateMarketValuesByAccount({
      splits: [
        {
          accountId: 10,
          securityId: 1,
          sharesMicros: 5_000_000,
          priceMicros: 10_000_000,
          feesCents: 0,
          action: "buy",
          transactionDate: "2024-01-05",
        },
        {
          accountId: 10,
          securityId: 1,
          sharesMicros: 5_000_000,
          priceMicros: 12_000_000,
          feesCents: 0,
          action: "sell",
          transactionDate: "2024-02-05",
        },
      ],
      prices: [
        { securityId: 1, priceMicros: 12_000_000, priceDate: "2024-03-01" },
      ],
    });

    // All shares sold → no market value → account excluded
    expect(result).toEqual([]);
  });

  it("returns empty array for empty inputs", () => {
    const result = aggregateMarketValuesByAccount({
      splits: [],
      prices: [],
    });

    expect(result).toEqual([]);
  });
});
