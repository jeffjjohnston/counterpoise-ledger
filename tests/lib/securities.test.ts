// tests/lib/securities.test.ts
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  setupTestDatabase,
  resetTestDatabase,
  createBook,
} from "@/tests/helpers/db-utils";
import { getDb } from "@/db";
import { books, securities } from "@/db/schema";
import { eq } from "drizzle-orm";
import {
  createSecurity,
  SecurityValidationError,
  SecurityDuplicateError,
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
});
