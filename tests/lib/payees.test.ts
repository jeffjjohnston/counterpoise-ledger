import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  setupTestDatabase,
  resetTestDatabase,
  createAccount,
  createBook,
  createTransactionWithSplits,
  createPayee as seedPayee,
} from "@/tests/helpers/db-utils";
import { getDb } from "@/db";
import { books, payees } from "@/db/schema";
import { eq } from "drizzle-orm";
import {
  normalizePayeeName,
  createPayee,
  deletePayee,
  PayeeNotFoundError,
  PayeeValidationError,
} from "@/lib/payees";

describe("normalizePayeeName", () => {
  it("trims and collapses whitespace", () => {
    expect(normalizePayeeName("  Blue   Bottle  ")).toBe("Blue Bottle");
  });

  it("normalizes curly quotes to straight quotes", () => {
    // Right single quotation mark (common in imports)
    expect(normalizePayeeName("Trader Joe's")).toBe("Trader Joe's");

    // Left single quotation mark
    expect(normalizePayeeName("Trader Joe's")).toBe("Trader Joe's");

    // All variations should normalize to the same result
    expect(normalizePayeeName("Trader Joe's")).toBe(
      normalizePayeeName("Trader Joe's")
    );
    expect(normalizePayeeName("Trader Joe's")).toBe(
      normalizePayeeName("Trader Joe's")
    );
  });

  it("normalizes grave accent and acute accent to straight quote", () => {
    expect(normalizePayeeName("Bob`s Diner")).toBe("Bob's Diner");
    expect(normalizePayeeName("Bob´s Diner")).toBe("Bob's Diner");
  });

  it("handles multiple quote types in one name", () => {
    expect(normalizePayeeName("Joe's & Jane's Store")).toBe("Joe's & Jane's Store");
  });
});

describe("payees shared logic", () => {
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

  describe("deletePayee", () => {
    it("refuses a payee that has transactions", async () => {
      const payee = await seedPayee({ name: "Acme", bookId });
      const checking = await createAccount({ name: "Checking", type: "asset", subtype: "bank", bookId });
      const office = await createAccount({ name: "Office", type: "expense", subtype: "other", bookId });
      await createTransactionWithSplits({
        bookId, date: "2026-01-10", description: "Supplies", payeeId: payee.id,
        splits: [
          { accountId: office.id, amount: 900 },
          { accountId: checking.id, amount: -900 },
        ],
      });

      await expect(deletePayee(getDb(), bookId, payee.id)).rejects.toThrow(
        /associated transactions/i
      );
    });

    it("deletes an unused payee", async () => {
      const payee = await seedPayee({ name: "Unused", bookId });
      await deletePayee(getDb(), bookId, payee.id);
      const rows = await getDb().select().from(payees).where(eq(payees.id, payee.id));
      expect(rows).toHaveLength(0);
    });

    it("throws PayeeNotFoundError for a payee in another book", async () => {
      const otherBook = await createBook({ name: "Other" });
      const theirs = await seedPayee({ name: "Theirs", bookId: otherBook.id });
      await expect(deletePayee(getDb(), bookId, theirs.id)).rejects.toThrow(
        PayeeNotFoundError
      );
    });

    it("throws PayeeNotFoundError, not the transaction guard, for a cross-book payee that HAS transactions", async () => {
      // A payee with zero transactions cannot tell the two guard orders
      // apart — the transaction count is 0 either way, so both orders land
      // on PayeeNotFoundError. Give the cross-book payee a transaction: if
      // the count check ran before the book-scoped existence check, the
      // unscoped `eq(transactions.payeeId, payeeId)` count query would find
      // it and raise the 409 "associated transactions" error instead — which
      // would leak the existence of another book's payee.
      const otherBook = await createBook({ name: "Other" });
      const theirs = await seedPayee({ name: "Theirs", bookId: otherBook.id });
      const theirChecking = await createAccount({
        name: "Checking", type: "asset", subtype: "bank", bookId: otherBook.id,
      });
      const theirOffice = await createAccount({
        name: "Office", type: "expense", subtype: "other", bookId: otherBook.id,
      });
      await createTransactionWithSplits({
        bookId: otherBook.id, date: "2026-01-10", description: "Supplies", payeeId: theirs.id,
        splits: [
          { accountId: theirOffice.id, amount: 900 },
          { accountId: theirChecking.id, amount: -900 },
        ],
      });

      await expect(deletePayee(getDb(), bookId, theirs.id)).rejects.toThrow(
        PayeeNotFoundError
      );
    });
  });

  describe("createPayee", () => {
    it("normalizes the name", async () => {
      const payee = await createPayee(getDb(), bookId, { name: "  Acme   Corp  " });
      expect(payee.name).toBe("Acme Corp");
    });

    it("does not lowercase — IKEA and Ikea are distinct payees", async () => {
      const upper = await createPayee(getDb(), bookId, { name: "IKEA" });
      const mixed = await createPayee(getDb(), bookId, { name: "Ikea" });
      expect(upper.id).not.toBe(mixed.id);
    });

    it("refuses an exact repeat of an existing name in the same book", async () => {
      // payees_name_book_unique (db/schema.ts) makes two rows with the
      // identical (name, bookId) impossible. Without this guard, the
      // second insert below would fail with a raw driver error instead of
      // a catchable PayeeValidationError.
      await createPayee(getDb(), bookId, { name: "Repeat Co" });
      await expect(createPayee(getDb(), bookId, { name: "Repeat Co" })).rejects.toThrow(
        PayeeValidationError
      );
    });

    it("allows the same name again in a different book", async () => {
      const otherBook = await createBook({ name: "Other" });
      await createPayee(getDb(), bookId, { name: "Shared Name" });
      const theirs = await createPayee(getDb(), otherBook.id, { name: "Shared Name" });
      expect(theirs.name).toBe("Shared Name");
      expect(theirs.bookId).toBe(otherBook.id);
    });
  });
});
