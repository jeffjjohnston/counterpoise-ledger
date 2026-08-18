import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/tests/helpers/db-utils";
import {
  setupTestDatabase,
  resetTestDatabase,
  createBook,
  createAccount,
  createSecurity,
  createTransactionWithSplits,
  createInvestmentSplit,
} from "@/tests/helpers/db";
import { investmentLots, investmentLotAllocations, investmentSplits } from "@/db/schema";
import { rebuildLots, rebuildLotsForPairs, findAllLotPairs, collectAffectedPairs } from "@/lib/lots-db";

const M = 1_000_000;

async function fixture() {
  const book = await createBook({ name: "B" });
  const brokerage = await createAccount({
    name: "Brokerage", type: "asset", subtype: "investment", bookId: book.id,
  });
  const cash = await createAccount({
    name: "Cash", type: "asset", subtype: "bank", bookId: book.id,
  });
  const security = await createSecurity({
    name: "Vanguard Total", symbol: "VTI", securityType: "etf", bookId: book.id,
  });
  return { book, brokerage, cash, security };
}

async function addTrade(
  ctx: Awaited<ReturnType<typeof fixture>>,
  o: { date: string; action: "buy" | "sell"; shares: number; price: number; fees?: number }
) {
  const amount = Math.round((o.shares / M) * (o.price / M) * 100);
  const txn = await createTransactionWithSplits({
    bookId: ctx.book.id,
    date: o.date,
    description: `${o.action} VTI`,
    splits: [
      { accountId: ctx.brokerage.id, amount: o.action === "buy" ? amount : -amount },
      { accountId: ctx.cash.id, amount: o.action === "buy" ? -amount : amount },
    ],
  });
  await createInvestmentSplit({
    bookId: ctx.book.id,
    transactionId: txn.id,
    accountId: ctx.brokerage.id,
    securityId: ctx.security.id,
    action: o.action,
    sharesMicros: o.shares,
    priceMicros: o.price,
    feesCents: o.fees ?? 0,
  });
  return txn;
}

/** Like `addTrade`, but for an investment account other than the fixture's default. */
async function addTradeInAccount(
  ctx: Awaited<ReturnType<typeof fixture>>,
  accountId: number,
  o: { date: string; action: "buy" | "sell"; shares: number; price: number; fees?: number }
) {
  const amount = Math.round((o.shares / M) * (o.price / M) * 100);
  const txn = await createTransactionWithSplits({
    bookId: ctx.book.id,
    date: o.date,
    description: `${o.action} VTI`,
    splits: [
      { accountId, amount: o.action === "buy" ? amount : -amount },
      { accountId: ctx.cash.id, amount: o.action === "buy" ? -amount : amount },
    ],
  });
  await createInvestmentSplit({
    bookId: ctx.book.id,
    transactionId: txn.id,
    accountId,
    securityId: ctx.security.id,
    action: o.action,
    sharesMicros: o.shares,
    priceMicros: o.price,
    feesCents: o.fees ?? 0,
  });
  return txn;
}

/** A stock-split investment split: accountId null, no shares/price traded. */
async function addStockSplit(
  ctx: Awaited<ReturnType<typeof fixture>>,
  o: { date: string; numerator: number; denominator: number }
) {
  const txn = await createTransactionWithSplits({
    bookId: ctx.book.id,
    date: o.date,
    description: `${o.numerator}-for-${o.denominator} split`,
    splits: [{ accountId: ctx.cash.id, amount: 0 }],
  });
  await createInvestmentSplit({
    bookId: ctx.book.id,
    transactionId: txn.id,
    securityId: ctx.security.id,
    action: "split",
    sharesMicros: 0,
    priceMicros: 0,
    splitNumerator: o.numerator,
    splitDenominator: o.denominator,
  });
  return txn;
}

