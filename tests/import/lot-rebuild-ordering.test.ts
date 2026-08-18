/**
 * Regression test for the CRITICAL Fix 1 bug: the Moneydance importer used to
 * rebuild investment lots (`lib/lots-db.ts`'s `rebuildLots`) from inside the
 * investment transactions phase, before stock splits were imported. A sell
 * that follows an imported split was therefore replayed against the security's
 * PRE-split share count, stranding most of the sell as "basis unknown."
 *
 * Building a full Moneydance JSON fixture through `importInvestmentTransactions`
 * would require faithfully reproducing its numbered-split parsing (dividend
 * reinvestment splitting, transfer detection, precision conversion, etc.) —
 * disproportionate for what this bug actually depends on. What matters is
 * ordering: does the lot rebuild see the "split" investment_splits row before
 * it replays the pair? This test seeds the DB state Phase 4 (Pass 1/2) leaves
 * behind directly (a buy and a sell, no lots yet — matching production after
 * Fix 1, since the investment transactions phase no longer rebuilds at all),
 * then exercises the REAL `importStockSplits()` parser and the REAL
 * `rebuildLots`/`findAllLotPairs` functions in both orders, to prove the
 * ordering in `scripts/import-moneydance/index.ts` (split import, THEN
 * rebuild) is the one that produces a correct result — and that the reverse
 * order is the bug this fix removes.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import {
  setupTestDatabase,
  resetTestDatabase,
  createAccount,
  createSecurity,
  createTransactionWithSplits,
  createInvestmentSplit,
} from "../helpers/db";
import { db } from "../helpers/db-utils";
import { investmentLots, investmentLotAllocations } from "@/db/schema";
import { importStockSplits } from "@/scripts/import-moneydance/parsers/stock-splits";
import { IdMapper, type MoneydanceStockSplit } from "@/scripts/import-moneydance/types";
import { findAllLotPairs, rebuildLots } from "@/lib/lots-db";

const M = 1_000_000;

const importOptions = { dryRun: false, importInactive: true, importHidden: true, verbose: false };

/**
 * Seeds exactly what the investment transactions phase leaves behind after
 * Fix 1: a buy and a sell with no lots yet. Buy 100 shares pre-split; sell
 * 700 shares, which is only fully coverable once the 7-for-1 split below is
 * accounted for.
 */
async function seedPreRebuildState() {
  const brokerage = await createAccount({ name: "Brokerage", type: "asset", subtype: "investment" });
  const cash = await createAccount({
    name: "Brokerage Cash", type: "asset", subtype: "cash", parentId: brokerage.id, isInvestmentCash: true,
  });
  const security = await createSecurity({ name: "Acme Corp", symbol: "ACME", securityType: "stock" });

  const buyTxn = await createTransactionWithSplits({
    date: "2024-01-01",
    splits: [
      { accountId: brokerage.id, amount: 100_000 },
      { accountId: cash.id, amount: -100_000 },
    ],
  });
  await createInvestmentSplit({
    transactionId: buyTxn.id,
    accountId: brokerage.id,
    securityId: security.id,
    action: "buy",
    sharesMicros: 100 * M,
    priceMicros: 10 * M, // 100 sh @ $10 = $1000 basis
  });

  const sellTxn = await createTransactionWithSplits({
    date: "2024-06-01",
    splits: [
      { accountId: brokerage.id, amount: -140_000 },
      { accountId: cash.id, amount: 140_000 },
    ],
  });
  await createInvestmentSplit({
    transactionId: sellTxn.id,
    accountId: brokerage.id,
    securityId: security.id,
    action: "sell",
    sharesMicros: 700 * M, // only possible post-split
    priceMicros: 2 * M,
  });

  return { brokerage, security };
}

async function importSevenForOneSplit(securityId: number) {
  const idMapper = new IdMapper();
  idMapper.setSecurity("md-acme", securityId);
  const splitItem: MoneydanceStockSplit = {
    obj_type: "csplit",
    id: "split-1",
    curr: "md-acme",
    dt: "20240301",
    oldshrs: "1",
    newshrs: "7",
    ratio: "7.0",
  };
  return importStockSplits([splitItem], idMapper, importOptions, db, 1);
}

describe("importer lot-rebuild ordering (Fix 1 regression)", () => {
  beforeEach(async () => {
    await setupTestDatabase();
    await resetTestDatabase();
  });

  it("the pre-fix order (rebuild before the split is imported) strands most of the sell as basis-unknown", async () => {
    const { brokerage, security } = await seedPreRebuildState();

    // What the importer used to do: rebuild while the "split" row doesn't
    // exist yet, because it ran from inside the investment transactions
    // phase, before stock splits were imported.
    await db.transaction(async (tx) => {
      await rebuildLots(tx, 1, brokerage.id, security.id);
    });

    const [lot] = await db.select().from(investmentLots).where(eq(investmentLots.securityId, security.id));
    expect(lot.originalSharesMicros).toBe(100 * M); // never restated — split hadn't happened yet
    expect(lot.remainingSharesMicros).toBe(0); // fully consumed at the pre-split count

    const allocations = await db.select().from(investmentLotAllocations);
    const allocatedShares = allocations.reduce((sum, a) => sum + a.sharesMicros, 0);
    expect(allocatedShares).toBe(100 * M); // only 100 of the 700 sold shares allocate
    // The other 600 shares have no lot to draw from — a real disposal with no
    // basis, cost basis / realized gains / holding term all wrong from here.
  });

  it("the fixed order (split imported, then rebuild) fully allocates the sell at post-split share counts", async () => {
    const { security } = await seedPreRebuildState();

    // Phase 6: import the stock split, exactly as index.ts does before its
    // Phase 6.5 lot rebuild.
    const splitStats = await importSevenForOneSplit(security.id);
    expect(splitStats.imported).toBe(1);

    // Phase 6.5: rebuild every affected pair, exactly as index.ts now does —
    // after stock splits, not from inside the investment transactions phase.
    const pairs = await findAllLotPairs(db, 1);
    for (const pair of pairs) {
      await db.transaction(async (tx) => {
        await rebuildLots(tx, 1, pair.accountId, pair.securityId);
      });
    }

    const [lot] = await db.select().from(investmentLots).where(eq(investmentLots.securityId, security.id));
    expect(lot.originalSharesMicros).toBe(700 * M); // restated 7-for-1 (100 -> 700)
    expect(lot.remainingSharesMicros).toBe(0); // fully consumed by the sell

    const allocations = await db.select().from(investmentLotAllocations);
    const allocatedShares = allocations.reduce((sum, a) => sum + a.sharesMicros, 0);
    expect(allocatedShares).toBe(700 * M); // the entire sell, fully allocated — no basis-unknown residual
  });
});
