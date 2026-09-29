import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { sql } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { backfillLots } from "../../scripts/rebuild-lots";
import {
  createAccount, createBook, createInvestmentSplit, createSecurity, createTransactionWithSplits,
  db, resetTestDatabase, setupTestDatabase,
} from "../helpers/db-utils";
import { workerDatabaseUrl } from "../helpers/database-safety";

const run = promisify(execFile);
const CLI = path.resolve("rust-api/target/debug/ledger-cli");

/** Run a `ledger-cli` command against this worker's database, in this process's zone. */
async function cli(...args: string[]) {
  return run(CLI, args, {
    env: {
      ...process.env,
      DATABASE_URL: workerDatabaseUrl(),
      TZ: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
  });
}

/** Run the Rust backfill. */
async function rustRebuild(...args: string[]) {
  return cli("rebuild-lots", ...args);
}

/**
 * Every lot and allocation, in insertion order, without the serial IDs that
 * differ between two runs. An allocation names its lot by the buy split that
 * opened it, which is unique per lot.
 */
async function snapshot() {
  const lots = await db.execute(sql`
    select book_id, account_id, security_id, acquired_date, opened_split_id,
           opened_transaction_id, closed_transaction_id, original_shares_micros,
           original_basis_cents, remaining_shares_micros, remaining_basis_cents
    from investment_lots order by id`);
  const allocations = await db.execute(sql`
    select a.book_id, l.opened_split_id, a.sell_split_id, a.transaction_id,
           a.shares_micros, a.basis_cents, a.proceeds_cents
    from investment_lot_allocations a join investment_lots l on l.id = a.lot_id
    order by a.id`);
  return { lots: [...lots], allocations: [...allocations] };
}

/** Pairs the seed and the importer do not produce. The seed and the import
 * come from `ledger-cli`; the TypeScript backfill still runs in the Docker
 * entrypoint, so both backfills must write the same lots. */
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

describe("rebuild-lots parity between the TypeScript script and the Rust CLI", () => {
  beforeAll(async () => { await setupTestDatabase(); }, 120_000);
  beforeEach(async () => { await resetTestDatabase(); });

  it("writes identical lots and allocations for seeded, imported, and edge-case books", async () => {
    await cli("seed", "--book-id", "1");
    await createEdgeCases();
    const imported = await createBook({ name: "Imported" });
    await cli(
      "import-moneydance", path.resolve("tests/fixtures/moneydance-sample.json"), "--book-id", String(imported.id)
    );

    const node = await backfillLots(db, { force: true });
    const expected = await snapshot();
    expect(expected.lots.length).toBeGreaterThan(20);
    expect(expected.allocations.length).toBeGreaterThan(5);
    expect(expected.lots.some((lot) => lot.closed_transaction_id !== null)).toBe(true);

    const { stdout } = await rustRebuild("--force");
    expect(stdout.trim()).toBe(
      `Lot rebuild: ${node.pairsRebuilt} pair(s) across ${node.booksProcessed} book(s).`
    );
    expect(await snapshot()).toEqual(expected);
  }, 120_000);

  it("keeps the TypeScript guard: skip when allocations exist or nothing trades", async () => {
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
    await db.execute(sql.raw(`
      create function refuse_edge_lot() returns trigger language plpgsql as $$
      begin
        if new.account_id = ${ira.id} then raise exception 'refused for the test'; end if;
        return new;
      end $$;
      create trigger refuse_edge_lot before insert on investment_lots
        for each row execute function refuse_edge_lot();`));
    try {
      await expect(rustRebuild()).rejects.toMatchObject({
        code: 1, stderr: expect.stringContaining("Lot rebuild FAILED"),
      });
    } finally {
      await db.execute(sql.raw(`
        drop trigger refuse_edge_lot on investment_lots;
        drop function refuse_edge_lot();`));
    }
    expect((await snapshot()).lots).toEqual([]);
  });
});
