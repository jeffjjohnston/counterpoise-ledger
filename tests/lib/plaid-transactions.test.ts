import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import {
  setupTestDatabase,
  resetTestDatabase,
  createAccount,
  createBook,
  createPlaidAccount,
  createPlaidReconciliation,
  createPlaidToken,
  createTransactionWithSplits,
} from "@/tests/helpers/db-utils";
import { getDb } from "@/db";
import { books, plaidTransactionReconciliation, transactions } from "@/db/schema";
import {
  getTransactionPlaidLink,
  listPendingPlaidTransactions,
  PlaidLinkNotFoundError,
  unlinkPlaidTransaction,
} from "@/lib/plaid-transactions";

describe("plaid-transactions shared logic", () => {
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

  /** A Plaid connection with one linked Counterpoise account. */
  async function seedLinkedConnection(
    forBookId: number,
    plaidAccountId = "plaid-acct-1",
    accountName = "Checking"
  ) {
    const account = await createAccount({ bookId: forBookId, name: accountName, type: "asset" });
    const token = await createPlaidToken({
      bookId: forBookId,
      financialInstitution: "Chase",
      // itemId is unique across the whole table, not just within a book, so
      // it must fold in forBookId — two books both linking a first checking
      // account would otherwise both want "item-plaid-acct-1".
      itemId: `item-${forBookId}-${plaidAccountId}`,
      accessToken: `access-${plaidAccountId}`,
    });
    const link = await createPlaidAccount({
      bookId: forBookId,
      tokenId: token.id,
      // Also unique across the whole table — same reasoning as itemId above.
      plaidAccountId: `${forBookId}-${plaidAccountId}`,
      name: `Chase ${accountName}`,
      type: "depository",
      counterpoiseAccountId: account.id,
    });
    return { token, account, link };
  }

  describe("listPendingPlaidTransactions", () => {
    it("returns staged rows for this book only", async () => {
      const db = getDb();
      const { link } = await seedLinkedConnection(bookId);
      await createPlaidReconciliation({
        bookId, plaidAccountLinkId: link.id,
        plaidTransactionId: "plaid-txn-1", date: "2026-02-01",
        amountCents: -4200, name: "Coffee Shop",
        resolutionStatus: "pending",
      });
      const other = await createBook({ name: "Other Book" });
      const theirLink = await seedLinkedConnection(other.id);
      await createPlaidReconciliation({
        bookId: other.id, plaidAccountLinkId: theirLink.link.id,
        plaidTransactionId: "plaid-txn-1", date: "2026-02-01",
        amountCents: -4200, name: "Coffee Shop",
        resolutionStatus: "pending",
      });

      const rows = await listPendingPlaidTransactions(db, bookId, {});

      expect(rows).toHaveLength(1);
    });

    it("filters to one account when accountId is given", async () => {
      const db = getDb();
      const first = await seedLinkedConnection(bookId, "plaid-acct-1", "Checking");
      const second = await seedLinkedConnection(bookId, "plaid-acct-2", "Savings");
      await createPlaidReconciliation({
        bookId, plaidAccountLinkId: first.link.id,
        plaidTransactionId: "plaid-txn-1", date: "2026-02-01",
        amountCents: -4200, name: "Coffee Shop",
        resolutionStatus: "pending",
      });
      await createPlaidReconciliation({
        bookId, plaidAccountLinkId: second.link.id,
        plaidTransactionId: "plaid-txn-1", date: "2026-02-01",
        amountCents: -4200, name: "Coffee Shop",
        resolutionStatus: "pending",
      });

      const rows = await listPendingPlaidTransactions(db, bookId, {
        accountId: first.account.id,
      });

      // The unfiltered call returns two, so this asserts the filter, not the seed.
      expect(rows).toHaveLength(1);
      expect(await listPendingPlaidTransactions(db, bookId, {})).toHaveLength(2);
    });
  });

  /** A linked connection plus a transaction matched to one staged row on it. */
  async function seedMatchedTransaction(forBookId: number) {
    // seedLinkedConnection's own account plays the checking side of the
    // split — a second "Checking" account in the same book would collide
    // with accounts_name_book_unique.
    const { link, account: checking } = await seedLinkedConnection(forBookId);
    const groceries = await createAccount({
      bookId: forBookId, name: "Groceries", type: "expense",
    });
    const txn = await createTransactionWithSplits({
      bookId: forBookId,
      date: "2026-02-01",
      description: "Grocery Store",
      isReconciled: true,
      splits: [
        { accountId: checking.id, amount: -2000 },
        { accountId: groceries.id, amount: 2000 },
      ],
    });
    const recon = await createPlaidReconciliation({
      bookId: forBookId, plaidAccountLinkId: link.id,
      plaidTransactionId: "plaid-txn-1", date: "2026-02-01",
      amountCents: -2000, name: "GROCERY STORE",
      resolutionStatus: "matched",
      matchedTransactionId: txn.id,
    });
    return { txn, recon };
  }

  describe("getTransactionPlaidLink", () => {
    it("returns the staged row matched to the transaction", async () => {
      const db = getDb();
      const { txn, recon } = await seedMatchedTransaction(bookId);

      const link = await getTransactionPlaidLink(db, bookId, txn.id);

      expect(link?.id).toBe(recon.id);
      expect(link?.plaidTransactionId).toBe("plaid-txn-1");
    });

    it("returns null for a transaction with no link", async () => {
      const db = getDb();
      const checking = await createAccount({ bookId, name: "Checking", type: "asset" });
      const groceries = await createAccount({ bookId, name: "Groceries", type: "expense" });
      const txn = await createTransactionWithSplits({
        bookId, date: "2026-02-01", description: "Manual",
        splits: [
          { accountId: checking.id, amount: -500 },
          { accountId: groceries.id, amount: 500 },
        ],
      });

      expect(await getTransactionPlaidLink(db, bookId, txn.id)).toBeNull();
    });

    it("does not find a link belonging to another book", async () => {
      const db = getDb();
      const other = await createBook({ name: "Other Book" });
      const { txn } = await seedMatchedTransaction(other.id);

      expect(await getTransactionPlaidLink(db, bookId, txn.id)).toBeNull();
    });
  });

  describe("unlinkPlaidTransaction", () => {
    it("puts the reconciliation row back to pending and clears isReconciled", async () => {
      const db = getDb();
      const { txn, recon } = await seedMatchedTransaction(bookId);

      await unlinkPlaidTransaction(db, bookId, txn.id);

      const [updatedRecon] = await db
        .select()
        .from(plaidTransactionReconciliation)
        .where(eq(plaidTransactionReconciliation.id, recon.id));
      expect(updatedRecon.resolutionStatus).toBe("pending");
      expect(updatedRecon.matchedTransactionId).toBeNull();
      expect(updatedRecon.reviewReason).toBeNull();
      expect(updatedRecon.resolvedAt).toBeNull();

      const [updatedTxn] = await db
        .select()
        .from(transactions)
        .where(eq(transactions.id, txn.id));
      expect(updatedTxn.isReconciled).toBe(false);
    });

    it("throws PlaidLinkNotFoundError for a transaction with no link", async () => {
      const db = getDb();
      const checking = await createAccount({ bookId, name: "Checking", type: "asset" });
      const groceries = await createAccount({ bookId, name: "Groceries", type: "expense" });
      const txn = await createTransactionWithSplits({
        bookId, date: "2026-02-01", description: "Manual", isReconciled: false,
        splits: [
          { accountId: checking.id, amount: -500 },
          { accountId: groceries.id, amount: 500 },
        ],
      });

      await expect(unlinkPlaidTransaction(db, bookId, txn.id)).rejects.toThrow(
        PlaidLinkNotFoundError
      );
    });

    it("throws for a transaction in another book, and leaves that book's row untouched", async () => {
      const db = getDb();
      const other = await createBook({ name: "Other Book" });
      const { txn, recon } = await seedMatchedTransaction(other.id);

      await expect(unlinkPlaidTransaction(db, bookId, txn.id)).rejects.toThrow(
        PlaidLinkNotFoundError
      );

      const [untouchedRecon] = await db
        .select()
        .from(plaidTransactionReconciliation)
        .where(eq(plaidTransactionReconciliation.id, recon.id));
      expect(untouchedRecon.resolutionStatus).toBe("matched");
      expect(untouchedRecon.matchedTransactionId).toBe(txn.id);

      const [untouchedTxn] = await db
        .select()
        .from(transactions)
        .where(eq(transactions.id, txn.id));
      expect(untouchedTxn.isReconciled).toBe(true);
    });
  });
});
