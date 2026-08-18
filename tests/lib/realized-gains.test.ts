import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db } from "@/tests/helpers/db-utils";
import {
  setupTestDatabase, resetTestDatabase, createBook, createAccount, createSecurity,
} from "@/tests/helpers/db";
import { createTransaction } from "@/lib/transactions";
import { getRealizedGains } from "@/lib/realized-gains";

const M = 1_000_000;

async function scenario() {
  const book = await createBook({ name: "B" });
  const brokerage = await createAccount({
    name: "Brokerage", type: "asset", subtype: "investment", bookId: book.id,
  });
  const cash = await createAccount({ name: "Cash", type: "asset", subtype: "bank", bookId: book.id });
  const security = await createSecurity({ name: "Vanguard Total", symbol: "VTI", securityType: "etf", bookId: book.id });

  const trade = (date: string, action: "buy" | "sell", shares: number, price: number) => {
    const amount = Math.round((shares / M) * (price / M) * 100);
    const signed = action === "buy" ? amount : -amount;
    return createTransaction(db, book.id, {
      date, description: `${action} VTI`,
      splits: [
        { accountId: brokerage.id, amount: signed },
        { accountId: cash.id, amount: -signed },
      ],
      investmentSplits: [
        { securityId: security.id, action, sharesMicros: shares, priceMicros: price, feesCents: 0 },
      ],
    });
  };

  await trade("2022-01-01", "buy", 100 * M, 10 * M);  // long-term when sold in 2024
  await trade("2024-05-01", "buy", 50 * M, 20 * M);   // short-term
  await trade("2024-09-01", "sell", 120 * M, 30 * M);

  return { book, brokerage, security };
}

