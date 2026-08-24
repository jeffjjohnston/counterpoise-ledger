import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  setupTestDatabase,
  resetTestDatabase,
  createAccount,
  createUser,
} from "@/tests/helpers/db-utils";
import { getDb } from "@/db";
import { accounts, books } from "@/db/schema";
import {
  createBook,
  updateBook,
  deleteBook,
  createDemoBook,
  BookValidationError,
  BookNotFoundError,
} from "@/lib/books";
import { seedBook } from "@/db/seed";

// createDemoBook's own test cases stub seedBook so they run in milliseconds
// instead of the several seconds a real reseed takes — tests/api/books-demo.test.ts
// already covers the real seedBook call end to end through the route.
vi.mock("@/db/seed", async (importActual) => {
  const actual = await importActual<typeof import("@/db/seed")>();
  return { ...actual, seedBook: vi.fn(actual.seedBook) };
});

describe("books shared logic", () => {
  const userId = 1; // seeded by setupTestDatabase/resetTestDatabase

  beforeAll(async () => {
    await setupTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  describe("createBook", () => {
    it("creates a book owned by the given user", async () => {
      const book = await createBook(getDb(), userId, { name: "Household" });

      expect(book.name).toBe("Household");
      expect(book.userId).toBe(userId);
    });
  });

  describe("updateBook", () => {
    it("updates the name of a book the user owns", async () => {
      const book = await createBook(getDb(), userId, { name: "Old Name" });

      const updated = await updateBook(getDb(), userId, book.id, { name: "New Name" });

      expect(updated.name).toBe("New Name");
    });

    it("updates upcomingDays when provided", async () => {
      const book = await createBook(getDb(), userId, { name: "Household" });

      const updated = await updateBook(getDb(), userId, book.id, {
        name: "Household",
        upcomingDays: 45,
      });

      expect(updated.upcomingDays).toBe(45);
    });

    it("throws BookNotFoundError for another user's book", async () => {
      const otherUser = await createUser({ username: "someone-else" });
      const theirs = await createBook(getDb(), otherUser.id, { name: "Theirs" });

      await expect(
        updateBook(getDb(), userId, theirs.id, { name: "Stolen" })
      ).rejects.toThrow(BookNotFoundError);
    });
  });

  describe("deleteBook", () => {
    it("deletes when the confirmation name matches exactly", async () => {
      const book = await createBook(getDb(), userId, { name: "Household" });
      await deleteBook(getDb(), userId, book.id, "Household");
      const rows = await getDb().select().from(books).where(eq(books.id, book.id));
      expect(rows).toHaveLength(0);
    });

    it("refuses a mismatched confirmation name", async () => {
      const book = await createBook(getDb(), userId, { name: "Household" });
      await expect(
        deleteBook(getDb(), userId, book.id, "household")
      ).rejects.toThrow(BookValidationError);

      // The book survives. This is the whole point of the guard.
      const rows = await getDb().select().from(books).where(eq(books.id, book.id));
      expect(rows).toHaveLength(1);
    });

    it("refuses an empty confirmation name", async () => {
      const book = await createBook(getDb(), userId, { name: "Household" });
      await expect(deleteBook(getDb(), userId, book.id, "")).rejects.toThrow(
        BookValidationError
      );

      // Throwing is not the guarantee that matters — the book surviving is.
      // A future deleteBook that deleted first and validated afterwards would
      // still throw here and still pass without this check.
      const rows = await getDb().select().from(books).where(eq(books.id, book.id));
      expect(rows).toHaveLength(1);
    });

    it("cascades to the book's data", async () => {
      const book = await createBook(getDb(), userId, { name: "Doomed" });
      const account = await createAccount({
        name: "Checking",
        type: "asset",
        subtype: "bank",
        bookId: book.id,
      });

      await deleteBook(getDb(), userId, book.id, "Doomed");

      // All 14 book-scoped tables carry ON DELETE cascade on book_id. This test
      // documents that the blast radius is real, and is why the guard exists.
      const rows = await getDb().select().from(accounts).where(eq(accounts.id, account.id));
      expect(rows).toHaveLength(0);
    });

    it("throws BookNotFoundError for another user's book", async () => {
      const otherUser = await createUser({ username: "someone-else" });
      const theirs = await createBook(getDb(), otherUser.id, { name: "Theirs" });
      await expect(
        deleteBook(getDb(), userId, theirs.id, "Theirs")
      ).rejects.toThrow(BookNotFoundError);
    });
  });

  describe("createDemoBook", () => {
    beforeEach(() => {
      vi.mocked(seedBook).mockClear();
      vi.mocked(seedBook).mockResolvedValue(undefined);
    });

    it("creates a book named 'Demo Book' and seeds it", async () => {
      const book = await createDemoBook(getDb(), userId);

      expect(book.name).toBe("Demo Book");
      expect(book.userId).toBe(userId);
      expect(seedBook).toHaveBeenCalledWith(expect.anything(), book.id);
    });

    it("picks a unique name when 'Demo Book' is already taken", async () => {
      await createBook(getDb(), userId, { name: "Demo Book" });

      const book = await createDemoBook(getDb(), userId);

      expect(book.name).toBe("Demo Book 2");
    });

    it("removes the half-seeded book and rethrows when seeding fails", async () => {
      vi.mocked(seedBook).mockRejectedValueOnce(new Error("seed exploded"));
      const before = await getDb().select().from(books);

      await expect(createDemoBook(getDb(), userId)).rejects.toThrow("seed exploded");

      const after = await getDb().select().from(books);
      expect(after).toHaveLength(before.length);
    });
  });
});