describe("rebuildLots", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("persists lots and multi-lot allocations for a pair", async () => {
    const ctx = await fixture();
    await addTrade(ctx, { date: "2024-01-01", action: "buy", shares: 100 * M, price: 10 * M });
    await addTrade(ctx, { date: "2024-02-01", action: "buy", shares: 50 * M, price: 20 * M });
    await addTrade(ctx, { date: "2024-06-01", action: "sell", shares: 120 * M, price: 30 * M });

    await rebuildLots(db, ctx.book.id, ctx.brokerage.id, ctx.security.id);

    const lots = await db
      .select()
      .from(investmentLots)
      .where(eq(investmentLots.bookId, ctx.book.id))
      .orderBy(investmentLots.acquiredDate);

    expect(lots).toHaveLength(2);
    expect(lots[0].remainingSharesMicros).toBe(0);
    expect(lots[0].closedTransactionId).not.toBeNull();
    expect(lots[1].remainingSharesMicros).toBe(30 * M);
    expect(lots[1].remainingBasisCents).toBe(60_000);
    expect(lots.every((l) => l.accountId === ctx.brokerage.id)).toBe(true);

    const allocations = await db
      .select()
      .from(investmentLotAllocations)
      .where(eq(investmentLotAllocations.bookId, ctx.book.id));

    expect(allocations).toHaveLength(2);
    const byLot = new Map(allocations.map((a) => [a.lotId, a]));
    expect(byLot.get(lots[0].id)?.sharesMicros).toBe(100 * M);
    expect(byLot.get(lots[1].id)?.sharesMicros).toBe(20 * M);
  });

  it("is idempotent — rebuilding twice yields the same rows", async () => {
    const ctx = await fixture();
    await addTrade(ctx, { date: "2024-01-01", action: "buy", shares: 100 * M, price: 10 * M });
    await addTrade(ctx, { date: "2024-06-01", action: "sell", shares: 40 * M, price: 30 * M });

    await rebuildLots(db, ctx.book.id, ctx.brokerage.id, ctx.security.id);
    const first = await db.select().from(investmentLots).orderBy(investmentLots.acquiredDate);
    const firstAllocs = await db
      .select({
        shares: investmentLotAllocations.sharesMicros,
        basis: investmentLotAllocations.basisCents,
        proceeds: investmentLotAllocations.proceedsCents,
      })
      .from(investmentLotAllocations);

    await rebuildLots(db, ctx.book.id, ctx.brokerage.id, ctx.security.id);
    const second = await db.select().from(investmentLots).orderBy(investmentLots.acquiredDate);
    const secondAllocs = await db
      .select({
        shares: investmentLotAllocations.sharesMicros,
        basis: investmentLotAllocations.basisCents,
        proceeds: investmentLotAllocations.proceedsCents,
      })
      .from(investmentLotAllocations);

    expect(second).toHaveLength(first.length);
    expect(second[0].remainingSharesMicros).toBe(first[0].remainingSharesMicros);
    expect(second[0].remainingBasisCents).toBe(first[0].remainingBasisCents);
    expect(secondAllocs).toEqual(firstAllocs);
  });

  it("reallocates correctly when a buy is backdated before existing sells", async () => {
    const ctx = await fixture();
    await addTrade(ctx, { date: "2024-02-01", action: "buy", shares: 100 * M, price: 20 * M });
    await addTrade(ctx, { date: "2024-06-01", action: "sell", shares: 100 * M, price: 30 * M });
    await rebuildLots(db, ctx.book.id, ctx.brokerage.id, ctx.security.id);

    // A cheaper lot is discovered and entered later, dated BEFORE the sell
    await addTrade(ctx, { date: "2024-01-01", action: "buy", shares: 100 * M, price: 5 * M });
    await rebuildLots(db, ctx.book.id, ctx.brokerage.id, ctx.security.id);

    const lots = await db.select().from(investmentLots).orderBy(investmentLots.acquiredDate);
    expect(lots).toHaveLength(2);

    // FIFO now consumes the January $5 lot; the February lot survives untouched
    expect(lots[0].acquiredDate).toBe("2024-01-01");
    expect(lots[0].remainingSharesMicros).toBe(0);
    expect(lots[1].acquiredDate).toBe("2024-02-01");
    expect(lots[1].remainingSharesMicros).toBe(100 * M);

    const allocations = await db.select().from(investmentLotAllocations);
    expect(allocations).toHaveLength(1);
    expect(allocations[0].basisCents).toBe(50_000);
  });

  it("keeps lots for different accounts separate", async () => {
    const ctx = await fixture();
    const ira = await createAccount({
      name: "IRA", type: "asset", subtype: "investment", bookId: ctx.book.id,
    });

    await addTrade(ctx, { date: "2024-01-01", action: "buy", shares: 10 * M, price: 10 * M });

    const iraTxn = await createTransactionWithSplits({
      bookId: ctx.book.id,
      date: "2024-01-02",
      description: "buy VTI in IRA",
      splits: [
        { accountId: ira.id, amount: 50_000 },
        { accountId: ctx.cash.id, amount: -50_000 },
      ],
    });
    await createInvestmentSplit({
      bookId: ctx.book.id,
      transactionId: iraTxn.id,
      accountId: ira.id,
      securityId: ctx.security.id,
      action: "buy",
      sharesMicros: 50 * M,
      priceMicros: 10 * M,
      feesCents: 0,
    });

    await rebuildLots(db, ctx.book.id, ctx.brokerage.id, ctx.security.id);
    await rebuildLots(db, ctx.book.id, ira.id, ctx.security.id);

    const brokerageLots = await db
      .select()
      .from(investmentLots)
      .where(and(
        eq(investmentLots.accountId, ctx.brokerage.id),
        eq(investmentLots.securityId, ctx.security.id)
      ));
    const iraLots = await db
      .select()
      .from(investmentLots)
      .where(and(
        eq(investmentLots.accountId, ira.id),
        eq(investmentLots.securityId, ctx.security.id)
      ));

    expect(brokerageLots).toHaveLength(1);
    expect(brokerageLots[0].remainingSharesMicros).toBe(10 * M);
    expect(iraLots).toHaveLength(1);
    expect(iraLots[0].remainingSharesMicros).toBe(50 * M);
  });

  it("clears lots for a pair that no longer has any buys", async () => {
    const ctx = await fixture();
    await addTrade(ctx, { date: "2024-01-01", action: "buy", shares: 10 * M, price: 10 * M });
    await rebuildLots(db, ctx.book.id, ctx.brokerage.id, ctx.security.id);
    expect(await db.select().from(investmentLots)).toHaveLength(1);

    await db.delete(investmentSplits).where(eq(investmentSplits.bookId, ctx.book.id));
    await rebuildLots(db, ctx.book.id, ctx.brokerage.id, ctx.security.id);
    expect(await db.select().from(investmentLots)).toHaveLength(0);
  });

  it("findAllLotPairs returns each distinct account/security combination once", async () => {
    const ctx = await fixture();
    await addTrade(ctx, { date: "2024-01-01", action: "buy", shares: 10 * M, price: 10 * M });
    await addTrade(ctx, { date: "2024-02-01", action: "buy", shares: 10 * M, price: 11 * M });

    const pairs = await findAllLotPairs(db, ctx.book.id);
    expect(pairs).toEqual([{ accountId: ctx.brokerage.id, securityId: ctx.security.id }]);
  });

  it("collectAffectedPairs fans a stock split out to every account holding the security", async () => {
    const ctx = await fixture();
    const ira = await createAccount({
      name: "IRA", type: "asset", subtype: "investment", bookId: ctx.book.id,
    });
    await addTrade(ctx, { date: "2024-01-01", action: "buy", shares: 10 * M, price: 10 * M });
    await addTradeInAccount(ctx, ira.id, { date: "2024-01-02", action: "buy", shares: 5 * M, price: 10 * M });

    // Lots already exist for both pairs at the time the split lands.
    await rebuildLots(db, ctx.book.id, ctx.brokerage.id, ctx.security.id);
    await rebuildLots(db, ctx.book.id, ira.id, ctx.security.id);

    const splitTxn = await addStockSplit(ctx, { date: "2024-03-01", numerator: 2, denominator: 1 });

    const pairs = await collectAffectedPairs(db, ctx.book.id, splitTxn.id);
    expect(pairs).toHaveLength(2);
    expect(pairs).toEqual(
      expect.arrayContaining([
        { accountId: ctx.brokerage.id, securityId: ctx.security.id },
        { accountId: ira.id, securityId: ctx.security.id },
      ])
    );
  });

  it("collectAffectedPairs fans a stock split out before any lot exists", async () => {
    const ctx = await fixture();
    const ira = await createAccount({
      name: "IRA", type: "asset", subtype: "investment", bookId: ctx.book.id,
    });
    await addTrade(ctx, { date: "2024-01-01", action: "buy", shares: 10 * M, price: 10 * M });
    await addTradeInAccount(ctx, ira.id, { date: "2024-01-02", action: "buy", shares: 5 * M, price: 10 * M });

    // Deliberately no rebuildLots call: investment_lots is empty for both pairs.
    // An implementation that derived fan-out from investmentLots instead of
    // investmentSplits would find nothing here and return an empty array.
    expect(await db.select().from(investmentLots)).toHaveLength(0);

    const splitTxn = await addStockSplit(ctx, { date: "2024-03-01", numerator: 2, denominator: 1 });

    const pairs = await collectAffectedPairs(db, ctx.book.id, splitTxn.id);
    expect(pairs).toHaveLength(2);
    expect(pairs).toEqual(
      expect.arrayContaining([
        { accountId: ctx.brokerage.id, securityId: ctx.security.id },
        { accountId: ira.id, securityId: ctx.security.id },
      ])
    );
  });

  it("collectAffectedPairs returns just the transaction's own pair for a plain buy/sell", async () => {
    const ctx = await fixture();
    const txn = await addTrade(ctx, { date: "2024-01-01", action: "buy", shares: 10 * M, price: 10 * M });

    const pairs = await collectAffectedPairs(db, ctx.book.id, txn.id);
    expect(pairs).toEqual([{ accountId: ctx.brokerage.id, securityId: ctx.security.id }]);
  });

  it("rebuildLotsForPairs rebuilds every distinct pair when the list contains duplicates", async () => {
    // Not a "rows aren't doubled" test: rebuildLots deletes a pair's lots
    // before recomputing and reinserting them, so it's idempotent per pair
    // regardless of the seen-pairs guard in rebuildLotsForPairs -- a repeated
    // call for the same pair just deletes the previous call's row and
    // reinserts identical values, so a row-count assertion here can't tell
    // de-duplication apart from its absence. What this DOES prove: an
    // over-aggressive or wrong dedup key must never cause a genuinely
    // distinct pair (the IRA pair) to be silently skipped.
    const ctx = await fixture();
    const ira = await createAccount({
      name: "IRA", type: "asset", subtype: "investment", bookId: ctx.book.id,
    });
    await addTrade(ctx, { date: "2024-01-01", action: "buy", shares: 10 * M, price: 10 * M });
    await addTradeInAccount(ctx, ira.id, { date: "2024-01-02", action: "buy", shares: 5 * M, price: 10 * M });

    await rebuildLotsForPairs(db, ctx.book.id, [
      { accountId: ctx.brokerage.id, securityId: ctx.security.id },
      { accountId: ctx.brokerage.id, securityId: ctx.security.id },
      { accountId: ira.id, securityId: ctx.security.id },
    ]);

    const brokerageLots = await db
      .select()
      .from(investmentLots)
      .where(and(
        eq(investmentLots.accountId, ctx.brokerage.id),
        eq(investmentLots.securityId, ctx.security.id)
      ));
    const iraLots = await db
      .select()
      .from(investmentLots)
      .where(and(
        eq(investmentLots.accountId, ira.id),
        eq(investmentLots.securityId, ctx.security.id)
      ));

    expect(brokerageLots).toHaveLength(1);
    expect(brokerageLots[0].remainingSharesMicros).toBe(10 * M);
    expect(iraLots).toHaveLength(1);
    expect(iraLots[0].remainingSharesMicros).toBe(5 * M);
  });
});
