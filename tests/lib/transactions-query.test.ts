import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  setupTestDatabase,
  resetTestDatabase,
  createAccount,
  createBook,
  createPayee,
  createTransactionWithSplits,
} from "@/tests/helpers/db-utils";
import { getDb } from "@/db";
import { books } from "@/db/schema";
import {
  selectTransactionPage,
  countTransactionsBefore,
} from "@/lib/transactions-query";
import { TransactionValidationError } from "@/lib/transactions";
import { toDateString } from "@/lib/formatters";

describe("transactions query", () => {
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

  const seedThree = async () => {
    const checking = await createAccount({ bookId, name: "Checking", type: "asset" });
    const groceries = await createAccount({ bookId, name: "Groceries", type: "expense" });
    const made = [];
    for (const day of ["01", "02", "03"]) {
      made.push(
        await createTransactionWithSplits({
          bookId, date: `2026-01-${day}`, description: `Txn ${day}`,
          splits: [
            { accountId: checking.id, amount: -100 },
            { accountId: groceries.id, amount: 100 },
          ],
        })
      );
    }
    return { checking, groceries, made };
  };

  describe("selectTransactionPage", () => {
    it("returns rows newest first with the date the caller needs for an anchor", async () => {
      const db = getDb();
      await seedThree();

      const { rows, totalCount } = await selectTransactionPage(db, bookId, {});

      expect(rows.map((r) => r.date)).toEqual(["2026-01-03", "2026-01-02", "2026-01-01"]);
      expect(totalCount).toBe(3);
    });

    it("breaks a date tie by id descending", async () => {
      const db = getDb();
      const checking = await createAccount({ bookId, name: "Checking", type: "asset" });
      const groceries = await createAccount({ bookId, name: "Groceries", type: "expense" });
      const first = await createTransactionWithSplits({
        bookId, date: "2026-01-10", description: "First",
        splits: [
          { accountId: checking.id, amount: -100 },
          { accountId: groceries.id, amount: 100 },
        ],
      });
      const second = await createTransactionWithSplits({
        bookId, date: "2026-01-10", description: "Second",
        splits: [
          { accountId: checking.id, amount: -200 },
          { accountId: groceries.id, amount: 200 },
        ],
      });

      const { rows } = await selectTransactionPage(db, bookId, {});

      expect(rows.map((r) => r.id)).toEqual([second.id, first.id]);
    });

    it("returns each matching transaction once when it has several splits on the filtered accounts", async () => {
      // The account filter joins transaction_splits, so a transaction with a
      // split on BOTH filtered accounts would appear twice without the
      // grouping. This is the test that pins the de-duplication.
      const db = getDb();
      const checking = await createAccount({ bookId, name: "Checking", type: "asset" });
      const groceries = await createAccount({ bookId, name: "Groceries", type: "expense" });
      await createTransactionWithSplits({
        bookId, date: "2026-01-10", description: "Both legs filtered",
        splits: [
          { accountId: checking.id, amount: -100 },
          { accountId: groceries.id, amount: 100 },
        ],
      });

      const { rows, totalCount } = await selectTransactionPage(db, bookId, {
        accountIds: [checking.id, groceries.id],
      });

      expect(rows).toHaveLength(1);
      expect(totalCount).toBe(1);
    });

    it("skips the count when withCount is false", async () => {
      const db = getDb();
      await seedThree();

      const { rows, totalCount } = await selectTransactionPage(db, bookId, {
        withCount: false,
      });

      expect(rows).toHaveLength(3);
      expect(totalCount).toBeNull();
    });

    it("returns every row when limit is null", async () => {
      const db = getDb();
      await seedThree();

      const { rows } = await selectTransactionPage(db, bookId, { limit: null });

      expect(rows).toHaveLength(3);
    });

    it("applies limit and offset to give disjoint pages", async () => {
      const db = getDb();
      await seedThree();

      const first = await selectTransactionPage(db, bookId, { limit: 2, offset: 0 });
      const second = await selectTransactionPage(db, bookId, { limit: 2, offset: 2 });

      expect(first.rows).toHaveLength(2);
      expect(second.rows).toHaveLength(1);
      expect(first.totalCount).toBe(3);
      const firstIds = first.rows.map((r) => r.id);
      expect(second.rows.filter((r) => firstIds.includes(r.id))).toEqual([]);
    });

    it("filters by date range on the effective date", async () => {
      const db = getDb();
      await seedThree();

      const { rows } = await selectTransactionPage(db, bookId, {
        startDate: "2026-01-02",
        endDate: "2026-01-02",
      });

      expect(rows.map((r) => r.date)).toEqual(["2026-01-02"]);
    });

    it("throws TransactionValidationError for a payee in another book and returns nothing", async () => {
      const db = getDb();
      await seedThree();
      const other = await createBook({ name: "Other Book" });
      const theirs = await createPayee({ name: "Theirs", bookId: other.id });

      await expect(
        selectTransactionPage(db, bookId, { payeeId: theirs.id })
      ).rejects.toThrow(TransactionValidationError);
      await expect(
        selectTransactionPage(db, bookId, { payeeId: theirs.id })
      ).rejects.toThrow("Invalid payeeId");
    });

    it("throws TransactionValidationError when accountIds includes another book's account, and returns nothing", async () => {
      const db = getDb();
      const { checking } = await seedThree();
      const other = await createBook({ name: "Other Book" });
      const theirAccount = await createAccount({
        bookId: other.id, name: "Theirs", type: "asset",
      });

      let result: Awaited<ReturnType<typeof selectTransactionPage>> | undefined;
      let caught: unknown;
      try {
        result = await selectTransactionPage(db, bookId, {
          accountIds: [checking.id, theirAccount.id],
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(TransactionValidationError);
      // Confirms the call never resolved to a page at all — a silent
      // { rows: [], totalCount: 0 } would leave `result` set, not undefined.
      expect(result).toBeUndefined();
    });

    it("throws TransactionValidationError for an empty accountIds array instead of matching the whole book", async () => {
      const db = getDb();
      await seedThree();

      await expect(
        selectTransactionPage(db, bookId, { accountIds: [] })
      ).rejects.toThrow(TransactionValidationError);
      await expect(
        selectTransactionPage(db, bookId, { accountIds: [] })
      ).rejects.toThrow("accountIds must not be empty");
    });

    it("does not return another book's transactions", async () => {
      const db = getDb();
      await seedThree();
      const other = await createBook({ name: "Other Book" });
      const theirAccount = await createAccount({
        bookId: other.id, name: "Theirs", type: "asset",
      });
      const theirExpense = await createAccount({
        bookId: other.id, name: "Their Expense", type: "expense",
      });
      await createTransactionWithSplits({
        bookId: other.id, date: "2026-06-01", description: "Not mine",
        splits: [
          { accountId: theirAccount.id, amount: -100 },
          { accountId: theirExpense.id, amount: 100 },
        ],
      });

      const { rows, totalCount } = await selectTransactionPage(db, bookId, {});

      expect(rows).toHaveLength(3);
      expect(totalCount).toBe(3);
    });

    it("orders a floating transaction by its effective date, not its stored date", async () => {
      // Regression guard: the orderBy in selectTransactionPage sorts by
      // effectiveDateSql. If that were swapped for the raw transactions.date
      // column, the floating row (stored far in the past) would sort LAST
      // instead of FIRST, because its effective date is today, not 2020.
      const db = getDb();
      const checking = await createAccount({ bookId, name: "Checking", type: "asset" });
      const groceries = await createAccount({ bookId, name: "Groceries", type: "expense" });
      const fixed = await createTransactionWithSplits({
        bookId, date: "2024-06-15", description: "Fixed, recorded in the past",
        splits: [
          { accountId: checking.id, amount: -100 },
          { accountId: groceries.id, amount: 100 },
        ],
      });
      const floating = await createTransactionWithSplits({
        bookId, date: "2020-01-01", description: "Floating, stored date long past",
        isFloating: true,
        splits: [
          { accountId: checking.id, amount: -50 },
          { accountId: groceries.id, amount: 50 },
        ],
      });

      const { rows } = await selectTransactionPage(db, bookId, {});

      expect(rows.map((r) => r.id)).toEqual([floating.id, fixed.id]);
    });

    it("includes a floating transaction under today's date filter despite its old stored date", async () => {
      // Regression guard: the startDate/endDate conditions in
      // buildTransactionFilters compare against effectiveDateSql. If that
      // were swapped for the raw transactions.date column, the floating row
      // (stored as 2020-01-01) would be filtered OUT of a range anchored on
      // today, even though its effective date IS today.
      const db = getDb();
      const checking = await createAccount({ bookId, name: "Checking", type: "asset" });
      const groceries = await createAccount({ bookId, name: "Groceries", type: "expense" });
      const floating = await createTransactionWithSplits({
        bookId, date: "2020-01-01", description: "Old stored date, but floating",
        isFloating: true,
        splits: [
          { accountId: checking.id, amount: -50 },
          { accountId: groceries.id, amount: 50 },
        ],
      });
      await createTransactionWithSplits({
        bookId, date: "2020-01-01", description: "Old stored date, and fixed",
        splits: [
          { accountId: checking.id, amount: -100 },
          { accountId: groceries.id, amount: 100 },
        ],
      });
      const today = toDateString(new Date());

      const { rows } = await selectTransactionPage(db, bookId, {
        startDate: today,
        endDate: today,
      });

      expect(rows.map((r) => r.id)).toEqual([floating.id]);
      expect(rows[0].date).toBe(today);
    });

    it("orders and dates a floating transaction correctly on the joined (accountIds) branch", async () => {
      // Regression guard for the JOINED branch specifically — passing
      // accountIds routes execution through the `if (joinsSplits)` branch,
      // which has its own orderBy (line 137) and its own `date:
      // effectiveDateSql.as("date")` projection (line 129), separate from
      // the non-joined branch's copies. Neither is exercised by the two
      // floating tests above, since neither of those passes accountIds. A
      // regression that swapped only the joined branch's effectiveDateSql
      // for transactions.date, leaving the non-joined branch alone, would
      // pass every other test in this file.
      //
      // Splits must land on the accounts named in accountIds, or the join
      // filters both rows out and the assertions below would pass for the
      // wrong reason (empty result, not correct ordering/dating).
      const db = getDb();
      const checking = await createAccount({ bookId, name: "Checking", type: "asset" });
      const groceries = await createAccount({ bookId, name: "Groceries", type: "expense" });
      const fixed = await createTransactionWithSplits({
        bookId, date: "2024-06-15", description: "Fixed, recorded in the past",
        splits: [
          { accountId: checking.id, amount: -100 },
          { accountId: groceries.id, amount: 100 },
        ],
      });
      const floating = await createTransactionWithSplits({
        bookId, date: "2020-01-01", description: "Floating, stored date long past",
        isFloating: true,
        splits: [
          { accountId: checking.id, amount: -50 },
          { accountId: groceries.id, amount: 50 },
        ],
      });
      const today = toDateString(new Date());

      const { rows } = await selectTransactionPage(db, bookId, {
        accountIds: [checking.id, groceries.id],
      });

      // Order: floating first, because its effective date is today, which
      // is after the fixed row's stored date of 2024-06-15.
      expect(rows.map((r) => r.id)).toEqual([floating.id, fixed.id]);
      // Date: the floating row's returned `date` is today, not its stored
      // 2020-01-01 — this is the value the route anchors a running-balance
      // sum on, so a wrong date here produces a wrong starting balance.
      expect(rows[0].date).toBe(today);
      expect(rows[1].date).toBe("2024-06-15");
    });
  });

  describe("countTransactionsBefore", () => {
    it("counts the rows that sort ahead of the anchor", async () => {
      const db = getDb();
      await seedThree();
      const { rows } = await selectTransactionPage(db, bookId, {});
      const oldest = rows[rows.length - 1];

      const before = await countTransactionsBefore(db, bookId, {}, {
        date: oldest.date,
        id: oldest.id,
      });

      // Two rows sort ahead of the oldest of three.
      expect(before).toBe(2);
    });

    it("honours the same filters as the page select", async () => {
      const db = getDb();
      const { checking } = await seedThree();
      const { rows } = await selectTransactionPage(db, bookId, {
        accountIds: [checking.id],
      });
      const oldest = rows[rows.length - 1];

      const before = await countTransactionsBefore(
        db, bookId, { accountIds: [checking.id], startDate: "2026-01-03" },
        { date: oldest.date, id: oldest.id }
      );

      // Only 2026-01-03 is in range, and it sorts ahead of the oldest row.
      expect(before).toBe(1);
    });

    it("counts a transaction with splits on two filtered accounts once, not twice", async () => {
      // Pins count(distinct transactions.id) in the joined branch. Both legs
      // of the "buy" below land on the two filtered accounts, so the join
      // produces two matching split rows for that one transaction. Dropping
      // `distinct` in favor of count(*) would count it twice.
      const db = getDb();
      const investment = await createAccount({
        bookId, name: "Brokerage", type: "asset", subtype: "investment",
      });
      const cash = await createAccount({
        bookId, name: "Brokerage Cash", type: "asset", isInvestmentCash: true,
      });
      const other = await createAccount({ bookId, name: "Other Expense", type: "expense" });

      const anchor = await createTransactionWithSplits({
        bookId, date: "2026-01-01", description: "Anchor",
        splits: [
          { accountId: investment.id, amount: -10 },
          { accountId: other.id, amount: 10 },
        ],
      });
      await createTransactionWithSplits({
        bookId, date: "2026-01-05", description: "Buy shares — both legs filtered",
        splits: [
          { accountId: investment.id, amount: 100 },
          { accountId: cash.id, amount: -100 },
        ],
      });

      const before = await countTransactionsBefore(
        db, bookId, { accountIds: [investment.id, cash.id] },
        { date: anchor.date, id: anchor.id }
      );

      expect(before).toBe(1);
    });

    it("counts a floating transaction ahead of a fixed anchor by effective date, not stored date", async () => {
      // Regression guard for positionFilter's first arm (effectiveDateSql >
      // at.date). If that comparison were swapped for the raw
      // transactions.date column, the floating row (stored in 2020) would
      // sort BEHIND the anchor instead of ahead, and the count would be 0
      // instead of 1.
      const db = getDb();
      const checking = await createAccount({ bookId, name: "Checking", type: "asset" });
      const groceries = await createAccount({ bookId, name: "Groceries", type: "expense" });
      const anchor = await createTransactionWithSplits({
        bookId, date: "2024-06-15", description: "Fixed anchor",
        splits: [
          { accountId: checking.id, amount: -100 },
          { accountId: groceries.id, amount: 100 },
        ],
      });
      await createTransactionWithSplits({
        bookId, date: "2020-01-01", description: "Floating, old stored date",
        isFloating: true,
        splits: [
          { accountId: checking.id, amount: -50 },
          { accountId: groceries.id, amount: 50 },
        ],
      });

      const before = await countTransactionsBefore(db, bookId, {}, {
        date: anchor.date,
        id: anchor.id,
      });

      expect(before).toBe(1);
    });

    it("counts a floating transaction tied on today's date via the id tie-break, not the stored date", async () => {
      // Regression guard for positionFilter's second arm (effectiveDateSql =
      // at.date AND id > at.id). Only reachable with a floating row when the
      // anchor's own effective date is ALSO today, so the anchor here is a
      // fixed transaction dated today. Under effectiveDateSql both rows tie
      // on today's date, and the floating row (created after, higher id)
      // counts via the id tie-break. Under raw transactions.date the
      // floating row's stored date (2020-01-01) matches neither arm, so it
      // would drop out and the count would be 0 instead of 1.
      const db = getDb();
      const checking = await createAccount({ bookId, name: "Checking", type: "asset" });
      const groceries = await createAccount({ bookId, name: "Groceries", type: "expense" });
      const today = toDateString(new Date());
      const anchor = await createTransactionWithSplits({
        bookId, date: today, description: "Fixed anchor dated today",
        splits: [
          { accountId: checking.id, amount: -100 },
          { accountId: groceries.id, amount: 100 },
        ],
      });
      await createTransactionWithSplits({
        bookId, date: "2020-01-01", description: "Floating, old stored date",
        isFloating: true,
        splits: [
          { accountId: checking.id, amount: -50 },
          { accountId: groceries.id, amount: 50 },
        ],
      });

      const before = await countTransactionsBefore(db, bookId, {}, {
        date: anchor.date,
        id: anchor.id,
      });

      expect(before).toBe(1);
    });
  });
});