describe("getRealizedGains", () => {
  beforeAll(async () => { await setupTestDatabase(); });
  beforeEach(async () => { await resetTestDatabase(); });

  it("returns one row per allocation with term and gain", async () => {
    const { book } = await scenario();
    const result = await getRealizedGains(db, book.id, {});

    expect(result.rows).toHaveLength(2);

    const long = result.rows.find((r) => r.term === "long");
    const short = result.rows.find((r) => r.term === "short");

    expect(long).toMatchObject({
      sharesMicros: 100 * M, acquiredDate: "2022-01-01", basisCents: 100_000,
    });
    expect(long!.gainCents).toBe(long!.proceedsCents - 100_000);

    expect(short).toMatchObject({
      sharesMicros: 20 * M, acquiredDate: "2024-05-01", basisCents: 40_000,
    });
  });

  it("splits totals into short-term and long-term", async () => {
    const { book } = await scenario();
    const result = await getRealizedGains(db, book.id, {});

    // 120 shares at $30 = $3600 proceeds; $1000 + $400 basis relieved
    expect(result.totals.proceedsCents).toBe(360_000);
    expect(result.totals.basisCents).toBe(140_000);
    expect(result.totals.shortTermGainCents + result.totals.longTermGainCents).toBe(220_000);
    expect(result.totals.unknownBasisRows).toBe(0);
  });

  it("filters by date range", async () => {
    const { book } = await scenario();
    const empty = await getRealizedGains(db, book.id, {
      startDate: "2023-01-01", endDate: "2023-12-31",
    });
    expect(empty.rows).toHaveLength(0);
    expect(empty.totals.proceedsCents).toBe(0);
  });

  it("emits an unknown-basis row for unallocated sell shares and excludes it from totals", async () => {
    const book = await createBook({ name: "B" });
    const brokerage = await createAccount({
      name: "Brokerage", type: "asset", subtype: "investment", bookId: book.id,
    });
    const cash = await createAccount({ name: "Cash", type: "asset", subtype: "bank", bookId: book.id });
    const security = await createSecurity({ name: "VTI", symbol: "VTI", securityType: "etf", bookId: book.id });

    await createTransaction(db, book.id, {
      date: "2024-01-01", description: "buy",
      splits: [
        { accountId: brokerage.id, amount: 100_000 },
        { accountId: cash.id, amount: -100_000 },
      ],
      investmentSplits: [
        // 10 shares @ $100/share = $1000, matching the $1000 ledger amount above.
        { securityId: security.id, action: "buy", sharesMicros: 10 * M, priceMicros: 100 * M, feesCents: 0 },
      ],
    });
    await createTransaction(db, book.id, {
      date: "2024-06-01", description: "sell more than held",
      splits: [
        { accountId: brokerage.id, amount: -300_000 },
        { accountId: cash.id, amount: 300_000 },
      ],
      investmentSplits: [
        // 25 shares @ $120/share = $3000, matching the $3000 ledger amount above.
        { securityId: security.id, action: "sell", sharesMicros: 25 * M, priceMicros: 120 * M, feesCents: 0 },
      ],
    });

    const result = await getRealizedGains(db, book.id, {});

    const unknown = result.rows.filter((r) => r.term === "unknown");
    expect(unknown).toHaveLength(1);
    expect(unknown[0].sharesMicros).toBe(15 * M);
    expect(unknown[0].basisCents).toBeNull();
    expect(unknown[0].gainCents).toBeNull();

    expect(result.totals.unknownBasisRows).toBe(1);
    // Only the allocated 10 shares contribute to basis
    expect(result.totals.basisCents).toBe(100_000);
  });

  it("computes unallocated proceeds as an exact remainder, not an apportionment, when shares/fee don't divide evenly", async () => {
    // Regression test: the unallocated row used to independently recompute
    // gross proceeds for its own shares and round an apportioned fee slice
    // (fee * unallocatedShares / totalShares), separately from however the
    // engine rounded the allocated portion's proceeds. Both roundings are
    // correct in isolation but don't have to agree, so allocated + unallocated
    // could miss the sell's true net proceeds by a cent whenever the division
    // was uneven. These share counts and fee were chosen so that division:
    // 1_767 cents of fee doesn't split evenly across a 2_050_950 / 23_649_932
    // share ratio. Verified against the pre-fix formula while writing this
    // test: allocated (82_823) + old-style unallocated (872_230) = 955_053,
    // one cent short of the sell's true net proceeds (955_054). The fix
    // derives unallocated proceeds as a remainder — sell's net proceeds minus
    // the proceeds actually recorded on the allocation rows — which is exact
    // by construction because both sides are already-rounded quantities that
    // don't require any further rounding to combine.
    const book = await createBook({ name: "B" });
    const brokerage = await createAccount({
      name: "Brokerage", type: "asset", subtype: "investment", bookId: book.id,
    });
    const cash = await createAccount({ name: "Cash", type: "asset", subtype: "bank", bookId: book.id });
    const security = await createSecurity({ name: "VTI", symbol: "VTI", securityType: "etf", bookId: book.id });

    const boughtShares = 2_050_950; // held shares -- fully allocated to the sell below
    const buyPriceMicros = 300_000_000;
    await createTransaction(db, book.id, {
      date: "2024-01-01", description: "buy",
      splits: [
        { accountId: brokerage.id, amount: 61_529 },
        { accountId: cash.id, amount: -61_529 },
      ],
      investmentSplits: [
        { securityId: security.id, action: "buy", sharesMicros: boughtShares, priceMicros: buyPriceMicros, feesCents: 0 },
      ],
    });

    const soldShares = 23_649_932; // more than held -- partially unallocated
    const sellPriceMicros = 404_576_461;
    const feesCents = 1_767;
    await createTransaction(db, book.id, {
      date: "2024-06-01", description: "sell more than held, with an unevenly-dividing fee",
      splits: [
        { accountId: brokerage.id, amount: -956_821 },
        { accountId: cash.id, amount: 956_821 },
      ],
      investmentSplits: [
        { securityId: security.id, action: "sell", sharesMicros: soldShares, priceMicros: sellPriceMicros, feesCents },
      ],
    });

    const result = await getRealizedGains(db, book.id, {});

    const allocated = result.rows.filter((r) => r.term !== "unknown");
    const unknown = result.rows.find((r) => r.term === "unknown");

    expect(allocated).toHaveLength(1);
    expect(unknown).toBeDefined();
    expect(unknown!.sharesMicros).toBe(soldShares - boughtShares);

    // Sell's total net proceeds: 23,649,932 shares * $404.576461 = $9,568.21
    // gross (956_821 cents), less the $17.67 fee (1_767 cents).
    const totalNetProceedsCents = 956_821 - feesCents;
    const allocatedProceeds = allocated.reduce((sum, r) => sum + r.proceedsCents, 0);

    expect(allocatedProceeds).toBe(82_823);
    expect(unknown!.proceedsCents).toBe(872_231);
    // The identity this fix guarantees, exactly — no ±1 cent slack — even
    // though the fee and share counts above don't divide evenly.
    expect(allocatedProceeds + unknown!.proceedsCents).toBe(totalNetProceedsCents);
  });

  // rebuildLots replays splits ordered by (effective date, transaction id,
  // investment split id) — see lib/lots-db.ts. A same-day buy and sell where
  // the sell's transaction happens to have a LOWER id than the buy's therefore
  // replays sell-before-buy: the sell finds no lot yet (fully unallocated) and
  // the buy opens a lot that is never touched (permanently open). This test
  // confirms getRealizedGains surfaces that as a single "unknown" row rather
  // than something misleading (a phantom disposal, or double-counted proceeds).
  it("surfaces a same-day sell-before-buy (lower transaction id) as a single unknown row", async () => {
    const book = await createBook({ name: "B" });
    const brokerage = await createAccount({
      name: "Brokerage", type: "asset", subtype: "investment", bookId: book.id,
    });
    const cash = await createAccount({ name: "Cash", type: "asset", subtype: "bank", bookId: book.id });
    const security = await createSecurity({ name: "VTI", symbol: "VTI", securityType: "etf", bookId: book.id });

    // Create the SELL transaction first so it gets the lower transaction id,
    // then the BUY second (higher id), both dated the same day.
    await createTransaction(db, book.id, {
      date: "2024-03-01", description: "sell VTI",
      splits: [
        { accountId: brokerage.id, amount: -60_000 },
        { accountId: cash.id, amount: 60_000 },
      ],
      investmentSplits: [
        { securityId: security.id, action: "sell", sharesMicros: 20 * M, priceMicros: 30 * M, feesCents: 0 },
      ],
    });
    await createTransaction(db, book.id, {
      date: "2024-03-01", description: "buy VTI",
      splits: [
        { accountId: brokerage.id, amount: 200_000 },
        { accountId: cash.id, amount: -200_000 },
      ],
      investmentSplits: [
        { securityId: security.id, action: "buy", sharesMicros: 20 * M, priceMicros: 10 * M, feesCents: 0 },
      ],
    });

    const result = await getRealizedGains(db, book.id, {});

    // Exactly one row: the sell, fully unallocated. The buy's lot stays open
    // (unrealized) and never appears here — no phantom disposal, no double
    // counting of proceeds.
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      term: "unknown",
      sharesMicros: 20 * M,
      acquiredDate: null,
      basisCents: null,
      gainCents: null,
      proceedsCents: 60_000, // 20 shares * $30, real and known despite unknown basis
    });
    expect(result.totals.unknownBasisRows).toBe(1);
    expect(result.totals.proceedsCents).toBe(0); // excluded from totals, as designed
    expect(result.totals.basisCents).toBe(0);
  });

  it("treats a sale exactly one year after acquisition as short-term", async () => {
    const book = await createBook({ name: "B" });
    const brokerage = await createAccount({
      name: "Brokerage", type: "asset", subtype: "investment", bookId: book.id,
    });
    const cash = await createAccount({ name: "Cash", type: "asset", subtype: "bank", bookId: book.id });
    const security = await createSecurity({ name: "VTI", symbol: "VTI", securityType: "etf", bookId: book.id });

    await createTransaction(db, book.id, {
      date: "2023-01-01", description: "buy VTI",
      splits: [
        { accountId: brokerage.id, amount: 100_000 },
        { accountId: cash.id, amount: -100_000 },
      ],
      investmentSplits: [
        { securityId: security.id, action: "buy", sharesMicros: 10 * M, priceMicros: 10 * M, feesCents: 0 },
      ],
    });
    // Sold exactly one year later, to the day.
    await createTransaction(db, book.id, {
      date: "2024-01-01", description: "sell VTI",
      splits: [
        { accountId: brokerage.id, amount: -150_000 },
        { accountId: cash.id, amount: 150_000 },
      ],
      investmentSplits: [
        { securityId: security.id, action: "sell", sharesMicros: 10 * M, priceMicros: 15 * M, feesCents: 0 },
      ],
    });

    const result = await getRealizedGains(db, book.id, {});

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].term).toBe("short");
  });
});
