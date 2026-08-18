import { describe, it, expect, beforeEach } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { eq, and, sql } from "drizzle-orm";
import { setupTestDatabase, resetTestDatabase } from "../helpers/db";
import { db } from "../helpers/db-utils";
import { runImport } from "@/scripts/import-moneydance/index";
import type { MoneydanceExport, ImportOptions } from "@/scripts/import-moneydance/types";
import {
  accounts,
  transactions,
  transactionSplits,
  securities,
  securityPrices,
  investmentSplits,
  investmentLots,
  investmentLotAllocations,
  payees,
  recurringRules,
} from "@/db/schema";

const BOOK_ID = 1;
const OPTIONS: ImportOptions = {
  dryRun: false,
  importInactive: true,
  importHidden: true,
  verbose: false,
};

async function loadFixture(): Promise<MoneydanceExport> {
  const raw = await readFile(
    path.join(process.cwd(), "tests/fixtures/moneydance-sample.json"),
    "utf-8"
  );
  return JSON.parse(raw) as MoneydanceExport;
}

describe("full Moneydance import", () => {
  beforeEach(async () => {
    await setupTestDatabase();
    await resetTestDatabase();
  });

  it("imports the fixture without errors", async () => {
    const result = await runImport(await loadFixture(), BOOK_ID, OPTIONS, db);

    expect(result.accounts.errors).toEqual([]);
    expect(result.transactions.errors).toEqual([]);
    expect(result.investments.errors).toEqual([]);
    expect(result.prices.errors).toEqual([]);
    expect(result.stockSplits.errors).toEqual([]);
    expect(result.reminders.errors).toEqual([]);
  });

  it("maps all ten Moneydance account types", async () => {
    await runImport(await loadFixture(), BOOK_ID, OPTIONS, db);

    const rows = await db.select().from(accounts).where(eq(accounts.bookId, BOOK_ID));
    const byName = new Map(rows.map((r) => [r.name, r]));

    expect(byName.get("Checking")).toMatchObject({ type: "asset", subtype: "bank" });
    expect(byName.get("Credit Card")).toMatchObject({ type: "liability", subtype: "credit_card" });
    expect(byName.get("Brokerage")).toMatchObject({ type: "asset", subtype: "investment" });
    expect(byName.get("Salary")).toMatchObject({ type: "income" });
    expect(byName.get("Groceries")).toMatchObject({ type: "expense" });
    expect(byName.get("Car")).toMatchObject({ type: "asset", subtype: "other" });
    expect(byName.get("Mortgage")).toMatchObject({ type: "liability", subtype: "loan" });
    expect(byName.get("Auto Loan")).toMatchObject({ type: "liability", subtype: "loan" });

    // Root is skipped; securities become `securities` rows, not accounts.
    expect(byName.has("Sample Book")).toBe(false);

    // The investment account gets an auto-created cash sibling.
    expect(rows.some((r) => r.isInvestmentCash)).toBe(true);
  });

  it("creates the three securities with their tickers", async () => {
    await runImport(await loadFixture(), BOOK_ID, OPTIONS, db);

    const rows = await db.select().from(securities).where(eq(securities.bookId, BOOK_ID));
    expect(rows.map((r) => r.symbol).sort()).toEqual(["BND", "VTI", "VXUS"]);
    expect(rows.every((r) => r.securityType === "etf")).toBe(true);
  });

  it("deduplicates payees whose descriptions differ only in whitespace", async () => {
    await runImport(await loadFixture(), BOOK_ID, OPTIONS, db);

    // The fixture spells the grocer "Green Grocer" once and
    // "  Green   Grocer  " once. Both normalizers — the importer's
    // normalizeName and the app's normalizePayeeName — trim and collapse
    // whitespace runs, so these are one payee.
    //
    // Neither normalizer lowercases, deliberately: "IKEA" and "Ikea" stay
    // distinct payees. So this asserts whitespace folding, not case folding.
    const rows = await db.select().from(payees).where(eq(payees.bookId, BOOK_ID));
    const grocers = rows.filter((r) => r.name === "Green Grocer");
    expect(grocers).toHaveLength(1);
  });

  it("leaves every transaction balanced", async () => {
    await runImport(await loadFixture(), BOOK_ID, OPTIONS, db);

    // The invariant the whole application rests on: splits sum to zero per
    // transaction. One query, and it catches any phase that writes an
    // unbalanced transaction regardless of which one introduced it.
    const unbalanced = await db
      .select({
        transactionId: transactionSplits.transactionId,
        total: sql<number>`cast(sum(${transactionSplits.amount}) as integer)`,
      })
      .from(transactionSplits)
      .where(eq(transactionSplits.bookId, BOOK_ID))
      .groupBy(transactionSplits.transactionId)
      .having(sql`sum(${transactionSplits.amount}) <> 0`);

    expect(unbalanced).toEqual([]);
  });

  it("records opening balances for accounts carrying sbal", async () => {
    const result = await runImport(await loadFixture(), BOOK_ID, OPTIONS, db);

    expect(result.openingBalances.errors).toEqual([]);
    expect(result.openingBalances.created).toBeGreaterThan(0);
  });

  it("imports the security price history", async () => {
    await runImport(await loadFixture(), BOOK_ID, OPTIONS, db);

    const rows = await db
      .select()
      .from(securityPrices)
      .where(eq(securityPrices.bookId, BOOK_ID));
    expect(rows).toHaveLength(6);

    // relrt is the INVERSE of the price: "0.02" -> $50.00 -> 50_000_000 micros.
    const vti = rows.find((r) => r.priceDate === "2024-01-15");
    expect(vti?.priceMicros).toBe(50_000_000);
  });

  it("records the stock split as a split-action investment split", async () => {
    await runImport(await loadFixture(), BOOK_ID, OPTIONS, db);

    const rows = await db
      .select()
      .from(investmentSplits)
      .where(and(eq(investmentSplits.bookId, BOOK_ID), eq(investmentSplits.action, "split")));

    expect(rows).toHaveLength(1);
    expect(rows[0].splitNumerator).toBe(2);
    expect(rows[0].splitDenominator).toBe(1);
  });

  it("rebuilds VTI lots against POST-split share counts", async () => {
    await runImport(await loadFixture(), BOOK_ID, OPTIONS, db);

    const [vti] = await db
      .select()
      .from(securities)
      .where(and(eq(securities.bookId, BOOK_ID), eq(securities.symbol, "VTI")));

    const lots = await db
      .select()
      .from(investmentLots)
      .where(and(eq(investmentLots.bookId, BOOK_ID), eq(investmentLots.securityId, vti.id)))
      .orderBy(investmentLots.acquiredDate);

    expect(lots).toHaveLength(2);

    // Lot A: bought 100 sh @ $50 with a $5 fee capitalized -> $5,005.00 basis.
    // The 2:1 split doubles shares to 200 and leaves basis untouched, so the
    // per-share basis is $25.025. Selling 60 leaves 140.
    expect(lots[0].acquiredDate).toBe("2024-01-15");
    expect(lots[0].originalSharesMicros).toBe(200_000_000);
    expect(lots[0].originalBasisCents).toBe(500_500);
    expect(lots[0].remainingSharesMicros).toBe(140_000_000);
    expect(lots[0].remainingBasisCents).toBe(350_350);

    // Lot B: 40 sh @ $55, no fee -> $2,200.00. Doubles to 80, untouched by the
    // sell because FIFO consumed Lot A first.
    expect(lots[1].acquiredDate).toBe("2024-02-20");
    expect(lots[1].originalSharesMicros).toBe(80_000_000);
    expect(lots[1].remainingSharesMicros).toBe(80_000_000);
    expect(lots[1].remainingBasisCents).toBe(220_000);
  });

  it("allocates the sell to the oldest lot with the right basis and gain", async () => {
    await runImport(await loadFixture(), BOOK_ID, OPTIONS, db);

    const allocations = await db
      .select()
      .from(investmentLotAllocations)
      .where(eq(investmentLotAllocations.bookId, BOOK_ID));

    expect(allocations).toHaveLength(1);
    const [allocation] = allocations;

    expect(allocation.sharesMicros).toBe(60_000_000);
    expect(allocation.basisCents).toBe(150_150);   // 60 x $25.025
    expect(allocation.proceedsCents).toBe(180_000); // 60 x $30.00
    // Realized gain is never stored — it is proceeds minus basis.
    expect(allocation.proceedsCents - allocation.basisCents).toBe(29_850);
  });

  it("creates a recurring rule per reminder", async () => {
    await runImport(await loadFixture(), BOOK_ID, OPTIONS, db);

    const rules = await db
      .select()
      .from(recurringRules)
      .where(eq(recurringRules.bookId, BOOK_ID));

    expect(rules).toHaveLength(2);
    expect(rules.map((r) => r.name).sort()).toEqual(["Annual Insurance", "City Power"]);
  });

  it("imports every fixture transaction", async () => {
    await runImport(await loadFixture(), BOOK_ID, OPTIONS, db);

    const rows = await db
      .select()
      .from(transactions)
      .where(eq(transactions.bookId, BOOK_ID));

    // 12 fixture transactions, plus opening balances, plus the stock split.
    expect(rows.length).toBeGreaterThanOrEqual(12);
  });
});
