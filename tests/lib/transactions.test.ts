import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  setupTestDatabase,
  resetTestDatabase,
  createAccount,
  createBook,
  createPlaidAccount,
  createPlaidReconciliation,
  createPlaidToken,
  createSecurity,
  createTransactionWithSplits,
} from "@/tests/helpers/db-utils";
import { getDb } from "@/db";
import {
  books,
  investmentLots,
  investmentSplits as investmentSplitsTable,
  payees,
  plaidTransactionReconciliation,
  transactions,
  transactionSplits,
} from "@/db/schema";
import { and, eq } from "drizzle-orm";
import {
  createTransaction,
  deleteTransaction,
  updateTransaction,
  TransactionNotFoundError,
} from "@/lib/transactions";

describe("transactions shared logic", () => {
  let bookId: number;

  beforeAll(async () => {
    await setupTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
    const db = getDb();
    const [book] = await db
      .select()
      .from(books)
      .limit(1);
    bookId = book.id;
  });

  describe("createTransaction", () => {
    it("creates a basic transaction with two splits", async () => {
      const db = getDb();
      const checking = await createAccount({
        name: "Checking",
        type: "asset",
        subtype: "bank",
        bookId,
      });
      const groceries = await createAccount({
        name: "Groceries",
        type: "expense",
        subtype: "other",
        bookId,
      });

      const result = await createTransaction(db, bookId, {
        date: "2025-01-15",
        description: "Grocery store",
        splits: [
          { accountId: groceries.id, amount: 5000 },
          { accountId: checking.id, amount: -5000 },
        ],
      });

      expect(result.id).toBeDefined();
      expect(result.splits).toHaveLength(2);
    });

    it("rejects unbalanced splits", async () => {
      const db = getDb();
      const checking = await createAccount({
        name: "Checking",
        type: "asset",
        subtype: "bank",
        bookId,
      });
      const groceries = await createAccount({
        name: "Groceries",
        type: "expense",
        subtype: "other",
        bookId,
      });

      await expect(
        createTransaction(db, bookId, {
          date: "2025-01-15",
          splits: [
            { accountId: groceries.id, amount: 5000 },
            { accountId: checking.id, amount: -4000 },
          ],
        })
      ).rejects.toThrow("splits must sum to zero");
    });

    it("creates/reuses payee by name", async () => {
      const db = getDb();
      const checking = await createAccount({
        name: "Checking",
        type: "asset",
        subtype: "bank",
        bookId,
      });
      const groceries = await createAccount({
        name: "Groceries",
        type: "expense",
        subtype: "other",
        bookId,
      });

      const result = await createTransaction(db, bookId, {
        date: "2025-01-15",
        payeeName: "Whole Foods",
        splits: [
          { accountId: groceries.id, amount: 5000 },
          { accountId: checking.id, amount: -5000 },
        ],
      });

      expect(result.payee?.name).toBe("Whole Foods");

      // Create a second transaction with the same payee name - should reuse
      const result2 = await createTransaction(db, bookId, {
        date: "2025-01-16",
        payeeName: "Whole Foods",
        splits: [
          { accountId: groceries.id, amount: 3000 },
          { accountId: checking.id, amount: -3000 },
        ],
      });

      expect(result2.payee?.id).toBe(result.payee?.id);
    });

    // The payee lookup is a SELECT followed by an INSERT, so another session
    // committing the same name in between makes the INSERT hit
    // payees_name_book_unique and takes the whole transaction down with a 500.
    // Reproduced deterministically by holding that other session open across
    // the lookup rather than racing two creates and hoping they interleave.
    it("creates a transaction when another session inserts the payee mid-lookup", async () => {
      const db = getDb();
      const checking = await createAccount({
        name: "Checking",
        type: "asset",
        subtype: "bank",
        bookId,
      });
      const groceries = await createAccount({
        name: "Groceries",
        type: "expense",
        subtype: "other",
        bookId,
      });

      let insertedPayee!: () => void;
      const payeeInserted = new Promise<void>((resolve) => {
        insertedPayee = resolve;
      });
      let commitHolder!: () => void;
      const holderMayCommit = new Promise<void>((resolve) => {
        commitHolder = resolve;
      });

      // Uncommitted, so createTransaction's lookup cannot see it...
      const holder = db.transaction(async (tx) => {
        await tx.insert(payees).values({ name: "Trader Joe's", bookId });
        insertedPayee();
        await holderMayCommit;
      });
      await payeeInserted;

      const created = createTransaction(db, bookId, {
        date: "2025-02-01",
        payeeName: "Trader Joe's",
        splits: [
          { accountId: groceries.id, amount: 1000 },
          { accountId: checking.id, amount: -1000 },
        ],
      });

      // ...until it has passed the lookup and is blocked on the unique index.
      await new Promise((resolve) => setTimeout(resolve, 500));
      commitHolder();
      await holder;

      const result = await created;
      expect(result.payee?.name).toBe("Trader Joe's");

      const payeeRows = await db
        .select()
        .from(payees)
        .where(eq(payees.bookId, bookId));
      expect(payeeRows).toHaveLength(1);
      expect(result.payee?.id).toBe(payeeRows[0].id);
    });

    it("rejects when split accounts do not belong to book", async () => {
      const db = getDb();
      await expect(
        createTransaction(db, bookId, {
          date: "2025-01-15",
          splits: [
            { accountId: 99999, amount: 5000 },
            { accountId: 99998, amount: -5000 },
          ],
        })
      ).rejects.toThrow("do not belong to this book");
    });

    it("rejects missing date", async () => {
      const db = getDb();
      const checking = await createAccount({
        name: "Checking",
        type: "asset",
        subtype: "bank",
        bookId,
      });
      const groceries = await createAccount({
        name: "Groceries",
        type: "expense",
        subtype: "other",
        bookId,
      });

      await expect(
        createTransaction(db, bookId, {
          date: "",
          splits: [
            { accountId: groceries.id, amount: 5000 },
            { accountId: checking.id, amount: -5000 },
          ],
        })
      ).rejects.toThrow("Date and at least 2 splits are required");
    });

    it("rejects fewer than 2 splits", async () => {
      const db = getDb();
      const checking = await createAccount({
        name: "Checking",
        type: "asset",
        subtype: "bank",
        bookId,
      });

      await expect(
        createTransaction(db, bookId, {
          date: "2025-01-15",
          splits: [{ accountId: checking.id, amount: 0 }],
        })
      ).rejects.toThrow("Date and at least 2 splits are required");
    });

    it("rejects checkNumber on non-bank transactions", async () => {
      const db = getDb();
      const income = await createAccount({
        name: "Salary",
        type: "income",
        subtype: "other",
        bookId,
      });
      const expense = await createAccount({
        name: "Rent",
        type: "expense",
        subtype: "other",
        bookId,
      });

      await expect(
        createTransaction(db, bookId, {
          date: "2025-01-15",
          checkNumber: "1001",
          splits: [
            { accountId: expense.id, amount: 5000 },
            { accountId: income.id, amount: -5000 },
          ],
        })
      ).rejects.toThrow(
        "Check number can only be set for transactions involving bank accounts"
      );
    });

    it("creates a reconciled transaction when isReconciled is true", async () => {
      const db = getDb();
      const checking = await createAccount({
        name: "Checking",
        type: "asset",
        subtype: "bank",
        bookId,
      });
      const groceries = await createAccount({
        name: "Groceries",
        type: "expense",
        subtype: "other",
        bookId,
      });

      const result = await createTransaction(db, bookId, {
        date: "2025-01-15",
        description: "Already cleared",
        isReconciled: true,
        splits: [
          { accountId: groceries.id, amount: 5000 },
          { accountId: checking.id, amount: -5000 },
        ],
      });

      expect(result.isReconciled).toBe(true);
    });

    it("creates an unreconciled transaction by default", async () => {
      const db = getDb();
      const checking = await createAccount({
        name: "Checking",
        type: "asset",
        subtype: "bank",
        bookId,
      });
      const groceries = await createAccount({
        name: "Groceries",
        type: "expense",
        subtype: "other",
        bookId,
      });

      const result = await createTransaction(db, bookId, {
        date: "2025-01-15",
        description: "Normal transaction",
        splits: [
          { accountId: groceries.id, amount: 5000 },
          { accountId: checking.id, amount: -5000 },
        ],
      });

      expect(result.isReconciled).toBe(false);
    });
  });

  describe("updateTransaction", () => {
    it("updates transaction description", async () => {
      const db = getDb();
      const checking = await createAccount({
        name: "Checking",
        type: "asset",
        subtype: "bank",
        bookId,
      });
      const groceries = await createAccount({
        name: "Groceries",
        type: "expense",
        subtype: "other",
        bookId,
      });

      const txn = await createTransaction(db, bookId, {
        date: "2025-01-15",
        description: "Original",
        splits: [
          { accountId: groceries.id, amount: 5000 },
          { accountId: checking.id, amount: -5000 },
        ],
      });

      const updated = await updateTransaction(db, bookId, txn.id, {
        description: "Updated description",
      });

      expect(updated.description).toBe("Updated description");
    });

    it("replaces splits when provided", async () => {
      const db = getDb();
      const checking = await createAccount({
        name: "Checking",
        type: "asset",
        subtype: "bank",
        bookId,
      });
      const groceries = await createAccount({
        name: "Groceries",
        type: "expense",
        subtype: "other",
        bookId,
      });
      const dining = await createAccount({
        name: "Dining",
        type: "expense",
        subtype: "other",
        bookId,
      });

      const txn = await createTransaction(db, bookId, {
        date: "2025-01-15",
        splits: [
          { accountId: groceries.id, amount: 5000 },
          { accountId: checking.id, amount: -5000 },
        ],
      });

      const updated = await updateTransaction(db, bookId, txn.id, {
        splits: [
          { accountId: dining.id, amount: 3000 },
          { accountId: checking.id, amount: -3000 },
        ],
      });

      expect(updated.splits).toHaveLength(2);
      expect(
        updated.splits.some(
          (s: { accountId: number }) => s.accountId === dining.id
        )
      ).toBe(true);
    });

    it("updates payee", async () => {
      const db = getDb();
      const checking = await createAccount({
        name: "Checking",
        type: "asset",
        subtype: "bank",
        bookId,
      });
      const groceries = await createAccount({
        name: "Groceries",
        type: "expense",
        subtype: "other",
        bookId,
      });

      const txn = await createTransaction(db, bookId, {
        date: "2025-01-15",
        payeeName: "Old Payee",
        splits: [
          { accountId: groceries.id, amount: 5000 },
          { accountId: checking.id, amount: -5000 },
        ],
      });

      const updated = await updateTransaction(db, bookId, txn.id, {
        payeeName: "New Payee",
      });

      expect(updated.payee?.name).toBe("New Payee");
    });

    it("throws TransactionNotFoundError for nonexistent transaction", async () => {
      const db = getDb();
      await expect(
        updateTransaction(db, bookId, 99999, { description: "nope" })
      ).rejects.toThrow(TransactionNotFoundError);
    });

    it("rejects unbalanced split updates", async () => {
      const db = getDb();
      const checking = await createAccount({
        name: "Checking",
        type: "asset",
        subtype: "bank",
        bookId,
      });
      const groceries = await createAccount({
        name: "Groceries",
        type: "expense",
        subtype: "other",
        bookId,
      });

      const txn = await createTransaction(db, bookId, {
        date: "2025-01-15",
        splits: [
          { accountId: groceries.id, amount: 5000 },
          { accountId: checking.id, amount: -5000 },
        ],
      });

      await expect(
        updateTransaction(db, bookId, txn.id, {
          splits: [
            { accountId: groceries.id, amount: 5000 },
            { accountId: checking.id, amount: -4000 },
          ],
        })
      ).rejects.toThrow("splits must sum to zero");
    });

    it("rejects invalid date string", async () => {
      const db = getDb();
      const checking = await createAccount({
        name: "Checking",
        type: "asset",
        subtype: "bank",
        bookId,
      });
      const groceries = await createAccount({
        name: "Groceries",
        type: "expense",
        subtype: "other",
        bookId,
      });

      const txn = await createTransaction(db, bookId, {
        date: "2025-01-15",
        splits: [
          { accountId: groceries.id, amount: 5000 },
          { accountId: checking.id, amount: -5000 },
        ],
      });

      await expect(
        updateTransaction(db, bookId, txn.id, { date: "not-a-date" })
      ).rejects.toThrow("YYYY-MM-DD");
    });

    it("rejects split accounts from another book", async () => {
      const db = getDb();
      const checking = await createAccount({
        name: "Checking",
        type: "asset",
        subtype: "bank",
        bookId,
      });
      const groceries = await createAccount({
        name: "Groceries",
        type: "expense",
        subtype: "other",
        bookId,
      });

      const txn = await createTransaction(db, bookId, {
        date: "2025-01-15",
        splits: [
          { accountId: groceries.id, amount: 5000 },
          { accountId: checking.id, amount: -5000 },
        ],
      });

      const book2 = await createBook({ name: "Other Book", userId: 1 });
      const otherAccount = await createAccount({
        name: "Other Checking",
        type: "asset",
        subtype: "bank",
        bookId: book2.id,
      });

      await expect(
        updateTransaction(db, bookId, txn.id, {
          splits: [
            { accountId: otherAccount.id, amount: 5000 },
            { accountId: checking.id, amount: -5000 },
          ],
        })
      ).rejects.toThrow("do not belong to this book");
    });

    it("throws TransactionNotFoundError for transaction in another book", async () => {
      const db = getDb();
      const checking = await createAccount({
        name: "Checking",
        type: "asset",
        subtype: "bank",
        bookId,
      });
      const groceries = await createAccount({
        name: "Groceries",
        type: "expense",
        subtype: "other",
        bookId,
      });

      const txn = await createTransaction(db, bookId, {
        date: "2025-01-15",
        splits: [
          { accountId: groceries.id, amount: 5000 },
          { accountId: checking.id, amount: -5000 },
        ],
      });

      const book2 = await createBook({ name: "Other Book", userId: 1 });

      await expect(
        updateTransaction(db, book2.id, txn.id, {
          description: "Should not work",
        })
      ).rejects.toThrow(TransactionNotFoundError);
    });
  });

  describe("deleteTransaction", () => {
    it("deletes the transaction and its splits", async () => {
      const db = getDb();
      const checking = await createAccount({
        name: "Checking",
        type: "asset",
        subtype: "bank",
        bookId,
      });
      const groceries = await createAccount({
        name: "Groceries",
        type: "expense",
        subtype: "other",
        bookId,
      });
      const txn = await createTransactionWithSplits({
        bookId,
        date: "2026-01-15",
        description: "Groceries",
        splits: [
          { accountId: groceries.id, amount: 5000 },
          { accountId: checking.id, amount: -5000 },
        ],
      });

      await deleteTransaction(db, bookId, txn.id);

      const rows = await db
        .select()
        .from(transactions)
        .where(eq(transactions.id, txn.id));
      expect(rows).toHaveLength(0);

      const splits = await db
        .select()
        .from(transactionSplits)
        .where(eq(transactionSplits.transactionId, txn.id));
      expect(splits).toHaveLength(0);
    });

    it("throws TransactionNotFoundError for a transaction in another book", async () => {
      const db = getDb();
      const otherBook = await createBook({ name: "Other Book" });
      const theirChecking = await createAccount({
        name: "Their Checking",
        type: "asset",
        subtype: "bank",
        bookId: otherBook.id,
      });
      const theirGroceries = await createAccount({
        name: "Their Groceries",
        type: "expense",
        subtype: "other",
        bookId: otherBook.id,
      });
      const txn = await createTransactionWithSplits({
        bookId: otherBook.id,
        date: "2026-01-15",
        description: "Not yours",
        splits: [
          { accountId: theirGroceries.id, amount: 100 },
          { accountId: theirChecking.id, amount: -100 },
        ],
      });

      await expect(deleteTransaction(db, bookId, txn.id)).rejects.toThrow(
        TransactionNotFoundError
      );

      // The row survives. A cross-book delete must not reach it.
      const rows = await db
        .select()
        .from(transactions)
        .where(eq(transactions.id, txn.id));
      expect(rows).toHaveLength(1);
    });

    it("returns a matched Plaid reconciliation row to pending", async () => {
      const db = getDb();
      const checking = await createAccount({
        name: "Checking",
        type: "asset",
        subtype: "bank",
        bookId,
      });
      const coffee = await createAccount({
        name: "Coffee",
        type: "expense",
        subtype: "other",
        bookId,
      });
      const txn = await createTransactionWithSplits({
        bookId,
        date: "2026-01-15",
        description: "Coffee",
        splits: [
          { accountId: coffee.id, amount: 500 },
          { accountId: checking.id, amount: -500 },
        ],
      });
      const token = await createPlaidToken({
        bookId,
        financialInstitution: "Test Bank",
        itemId: "item-delete-1",
        accessToken: "access-delete-1",
      });
      const link = await createPlaidAccount({
        bookId,
        tokenId: token.id,
        plaidAccountId: "plaid-acct-delete-1",
        name: "Checking",
        type: "depository",
        counterpoiseAccountId: checking.id,
      });
      const recon = await createPlaidReconciliation({
        bookId,
        plaidAccountLinkId: link.id,
        plaidTransactionId: "plaid-txn-delete-1",
        date: "2026-01-15",
        amountCents: 500,
        name: "Coffee",
        resolutionStatus: "matched",
        matchedTransactionId: txn.id,
      });

      await deleteTransaction(db, bookId, txn.id);

      const [row] = await db
        .select()
        .from(plaidTransactionReconciliation)
        .where(eq(plaidTransactionReconciliation.id, recon.id));
      // Left at "matched" with a null id, this row hides from the
      // reconciliation queue forever. That is the bug this reset prevents.
      expect(row.resolutionStatus).toBe("pending");
      expect(row.matchedTransactionId).toBeNull();
    });

    it("rebuilds lots after deleting a sell", async () => {
      const db = getDb();
      const investmentAccount = await createAccount({
        name: "Brokerage",
        type: "asset",
        subtype: "investment",
        bookId,
      });
      const cashAccount = await createAccount({
        name: "Brokerage Cash",
        type: "asset",
        subtype: "cash",
        parentId: investmentAccount.id,
        isInvestmentCash: true,
        bookId,
      });
      const security = await createSecurity({
        name: "Vanguard Total Stock",
        symbol: "VTI",
        securityType: "etf",
        bookId,
      });

      // Built with createTransaction, not the raw helpers, so the lots exist
      // before the delete.
      await createTransaction(db, bookId, {
        date: "2026-01-05",
        description: "Buy VTI",
        splits: [
          { accountId: investmentAccount.id, amount: 100_000 },
          { accountId: cashAccount.id, amount: -100_000 },
        ],
        investmentSplits: [
          {
            securityId: security.id,
            action: "buy",
            sharesMicros: 100_000_000,
            priceMicros: 10_000_000,
          },
        ],
      });
      const sell = await createTransaction(db, bookId, {
        date: "2026-02-05",
        description: "Sell VTI",
        splits: [
          { accountId: investmentAccount.id, amount: -60_000 },
          { accountId: cashAccount.id, amount: 60_000 },
        ],
        investmentSplits: [
          {
            securityId: security.id,
            action: "sell",
            sharesMicros: 40_000_000,
            priceMicros: 15_000_000,
          },
        ],
      });

      // The sell really did consume part of the lot, so the assertion after
      // the delete is not passing on an untouched lot.
      const consumed = await db
        .select()
        .from(investmentLots)
        .where(
          and(
            eq(investmentLots.securityId, security.id),
            eq(investmentLots.accountId, investmentAccount.id)
          )
        );
      expect(consumed).toHaveLength(1);
      expect(consumed[0].remainingSharesMicros).toBe(60_000_000);

      await deleteTransaction(db, bookId, sell.id);

      // After deleting the sell, the buy's lot must be whole again:
      const lots = await db
        .select()
        .from(investmentLots)
        .where(
          and(
            eq(investmentLots.securityId, security.id),
            eq(investmentLots.accountId, investmentAccount.id)
          )
        );
      expect(lots).toHaveLength(1);
      expect(lots[0].remainingSharesMicros).toBe(lots[0].originalSharesMicros);
      expect(lots[0].remainingBasisCents).toBe(lots[0].originalBasisCents);
    });
  });

  describe("investment transactions", () => {
    let investmentAcct: Awaited<ReturnType<typeof createAccount>>;
    let cashAcct: Awaited<ReturnType<typeof createAccount>>;
    let incomeAcct: Awaited<ReturnType<typeof createAccount>>;
    let expenseAcct: Awaited<ReturnType<typeof createAccount>>;
    let security: Awaited<ReturnType<typeof createSecurity>>;

    beforeEach(async () => {
      investmentAcct = await createAccount({
        name: "Brokerage",
        type: "asset",
        subtype: "investment",
        bookId,
      });
      cashAcct = await createAccount({
        name: "Brokerage Cash",
        type: "asset",
        subtype: "cash",
        parentId: investmentAcct.id,
        isInvestmentCash: true,
        bookId,
      });
      incomeAcct = await createAccount({
        name: "Dividend Income",
        type: "income",
        subtype: "other",
        bookId,
      });
      expenseAcct = await createAccount({
        name: "Investment Fees",
        type: "expense",
        subtype: "other",
        bookId,
      });
      security = await createSecurity({
        name: "Vanguard Total Stock",
        symbol: "VTI",
        securityType: "etf",
        bookId,
      });
    });

    it("creates a buy transaction with investment splits", async () => {
      const db = getDb();
      const result = await createTransaction(db, bookId, {
        date: "2025-03-01",
        description: "Buy VTI",
        splits: [
          { accountId: investmentAcct.id, amount: 50000 },
          { accountId: cashAcct.id, amount: -50000 },
        ],
        investmentSplits: [
          {
            securityId: security.id,
            action: "buy",
            sharesMicros: 10_000_000,
            priceMicros: 50_000_000,
          },
        ],
      });

      expect(result.investmentSplits).toHaveLength(1);
      expect(result.investmentSplits[0].action).toBe("buy");
      expect(result.investmentSplits[0].accountId).toBe(investmentAcct.id);
      expect(Number(result.investmentSplits[0].sharesMicros)).toBe(10_000_000);
    });

    it("creates a sell transaction with investment splits", async () => {
      const db = getDb();
      const result = await createTransaction(db, bookId, {
        date: "2025-03-02",
        description: "Sell VTI",
        splits: [
          { accountId: investmentAcct.id, amount: -50000 },
          { accountId: cashAcct.id, amount: 50000 },
        ],
        investmentSplits: [
          {
            securityId: security.id,
            action: "sell",
            sharesMicros: 10_000_000,
            priceMicros: 50_000_000,
          },
        ],
      });

      expect(result.investmentSplits).toHaveLength(1);
      expect(result.investmentSplits[0].action).toBe("sell");
      expect(result.investmentSplits[0].accountId).toBe(investmentAcct.id);
    });

    it("creates a dividend transaction without an investment account split", async () => {
      const db = getDb();
      const result = await createTransaction(db, bookId, {
        date: "2025-03-15",
        description: "VTI Dividend",
        splits: [
          { accountId: cashAcct.id, amount: 1500 },
          { accountId: incomeAcct.id, amount: -1500 },
        ],
        investmentSplits: [
          {
            securityId: security.id,
            action: "dividend",
            sharesMicros: 0,
            priceMicros: 0,
          },
        ],
      });

      expect(result.investmentSplits).toHaveLength(1);
      expect(result.investmentSplits[0].action).toBe("dividend");
      expect(Number(result.investmentSplits[0].sharesMicros)).toBe(0);
      expect(Number(result.investmentSplits[0].priceMicros)).toBe(0);
    });

    it("creates a capital gain transaction without an investment account split", async () => {
      const db = getDb();
      const result = await createTransaction(db, bookId, {
        date: "2025-03-15",
        description: "VTI Cap Gain Distribution",
        splits: [
          { accountId: cashAcct.id, amount: 2500 },
          { accountId: incomeAcct.id, amount: -2500 },
        ],
        investmentSplits: [
          {
            securityId: security.id,
            action: "capGain",
            sharesMicros: 0,
            priceMicros: 0,
          },
        ],
      });

      expect(result.investmentSplits).toHaveLength(1);
      expect(result.investmentSplits[0].action).toBe("capGain");
    });

    it("creates a fee transaction without an investment account split", async () => {
      const db = getDb();
      const result = await createTransaction(db, bookId, {
        date: "2025-03-15",
        description: "Advisory Fee",
        splits: [
          { accountId: expenseAcct.id, amount: 500 },
          { accountId: cashAcct.id, amount: -500 },
        ],
        investmentSplits: [
          {
            securityId: security.id,
            action: "fee",
            sharesMicros: 0,
            priceMicros: 0,
            feesCents: 500,
          },
        ],
      });

      expect(result.investmentSplits).toHaveLength(1);
      expect(result.investmentSplits[0].action).toBe("fee");
    });

    it("creates a stock split transaction", async () => {
      const db = getDb();
      const result = await createTransaction(db, bookId, {
        date: "2025-03-15",
        description: "VTI 2:1 Stock Split",
        splits: [
          { accountId: investmentAcct.id, amount: 0 },
          { accountId: cashAcct.id, amount: 0 },
        ],
        investmentSplits: [
          {
            securityId: security.id,
            action: "split",
            sharesMicros: 0,
            priceMicros: 0,
            splitNumerator: 2,
            splitDenominator: 1,
          },
        ],
      });

      expect(result.investmentSplits).toHaveLength(1);
      expect(result.investmentSplits[0].action).toBe("split");
      expect(result.investmentSplits[0].accountId).toBeNull();
    });

    describe("investment account resolution for income/fee actions", () => {
      it("resolves a dividend split to the brokerage account via the cash leg's parent", async () => {
        const db = getDb();
        const result = await createTransaction(db, bookId, {
          date: "2025-03-15",
          description: "VTI Dividend",
          splits: [
            { accountId: cashAcct.id, amount: 1500 },
            { accountId: incomeAcct.id, amount: -1500 },
          ],
          investmentSplits: [
            {
              securityId: security.id,
              action: "dividend",
              sharesMicros: 0,
              priceMicros: 0,
            },
          ],
        });

        expect(result.investmentSplits[0].accountId).toBe(investmentAcct.id);
      });

      it("resolves a capital gain split to the brokerage account via the cash leg's parent", async () => {
        const db = getDb();
        const result = await createTransaction(db, bookId, {
          date: "2025-03-15",
          description: "VTI Cap Gain Distribution",
          splits: [
            { accountId: cashAcct.id, amount: 2500 },
            { accountId: incomeAcct.id, amount: -2500 },
          ],
          investmentSplits: [
            {
              securityId: security.id,
              action: "capGain",
              sharesMicros: 0,
              priceMicros: 0,
            },
          ],
        });

        expect(result.investmentSplits[0].accountId).toBe(investmentAcct.id);
      });

      it("resolves a fee split paid from investment cash to the brokerage account", async () => {
        const db = getDb();
        const result = await createTransaction(db, bookId, {
          date: "2025-03-15",
          description: "Advisory Fee",
          splits: [
            { accountId: expenseAcct.id, amount: 500 },
            { accountId: cashAcct.id, amount: -500 },
          ],
          investmentSplits: [
            {
              securityId: security.id,
              action: "fee",
              sharesMicros: 0,
              priceMicros: 0,
              feesCents: 500,
            },
          ],
        });

        expect(result.investmentSplits[0].accountId).toBe(investmentAcct.id);
      });

      it("leaves accountId null when a dividend's cash leg is not an investment-cash account", async () => {
        const db = getDb();
        const checking = await createAccount({
          name: "Plain Checking",
          type: "asset",
          subtype: "bank",
          bookId,
        });

        const result = await createTransaction(db, bookId, {
          date: "2025-03-15",
          description: "Dividend to checking",
          splits: [
            { accountId: checking.id, amount: 1500 },
            { accountId: incomeAcct.id, amount: -1500 },
          ],
          investmentSplits: [
            {
              securityId: security.id,
              action: "dividend",
              sharesMicros: 0,
              priceMicros: 0,
            },
          ],
        });

        expect(result.investmentSplits[0].accountId).toBeNull();
      });

      it("resolves the brokerage account when editing splits into a dividend via updateTransaction", async () => {
        const db = getDb();
        const txn = await createTransaction(db, bookId, {
          date: "2025-03-15",
          description: "VTI Dividend",
          splits: [
            { accountId: cashAcct.id, amount: 1500 },
            { accountId: incomeAcct.id, amount: -1500 },
          ],
          investmentSplits: [
            {
              securityId: security.id,
              action: "dividend",
              sharesMicros: 0,
              priceMicros: 0,
            },
          ],
        });

        const updated = await updateTransaction(db, bookId, txn.id, {
          splits: [
            { accountId: cashAcct.id, amount: 2000 },
            { accountId: incomeAcct.id, amount: -2000 },
          ],
          investmentSplits: [
            {
              securityId: security.id,
              action: "dividend",
              sharesMicros: 0,
              priceMicros: 0,
            },
          ],
        });

        expect(updated.investmentSplits[0].accountId).toBe(investmentAcct.id);
      });
    });

    it("rejects buy without an investment account in splits", async () => {
      const db = getDb();
      await expect(
        createTransaction(db, bookId, {
          date: "2025-03-01",
          splits: [
            { accountId: cashAcct.id, amount: 50000 },
            { accountId: expenseAcct.id, amount: -50000 },
          ],
          investmentSplits: [
            {
              securityId: security.id,
              action: "buy",
              sharesMicros: 10_000_000,
              priceMicros: 50_000_000,
            },
          ],
        })
      ).rejects.toThrow(
        "Investment splits require a transaction split on an investment account"
      );
    });

    it("rejects sell without an investment account in splits", async () => {
      const db = getDb();
      await expect(
        createTransaction(db, bookId, {
          date: "2025-03-01",
          splits: [
            { accountId: cashAcct.id, amount: -50000 },
            { accountId: incomeAcct.id, amount: 50000 },
          ],
          investmentSplits: [
            {
              securityId: security.id,
              action: "sell",
              sharesMicros: 10_000_000,
              priceMicros: 50_000_000,
            },
          ],
        })
      ).rejects.toThrow(
        "Investment splits require a transaction split on an investment account"
      );
    });

    it("requires investmentSplits when a split is on an investment account", async () => {
      const db = getDb();
      await expect(
        createTransaction(db, bookId, {
          date: "2025-03-01",
          splits: [
            { accountId: investmentAcct.id, amount: 50000 },
            { accountId: cashAcct.id, amount: -50000 },
          ],
        })
      ).rejects.toThrow("Investment transactions require investmentSplits");
    });

    it("updates a dividend transaction via updateTransaction", async () => {
      const db = getDb();
      const txn = await createTransaction(db, bookId, {
        date: "2025-03-15",
        description: "VTI Dividend",
        splits: [
          { accountId: cashAcct.id, amount: 1500 },
          { accountId: incomeAcct.id, amount: -1500 },
        ],
        investmentSplits: [
          {
            securityId: security.id,
            action: "dividend",
            sharesMicros: 0,
            priceMicros: 0,
          },
        ],
      });

      const updated = await updateTransaction(db, bookId, txn.id, {
        splits: [
          { accountId: cashAcct.id, amount: 2000 },
          { accountId: incomeAcct.id, amount: -2000 },
        ],
        investmentSplits: [
          {
            securityId: security.id,
            action: "dividend",
            sharesMicros: 0,
            priceMicros: 0,
          },
        ],
      });

      expect(updated.splits).toHaveLength(2);
      const cashSplit = updated.splits.find(
        (s: { accountId: number }) => s.accountId === cashAcct.id
      );
      expect(cashSplit?.amount).toBe(2000);
    });

    it("updates a buy to replace investment splits", async () => {
      const db = getDb();
      const txn = await createTransaction(db, bookId, {
        date: "2025-03-01",
        description: "Buy VTI",
        splits: [
          { accountId: investmentAcct.id, amount: 50000 },
          { accountId: cashAcct.id, amount: -50000 },
        ],
        investmentSplits: [
          {
            securityId: security.id,
            action: "buy",
            sharesMicros: 10_000_000,
            priceMicros: 50_000_000,
          },
        ],
      });

      const updated = await updateTransaction(db, bookId, txn.id, {
        splits: [
          { accountId: investmentAcct.id, amount: 75000 },
          { accountId: cashAcct.id, amount: -75000 },
        ],
        investmentSplits: [
          {
            securityId: security.id,
            action: "buy",
            sharesMicros: 15_000_000,
            priceMicros: 50_000_000,
          },
        ],
      });

      expect(updated.investmentSplits).toHaveLength(1);
      expect(Number(updated.investmentSplits[0].sharesMicros)).toBe(15_000_000);

      // Verify old investment splits were replaced
      const allInvSplits = await db
        .select()
        .from(investmentSplitsTable)
        .where(eq(investmentSplitsTable.transactionId, txn.id));
      expect(allInvSplits).toHaveLength(1);
      expect(Number(allInvSplits[0].sharesMicros)).toBe(15_000_000);
    });

    describe("validateInvestmentSplitReferences", () => {
      it("rejects security that does not belong to this book", async () => {
        const db = getDb();
        const book2 = await createBook({ name: "Other Book", userId: 1 });
        const otherSecurity = await createSecurity({
          name: "Other ETF",
          symbol: "SPY",
          securityType: "etf",
          bookId: book2.id,
        });

        await expect(
          createTransaction(db, bookId, {
            date: "2025-03-01",
            splits: [
              { accountId: investmentAcct.id, amount: 50000 },
              { accountId: cashAcct.id, amount: -50000 },
            ],
            investmentSplits: [
              {
                securityId: otherSecurity.id,
                action: "buy",
                sharesMicros: 10_000_000,
                priceMicros: 50_000_000,
              },
            ],
          })
        ).rejects.toThrow(
          "investment split securities do not belong to this book"
        );
      });

      it("rejects nonexistent security ID", async () => {
        const db = getDb();
        await expect(
          createTransaction(db, bookId, {
            date: "2025-03-01",
            splits: [
              { accountId: investmentAcct.id, amount: 50000 },
              { accountId: cashAcct.id, amount: -50000 },
            ],
            investmentSplits: [
              {
                securityId: 99999,
                action: "buy",
                sharesMicros: 10_000_000,
                priceMicros: 50_000_000,
              },
            ],
          })
        ).rejects.toThrow(
          "investment split securities do not belong to this book"
        );
      });

      // Lot-reference validation (rejecting a lotId from another book or
      // security) was removed along with InvestmentSplitInput.lotId: lot
      // assignment is no longer client-supplied input, it's derived entirely by
      // the FIFO replay engine in lib/lots-db.ts. See tests/lib/lots-db.test.ts
      // and tests/lib/transactions-lots.test.ts for the replacement coverage.
    });

    describe("validateInvestmentSplitPayload", () => {
      it("rejects NaN sharesMicros", async () => {
        const db = getDb();
        await expect(
          createTransaction(db, bookId, {
            date: "2025-03-01",
            splits: [
              { accountId: investmentAcct.id, amount: 50000 },
              { accountId: cashAcct.id, amount: -50000 },
            ],
            investmentSplits: [
              {
                securityId: security.id,
                action: "buy",
                sharesMicros: NaN,
                priceMicros: 50_000_000,
              },
            ],
          })
        ).rejects.toThrow("Invalid investment split values");
      });

      it("rejects Infinity priceMicros", async () => {
        const db = getDb();
        await expect(
          createTransaction(db, bookId, {
            date: "2025-03-01",
            splits: [
              { accountId: investmentAcct.id, amount: 50000 },
              { accountId: cashAcct.id, amount: -50000 },
            ],
            investmentSplits: [
              {
                securityId: security.id,
                action: "buy",
                sharesMicros: 10_000_000,
                priceMicros: Infinity,
              },
            ],
          })
        ).rejects.toThrow("Invalid investment split values");
      });

      it("rejects NaN securityId", async () => {
        const db = getDb();
        await expect(
          createTransaction(db, bookId, {
            date: "2025-03-01",
            splits: [
              { accountId: investmentAcct.id, amount: 50000 },
              { accountId: cashAcct.id, amount: -50000 },
            ],
            investmentSplits: [
              {
                securityId: NaN,
                action: "buy",
                sharesMicros: 10_000_000,
                priceMicros: 50_000_000,
              },
            ],
          })
        ).rejects.toThrow("Invalid investment split values");
      });
    });

    describe("validateInvestmentActions", () => {
      it("rejects buy with zero shares", async () => {
        const db = getDb();
        await expect(
          createTransaction(db, bookId, {
            date: "2025-03-01",
            splits: [
              { accountId: investmentAcct.id, amount: 50000 },
              { accountId: cashAcct.id, amount: -50000 },
            ],
            investmentSplits: [
              {
                securityId: security.id,
                action: "buy",
                sharesMicros: 0,
                priceMicros: 50_000_000,
              },
            ],
          })
        ).rejects.toThrow("Invalid investment actions");
      });

      it("rejects sell with negative sharesMicros", async () => {
        const db = getDb();
        await expect(
          createTransaction(db, bookId, {
            date: "2025-03-01",
            splits: [
              { accountId: investmentAcct.id, amount: -50000 },
              { accountId: cashAcct.id, amount: 50000 },
            ],
            investmentSplits: [
              {
                securityId: security.id,
                action: "sell",
                sharesMicros: -10_000_000,
                priceMicros: 50_000_000,
              },
            ],
          })
        ).rejects.toThrow("Invalid investment actions");
      });
    });

    describe("updateTransaction with investment splits only", () => {
      it("replaces investment splits without changing transaction splits", async () => {
        const db = getDb();
        const txn = await createTransaction(db, bookId, {
          date: "2025-03-01",
          description: "Buy VTI",
          splits: [
            { accountId: investmentAcct.id, amount: 50000 },
            { accountId: cashAcct.id, amount: -50000 },
          ],
          investmentSplits: [
            {
              securityId: security.id,
              action: "buy",
              sharesMicros: 10_000_000,
              priceMicros: 50_000_000,
            },
          ],
        });

        // Update only investment splits, leave transaction splits unchanged
        const updated = await updateTransaction(db, bookId, txn.id, {
          investmentSplits: [
            {
              securityId: security.id,
              action: "buy",
              sharesMicros: 20_000_000,
              priceMicros: 50_000_000,
            },
          ],
        });

        // Transaction splits should be unchanged
        expect(updated.splits).toHaveLength(2);
        // Investment splits should be updated
        expect(updated.investmentSplits).toHaveLength(1);
        expect(Number(updated.investmentSplits[0].sharesMicros)).toBe(
          20_000_000
        );
        // The investment account should still be derived from existing splits
        expect(updated.investmentSplits[0].accountId).toBe(investmentAcct.id);
      });

      it("deletes all investment splits when empty array is provided", async () => {
        const db = getDb();
        const txn = await createTransaction(db, bookId, {
          date: "2025-03-15",
          description: "VTI Dividend",
          splits: [
            { accountId: cashAcct.id, amount: 1500 },
            { accountId: incomeAcct.id, amount: -1500 },
          ],
          investmentSplits: [
            {
              securityId: security.id,
              action: "dividend",
              sharesMicros: 0,
              priceMicros: 0,
            },
          ],
        });

        expect(txn.investmentSplits).toHaveLength(1);

        // Pass empty array — should delete all investment splits
        const updated = await updateTransaction(db, bookId, txn.id, {
          investmentSplits: [],
        });

        expect(updated.investmentSplits).toHaveLength(0);

        // Verify at DB level
        const remaining = await db
          .select()
          .from(investmentSplitsTable)
          .where(eq(investmentSplitsTable.transactionId, txn.id));
        expect(remaining).toHaveLength(0);
      });

      it("preserves investment splits when investmentSplits is undefined", async () => {
        const db = getDb();
        const txn = await createTransaction(db, bookId, {
          date: "2025-03-01",
          description: "Buy VTI",
          splits: [
            { accountId: investmentAcct.id, amount: 50000 },
            { accountId: cashAcct.id, amount: -50000 },
          ],
          investmentSplits: [
            {
              securityId: security.id,
              action: "buy",
              sharesMicros: 10_000_000,
              priceMicros: 50_000_000,
            },
          ],
        });

        // Update only description — investmentSplits not provided
        const updated = await updateTransaction(db, bookId, txn.id, {
          description: "Buy VTI - corrected",
        });

        expect(updated.investmentSplits).toHaveLength(1);
        expect(Number(updated.investmentSplits[0].sharesMicros)).toBe(
          10_000_000
        );
      });
    });
  });
});
