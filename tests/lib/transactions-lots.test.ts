import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/tests/helpers/db-utils";
import {
  setupTestDatabase, resetTestDatabase, createBook, createAccount, createSecurity,
} from "@/tests/helpers/db";
import { investmentLots, investmentLotAllocations } from "@/db/schema";
import { createTransaction, updateTransaction } from "@/lib/transactions";

const M = 1_000_000;

async function fixture() {
  const book = await createBook({ name: "B" });
  const brokerage = await createAccount({
    name: "Brokerage", type: "asset", subtype: "investment", bookId: book.id,
  });
  const cash = await createAccount({
    name: "Cash", type: "asset", subtype: "bank", bookId: book.id,
  });
  const security = await createSecurity({ name: "Vanguard Total", symbol: "VTI", securityType: "etf", bookId: book.id });
  return { book, brokerage, cash, security };
}

const buy = (ctx: Awaited<ReturnType<typeof fixture>>, date: string, shares: number, price: number) => ({
  date,
  description: "buy VTI",
  splits: [
    { accountId: ctx.brokerage.id, amount: Math.round((shares / M) * (price / M) * 100) },
    { accountId: ctx.cash.id, amount: -Math.round((shares / M) * (price / M) * 100) },
  ],
  investmentSplits: [
    { securityId: ctx.security.id, action: "buy" as const, sharesMicros: shares, priceMicros: price, feesCents: 0 },
  ],
});

describe("transaction writes maintain lots", () => {
  beforeAll(async () => { await setupTestDatabase(); });
  beforeEach(async () => { await resetTestDatabase(); });

  it("creates a lot when a buy transaction is created", async () => {
    const ctx = await fixture();
    await createTransaction(db, ctx.book.id, buy(ctx, "2024-01-01", 100 * M, 10 * M));

    const lots = await db.select().from(investmentLots).where(eq(investmentLots.bookId, ctx.book.id));
    expect(lots).toHaveLength(1);
    expect(lots[0].accountId).toBe(ctx.brokerage.id);
    expect(lots[0].remainingSharesMicros).toBe(100 * M);
    expect(lots[0].remainingBasisCents).toBe(100_000);
  });

  it("allocates across lots when a sell transaction is created", async () => {
    const ctx = await fixture();
    await createTransaction(db, ctx.book.id, buy(ctx, "2024-01-01", 100 * M, 10 * M));
    await createTransaction(db, ctx.book.id, buy(ctx, "2024-02-01", 50 * M, 20 * M));

    await createTransaction(db, ctx.book.id, {
      date: "2024-06-01",
      description: "sell VTI",
      splits: [
        { accountId: ctx.brokerage.id, amount: -360_000 },
        { accountId: ctx.cash.id, amount: 360_000 },
      ],
      investmentSplits: [
        { securityId: ctx.security.id, action: "sell", sharesMicros: 120 * M, priceMicros: 30 * M, feesCents: 0 },
      ],
    });

    const allocations = await db
      .select()
      .from(investmentLotAllocations)
      .where(eq(investmentLotAllocations.bookId, ctx.book.id));
    expect(allocations).toHaveLength(2);
    expect(allocations.reduce((s, a) => s + a.sharesMicros, 0)).toBe(120 * M);
  });

  it("reallocates when an existing buy is edited to an earlier date", async () => {
    const ctx = await fixture();
    const late = await createTransaction(db, ctx.book.id, buy(ctx, "2024-03-01", 100 * M, 20 * M));
    await createTransaction(db, ctx.book.id, buy(ctx, "2024-02-01", 100 * M, 5 * M));
    await createTransaction(db, ctx.book.id, {
      date: "2024-06-01",
      description: "sell VTI",
      splits: [
        { accountId: ctx.brokerage.id, amount: -300_000 },
        { accountId: ctx.cash.id, amount: 300_000 },
      ],
      investmentSplits: [
        { securityId: ctx.security.id, action: "sell", sharesMicros: 100 * M, priceMicros: 30 * M, feesCents: 0 },
      ],
    });

    // The $5 lot was consumed first
    let allocations = await db.select().from(investmentLotAllocations);
    expect(allocations[0].basisCents).toBe(50_000);

    // Move the expensive lot to be the earliest
    await updateTransaction(db, ctx.book.id, late.id, { date: "2024-01-01" });

    allocations = await db.select().from(investmentLotAllocations);
    expect(allocations).toHaveLength(1);
    expect(allocations[0].basisCents).toBe(200_000);
  });

  it("restates open lots when a stock split is created, even though split rows have no account", async () => {
    const ctx = await fixture();
    await createTransaction(db, ctx.book.id, buy(ctx, "2024-01-01", 10 * M, 100 * M));

    // A stock split carries accountId: null and must fan out to every account
    // holding the security — which is why affected pairs come from investment
    // splits rather than from the split row's own (absent) account.
    //
    // createTransaction requires at least 2 splits even for a stock split (no
    // cash moves), so this mirrors the zero-amount splits the transaction form
    // sends for a "split" action rather than an empty splits array.
    await createTransaction(db, ctx.book.id, {
      date: "2024-04-01",
      description: "7:1 split",
      splits: [
        { accountId: ctx.brokerage.id, amount: 0 },
        { accountId: ctx.cash.id, amount: 0 },
      ],
      investmentSplits: [
        {
          securityId: ctx.security.id,
          action: "split",
          sharesMicros: 0,
          priceMicros: 0,
          feesCents: 0,
          splitNumerator: 7,
          splitDenominator: 1,
        },
      ],
    });

    const lots = await db.select().from(investmentLots).where(eq(investmentLots.bookId, ctx.book.id));
    expect(lots).toHaveLength(1);
    expect(lots[0].remainingSharesMicros).toBe(70 * M);
    expect(lots[0].remainingBasisCents).toBe(100_000);
  });
});
