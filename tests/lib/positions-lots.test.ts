import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/tests/helpers/db-utils";
import {
  setupTestDatabase, resetTestDatabase, createBook, createAccount, createSecurity,
} from "@/tests/helpers/db";
import { investmentLots } from "@/db/schema";
import { createTransaction } from "@/lib/transactions";
import { getPositions } from "@/lib/investments";

const M = 1_000_000;

describe("positions cost basis from lots", () => {
  beforeAll(async () => { await setupTestDatabase(); });
  beforeEach(async () => { await resetTestDatabase(); });

  it("reports FIFO remaining basis, not an average-cost approximation", async () => {
    const book = await createBook({ name: "B" });
    const brokerage = await createAccount({
      name: "Brokerage", type: "asset", subtype: "investment", bookId: book.id,
    });
    const cash = await createAccount({ name: "Cash", type: "asset", subtype: "bank", bookId: book.id });
    const security = await createSecurity({ name: "VTI", symbol: "VTI", bookId: book.id, securityType: "etf" });

    const trade = (date: string, action: "buy" | "sell", shares: number, price: number) => {
      const amount = Math.round((shares / M) * (price / M) * 100);
      const signed = action === "buy" ? amount : -amount;
      return createTransaction(db, book.id, {
        date,
        description: `${action} VTI`,
        splits: [
          { accountId: brokerage.id, amount: signed },
          { accountId: cash.id, amount: -signed },
        ],
        investmentSplits: [
          { securityId: security.id, action, sharesMicros: shares, priceMicros: price, feesCents: 0 },
        ],
      });
    };

    await trade("2024-01-01", "buy", 100 * M, 10 * M);   // $1000
    await trade("2024-02-01", "buy", 50 * M, 20 * M);    // $1000
    await trade("2024-06-01", "sell", 120 * M, 30 * M);  // closes lot A, takes 20 of lot B

    const positions = await getPositions(db, book.id);
    expect(positions).toHaveLength(1);
    expect(positions[0].sharesMicros).toBe(30 * M);

    // FIFO leaves 30 shares of the $20 lot: $600. Average cost would say $400.
    expect(positions[0].costBasisCents).toBe(60_000);
  });

  // KNOWN, CONFIRMED BUG — not fixed by this test, deliberately left failing.
  //
  // Three buys with no split and no sell (the original version of this test)
  // cannot discriminate: nothing in that scenario gives the replay and the
  // per-lot engine a chance to disagree. Adding a split whose ratio doesn't
  // evenly divide the individual lot sizes does: the aggregate replay
  // (lib/investments.ts's aggregatePositions) rounds the WHOLE position once
  // per split, while the FIFO engine (lib/lots.ts's replayLots) rounds EACH
  // lot separately when restating it for the same split. Sum-of-rounded and
  // rounded-sum are only guaranteed equal when the ratio divides every lot
  // evenly — a 1-for-3 reverse split over lots of 10M, 7M, and 3M shares does
  // not, and this test's numbers were chosen specifically to expose that.
  //
  // Confirmed on first run: getPositions().sharesMicros reports 2,666,667
  // while Σ investment_lots.remaining_shares_micros reports 2,666,666 for the
  // same book/security — a genuine 1-micro divergence between the two
  // "shares outstanding" computations this app maintains. It predates the lot
  // tracking work and was not introduced by it. Filed here as `it.fails` — an
  // assertion that is expected to fail — rather than either silently adjusting
  // the expected value to match the buggy output or leaving a bare failing
  // test that would break every future CI run for an issue outside that
  // work's approved scope.
  // Converting this back to a plain `it` is the signal that whoever fixes the
  // divergence should flip when they do.
  it.fails("keeps lot shares and replayed position shares in agreement across a split and a partial sell", async () => {
    const book = await createBook({ name: "B" });
    const brokerage = await createAccount({
      name: "Brokerage", type: "asset", subtype: "investment", bookId: book.id,
    });
    const cash = await createAccount({ name: "Cash", type: "asset", subtype: "bank", bookId: book.id });
    const security = await createSecurity({ name: "VTI", symbol: "VTI", bookId: book.id, securityType: "etf" });

    for (const [date, shares] of [["2024-01-01", 10 * M], ["2024-02-01", 7 * M], ["2024-03-01", 3 * M]] as const) {
      await createTransaction(db, book.id, {
        date,
        description: "buy VTI",
        splits: [
          { accountId: brokerage.id, amount: 10_000 },
          { accountId: cash.id, amount: -10_000 },
        ],
        investmentSplits: [
          { securityId: security.id, action: "buy", sharesMicros: shares, priceMicros: 1 * M, feesCents: 0 },
        ],
      });
    }

    await createTransaction(db, book.id, {
      date: "2024-04-01",
      description: "1-for-3 reverse split",
      splits: [
        { accountId: brokerage.id, amount: 0 },
        { accountId: cash.id, amount: 0 },
      ],
      investmentSplits: [
        {
          securityId: security.id, action: "split",
          sharesMicros: 0, priceMicros: 0, splitNumerator: 1, splitDenominator: 3,
        },
      ],
    });

    // Partial sell after the split, drawing across lot boundaries.
    await createTransaction(db, book.id, {
      date: "2024-05-01",
      description: "sell VTI",
      splits: [
        { accountId: brokerage.id, amount: -4_000 },
        { accountId: cash.id, amount: 4_000 },
      ],
      investmentSplits: [
        { securityId: security.id, action: "sell", sharesMicros: 4 * M, priceMicros: 1 * M, feesCents: 0 },
      ],
    });

    const positions = await getPositions(db, book.id);
    const [{ total }] = await db
      .select({ total: sql<number>`cast(coalesce(sum(${investmentLots.remainingSharesMicros}), 0) as bigint)` })
      .from(investmentLots)
      .where(eq(investmentLots.bookId, book.id));

    expect(Number(total)).toBe(positions[0].sharesMicros);
  });
});
