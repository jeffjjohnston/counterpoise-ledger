import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/tests/helpers/db-utils";
import {
  setupTestDatabase, resetTestDatabase, createBook, createAccount,
  createSecurity, createTransactionWithSplits, createInvestmentSplit,
} from "@/tests/helpers/db";
import { investmentLots } from "@/db/schema";
import { backfillLots } from "@/scripts/rebuild-lots";

const M = 1_000_000;

describe("backfillLots", () => {
  beforeAll(async () => { await setupTestDatabase(); });
  beforeEach(async () => { await resetTestDatabase(); });

  it("rebuilds every pair across every book when allocations are empty", async () => {
    const book = await createBook({ name: "B" });
    const brokerage = await createAccount({
      name: "Brokerage", type: "asset", subtype: "investment", bookId: book.id,
    });
    const cash = await createAccount({ name: "Cash", type: "asset", subtype: "bank", bookId: book.id });
    const security = await createSecurity({ name: "VTI", symbol: "VTI", securityType: "etf", bookId: book.id });

    const txn = await createTransactionWithSplits({
      bookId: book.id,
      date: "2024-01-01",
      description: "buy",
      splits: [
        { accountId: brokerage.id, amount: 100_000 },
        { accountId: cash.id, amount: -100_000 },
      ],
    });
    await createInvestmentSplit({
      bookId: book.id, transactionId: txn.id, accountId: brokerage.id,
      securityId: security.id, action: "buy",
      sharesMicros: 100 * M, priceMicros: 10 * M, feesCents: 0,
    });

    const result = await backfillLots(db);

    expect(result.skipped).toBe(false);
    expect(result.pairsRebuilt).toBe(1);
    const lots = await db.select().from(investmentLots).where(eq(investmentLots.bookId, book.id));
    expect(lots).toHaveLength(1);
    expect(lots[0].remainingSharesMicros).toBe(100 * M);
  });

  it("skips when there is nothing to do", async () => {
    const result = await backfillLots(db);
    expect(result.skipped).toBe(true);
    expect(result.pairsRebuilt).toBe(0);
  });
});
