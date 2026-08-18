import { describe, it, expect } from "vitest";
import { replayLots, type ReplaySplit } from "@/lib/lots";

const M = 1_000_000;

// Builds a split with sane defaults; override what the case cares about.
const split = (o: Partial<ReplaySplit> & Pick<ReplaySplit, "action">): ReplaySplit => ({
  investmentSplitId: o.investmentSplitId ?? 1,
  transactionId: o.transactionId ?? 1,
  action: o.action,
  sharesMicros: o.sharesMicros ?? 0,
  priceMicros: o.priceMicros ?? 0,
  feesCents: o.feesCents ?? 0,
  splitNumerator: o.splitNumerator ?? null,
  splitDenominator: o.splitDenominator ?? null,
  transactionDate: o.transactionDate ?? "2024-01-01",
});

describe("replayLots", () => {
  it("opens a lot on buy with fees capitalized into basis", () => {
    const { lots } = replayLots([
      split({ investmentSplitId: 1, transactionId: 1, action: "buy",
              sharesMicros: 100 * M, priceMicros: 10 * M, feesCents: 500,
              transactionDate: "2024-01-01" }),
    ]);

    expect(lots).toHaveLength(1);
    expect(lots[0].acquiredDate).toBe("2024-01-01");
    expect(lots[0].originalSharesMicros).toBe(100 * M);
    // 100 shares x $10 = $1000, plus $5 fee
    expect(lots[0].originalBasisCents).toBe(100_500);
    expect(lots[0].remainingBasisCents).toBe(100_500);
    expect(lots[0].closedTransactionId).toBeNull();
  });

  it("spans multiple lots on a single sell, closing the first and partially consuming the second", () => {
    const { lots, allocations, unallocated } = replayLots([
      split({ investmentSplitId: 1, transactionId: 1, action: "buy",
              sharesMicros: 100 * M, priceMicros: 10 * M, transactionDate: "2024-01-01" }),
      split({ investmentSplitId: 2, transactionId: 2, action: "buy",
              sharesMicros: 50 * M, priceMicros: 20 * M, transactionDate: "2024-02-01" }),
      split({ investmentSplitId: 3, transactionId: 3, action: "sell",
              sharesMicros: 120 * M, priceMicros: 30 * M, transactionDate: "2024-06-01" }),
    ]);

    expect(unallocated).toHaveLength(0);
    expect(allocations).toHaveLength(2);

    // Lot A: fully consumed, all $1000 basis relieved
    expect(allocations[0]).toMatchObject({
      lotKey: 0, sellSplitId: 3, sharesMicros: 100 * M, basisCents: 100_000,
    });
    // Lot B: 20 of 50 shares, so 40% of its $1000 basis
    expect(allocations[1]).toMatchObject({
      lotKey: 1, sellSplitId: 3, sharesMicros: 20 * M, basisCents: 40_000,
    });

    expect(lots[0].remainingSharesMicros).toBe(0);
    expect(lots[0].remainingBasisCents).toBe(0);
    expect(lots[0].closedTransactionId).toBe(3);

    expect(lots[1].remainingSharesMicros).toBe(30 * M);
    expect(lots[1].remainingBasisCents).toBe(60_000);
    expect(lots[1].closedTransactionId).toBeNull();

    // Proceeds: 120 x $30 = $3600, apportioned 100/20
    expect(allocations[0].proceedsCents + allocations[1].proceedsCents).toBe(360_000);
  });

  it("relieves exactly the remaining basis when a lot closes, leaving no stranded cent", () => {
    // 3 shares at $3.33 = $9.99 basis; selling 1 share at a time must relieve 999 total
    const { lots, allocations } = replayLots([
      split({ investmentSplitId: 1, transactionId: 1, action: "buy",
              sharesMicros: 3 * M, priceMicros: 3_330_000, transactionDate: "2024-01-01" }),
      split({ investmentSplitId: 2, transactionId: 2, action: "sell",
              sharesMicros: 1 * M, priceMicros: 4 * M, transactionDate: "2024-02-01" }),
      split({ investmentSplitId: 3, transactionId: 3, action: "sell",
              sharesMicros: 1 * M, priceMicros: 4 * M, transactionDate: "2024-03-01" }),
      split({ investmentSplitId: 4, transactionId: 4, action: "sell",
              sharesMicros: 1 * M, priceMicros: 4 * M, transactionDate: "2024-04-01" }),
    ]);

    const relieved = allocations.reduce((sum, a) => sum + a.basisCents, 0);
    expect(relieved).toBe(999);
    expect(lots[0].remainingBasisCents).toBe(0);
    expect(lots[0].remainingSharesMicros).toBe(0);
  });

  it("apportions proceeds so the parts sum exactly to the sell total", () => {
    // $100.00 net across 3 lots of 1 share each cannot divide evenly
    const { allocations } = replayLots([
      split({ investmentSplitId: 1, transactionId: 1, action: "buy",
              sharesMicros: 1 * M, priceMicros: 1 * M, transactionDate: "2024-01-01" }),
      split({ investmentSplitId: 2, transactionId: 2, action: "buy",
              sharesMicros: 1 * M, priceMicros: 1 * M, transactionDate: "2024-01-02" }),
      split({ investmentSplitId: 3, transactionId: 3, action: "buy",
              sharesMicros: 1 * M, priceMicros: 1 * M, transactionDate: "2024-01-03" }),
      split({ investmentSplitId: 4, transactionId: 4, action: "sell",
              sharesMicros: 3 * M, priceMicros: 33_333_333, transactionDate: "2024-05-01" }),
    ]);

    const gross = Math.round((3 * M / M) * (33_333_333 / M) * 100);
    expect(allocations.reduce((s, a) => s + a.proceedsCents, 0)).toBe(gross);
  });

  it("nets fees out of proceeds on sell", () => {
    const { allocations } = replayLots([
      split({ investmentSplitId: 1, transactionId: 1, action: "buy",
              sharesMicros: 10 * M, priceMicros: 10 * M, transactionDate: "2024-01-01" }),
      split({ investmentSplitId: 2, transactionId: 2, action: "sell",
              sharesMicros: 10 * M, priceMicros: 20 * M, feesCents: 700,
              transactionDate: "2024-02-01" }),
    ]);

    // 10 x $20 = $200 gross, less $7 fee
    expect(allocations[0].proceedsCents).toBe(19_300);
  });

  it("restates open lots on a stock split and leaves closed lots alone", () => {
    const { lots } = replayLots([
      split({ investmentSplitId: 1, transactionId: 1, action: "buy",
              sharesMicros: 10 * M, priceMicros: 100 * M, transactionDate: "2024-01-01" }),
      split({ investmentSplitId: 2, transactionId: 2, action: "sell",
              sharesMicros: 10 * M, priceMicros: 120 * M, transactionDate: "2024-02-01" }),
      split({ investmentSplitId: 3, transactionId: 3, action: "buy",
              sharesMicros: 5 * M, priceMicros: 200 * M, transactionDate: "2024-03-01" }),
      split({ investmentSplitId: 4, transactionId: 4, action: "split",
              splitNumerator: 7, splitDenominator: 1, transactionDate: "2024-04-01" }),
    ]);

    // Closed lot keeps its pre-split share count — its disposal already happened
    expect(lots[0].remainingSharesMicros).toBe(0);
    expect(lots[0].originalSharesMicros).toBe(10 * M);

    // Open lot is restated 7:1, basis unchanged
    expect(lots[1].originalSharesMicros).toBe(35 * M);
    expect(lots[1].remainingSharesMicros).toBe(35 * M);
    expect(lots[1].remainingBasisCents).toBe(100_000);
  });

  it("fully allocates a sell against split-restated lot shares", () => {
    // This is the exact case Fix 1 (moving the importer's rebuild to run
    // after stock splits) exists to protect: if a sell that follows a split
    // is replayed before the split row is present, the engine only sees the
    // lot's pre-split share count and strands the rest as "unallocated" —
    // corrupting cost basis, proceeds, and term. Here the split IS present
    // before the sell, as it always is for every write path except the
    // (now-fixed) importer ordering bug, so the sell must be fully satisfied.
    const { lots, allocations, unallocated } = replayLots([
      split({ investmentSplitId: 1, transactionId: 1, action: "buy",
              sharesMicros: 100 * M, priceMicros: 10 * M, transactionDate: "2024-01-01" }),
      split({ investmentSplitId: 2, transactionId: 2, action: "split",
              splitNumerator: 2, splitDenominator: 1, transactionDate: "2024-02-01" }),
      split({ investmentSplitId: 3, transactionId: 3, action: "sell",
              sharesMicros: 150 * M, priceMicros: 8 * M, transactionDate: "2024-03-01" }),
    ]);

    // Pre-split the lot only held 100 shares — a sell of 150 would have left
    // 50 shares unallocated. Post-split (2-for-1) the lot holds 200 shares,
    // so the sell is fully satisfied from the single restated lot.
    expect(unallocated).toHaveLength(0);
    expect(allocations).toHaveLength(1);
    expect(allocations[0].sharesMicros).toBe(150 * M);

    // $1000 basis over 200 post-split shares; selling 150 relieves 75% = $750.
    expect(allocations[0].basisCents).toBe(75_000);
    expect(lots[0].remainingSharesMicros).toBe(50 * M);
    expect(lots[0].remainingBasisCents).toBe(25_000);
  });

  it("treats a sell at price 0 as a full-basis realized loss (option expiration)", () => {
    const { lots, allocations } = replayLots([
      split({ investmentSplitId: 1, transactionId: 1, action: "buy",
              sharesMicros: 1 * M, priceMicros: 500 * M, transactionDate: "2024-01-01" }),
      split({ investmentSplitId: 2, transactionId: 2, action: "sell",
              sharesMicros: 1 * M, priceMicros: 0, transactionDate: "2024-06-01" }),
    ]);

    expect(allocations[0].basisCents).toBe(50_000);
    expect(allocations[0].proceedsCents).toBe(0);
    expect(lots[0].remainingSharesMicros).toBe(0);
  });

  it("reports unallocated shares when a sell exceeds available lots", () => {
    const { allocations, unallocated } = replayLots([
      split({ investmentSplitId: 1, transactionId: 1, action: "buy",
              sharesMicros: 10 * M, priceMicros: 10 * M, transactionDate: "2024-01-01" }),
      split({ investmentSplitId: 2, transactionId: 2, action: "sell",
              sharesMicros: 25 * M, priceMicros: 12 * M, transactionDate: "2024-02-01" }),
    ]);

    expect(allocations).toHaveLength(1);
    expect(allocations[0].sharesMicros).toBe(10 * M);
    expect(unallocated).toEqual([{ sellSplitId: 2, sharesMicros: 15 * M }]);
  });

  it("ignores dividend, capGain, and fee actions", () => {
    const { lots, allocations } = replayLots([
      split({ investmentSplitId: 1, transactionId: 1, action: "buy",
              sharesMicros: 10 * M, priceMicros: 10 * M, transactionDate: "2024-01-01" }),
      split({ investmentSplitId: 2, transactionId: 2, action: "dividend", transactionDate: "2024-02-01" }),
      split({ investmentSplitId: 3, transactionId: 3, action: "capGain", transactionDate: "2024-03-01" }),
      split({ investmentSplitId: 4, transactionId: 4, action: "fee", feesCents: 100, transactionDate: "2024-04-01" }),
    ]);

    expect(lots).toHaveLength(1);
    expect(lots[0].remainingSharesMicros).toBe(10 * M);
    expect(allocations).toHaveLength(0);
  });

  it("consumes lots in acquisition order regardless of input array order", () => {
    const { allocations } = replayLots([
      split({ investmentSplitId: 3, transactionId: 3, action: "sell",
              sharesMicros: 10 * M, priceMicros: 30 * M, transactionDate: "2024-06-01" }),
      split({ investmentSplitId: 2, transactionId: 2, action: "buy",
              sharesMicros: 10 * M, priceMicros: 20 * M, transactionDate: "2024-02-01" }),
      split({ investmentSplitId: 1, transactionId: 1, action: "buy",
              sharesMicros: 10 * M, priceMicros: 10 * M, transactionDate: "2024-01-01" }),
    ]);

    // The January lot ($10) must be consumed, not the February one
    expect(allocations).toHaveLength(1);
    expect(allocations[0].basisCents).toBe(10_000);
  });

  it("uses transactionId as a tiebreak when transactionDate is equal", () => {
    // investmentSplitId is deliberately inverted relative to transactionId (5/2 vs 9/1) so
    // this only passes if the transactionId comparator actually runs — if it were deleted
    // and sorting fell through to investmentSplitId, the $20 lot (id 5) would sort first
    // instead of the $10 lot (id 9), and the assertion below would fail.
    const { allocations } = replayLots([
      split({ investmentSplitId: 5, transactionId: 2, action: "buy",
              sharesMicros: 10 * M, priceMicros: 20 * M, transactionDate: "2024-01-01" }),
      split({ investmentSplitId: 9, transactionId: 1, action: "buy",
              sharesMicros: 10 * M, priceMicros: 10 * M, transactionDate: "2024-01-01" }),
      split({ investmentSplitId: 3, transactionId: 3, action: "sell",
              sharesMicros: 10 * M, priceMicros: 30 * M, transactionDate: "2024-06-01" }),
    ]);

    // Same date; the lower-transactionId lot ($10 basis, transactionId 1) must be consumed
    // first, not the higher one ($20, transactionId 2)
    expect(allocations).toHaveLength(1);
    expect(allocations[0].basisCents).toBe(10_000);
  });

  it("uses investmentSplitId as a tiebreak when transactionDate and transactionId are both equal", () => {
    const { allocations } = replayLots([
      split({ investmentSplitId: 6, transactionId: 1, action: "buy",
              sharesMicros: 10 * M, priceMicros: 20 * M, transactionDate: "2024-01-01" }),
      split({ investmentSplitId: 5, transactionId: 1, action: "buy",
              sharesMicros: 10 * M, priceMicros: 10 * M, transactionDate: "2024-01-01" }),
      split({ investmentSplitId: 7, transactionId: 2, action: "sell",
              sharesMicros: 10 * M, priceMicros: 30 * M, transactionDate: "2024-06-01" }),
    ]);

    // Same date and transactionId; the lower-investmentSplitId lot ($10 basis) must be consumed first
    expect(allocations).toHaveLength(1);
    expect(allocations[0].basisCents).toBe(10_000);
  });

  it("is deterministic — replaying the same input twice gives identical output", () => {
    const input = [
      split({ investmentSplitId: 1, transactionId: 1, action: "buy",
              sharesMicros: 7 * M, priceMicros: 13_570_000, transactionDate: "2024-01-01" }),
      split({ investmentSplitId: 2, transactionId: 2, action: "buy",
              sharesMicros: 11 * M, priceMicros: 9_990_000, transactionDate: "2024-02-01" }),
      split({ investmentSplitId: 3, transactionId: 3, action: "sell",
              sharesMicros: 13 * M, priceMicros: 17_770_000, feesCents: 123,
              transactionDate: "2024-03-01" }),
    ];

    expect(replayLots(input)).toEqual(replayLots(input));
  });
});
