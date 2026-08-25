import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  setupTestDatabase,
  resetTestDatabase,
  createBook,
  createAccount,
  createTransactionWithSplits,
  createInvestmentSplit,
  createSecurityPrice,
  createSecurity as seedSecurity,
} from "@/tests/helpers/db-utils";
import { getDb } from "@/db";
import { books, securityPrices } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import {
  setSecurityPrices,
  updateSecurityPrice,
  deleteSecurityPrice,
  listPricesDue,
  PriceEntryNotFoundError,
  PriceEntryConflictError,
} from "@/lib/security-prices";
import { SecurityValidationError, SecurityNotFoundError } from "@/lib/securities";

describe("security prices shared logic", () => {
  let bookId: number;

  beforeAll(async () => {
    await setupTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
    const db = getDb();
    const [book] = await db.select().from(books).limit(1);
    bookId = book.id;
  });

  describe("setSecurityPrices", () => {
    it("inserts new prices and reports the count written", async () => {
      const db = getDb();
      const sec = await seedSecurity({ bookId, name: "A", symbol: "AAA", securityType: "etf" });

      const result = await setSecurityPrices(db, bookId, [
        { securityId: sec.id, priceMicros: 1_500_000, priceDate: "2026-01-15" },
      ]);

      expect(result.count).toBe(1);
      expect(result.discarded).toEqual([]);
      const [row] = await db
        .select()
        .from(securityPrices)
        .where(and(eq(securityPrices.securityId, sec.id), eq(securityPrices.priceDate, "2026-01-15")));
      expect(row.priceMicros).toBe(1_500_000);
      expect(row.source).toBe("manual");
    });

    it("overwrites an existing price for the same security and date", async () => {
      const db = getDb();
      const sec = await seedSecurity({ bookId, name: "A", symbol: "AAA", securityType: "etf" });
      await setSecurityPrices(db, bookId, [
        { securityId: sec.id, priceMicros: 1_000_000, priceDate: "2026-01-15" },
      ]);

      await setSecurityPrices(db, bookId, [
        { securityId: sec.id, priceMicros: 2_000_000, priceDate: "2026-01-15" },
      ]);

      const rows = await db
        .select()
        .from(securityPrices)
        .where(and(eq(securityPrices.securityId, sec.id), eq(securityPrices.priceDate, "2026-01-15")));
      expect(rows).toHaveLength(1);
      expect(rows[0].priceMicros).toBe(2_000_000);
    });

    it("reports malformed items as discarded and still writes the valid ones", async () => {
      const db = getDb();
      const sec = await seedSecurity({ bookId, name: "A", symbol: "AAA", securityType: "etf" });

      const result = await setSecurityPrices(db, bookId, [
        { securityId: sec.id, priceMicros: 1_000_000, priceDate: "2026-01-15" },
        { securityId: sec.id, priceMicros: -5, priceDate: "2026-01-16" },
        { securityId: sec.id, priceMicros: 1_000_000, priceDate: "2026-02-30" },
      ]);

      expect(result.count).toBe(1);
      expect(result.discarded.map((d) => d.index)).toEqual([1, 2]);
      const rows = await db.select().from(securityPrices);
      expect(rows).toHaveLength(1);
    });

    it("refuses a batch containing a security from another book and writes nothing", async () => {
      const db = getDb();
      const mine = await seedSecurity({ bookId, name: "Mine", symbol: "MINE", securityType: "etf" });
      const other = await createBook({ name: "Other" });
      const theirs = await seedSecurity({
        bookId: other.id, name: "Theirs", symbol: "THRS", securityType: "etf",
      });

      await expect(
        setSecurityPrices(db, bookId, [
          { securityId: mine.id, priceMicros: 1_000_000, priceDate: "2026-01-15" },
          { securityId: theirs.id, priceMicros: 1_000_000, priceDate: "2026-01-15" },
        ])
      ).rejects.toThrow(SecurityValidationError);

      // The valid item must not have been written either.
      const rows = await db.select().from(securityPrices);
      expect(rows).toHaveLength(0);
    });

    it("discards a fractional or oversized priceMicros instead of aborting the batch", async () => {
      // This replaces an earlier test that passed priceMicros: 1e30 expecting
      // it to survive validation and blow up inside the transaction, proving
      // rollback. priceUpdateItemSchema.priceMicros is now `.int()`, and zod
      // bounds `.int()` to the SAFE integer range (< 2^53) — comfortably
      // inside bigint's (< 2^63). So no value that passes the schema can fail
      // at the INSERT any more, and there is no longer an input that reaches
      // a mid-loop failure. That is the point: a malformed price is reported
      // in `discarded` rather than taking every valid item in the batch down
      // with it. The db.transaction wrapper in setSecurityPrices stays as
      // defence for a future column or constraint that CAN fail mid-loop; it
      // is simply no longer reachable from input, so nothing here exercises
      // it.
      const db = getDb();
      const sec = await seedSecurity({ bookId, name: "A", symbol: "AAA", securityType: "etf" });

      const result = await setSecurityPrices(db, bookId, [
        { securityId: sec.id, priceMicros: 1_000_000, priceDate: "2026-01-15" },
        { securityId: sec.id, priceMicros: 1.5, priceDate: "2026-01-16" },
        { securityId: sec.id, priceMicros: 1e30, priceDate: "2026-01-17" },
      ]);

      expect(result.count).toBe(1);
      expect(result.discarded.map((d) => d.index)).toEqual([1, 2]);

      // The valid item is written — the malformed ones did not take it down.
      const rows = await db.select().from(securityPrices);
      expect(rows).toHaveLength(1);
      expect(rows[0].priceDate).toBe("2026-01-15");
    });

    it("throws when no item survives validation", async () => {
      const db = getDb();

      await expect(setSecurityPrices(db, bookId, [{ nonsense: true }])).rejects.toThrow(
        "No valid price updates provided"
      );
    });
  });

  describe("updateSecurityPrice", () => {
    it("updates the price in place when the date is unchanged", async () => {
      const db = getDb();
      const sec = await seedSecurity({ bookId, name: "A", symbol: "AAA", securityType: "etf" });
      await setSecurityPrices(db, bookId, [
        { securityId: sec.id, priceMicros: 1_000_000, priceDate: "2026-01-15" },
      ]);

      await updateSecurityPrice(db, bookId, sec.id, "2026-01-15", {
        priceDate: "2026-01-15",
        priceMicros: 2_000_000,
        source: "manual",
      });

      const rows = await db.select().from(securityPrices).where(eq(securityPrices.securityId, sec.id));
      expect(rows).toHaveLength(1);
      expect(rows[0].priceMicros).toBe(2_000_000);
    });

    it("moves the entry when the date changes", async () => {
      const db = getDb();
      const sec = await seedSecurity({ bookId, name: "A", symbol: "AAA", securityType: "etf" });
      await setSecurityPrices(db, bookId, [
        { securityId: sec.id, priceMicros: 1_000_000, priceDate: "2026-01-15" },
      ]);

      await updateSecurityPrice(db, bookId, sec.id, "2026-01-15", {
        priceDate: "2026-01-20",
        priceMicros: 1_000_000,
        source: null,
      });

      const rows = await db.select().from(securityPrices).where(eq(securityPrices.securityId, sec.id));
      expect(rows).toHaveLength(1);
      expect(rows[0].priceDate).toBe("2026-01-20");
    });

    it("throws SecurityNotFoundError for a security in another book", async () => {
      const db = getDb();
      const other = await createBook({ name: "Other" });
      const theirs = await seedSecurity({
        bookId: other.id, name: "T", symbol: "THRS", securityType: "etf",
      });

      await expect(
        updateSecurityPrice(db, bookId, theirs.id, "2026-01-15", {
          priceDate: "2026-01-15", priceMicros: 1, source: null,
        })
      ).rejects.toThrow(SecurityNotFoundError);
    });

    it("throws PriceEntryNotFoundError when there is no entry for that date", async () => {
      const db = getDb();
      const sec = await seedSecurity({ bookId, name: "A", symbol: "AAA", securityType: "etf" });

      await expect(
        updateSecurityPrice(db, bookId, sec.id, "2026-01-15", {
          priceDate: "2026-01-15", priceMicros: 1_000_000, source: null,
        })
      ).rejects.toThrow(PriceEntryNotFoundError);
    });

    it("refuses to move a price onto a date that already has one", async () => {
      const db = getDb();
      const sec = await seedSecurity({ bookId, name: "A", symbol: "AAA", securityType: "etf" });
      await createSecurityPrice({
        bookId, securityId: sec.id, priceDate: "2026-02-08", priceMicros: 100_000_000,
      });
      await createSecurityPrice({
        bookId, securityId: sec.id, priceDate: "2026-02-09", priceMicros: 101_000_000,
      });

      await expect(
        updateSecurityPrice(db, bookId, sec.id, "2026-02-08", {
          priceDate: "2026-02-09",
          priceMicros: 102_000_000,
        })
      ).rejects.toBeInstanceOf(PriceEntryConflictError);

      // The delete and the insert share a transaction, so a refusal must leave
      // both dates exactly as they were.
      const rows = await db
        .select()
        .from(securityPrices)
        .where(eq(securityPrices.securityId, sec.id));
      expect(rows).toHaveLength(2);
      expect(rows.find((r) => r.priceDate === "2026-02-08")?.priceMicros).toBe(100_000_000);
      expect(rows.find((r) => r.priceDate === "2026-02-09")?.priceMicros).toBe(101_000_000);
    });
  });

  describe("deleteSecurityPrice", () => {
    it("deletes the entry for that security and date", async () => {
      const db = getDb();
      const sec = await seedSecurity({ bookId, name: "A", symbol: "AAA", securityType: "etf" });
      await setSecurityPrices(db, bookId, [
        { securityId: sec.id, priceMicros: 1_000_000, priceDate: "2026-01-15" },
      ]);

      await deleteSecurityPrice(db, bookId, sec.id, "2026-01-15");

      const rows = await db.select().from(securityPrices).where(eq(securityPrices.securityId, sec.id));
      expect(rows).toHaveLength(0);
    });

    it("throws PriceEntryNotFoundError when nothing is there, and deletes nothing", async () => {
      const db = getDb();
      const sec = await seedSecurity({ bookId, name: "A", symbol: "AAA", securityType: "etf" });
      await setSecurityPrices(db, bookId, [
        { securityId: sec.id, priceMicros: 1_000_000, priceDate: "2026-01-15" },
      ]);

      await expect(deleteSecurityPrice(db, bookId, sec.id, "2026-01-20")).rejects.toThrow(
        PriceEntryNotFoundError
      );

      const rows = await db.select().from(securityPrices).where(eq(securityPrices.securityId, sec.id));
      expect(rows).toHaveLength(1);
    });

    it("throws SecurityNotFoundError for a security in another book and leaves that book's price untouched", async () => {
      // requireSecurityInBook is the only thing that keeps deleteSecurityPrice's
      // own DELETE — which filters on (securityId, priceDate) alone, with no
      // bookId term — from reaching a row that belongs to a different book.
      const db = getDb();
      const other = await createBook({ name: "Other" });
      const theirs = await seedSecurity({
        bookId: other.id, name: "Theirs", symbol: "THRS", securityType: "etf",
      });
      await setSecurityPrices(db, other.id, [
        { securityId: theirs.id, priceMicros: 1_000_000, priceDate: "2026-01-15" },
      ]);

      await expect(deleteSecurityPrice(db, bookId, theirs.id, "2026-01-15")).rejects.toThrow(
        SecurityNotFoundError
      );

      const rows = await db
        .select()
        .from(securityPrices)
        .where(and(eq(securityPrices.securityId, theirs.id), eq(securityPrices.priceDate, "2026-01-15")));
      expect(rows).toHaveLength(1);
    });
  });

  describe("listPricesDue", () => {
    it("returns an empty result when the book has no manually-priced securities", async () => {
      const db = getDb();
      await seedSecurity({ bookId, name: "Auto", symbol: "AUTO", securityType: "etf", fetchPrices: true });

      const result = await listPricesDue(db, bookId);

      expect(result.dueDate).toBeNull();
      expect(result.securities).toEqual([]);
    });

    it("excludes fixed-price securities from the manually-priced population", async () => {
      const db = getDb();
      await seedSecurity({
        bookId, name: "Money Market", symbol: "MMF", securityType: "mutual_fund",
        fetchPrices: false, fixedPriceMicros: 1_000_000,
      });

      const result = await listPricesDue(db, bookId);

      expect(result.dueDate).toBeNull();
      expect(result.securities).toEqual([]);
    });

    it("lists a manually-priced security with an open position and a stale price", async () => {
      const db = getDb();
      const account = await createAccount({
        bookId, name: "Brokerage", type: "asset", subtype: "investment",
      });
      const auto = await seedSecurity({
        bookId, name: "Auto", symbol: "AUTO", securityType: "etf", fetchPrices: true,
      });
      const manual = await seedSecurity({
        bookId, name: "Option", symbol: "OPT", securityType: "stock", fetchPrices: false,
      });
      // The newest auto-fetched price is what defines the due date.
      await createSecurityPrice({ bookId, securityId: auto.id, priceDate: "2026-03-10", priceMicros: 1_000_000 });

      const txn = await createTransactionWithSplits({
        bookId, date: "2026-01-15", description: "Buy",
        splits: [
          { accountId: account.id, amount: 100000 },
          { accountId: account.id, amount: -100000 },
        ],
      });
      await createInvestmentSplit({
        bookId, transactionId: txn.id, accountId: account.id, securityId: manual.id,
        action: "buy", sharesMicros: 10_000_000, priceMicros: 10_000_000,
      });

      const result = await listPricesDue(db, bookId);

      expect(result.dueDate).toBe("2026-03-10");
      expect(result.securities.map((s) => s.symbol)).toEqual(["OPT"]);
    });
  });
});
