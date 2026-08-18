import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { getPositions } from "@/lib/investments";
import { rebuildLots } from "@/lib/lots-db";
import {
  createAccount,
  createInvestmentSplit,
  createSecurity,
  createTransactionWithSplits,
  resetTestDatabase,
  setupTestDatabase,
} from "@/tests/helpers/db";

describe("same-date investment ordering", () => {
  const db = getDb();

  beforeAll(async () => {
    await setupTestDatabase();
  });
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("processes a same-day buy before its sell regardless of split insert order", async () => {
    const brokerage = await createAccount({ name: "Brokerage", type: "asset", subtype: "investment" });
    const cash = await createAccount({ name: "Brokerage Cash", type: "asset" });
    const security = await createSecurity({ name: "Vanguard Total", symbol: "VTI", securityType: "etf" });

    // Buy is the earlier TRANSACTION, sell the later one — same date.
    const buyTxn = await createTransactionWithSplits({
      date: "2026-06-01",
      description: "Buy VTI",
      splits: [
        { accountId: brokerage.id, amount: 100000 },
        { accountId: cash.id, amount: -100000 },
      ],
    });
    const sellTxn = await createTransactionWithSplits({
      date: "2026-06-01",
      description: "Sell VTI",
      splits: [
        { accountId: cash.id, amount: 60000 },
        { accountId: brokerage.id, amount: -60000 },
      ],
    });

    // Insert the SELL's investment split first, so its id is lower.
    await createInvestmentSplit({
      transactionId: sellTxn.id,
      accountId: brokerage.id,
      securityId: security.id,
      action: "sell",
      sharesMicros: 5_000_000,
      priceMicros: 120_000_000,
    });
    await createInvestmentSplit({
      transactionId: buyTxn.id,
      accountId: brokerage.id,
      securityId: security.id,
      action: "buy",
      sharesMicros: 10_000_000,
      priceMicros: 100_000_000,
    });

    // The low-level helpers above bypass lib/transactions.ts's createTransaction(),
    // which is what normally triggers rebuildLots after a write. Rebuild
    // explicitly so investment_lots reflects this account/security pair, same
    // as it would after a real write-path call.
    await rebuildLots(db, 1, brokerage.id, security.id);

    const positions = await getPositions(db, 1, brokerage.id);
    const vti = positions.find((p) => p.securitySymbol === "VTI");

    // sharesMicros is order-invariant (buy +10M and sell -5M sum to +5M no
    // matter which is applied first), so it can't distinguish correct from
    // buggy ordering — asserted here only as a basic sanity check.
    expect(vti?.sharesMicros).toBe(5_000_000);

    // costBasisCents IS order-sensitive: it now comes from rebuildLots's FIFO
    // replay (lib/lots.ts), which consumes rows in the order the SQL query
    // hands them over. Processing the sell before the buy leaves it with no
    // lot to draw from (an unallocated sell), so the buy's full $1,000 basis
    // survives untouched — 100,000 cents instead of the correct 50,000.
    // Buy-then-sell lets FIFO allocate the sell against the buy's lot,
    // removing the proportional $500 of basis for the 5 shares sold and
    // leaving $500 (50,000 cents) for the remaining 5 shares.
    expect(vti?.costBasisCents).toBe(50_000);
  });
});
