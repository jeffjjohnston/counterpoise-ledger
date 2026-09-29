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
  getPayeeLastAccountId,
  listPayees,
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

  describe("listPayees", () => {
    // The forms ask for `limit: 8`. Ranked alphabetically, "United" sat
    // below "American Civil Liberties Union" for the term "uni" and could
    // fall outside the eight rows entirely.
    it("ranks prefix matches, then word-start matches, then other substrings", async () => {
      const db = getDb();
      await seedPayee({ name: "Reunion Hall", bookId });
      await seedPayee({ name: "American Civil Liberties Union", bookId });
      await seedPayee({ name: "United Airlines", bookId });
      await seedPayee({ name: "Union Square Cafe", bookId });

      const rows = await listPayees(db, bookId, { search: "uni" });

      expect(rows.map((r) => r.name)).toEqual([
        "Union Square Cafe",
        "United Airlines",
        "American Civil Liberties Union",
        "Reunion Hall",
      ]);
    });

    it("applies the limit after the ranking", async () => {
      const db = getDb();
      await seedPayee({ name: "American Civil Liberties Union", bookId });
      await seedPayee({ name: "Communion Bakery", bookId });
      await seedPayee({ name: "United Airlines", bookId });

      const rows = await listPayees(db, bookId, { search: "uni", limit: 2 });

      expect(rows.map((r) => r.name)).toEqual([
        "United Airlines",
        "American Civil Liberties Union",
      ]);
    });

    // The client filters with `includes()`, which is literal. If the SQL
    // treated `%` and `_` as LIKE wildcards, "un_" would rank "United"
    // and "Unity" as prefix matches, fill the limit, and starve the one
    // literal match the client would keep.
    it("matches % and _ in the search term literally", async () => {
      const db = getDb();
      await seedPayee({ name: "United Airlines", bookId });
      await seedPayee({ name: "Unity Bank", bookId });
      await seedPayee({ name: "A un_ Store", bookId });
      await seedPayee({ name: "50% Off Outlet", bookId });

      const underscore = await listPayees(db, bookId, { search: "un_", limit: 2 });
      expect(underscore.map((r) => r.name)).toEqual(["A un_ Store"]);

      const percent = await listPayees(db, bookId, { search: "50%" });
      expect(percent.map((r) => r.name)).toEqual(["50% Off Outlet"]);
    });

    it("keeps the alphabetical order when there is no search", async () => {
      const db = getDb();
      await seedPayee({ name: "Whole Foods", bookId });
      await seedPayee({ name: "Blue Bottle", bookId });

      const rows = await listPayees(db, bookId);

      expect(rows.map((r) => r.name)).toEqual(["Blue Bottle", "Whole Foods"]);
    });
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

  describe("getPayeeLastAccountId", () => {
    it("breaks an equal-frequency equal-amount debit tie by ascending account id", async () => {
      const payee = await seedPayee({ name: "Deterministic Vendor", bookId });
      const checking = await createAccount({ name: "Checking", type: "asset", subtype: "bank", bookId });
      const dining = await createAccount({ name: "Dining", type: "expense", bookId });
      const groceries = await createAccount({ name: "Groceries", type: "expense", bookId });

      // Each candidate has one earlier debit split, so historical frequency
      // cannot decide the tied largest debits in the last transaction.
      await createTransactionWithSplits({
        bookId, date: "2026-01-01", description: "Deterministic Vendor", payeeId: payee.id,
        splits: [
          { accountId: dining.id, amount: 500 },
          { accountId: checking.id, amount: -500 },
        ],
      });
      await createTransactionWithSplits({
        bookId, date: "2026-01-05", description: "Deterministic Vendor", payeeId: payee.id,
        splits: [
          { accountId: groceries.id, amount: 500 },
          { accountId: checking.id, amount: -500 },
        ],
      });

      // Insert the higher id first. A query ordered only by amount may retain
      // insertion order, but the documented final tie-break must pick Dining.
      expect(groceries.id).toBeGreaterThan(dining.id);
      await createTransactionWithSplits({
        bookId, date: "2026-01-10", description: "Deterministic Vendor", payeeId: payee.id,
        splits: [
          { accountId: groceries.id, amount: 300 },
          { accountId: dining.id, amount: 300 },
          { accountId: checking.id, amount: -600 },
        ],
      });

      const result = await getPayeeLastAccountId(getDb(), bookId, payee.id);
      expect(result).toBe(dining.id);
    });

    it("breaks a tie between equal-amount debit splits of the same transaction by historical account frequency", async () => {
      const payee = await seedPayee({ name: "Recurring Vendor", bookId });
      const checking = await createAccount({ name: "Checking", type: "asset", subtype: "bank", bookId });
      const dining = await createAccount({ name: "Dining", type: "expense", bookId });
      const groceries = await createAccount({ name: "Groceries", type: "expense", bookId });

      // History: Dining used twice, Groceries once, so Dining should win a
      // frequency tie-break.
      await createTransactionWithSplits({
        bookId, date: "2026-01-01", description: "Recurring Vendor", payeeId: payee.id,
        splits: [
          { accountId: dining.id, amount: 500 },
          { accountId: checking.id, amount: -500 },
        ],
      });
      await createTransactionWithSplits({
        bookId, date: "2026-01-05", description: "Recurring Vendor", payeeId: payee.id,
        splits: [
          { accountId: dining.id, amount: 500 },
          { accountId: checking.id, amount: -500 },
        ],
      });
      await createTransactionWithSplits({
        bookId, date: "2026-01-10", description: "Recurring Vendor", payeeId: payee.id,
        splits: [
          { accountId: groceries.id, amount: 500 },
          { accountId: checking.id, amount: -500 },
        ],
      });

      // The LAST transaction has two equal-amount debit splits, one on
      // Groceries and one on Dining. The primary rule (largest debit split)
      // cannot separate them, so only frequency can: Dining wins 3-2.
      // Groceries is inserted first and holds the HIGHER id, so both
      // first-row-wins and a desc(accountId) tiebreak would answer Groceries
      // and fail here. The mirrored test below inverts the id relationship,
      // which is what rules out asc(accountId).
      const lastTxn = await createTransactionWithSplits({
        bookId, date: "2026-01-15", description: "Recurring Vendor", payeeId: payee.id,
        splits: [
          { accountId: groceries.id, amount: 300 },
          { accountId: dining.id, amount: 300 },
          { accountId: checking.id, amount: -600 },
        ],
      });
      expect(lastTxn).toBeDefined();
      expect(groceries.id).toBeGreaterThan(dining.id);

      const result = await getPayeeLastAccountId(getDb(), bookId, payee.id);
      expect(result).toBe(dining.id);
    });

    // The mirror of the test above: same tie, but the frequent account is now
    // the one with the HIGHER id. An accountId tiebreak in either direction
    // passes one of these two tests and fails the other, so the pair admits
    // only the frequency rule.
    it("breaks the same tie toward the frequent account even when it holds the higher account id", async () => {
      const payee = await seedPayee({ name: "Mirror Vendor", bookId });
      const checking = await createAccount({ name: "Checking", type: "asset", subtype: "bank", bookId });
      const dining = await createAccount({ name: "Dining", type: "expense", bookId });
      const groceries = await createAccount({ name: "Groceries", type: "expense", bookId });

      // History: Groceries twice, Dining once, so Groceries wins on frequency.
      for (const date of ["2026-01-01", "2026-01-05"]) {
        await createTransactionWithSplits({
          bookId, date, description: "Mirror Vendor", payeeId: payee.id,
          splits: [
            { accountId: groceries.id, amount: 500 },
            { accountId: checking.id, amount: -500 },
          ],
        });
      }
      await createTransactionWithSplits({
        bookId, date: "2026-01-10", description: "Mirror Vendor", payeeId: payee.id,
        splits: [
          { accountId: dining.id, amount: 500 },
          { accountId: checking.id, amount: -500 },
        ],
      });

      // Dining is inserted first in the tied transaction and holds the lower
      // id, so first-row-wins and asc(accountId) both answer Dining.
      await createTransactionWithSplits({
        bookId, date: "2026-01-15", description: "Mirror Vendor", payeeId: payee.id,
        splits: [
          { accountId: dining.id, amount: 300 },
          { accountId: groceries.id, amount: 300 },
          { accountId: checking.id, amount: -600 },
        ],
      });
      expect(groceries.id).toBeGreaterThan(dining.id);

      const result = await getPayeeLastAccountId(getDb(), bookId, payee.id);
      expect(result).toBe(groceries.id);
    });

    it("returns the sole debit split's account when there is no tie", async () => {
      const payee = await seedPayee({ name: "Simple Vendor", bookId });
      const checking = await createAccount({ name: "Checking", type: "asset", subtype: "bank", bookId });
      const office = await createAccount({ name: "Office", type: "expense", bookId });

      await createTransactionWithSplits({
        bookId, date: "2026-01-10", description: "Office supplies", payeeId: payee.id,
        splits: [
          { accountId: office.id, amount: 900 },
          { accountId: checking.id, amount: -900 },
        ],
      });

      const result = await getPayeeLastAccountId(getDb(), bookId, payee.id);
      expect(result).toBe(office.id);
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
