// tests/lib/securities.test.ts
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  setupTestDatabase,
  resetTestDatabase,
  createBook,
  createAccount,
  createTransactionWithSplits,
  createInvestmentSplit,
  createSecurity as seedSecurity,
} from "@/tests/helpers/db-utils";
import { getDb } from "@/db";
import { books, securities } from "@/db/schema";
import { eq } from "drizzle-orm";
import {
  createSecurity,
  listSecurities,
  updateSecurity,
  deleteSecurity,
  SecurityValidationError,
  SecurityDuplicateError,
  SecurityNotFoundError,
} from "@/lib/securities";

describe("securities shared logic", () => {
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

  describe("createSecurity", () => {
    it("creates a security with required fields and returns it", async () => {
      const db = getDb();
      const result = await createSecurity(db, bookId, {
        name: "Vanguard Total Stock",
        symbol: "VTI",
        securityType: "etf",
      });

      expect(result.id).toBeDefined();
      expect(result.name).toBe("Vanguard Total Stock");
      expect(result.symbol).toBe("VTI");
      expect(result.securityType).toBe("etf");
      expect(result.bookId).toBe(bookId);
      // fetchPrices defaults to true at the DB level when not provided
      expect(result.fetchPrices).toBe(true);
    });

    it("respects fetchPrices when explicitly provided", async () => {
      const db = getDb();
      const result = await createSecurity(db, bookId, {
        name: "My Fund",
        symbol: "MYF",
        securityType: "mutual_fund",
        fetchPrices: false,
      });

      expect(result.fetchPrices).toBe(false);
    });

    it("trims whitespace from name and symbol", async () => {
      const db = getDb();
      const result = await createSecurity(db, bookId, {
        name: "  Spaced  ",
        symbol: "  SPC  ",
        securityType: "stock",
      });

      expect(result.name).toBe("Spaced");
      expect(result.symbol).toBe("SPC");
    });

    it("throws SecurityValidationError when name is missing", async () => {
      const db = getDb();
      await expect(
        createSecurity(db, bookId, {
          name: "",
          symbol: "VTI",
          securityType: "etf",
        })
      ).rejects.toBeInstanceOf(SecurityValidationError);
    });

    it("throws SecurityValidationError when name is only whitespace", async () => {
      const db = getDb();
      await expect(
        createSecurity(db, bookId, {
          name: "   ",
          symbol: "VTI",
          securityType: "etf",
        })
      ).rejects.toBeInstanceOf(SecurityValidationError);
    });

    it("throws SecurityValidationError when symbol is missing", async () => {
      const db = getDb();
      await expect(
        createSecurity(db, bookId, {
          name: "Vanguard",
          symbol: "",
          securityType: "etf",
        })
      ).rejects.toBeInstanceOf(SecurityValidationError);
    });

    it("throws SecurityValidationError when securityType is missing", async () => {
      const db = getDb();
      await expect(
        createSecurity(db, bookId, {
          name: "Vanguard",
          symbol: "VTI",
          // @ts-expect-error intentional missing field
          securityType: undefined,
        })
      ).rejects.toBeInstanceOf(SecurityValidationError);
    });

    it("throws SecurityValidationError when securityType is invalid", async () => {
      const db = getDb();
      await expect(
        createSecurity(db, bookId, {
          name: "Vanguard",
          symbol: "VTI",
          // @ts-expect-error intentional bad value
          securityType: "bond",
        })
      ).rejects.toBeInstanceOf(SecurityValidationError);
    });

    it("throws SecurityDuplicateError on exact-case symbol match", async () => {
      const db = getDb();
      await createSecurity(db, bookId, {
        name: "Vanguard Total Stock",
        symbol: "VTI",
        securityType: "etf",
      });

      await expect(
        createSecurity(db, bookId, {
          name: "Different Name",
          symbol: "VTI",
          securityType: "etf",
        })
      ).rejects.toBeInstanceOf(SecurityDuplicateError);
    });

    it("throws SecurityDuplicateError on case-insensitive symbol match", async () => {
      const db = getDb();
      await createSecurity(db, bookId, {
        name: "Vanguard Total Stock",
        symbol: "VTI",
        securityType: "etf",
      });

      await expect(
        createSecurity(db, bookId, {
          name: "Different",
          symbol: "vti",
          securityType: "etf",
        })
      ).rejects.toBeInstanceOf(SecurityDuplicateError);
    });

    it("allows the same symbol in a different book", async () => {
      const db = getDb();
      const secondBook = await createBook({
        name: "Second Book",
        userId: 1,
      });

      await createSecurity(db, bookId, {
        name: "Vanguard Total Stock",
        symbol: "VTI",
        securityType: "etf",
      });

      const result = await createSecurity(db, secondBook.id, {
        name: "Vanguard Total Stock",
        symbol: "VTI",
        securityType: "etf",
      });

      expect(result.bookId).toBe(secondBook.id);

      // Confirm both rows exist
      const vtiRows = await db
        .select()
        .from(securities)
        .where(eq(securities.symbol, "VTI"));
      expect(vtiRows).toHaveLength(2);
    });
  });

  describe("listSecurities", () => {
    it("returns securities ordered by name with zeroed position fields when unheld", async () => {
      const db = getDb();
      await seedSecurity({ bookId, name: "Zebra Fund", symbol: "ZZZ", securityType: "etf" });
      await seedSecurity({ bookId, name: "Alpha Fund", symbol: "AAA", securityType: "etf" });

      const result = await listSecurities(db, bookId);

      expect(result.map((s) => s.symbol)).toEqual(["AAA", "ZZZ"]);
      expect(result[0].sharesMicros).toBe(0);
      expect(result[0].costBasisCents).toBe(0);
      expect(result[0].marketValueCents).toBeNull();
      expect(result[0].incomeCents).toBe(0);
    });

    it("does not return securities belonging to another book", async () => {
      const db = getDb();
      const other = await createBook({ name: "Other Book" });
      await seedSecurity({ bookId, name: "Mine", symbol: "MINE", securityType: "etf" });
      await seedSecurity({ bookId: other.id, name: "Theirs", symbol: "THRS", securityType: "etf" });

      const result = await listSecurities(db, bookId);

      expect(result.map((s) => s.symbol)).toEqual(["MINE"]);
    });
  });

  describe("updateSecurity", () => {
    it("updates only the fields provided", async () => {
      const db = getDb();
      const sec = await seedSecurity({ bookId, name: "Old Name", symbol: "OLD", securityType: "etf" });

      const result = await updateSecurity(db, bookId, sec.id, { name: "New Name" });

      expect(result.name).toBe("New Name");
      expect(result.symbol).toBe("OLD");
      expect(result.securityType).toBe("etf");
    });

    it("throws SecurityNotFoundError for a security in another book", async () => {
      const db = getDb();
      const other = await createBook({ name: "Other Book" });
      const theirs = await seedSecurity({
        bookId: other.id, name: "Theirs", symbol: "THRS", securityType: "etf",
      });

      await expect(updateSecurity(db, bookId, theirs.id, { name: "Hijacked" }))
        .rejects.toThrow(SecurityNotFoundError);

      // The row must be untouched, not merely the call rejected.
      const [after] = await db.select().from(securities).where(eq(securities.id, theirs.id));
      expect(after.name).toBe("Theirs");
    });

    it("throws SecurityValidationError for an empty input and leaves the row unchanged", async () => {
      const db = getDb();
      const sec = await seedSecurity({ bookId, name: "Untouched", symbol: "UNT", securityType: "etf" });

      await expect(updateSecurity(db, bookId, sec.id, {})).rejects.toBeInstanceOf(
        SecurityValidationError
      );

      const [after] = await db.select().from(securities).where(eq(securities.id, sec.id));
      expect(after.name).toBe("Untouched");
      expect(after.symbol).toBe("UNT");
    });

    it("forces fetchPrices off when a fixed price is set, and leaves it alone when cleared", async () => {
      const db = getDb();
      const sec = await seedSecurity({
        bookId, name: "Money Market", symbol: "MMF", securityType: "mutual_fund", fetchPrices: true,
      });

      const fixed = await updateSecurity(db, bookId, sec.id, { fixedPriceMicros: 1_000_000 });
      expect(fixed.fixedPriceMicros).toBe(1_000_000);
      expect(fixed.fetchPrices).toBe(false);

      const cleared = await updateSecurity(db, bookId, sec.id, { fixedPriceMicros: null });
      expect(cleared.fixedPriceMicros).toBeNull();
      expect(cleared.fetchPrices).toBe(false);
    });

    it("refuses to rename a symbol onto another security's, case-insensitively", async () => {
      const db = getDb();
      await seedSecurity({ bookId, name: "Vanguard Total", symbol: "VTI", securityType: "etf" });
      const bnd = await seedSecurity({ bookId, name: "Vanguard Bond", symbol: "BND", securityType: "etf" });

      await expect(
        updateSecurity(db, bookId, bnd.id, { symbol: "vti" })
      ).rejects.toBeInstanceOf(SecurityDuplicateError);

      const [after] = await db.select().from(securities).where(eq(securities.id, bnd.id));
      expect(after.symbol).toBe("BND");
    });

    it("refuses a symbol that only differs by surrounding whitespace", async () => {
      const db = getDb();
      await seedSecurity({ bookId, name: "Vanguard Total", symbol: "VTI", securityType: "etf" });
      const bnd = await seedSecurity({ bookId, name: "Vanguard Bond", symbol: "BND", securityType: "etf" });

      await expect(
        updateSecurity(db, bookId, bnd.id, { symbol: " vti " })
      ).rejects.toBeInstanceOf(SecurityDuplicateError);

      const [after] = await db.select().from(securities).where(eq(securities.id, bnd.id));
      expect(after.symbol).toBe("BND");
    });

    it("allows a security to keep its own symbol", async () => {
      const db = getDb();
      const vti = await seedSecurity({ bookId, name: "Vanguard Total", symbol: "VTI", securityType: "etf" });

      const updated = await updateSecurity(db, bookId, vti.id, {
        name: "Vanguard Total Stock Market",
        symbol: "VTI",
      });

      expect(updated.symbol).toBe("VTI");
      expect(updated.name).toBe("Vanguard Total Stock Market");
    });
  });

  describe("deleteSecurity", () => {
    it("deletes a security that has no investment transactions", async () => {
      const db = getDb();
      const sec = await seedSecurity({ bookId, name: "Unused", symbol: "UNU", securityType: "etf" });

      await deleteSecurity(db, bookId, sec.id);

      const rows = await db.select().from(securities).where(eq(securities.id, sec.id));
      expect(rows).toHaveLength(0);
    });

    it("refuses a security with investment transactions and leaves it in place", async () => {
      const db = getDb();
      const account = await createAccount({
        bookId, name: "Brokerage", type: "asset", subtype: "investment",
      });
      const sec = await seedSecurity({ bookId, name: "Held", symbol: "HELD", securityType: "etf" });
      const txn = await createTransactionWithSplits({
        bookId, date: "2026-01-15", description: "Buy",
        splits: [
          { accountId: account.id, amount: 100000 },
          { accountId: account.id, amount: -100000 },
        ],
      });
      await createInvestmentSplit({
        bookId, transactionId: txn.id, accountId: account.id, securityId: sec.id,
        action: "buy", sharesMicros: 10_000_000, priceMicros: 10_000_000,
      });

      await expect(deleteSecurity(db, bookId, sec.id)).rejects.toThrow(SecurityValidationError);

      const rows = await db.select().from(securities).where(eq(securities.id, sec.id));
      expect(rows).toHaveLength(1);
    });

    it("throws SecurityNotFoundError for a security in another book", async () => {
      const db = getDb();
      const other = await createBook({ name: "Other" });
      const theirs = await seedSecurity({
        bookId: other.id, name: "Theirs", symbol: "THRS", securityType: "etf",
      });

      await expect(deleteSecurity(db, bookId, theirs.id)).rejects.toThrow(SecurityNotFoundError);

      const rows = await db.select().from(securities).where(eq(securities.id, theirs.id));
      expect(rows).toHaveLength(1);
    });
  });
});
