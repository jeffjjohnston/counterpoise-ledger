import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createAccount, createBook, createInvestmentSplit, createSecurity, createTransactionWithSplits,
  resetTestDatabase, setupTestDatabase,
} from "../helpers/db-utils";
import { rows, scalar, script } from "../helpers/sql";
import { workerDatabasePath } from "../helpers/test-database";

const run = promisify(execFile);
const CLI = path.resolve("rust-api/target/debug/ledger-cli");

/** Run a `ledger-cli` command against this worker's database, in this process's zone. */
async function cli(...args: string[]) {
  return run(CLI, args, {
    env: {
      ...process.env,
      DATABASE_PATH: workerDatabasePath(),
      DATABASE_URL: "",
      TZ: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
  });
}

/** Run the Rust backfill. */
async function rustRebuild(...args: string[]) {
  return cli("rebuild-lots", ...args);
}

/**
 * Every lot and allocation, without the serial IDs, which a rebuild
 * regenerates. The rows are in pair order, and in insertion order inside one
 * pair. A rebuild writes each pair in replay order, but the writers visit
 * the pairs in different orders. An allocation names its lot by the buy
 * split that opened it, which is unique per lot.
 */
async function snapshot() {
  const lots = await rows(`
    SELECT book_id, account_id, security_id, acquired_date, opened_split_id,
           opened_transaction_id, closed_transaction_id, original_shares_micros,
           original_basis_cents, remaining_shares_micros, remaining_basis_cents
    FROM investment_lots ORDER BY book_id, account_id, security_id, id`);
  const allocations = await rows(`
    SELECT a.book_id, l.account_id, l.security_id, l.opened_split_id, a.sell_split_id,
           a.transaction_id, a.shares_micros, a.basis_cents, a.proceeds_cents
    FROM investment_lot_allocations a JOIN investment_lots l ON l.id = a.lot_id
    ORDER BY a.book_id, l.account_id, l.security_id, a.id`);
  return { lots, allocations };
}

/** Pairs that the seed and the importer do not produce, in book 1. The rows
 * come from node:sqlite, so no lots exist until a rebuild writes them. */
async function createEdgeCases() {
  const brokerage = await createAccount({ name: "Edge Brokerage", type: "asset", subtype: "investment" });
  const ira = await createAccount({ name: "Edge IRA", type: "asset", subtype: "investment" });
  const cash = await createAccount({ name: "Edge Cash", type: "asset" });
  const security = await createSecurity({ name: "Edge Fund", symbol: "EDGE", securityType: "etf" });
  async function trade(date: string, split: Omit<Parameters<typeof createInvestmentSplit>[0], "transactionId">, isFloating = false) {
    const transaction = await createTransactionWithSplits({
      date, isFloating, splits: [{ accountId: cash.id, amount: -1 }, { accountId: cash.id, amount: 1 }],
    });
    return createInvestmentSplit({ ...split, transactionId: transaction.id });
  }
  const base = { securityId: security.id, priceMicros: 10_333_333 };
  // Same-date buys keep transaction order; a fee lands in the basis.
  await trade("2024-01-02", { ...base, accountId: brokerage.id, action: "buy", sharesMicros: 3_000_000, feesCents: 7 });
  await trade("2024-01-02", { ...base, accountId: brokerage.id, action: "buy", sharesMicros: 1_500_001 });
  await trade("2024-01-02", { ...base, accountId: ira.id, action: "buy", sharesMicros: 2_000_000 });
  // A 3-for-2 split with no account restates every holder's open lots.
  await trade("2024-03-01", { securityId: security.id, action: "split", sharesMicros: 0, priceMicros: 0, splitNumerator: 3, splitDenominator: 2 });
  // A sell that spans lots with an uneven fee, then one larger than what is left.
  await trade("2024-06-01", { ...base, accountId: brokerage.id, action: "sell", sharesMicros: 5_000_000, feesCents: 13 });
  await trade("2024-07-01", { ...base, accountId: ira.id, action: "sell", sharesMicros: 9_000_000, feesCents: 1 });
  // A floating buy takes today's date as its acquired date.
  await trade("2020-01-01", { ...base, accountId: brokerage.id, action: "buy", sharesMicros: 1_000_000 }, true);
  // A split with a zero denominator is ignored.
  await trade("2024-08-01", { securityId: security.id, action: "split", sharesMicros: 0, priceMicros: 0, splitNumerator: 2, splitDenominator: 0 });
  return { brokerage, ira };
}

describe("ledger-cli rebuild-lots", () => {
  beforeAll(async () => { await setupTestDatabase(); }, 120_000);
  beforeEach(async () => { await resetTestDatabase(); });

  it("rewrites the lots and allocations of seeded, imported, and edge-case books unchanged", async () => {
    // The deploy backfill writes the edge-case pairs: no allocation exists yet.
    await createEdgeCases();
    expect((await rustRebuild()).stdout.trim()).toBe("Lot rebuild: 2 pair(s) across 1 book(s).");
    // The seed and the importer write the lots of their own books.
    const seeded = await createBook({ name: "Seeded" });
    await cli("seed", "--book-id", String(seeded.id));
    const imported = await createBook({ name: "Imported" });
    await cli(
      "import-moneydance", path.resolve("tests/fixtures/moneydance-sample.json"), "--book-id", String(imported.id)
    );

    const expected = await snapshot();
    expect(expected.lots.length).toBeGreaterThan(20);
    expect(expected.allocations.length).toBeGreaterThan(5);
    expect(expected.lots.some((lot) => lot.closedTransactionId !== null)).toBe(true);
    for (const book of [1, seeded.id, imported.id]) {
      expect(expected.lots.some((lot) => lot.bookId === book), `lots of book ${book}`).toBe(true);
    }
    const lotIds = await rows<{ id: number }>("SELECT id FROM investment_lots ORDER BY id");

    // A forced rebuild deletes every lot and writes each pair again.
    const pairs = await scalar<number>(`
      SELECT COUNT(*) FROM (SELECT DISTINCT book_id, account_id, security_id FROM investment_splits
        WHERE action IN ('buy', 'sell') AND account_id IS NOT NULL)`);
    const { stdout } = await rustRebuild("--force");
    expect(stdout.trim()).toBe(`Lot rebuild: ${pairs} pair(s) across 3 book(s).`);
    const rebuiltIds = await rows<{ id: number }>("SELECT id FROM investment_lots ORDER BY id");
    expect(rebuiltIds).toHaveLength(lotIds.length);
    expect(rebuiltIds).not.toEqual(lotIds);
    expect(await snapshot()).toEqual(expected);
  }, 120_000);

  it("keeps the deploy guard: skip when allocations exist or nothing trades", async () => {
    expect((await rustRebuild()).stdout.trim()).toBe("Lot rebuild: already populated, skipping.");
    await createEdgeCases();
    expect((await rustRebuild()).stdout.trim()).toBe("Lot rebuild: 2 pair(s) across 1 book(s).");
    const built = await snapshot();
    expect((await rustRebuild()).stdout.trim()).toBe("Lot rebuild: already populated, skipping.");
    expect(await snapshot()).toEqual(built);
  });

  it("exits 1 and commits no pair when a later pair fails", async () => {
    const { brokerage, ira } = await createEdgeCases();
    expect(brokerage.id).toBeLessThan(ira.id);
    // Pairs rebuild in account order, so the brokerage pair is written before
    // this trigger refuses the IRA pair.
    await script(`CREATE TRIGGER refuse_edge_lot BEFORE INSERT ON investment_lots
      WHEN NEW.account_id = ${ira.id} BEGIN SELECT RAISE(ABORT, 'refused for the test'); END;`);
    try {
      await expect(rustRebuild()).rejects.toMatchObject({
        code: 1, stderr: expect.stringContaining("Lot rebuild FAILED"),
      });
    } finally {
      await script("DROP TRIGGER IF EXISTS refuse_edge_lot");
    }
    expect((await snapshot()).lots).toEqual([]);
  });
});
