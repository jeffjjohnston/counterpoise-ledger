import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db } from "@/tests/helpers/db-utils";
import {
  setupTestDatabase,
  resetTestDatabase,
  createBook,
  createAccount,
  createSecurity,
  createRecurringRule,
  createTransactionWithSplits,
} from "@/tests/helpers/db";
import {
  accounts,
  investmentSplits,
  recurringTemplateSplits,
  securityPrices,
  transactionSplits,
} from "@/db/schema";

/**
 * The core-ledger relations carry a composite (book_id, parent_id) foreign key,
 * so the database — not just the application — refuses a row that points at a
 * parent in a different book. Added by migration 0019, plus
 * recurring_template_splits.account_id by migration 0021.
 *
 * Every case asserts BOTH halves. A constraint that rejects everything looks
 * exactly like a working one if you only test the rejection, so each relation
 * also writes a valid same-book row and requires it to be accepted.
 *
 * The write paths in lib/ all scope their lookups already, which is why these
 * inserts go straight to the table: the point is what the database enforces on
 * its own, after a future call site forgets to check.
 */
describe("book-scoped composite foreign keys", () => {
  // Book 1 is seeded by the test database; book 2 is the foreign one.
  let mine: Awaited<ReturnType<typeof fixtures>>;

  async function fixtures() {
    await createBook({ name: "Other Book" });

    const [myParent, myAccount, theirAccount] = await Promise.all([
      createAccount({ name: "My Parent", type: "expense", bookId: 1 }),
      createAccount({ name: "My Asset", type: "asset", subtype: "bank", bookId: 1 }),
      createAccount({ name: "Their Asset", type: "asset", subtype: "bank", bookId: 2 }),
    ]);
    const [mySecurity, theirSecurity] = await Promise.all([
      createSecurity({ name: "Mine", symbol: "MINE", securityType: "etf", bookId: 1 }),
      createSecurity({ name: "Theirs", symbol: "THRS", securityType: "etf", bookId: 2 }),
    ]);
    // createRecurringRule always writes at least one template split, so each
    // rule gets one pointing at its own book's account.
    const [myRule, theirRule] = await Promise.all([
      createRecurringRule({
        name: "My rule",
        frequency: "monthly",
        startDate: "2026-01-01",
        nextDate: "2026-02-01",
        bookId: 1,
        templateSplits: [{ accountId: myAccount.id, amount: 0 }],
      }),
      createRecurringRule({
        name: "Their rule",
        frequency: "monthly",
        startDate: "2026-01-01",
        nextDate: "2026-02-01",
        bookId: 2,
        templateSplits: [{ accountId: theirAccount.id, amount: 0 }],
      }),
    ]);
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
   * Drizzle wraps a query failure in its own error and puts the driver error on
   * `cause`, so the constraint name is not in the top-level message. Walk the
   * chain for postgres.js's `constraint_name` instead: asserting the exact
   * constraint proves THIS foreign key did the rejecting, where matching on the
   * message would also pass if some unrelated constraint fired first.
   */
  function rejectingConstraint(error: unknown): string | undefined {
    for (let current = error; current; current = (current as { cause?: unknown }).cause) {
      const name = (current as { constraint_name?: unknown }).constraint_name;
      if (typeof name === "string") return name;
    }
    return undefined;
  }

  async function expectRejected(insert: Promise<unknown>, constraint: string) {
    const error = await insert.then(
      () => null,
      (thrown: unknown) => thrown
    );
    expect(error, "expected the database to reject this row").not.toBeNull();
    expect(rejectingConstraint(error)).toBe(constraint);
  }

  beforeAll(async () => {
    await setupTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
    mine = await fixtures();
  });

  type InvestmentSplitInsert = typeof investmentSplits.$inferInsert;

  /** A minimal valid investment split. Callers supply only what the case varies. */
  const investmentSplit = (
    overrides: Partial<InvestmentSplitInsert> &
      Pick<InvestmentSplitInsert, "bookId" | "transactionId" | "securityId">
  ): InvestmentSplitInsert => ({
    action: "buy",
    sharesMicros: 1_000_000,
    priceMicros: 1_000_000,
    ...overrides,
  });

  it("transaction_splits cannot reference an account in another book", async () => {
    await expectRejected(
      db.insert(transactionSplits).values({
        bookId: 1,
        transactionId: mine.myTransaction.id,
        accountId: mine.theirAccount.id,
        amount: 100,
      }),
      "transaction_splits_book_account_fk"
    );

    await expect(
      db.insert(transactionSplits).values({
        bookId: 1,
        transactionId: mine.myTransaction.id,
        accountId: mine.myAccount.id,
        amount: 100,
      })
    ).resolves.toBeDefined();
  });

  it("transaction_splits cannot reference a transaction in another book", async () => {
    await expectRejected(
      db.insert(transactionSplits).values({
        bookId: 1,
        transactionId: mine.theirTransaction.id,
        accountId: mine.myAccount.id,
        amount: 100,
      }),
      "transaction_splits_book_transaction_fk"
    );

    await expect(
      db.insert(transactionSplits).values({
        bookId: 1,
        transactionId: mine.myTransaction.id,
        accountId: mine.myAccount.id,
        amount: -100,
      })
    ).resolves.toBeDefined();
  });

  it("investment_splits cannot reference a transaction in another book", async () => {
    await expectRejected(
      db.insert(investmentSplits).values(
        investmentSplit({
          bookId: 1,
          transactionId: mine.theirTransaction.id,
          accountId: mine.myAccount.id,
          securityId: mine.mySecurity.id,
        })
      ),
      "investment_splits_book_transaction_fk"
    );

    await expect(
      db.insert(investmentSplits).values(
        investmentSplit({
          bookId: 1,
          transactionId: mine.myTransaction.id,
          accountId: mine.myAccount.id,
          securityId: mine.mySecurity.id,
        })
      )
    ).resolves.toBeDefined();
  });

  it("investment_splits cannot reference an account in another book", async () => {
    await expectRejected(
      db.insert(investmentSplits).values(
        investmentSplit({
          bookId: 1,
          transactionId: mine.myTransaction.id,
          accountId: mine.theirAccount.id,
          securityId: mine.mySecurity.id,
        })
      ),
      "investment_splits_book_account_fk"
    );

    await expect(
      db.insert(investmentSplits).values(
        investmentSplit({
          bookId: 1,
          transactionId: mine.myTransaction.id,
          accountId: mine.myAccount.id,
          securityId: mine.mySecurity.id,
        })
      )
    ).resolves.toBeDefined();
  });

  it("investment_splits cannot reference a security in another book", async () => {
    await expectRejected(
      db.insert(investmentSplits).values(
        investmentSplit({
          bookId: 1,
          transactionId: mine.myTransaction.id,
          accountId: mine.myAccount.id,
          securityId: mine.theirSecurity.id,
        })
      ),
      "investment_splits_book_security_fk"
    );

    await expect(
      db.insert(investmentSplits).values(
        investmentSplit({
          bookId: 1,
          transactionId: mine.myTransaction.id,
          accountId: mine.myAccount.id,
          securityId: mine.mySecurity.id,
        })
      )
    ).resolves.toBeDefined();
  });

  it("security_prices cannot reference a security in another book", async () => {
    await expectRejected(
      db.insert(securityPrices).values({
        bookId: 1,
        securityId: mine.theirSecurity.id,
        priceDate: "2026-03-01",
        priceMicros: 1_000_000,
      }),
      "security_prices_book_security_fk"
    );

    await expect(
      db.insert(securityPrices).values({
        bookId: 1,
        securityId: mine.mySecurity.id,
        priceDate: "2026-03-01",
        priceMicros: 1_000_000,
      })
    ).resolves.toBeDefined();
  });

  it("an account cannot have a parent in another book", async () => {
    await expectRejected(
      db.insert(accounts).values({
        bookId: 1,
        name: "Cross-book child",
        type: "expense",
        parentId: mine.theirAccount.id,
      }),
      "accounts_book_parent_fk"
    );

    await expect(
      db.insert(accounts).values({
        bookId: 1,
        name: "Same-book child",
        type: "expense",
        parentId: mine.myParent.id,
      })
    ).resolves.toBeDefined();
  });

  it("recurring_template_splits cannot reference a rule in another book", async () => {
    await expectRejected(
      db.insert(recurringTemplateSplits).values({
        bookId: 1,
        recurringRuleId: mine.theirRule.id,
        accountId: mine.myAccount.id,
        amount: 100,
      }),
      "recurring_template_splits_book_rule_fk"
    );

    await expect(
      db.insert(recurringTemplateSplits).values({
        bookId: 1,
        recurringRuleId: mine.myRule.id,
        accountId: mine.myAccount.id,
        amount: 100,
      })
    ).resolves.toBeDefined();
  });

  /**
   * Vary ONLY the account. The rule-id case above pins accountId to myAccount in
   * both halves, so it cannot tell whether the account column is scoped at all.
   * Naming the constraint keeps a rejection from the rule key out of the result.
   */
  it("recurring_template_splits cannot reference an account in another book", async () => {
    await expectRejected(
      db.insert(recurringTemplateSplits).values({
        bookId: 1,
        recurringRuleId: mine.myRule.id,
        accountId: mine.theirAccount.id,
        amount: 100,
      }),
      "recurring_template_splits_book_account_fk"
    );

    await expect(
      db.insert(recurringTemplateSplits).values({
        bookId: 1,
        recurringRuleId: mine.myRule.id,
        accountId: mine.myAccount.id,
        amount: 100,
      })
    ).resolves.toBeDefined();
  });

  /**
   * PostgreSQL uses MATCH SIMPLE by default, so a composite key that contains a
   * NULL is not checked at all. A root account and a dividend split with no
   * investment account both depend on that, and both are ordinary rows.
   */
  it("still accepts the nullable halves of these keys", async () => {
    await expect(
      db.insert(accounts).values({
        bookId: 1,
        name: "Root account",
        type: "expense",
        parentId: null,
      })
    ).resolves.toBeDefined();

    await expect(
      db.insert(investmentSplits).values(
        investmentSplit({
          bookId: 1,
          transactionId: mine.myTransaction.id,
          accountId: null,
          securityId: mine.mySecurity.id,
          action: "dividend",
        })
      )
    ).resolves.toBeDefined();
  });
});
