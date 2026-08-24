import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  setupTestDatabase,
  resetTestDatabase,
  createAccount as seedAccount,
  createBook,
  createTransactionWithSplits,
} from "@/tests/helpers/db-utils";
import { getDb } from "@/db";
import { accounts, books } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import {
  getAccountsWithBalances,
  createAccount,
  updateAccount,
  deleteAccount,
  AccountValidationError,
  AccountNotFoundError,
} from "@/lib/accounts";

describe("accounts shared logic", () => {
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

  describe("getAccountsWithBalances", () => {
    it("returns accounts with zero balance when they have no splits", async () => {
      await seedAccount({ name: "Checking", type: "asset", subtype: "bank", bookId });

      const rows = await getAccountsWithBalances(getDb(), bookId);

      expect(rows).toHaveLength(1);
      expect(rows[0].balanceCents).toBe(0);
      expect(rows[0].hasTransactions).toBe(false);
    });

    it("sums splits into balanceCents and flags hasTransactions", async () => {
      const checking = await seedAccount({ name: "Checking", type: "asset", subtype: "bank", bookId });
      const expense = await seedAccount({ name: "Groceries", type: "expense", bookId });
      await createTransactionWithSplits({
        bookId,
        date: "2024-03-01",
        description: "Market",
        splits: [
          { accountId: expense.id, amount: 5000 },
          { accountId: checking.id, amount: -5000 },
        ],
      });

      const rows = await getAccountsWithBalances(getDb(), bookId);
      const byName = new Map(rows.map((r) => [r.name, r]));

      expect(byName.get("Checking")!.balanceCents).toBe(-5000);
      expect(byName.get("Checking")!.hasTransactions).toBe(true);
      expect(byName.get("Groceries")!.balanceCents).toBe(5000);
    });

    it("excludes inactive accounts unless includeInactive is set", async () => {
      await seedAccount({ name: "Open", type: "asset", subtype: "bank", bookId });
      await seedAccount({ name: "Closed", type: "asset", subtype: "bank", isActive: false, bookId });

      const active = await getAccountsWithBalances(getDb(), bookId);
      expect(active.map((r) => r.name)).toEqual(["Open"]);

      const all = await getAccountsWithBalances(getDb(), bookId, { includeInactive: true });
      expect(all.map((r) => r.name).sort()).toEqual(["Closed", "Open"]);
    });

    it("filters by account type", async () => {
      await seedAccount({ name: "Checking", type: "asset", subtype: "bank", bookId });
      await seedAccount({ name: "Groceries", type: "expense", bookId });

      const rows = await getAccountsWithBalances(getDb(), bookId, { type: "expense" });
      expect(rows.map((r) => r.name)).toEqual(["Groceries"]);
    });

    it("honors asOfDate using the EFFECTIVE date, not the stored date", async () => {
      const checking = await seedAccount({ name: "Checking", type: "asset", subtype: "bank", bookId });
      const expense = await seedAccount({ name: "Groceries", type: "expense", bookId });

      // A fixed-date transaction inside the window.
      await createTransactionWithSplits({
        bookId,
        date: "2024-01-10",
        description: "Early",
        splits: [
          { accountId: expense.id, amount: 1000 },
          { accountId: checking.id, amount: -1000 },
        ],
      });
      // A fixed-date transaction after the window.
      await createTransactionWithSplits({
        bookId,
        date: "2024-06-01",
        description: "Late",
        splits: [
          { accountId: expense.id, amount: 2500 },
          { accountId: checking.id, amount: -2500 },
        ],
      });

      const rows = await getAccountsWithBalances(getDb(), bookId, { asOfDate: "2024-02-01" });
      const groceries = rows.find((r) => r.name === "Groceries")!;
      expect(groceries.balanceCents).toBe(1000);
    });

    it("orders by type then name", async () => {
      await seedAccount({ name: "Zebra", type: "asset", subtype: "bank", bookId });
      await seedAccount({ name: "Apple", type: "asset", subtype: "bank", bookId });
      await seedAccount({ name: "Groceries", type: "expense", bookId });

      const rows = await getAccountsWithBalances(getDb(), bookId);
      expect(rows.map((r) => r.name)).toEqual(["Apple", "Zebra", "Groceries"]);
    });
  });

  describe("createAccount", () => {
    it("creates an account", async () => {
      const account = await createAccount(getDb(), bookId, {
        name: "Checking", type: "asset", subtype: "bank",
      });
      expect(account.id).toBeDefined();
      expect(account.bookId).toBe(bookId);
      expect(account.isActive).toBe(true);
    });

    it("auto-creates the cash sub-account for an investment account", async () => {
      const brokerage = await createAccount(getDb(), bookId, {
        name: "Brokerage", type: "asset", subtype: "investment",
      });
      const children = await getDb()
        .select()
        .from(accounts)
        .where(and(eq(accounts.parentId, brokerage.id), eq(accounts.bookId, bookId)));
      expect(children).toHaveLength(1);
      expect(children[0].isInvestmentCash).toBe(true);
    });

    it("rejects a parentId from another book", async () => {
      const otherBook = await createBook({ name: "Other" });
      const theirAccount = await createAccount(getDb(), otherBook.id, {
        name: "Theirs", type: "asset", subtype: "bank",
      });
      await expect(
        createAccount(getDb(), bookId, {
          name: "Child", type: "asset", subtype: "bank", parentId: theirAccount.id,
        })
      ).rejects.toThrow(AccountValidationError);
    });
  });

  describe("updateAccount", () => {
    it("updates fields", async () => {
      const account = await createAccount(getDb(), bookId, {
        name: "Checking",
        type: "asset",
        subtype: "bank",
      });
      const updated = await updateAccount(getDb(), bookId, account.id, {
        name: "Primary Checking",
        isFavorite: true,
      });
      expect(updated.name).toBe("Primary Checking");
      expect(updated.isFavorite).toBe(true);
    });

    it("rejects a parentId from another book", async () => {
      const account = await createAccount(getDb(), bookId, {
        name: "Checking",
        type: "asset",
        subtype: "bank",
      });
      const otherBook = await createBook({ name: "Other" });
      const theirAccount = await createAccount(getDb(), otherBook.id, {
        name: "Theirs",
        type: "asset",
        subtype: "bank",
      });
      await expect(
        updateAccount(getDb(), bookId, account.id, { parentId: theirAccount.id })
      ).rejects.toThrow(AccountValidationError);
    });

    it("throws AccountNotFoundError for an account in another book", async () => {
      const otherBook = await createBook({ name: "Other" });
      const theirs = await createAccount(getDb(), otherBook.id, {
        name: "Theirs",
        type: "expense",
        subtype: "other",
      });
      await expect(
        updateAccount(getDb(), bookId, theirs.id, { name: "Renamed" })
      ).rejects.toThrow(AccountNotFoundError);
    });
  });

  describe("deleteAccount", () => {
    it("refuses an account that has transaction splits", async () => {
      const checking = await createAccount(getDb(), bookId, {
        name: "Checking", type: "asset", subtype: "bank",
      });
      const groceries = await createAccount(getDb(), bookId, {
        name: "Groceries", type: "expense", subtype: "other",
      });
      await createTransactionWithSplits({
        bookId, date: "2026-01-15", description: "Food",
        splits: [
          { accountId: groceries.id, amount: 500 },
          { accountId: checking.id, amount: -500 },
        ],
      });

      await expect(deleteAccount(getDb(), bookId, checking.id)).rejects.toThrow(
        /transactions/i
      );

      // Still there — a refused delete must not partially apply.
      const rows = await getDb().select().from(accounts).where(eq(accounts.id, checking.id));
      expect(rows).toHaveLength(1);
    });

    it("refuses an account that has sub-accounts", async () => {
      const parent = await createAccount(getDb(), bookId, {
        name: "Parent", type: "expense", subtype: "other",
      });
      await createAccount(getDb(), bookId, {
        name: "Child", type: "expense", subtype: "other", parentId: parent.id,
      });
      await expect(deleteAccount(getDb(), bookId, parent.id)).rejects.toThrow(
        /sub-account/i
      );
    });

    it("deletes an empty, childless account", async () => {
      const spare = await createAccount(getDb(), bookId, {
        name: "Spare", type: "expense", subtype: "other",
      });
      await deleteAccount(getDb(), bookId, spare.id);
      const rows = await getDb().select().from(accounts).where(eq(accounts.id, spare.id));
      expect(rows).toHaveLength(0);
    });

    it("throws AccountNotFoundError for an account in another book", async () => {
      const otherBook = await createBook({ name: "Other" });
      const theirs = await createAccount(getDb(), otherBook.id, {
        name: "Theirs", type: "expense", subtype: "other",
      });
      await expect(deleteAccount(getDb(), bookId, theirs.id)).rejects.toThrow(
        AccountNotFoundError
      );
    });
  });
});
