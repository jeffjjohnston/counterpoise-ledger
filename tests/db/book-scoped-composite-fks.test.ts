import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  setupTestDatabase,
  resetTestDatabase,
  createBook,
  createAccount,
  createSecurity,
  createRecurringRule,
  createTransactionWithSplits,
} from "@/tests/helpers/db-utils";
import { exec, insert, rows, type Row } from "@/tests/helpers/sql";

/**
 * The core-ledger relations carry a composite (book_id, parent_id) foreign key,
 * so the database, not only the application, refuses a row that points at a
 * parent in a different book (rust-api/db/migrations/0001_baseline.sql).
 *
 * Every case asserts BOTH halves. A constraint that rejects everything looks
 * exactly like a working one if you only test the rejection, so each relation
 * also writes a valid same-book row and requires it to be accepted.
 *
 * The inserts go straight to the table: the point is what the database
 * enforces on its own, after a future call site forgets to check.
 */
describe("book-scoped composite foreign keys", () => {
  // Book 1 is seeded by the test database; book 2 is the foreign one.
  let mine: Awaited<ReturnType<typeof fixtures>>;

  async function fixtures() {
    await createBook({ name: "Other Book" });

    const myParent = await createAccount({ name: "My Parent", type: "expense", bookId: 1 });
    const myAccount = await createAccount({ name: "My Asset", type: "asset", subtype: "bank", bookId: 1 });
    const theirAccount = await createAccount({ name: "Their Asset", type: "asset", subtype: "bank", bookId: 2 });
    const mySecurity = await createSecurity({ name: "Mine", symbol: "MINE", securityType: "etf", bookId: 1 });
    const theirSecurity = await createSecurity({ name: "Theirs", symbol: "THRS", securityType: "etf", bookId: 2 });
    // createRecurringRule always writes at least one template split, so each
    // rule gets one pointing at its own book's account.
    const myRule = await createRecurringRule({
      name: "My rule",
      frequency: "monthly",
      startDate: "2026-01-01",
      nextDate: "2026-02-01",
      bookId: 1,
      templateSplits: [{ accountId: myAccount.id, amount: 0 }],
    });
    const theirRule = await createRecurringRule({
      name: "Their rule",
      frequency: "monthly",
      startDate: "2026-01-01",
      nextDate: "2026-02-01",
      bookId: 2,
      templateSplits: [{ accountId: theirAccount.id, amount: 0 }],
    });
    const myTransaction = await createTransactionWithSplits({
      date: "2026-01-15",
      bookId: 1,
      splits: [{ accountId: myAccount.id, amount: 0 }],
    });
    const theirTransaction = await createTransactionWithSplits({
      date: "2026-01-15",
      bookId: 2,
      splits: [{ accountId: theirAccount.id, amount: 0 }],
    });

    return {
      myParent,
      myAccount,
      theirAccount,
      mySecurity,
      theirSecurity,
      myRule,
      theirRule,
      myTransaction,
      theirTransaction,
    };
  }

  /**
   * SQLite does not name the constraint in its error. So the case asserts the
   * rejection, then writes the same row with the checks off and asks
   * `PRAGMA foreign_key_check` which parent table the row violates. That proves
   * THIS foreign key did the rejecting, and not an unrelated one. The row is
   * deleted again before the checks go back on.
   */
  async function expectRejected(table: string, values: Row, parent: string) {
    await expect(insert(table, values), "expected the database to reject this row")
      .rejects.toThrow(/FOREIGN KEY constraint failed/);

    await exec("PRAGMA foreign_keys = OFF");
    try {
      await insert(table, values);
      const violations = await rows<{ parent: string }>(`PRAGMA foreign_key_check(${table})`);
      expect(violations.map((v) => v.parent)).toEqual([parent]);
      await exec(`DELETE FROM ${table} WHERE rowid = (SELECT MAX(rowid) FROM ${table})`);
    } finally {
      await exec("PRAGMA foreign_keys = ON");
    }
  }

  beforeAll(async () => {
    await setupTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
    mine = await fixtures();
  });

  /** A minimal valid investment split. Callers supply only what the case varies. */
  const investmentSplit = (overrides: Row): Row => ({
    bookId: 1,
    action: "buy",
    sharesMicros: 1_000_000,
    priceMicros: 1_000_000,
    ...overrides,
  });

  it("transaction_splits cannot reference an account in another book", async () => {
    await expectRejected(
      "transaction_splits",
      { bookId: 1, transactionId: mine.myTransaction.id, accountId: mine.theirAccount.id, amount: 100 },
      "accounts"
    );
    await expect(
      insert("transaction_splits", { bookId: 1, transactionId: mine.myTransaction.id, accountId: mine.myAccount.id, amount: 100 })
    ).resolves.toBeDefined();
  });

  it("transaction_splits cannot reference a transaction in another book", async () => {
    await expectRejected(
      "transaction_splits",
      { bookId: 1, transactionId: mine.theirTransaction.id, accountId: mine.myAccount.id, amount: 100 },
      "transactions"
    );
    await expect(
      insert("transaction_splits", { bookId: 1, transactionId: mine.myTransaction.id, accountId: mine.myAccount.id, amount: -100 })
    ).resolves.toBeDefined();
  });

  it("investment_splits cannot reference a transaction in another book", async () => {
    await expectRejected(
      "investment_splits",
      investmentSplit({ transactionId: mine.theirTransaction.id, accountId: mine.myAccount.id, securityId: mine.mySecurity.id }),
      "transactions"
    );
    await expect(
      insert("investment_splits", investmentSplit({ transactionId: mine.myTransaction.id, accountId: mine.myAccount.id, securityId: mine.mySecurity.id }))
    ).resolves.toBeDefined();
  });

  it("investment_splits cannot reference an account in another book", async () => {
    await expectRejected(
      "investment_splits",
      investmentSplit({ transactionId: mine.myTransaction.id, accountId: mine.theirAccount.id, securityId: mine.mySecurity.id }),
      "accounts"
    );
    await expect(
      insert("investment_splits", investmentSplit({ transactionId: mine.myTransaction.id, accountId: mine.myAccount.id, securityId: mine.mySecurity.id }))
    ).resolves.toBeDefined();
  });

  it("investment_splits cannot reference a security in another book", async () => {
    await expectRejected(
      "investment_splits",
      investmentSplit({ transactionId: mine.myTransaction.id, accountId: mine.myAccount.id, securityId: mine.theirSecurity.id }),
      "securities"
    );
    await expect(
      insert("investment_splits", investmentSplit({ transactionId: mine.myTransaction.id, accountId: mine.myAccount.id, securityId: mine.mySecurity.id }))
    ).resolves.toBeDefined();
  });

  it("security_prices cannot reference a security in another book", async () => {
    await expectRejected(
      "security_prices",
      { bookId: 1, securityId: mine.theirSecurity.id, priceDate: "2026-03-01", priceMicros: 1_000_000 },
      "securities"
    );
    await expect(
      insert("security_prices", { bookId: 1, securityId: mine.mySecurity.id, priceDate: "2026-03-01", priceMicros: 1_000_000 })
    ).resolves.toBeDefined();
  });

  it("an account cannot have a parent in another book", async () => {
    await expectRejected(
      "accounts",
      { bookId: 1, name: "Cross-book child", type: "expense", parentId: mine.theirAccount.id },
      "accounts"
    );
    await expect(
      insert("accounts", { bookId: 1, name: "Same-book child", type: "expense", parentId: mine.myParent.id })
    ).resolves.toBeDefined();
  });

  it("recurring_template_splits cannot reference a rule in another book", async () => {
    await expectRejected(
      "recurring_template_splits",
      { bookId: 1, recurringRuleId: mine.theirRule.id, accountId: mine.myAccount.id, amount: 100 },
      "recurring_rules"
    );
    await expect(
      insert("recurring_template_splits", { bookId: 1, recurringRuleId: mine.myRule.id, accountId: mine.myAccount.id, amount: 100 })
    ).resolves.toBeDefined();
  });

  /**
   * Vary ONLY the account. The rule-id case above pins accountId to myAccount in
   * both halves, so it cannot tell whether the account column is scoped at all.
   */
  it("recurring_template_splits cannot reference an account in another book", async () => {
    await expectRejected(
      "recurring_template_splits",
      { bookId: 1, recurringRuleId: mine.myRule.id, accountId: mine.theirAccount.id, amount: 100 },
      "accounts"
    );
    await expect(
      insert("recurring_template_splits", { bookId: 1, recurringRuleId: mine.myRule.id, accountId: mine.myAccount.id, amount: 100 })
    ).resolves.toBeDefined();
  });

  /**
   * SQLite does not check a composite key that contains a NULL. A root account
   * and a dividend split with no investment account both depend on that, and
   * both are ordinary rows.
   */
  it("still accepts the nullable halves of these keys", async () => {
    await expect(
      insert("accounts", { bookId: 1, name: "Root account", type: "expense", parentId: null })
    ).resolves.toBeDefined();
    await expect(
      insert("investment_splits", investmentSplit({
        transactionId: mine.myTransaction.id,
        accountId: null,
        securityId: mine.mySecurity.id,
        action: "dividend",
      }))
    ).resolves.toBeDefined();
  });
});
