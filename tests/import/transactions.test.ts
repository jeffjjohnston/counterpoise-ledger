import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { transactions, transactionSplits } from "@/db/schema";
import { importTransactions } from "@/scripts/import-moneydance/parsers/transactions";
import { IdMapper, type MoneydanceTransaction, type ImportOptions } from "@/scripts/import-moneydance/types";
import { createAccount, resetTestDatabase, setupTestDatabase } from "@/tests/helpers/db";

const db = getDb();

const options: ImportOptions = {
  dryRun: false,
  importInactive: false,
  importHidden: false,
  verbose: false,
};

describe("Moneydance standard transaction import", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("imports check numbers when available", async () => {
    const checking = await createAccount({
      name: "Checking",
      type: "asset",
      subtype: "bank",
    });
    const rent = await createAccount({
      name: "Rent",
      type: "expense",
    });

    const idMapper = new IdMapper();
    idMapper.setAccount("md-checking", checking.id);
    idMapper.setAccount("md-rent", rent.id);

    const txn: MoneydanceTransaction = {
      obj_type: "txn",
      id: "txn-1",
      dt: "20240105",
      desc: "Rent",
      acctid: "md-checking",
      chk: "1234",
      "0.id": "split-1",
      "0.acctid": "md-rent",
      "0.desc": "Rent",
      "0.samt": "150000",
      "0.pamt": "-150000",
    };

    const stats = await importTransactions([txn], idMapper, options, db, 1);
    expect(stats.imported).toBe(1);
    expect(stats.errors).toHaveLength(0);

    const importedTransactions = await db.query.transactions.findMany();
    expect(importedTransactions).toHaveLength(1);
    expect(importedTransactions[0].checkNumber).toBe("1234");
  });

  it("writes no splits when a transaction's splits are rejected", async () => {
    // Both split amounts are balanced (they sum to zero) and pass every
    // application-level check, but at 3,000,000,000 they exceed Postgres's
    // int4 range for transaction_splits.amount. The insert fails only after
    // the transaction row has already been created, which is the same shape
    // as any mid-sequence failure: the row lands, its splits do not, and the
    // books are silently unbalanced unless the writes are atomic.
    const checking = await createAccount({
      name: "Checking",
      type: "asset",
      subtype: "bank",
    });
    const rent = await createAccount({
      name: "Rent",
      type: "expense",
    });

    const idMapper = new IdMapper();
    idMapper.setAccount("md-checking", checking.id);
    idMapper.setAccount("md-rent", rent.id);

    const txn: MoneydanceTransaction = {
      obj_type: "txn",
      id: "txn-overflow",
      dt: "20240105",
      desc: "Overflow",
      acctid: "md-checking",
      "0.id": "split-1",
      "0.acctid": "md-rent",
      "0.desc": "Overflow",
      // pamt drives the PARENT split and stays in range so that insert
      // succeeds; samt drives the numbered split and overflows int4. The
      // failure therefore lands after a split has already been written, which
      // is what makes both the rollback and the counter assertions meaningful.
      // An overflowing pamt would fail on the very first insert and prove
      // nothing about either.
      "0.samt": "3000000000",
      "0.pamt": "-100",
    };

    const before = await db.select().from(transactions).where(eq(transactions.bookId, 1));

    const stats = await importTransactions([txn], idMapper, options, db, 1);
    expect(stats.imported).toBe(0);
    expect(stats.errors.length).toBeGreaterThan(0);

    const after = await db.select().from(transactions).where(eq(transactions.bookId, 1));
    expect(after).toHaveLength(before.length);

    // Direct, not a leftJoin for orphans: with the rollback working there are
    // no transaction rows at all, so an orphan join returns zero either way and
    // asserts nothing.
    const splitsWritten = await db
      .select()
      .from(transactionSplits)
      .where(eq(transactionSplits.bookId, 1));
    expect(splitsWritten).toHaveLength(0);

    // The parent split inserts successfully before the numbered split overflows.
    // Counting inside the transaction callback would report that split as
    // created even though it was rolled back with everything else.
    expect(stats.splits).toBe(0);
  });
});

