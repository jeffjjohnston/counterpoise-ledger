import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import {
  books,
  payees,
  recurringRules,
  recurringTemplateSplits,
  transactions,
} from "@/db/schema";
import {
  setupTestDatabase,
  resetTestDatabase,
  createAccount,
  createBook,
  createPayee,
  createRecurringRule,
  createTransactionWithSplits,
} from "@/tests/helpers/db-utils";
import {
  createRecurringRule as createRule,
  updateRecurringRule as updateRule,
  deleteRecurringRule as deleteRule,
  getProjectedTransactions,
  getRecurringRule,
  listRecurringRules,
  listRecurringTransactions,
  RecurringRuleNotFoundError,
  RecurringRuleValidationError,
} from "@/lib/recurring-rules";

const bookId = 1;

beforeAll(async () => {
  await setupTestDatabase();
});

beforeEach(async () => {
  await resetTestDatabase();
});

async function fixture() {
  const checking = await createAccount({
    name: "Checking", type: "asset", subtype: "bank", bookId,
  });
  const rent = await createAccount({
    name: "Rent", type: "expense", subtype: "other", bookId,
  });
  return { checking, rent };
}

describe("recurring-rules reads", () => {
  describe("listRecurringRules", () => {
    it("hydrates payee and template-split accounts, active first then by nextDate", async () => {
      const { checking, rent } = await fixture();
      const payee = await createPayee({ name: "Landlord", bookId });

      const inactive = await createRecurringRule({
        name: "Old", frequency: "monthly", startDate: "2025-01-01",
        nextDate: "2025-02-01", isActive: false, bookId,
        templateSplits: [
          { accountId: rent.id, amount: 100 },
          { accountId: checking.id, amount: -100 },
        ],
      });
      const later = await createRecurringRule({
        name: "Later", frequency: "monthly", startDate: "2026-01-01",
        nextDate: "2026-09-01", bookId,
        templateSplits: [
          { accountId: rent.id, amount: 200 },
          { accountId: checking.id, amount: -200 },
        ],
      });
      const sooner = await createRecurringRule({
        name: "Sooner", frequency: "monthly", startDate: "2026-01-01",
        nextDate: "2026-08-01", payeeId: payee.id, bookId,
        templateSplits: [
          { accountId: rent.id, amount: 300 },
          { accountId: checking.id, amount: -300 },
        ],
      });

      const rules = await listRecurringRules(getDb(), bookId);

      expect(rules.map((r) => r.id)).toEqual([sooner.id, later.id, inactive.id]);
      expect(rules[0].payee?.name).toBe("Landlord");
      expect(rules[0].templateSplits[0].account.name).toBeDefined();
    });

    it("returns only this book's rules", async () => {
      const { checking, rent } = await fixture();
      const otherBook = await createBook({ name: "Other" });
      const otherChecking = await createAccount({
        name: "Their Checking", type: "asset", subtype: "bank", bookId: otherBook.id,
      });
      const otherRent = await createAccount({
        name: "Their Rent", type: "expense", subtype: "other", bookId: otherBook.id,
      });
      await createRecurringRule({
        name: "Mine", frequency: "monthly", startDate: "2026-01-01",
        nextDate: "2026-08-01", bookId,
        templateSplits: [
          { accountId: rent.id, amount: 100 },
          { accountId: checking.id, amount: -100 },
        ],
      });
      await createRecurringRule({
        name: "Theirs", frequency: "monthly", startDate: "2026-01-01",
        nextDate: "2026-08-01", bookId: otherBook.id,
        templateSplits: [
          { accountId: otherRent.id, amount: 100 },
          { accountId: otherChecking.id, amount: -100 },
        ],
      });

      const rules = await listRecurringRules(getDb(), bookId);
      expect(rules.map((r) => r.name)).toEqual(["Mine"]);
    });
  });

  describe("getRecurringRule", () => {
    it("returns undefined for a rule in another book", async () => {
      const otherBook = await createBook({ name: "Other" });
      const a = await createAccount({
        name: "A", type: "asset", subtype: "bank", bookId: otherBook.id,
      });
      const b = await createAccount({
        name: "B", type: "expense", subtype: "other", bookId: otherBook.id,
      });
      const theirs = await createRecurringRule({
        name: "Theirs", frequency: "monthly", startDate: "2026-01-01",
        nextDate: "2026-08-01", bookId: otherBook.id,
        templateSplits: [
          { accountId: b.id, amount: 100 },
          { accountId: a.id, amount: -100 },
        ],
      });

      await expect(getRecurringRule(getDb(), bookId, theirs.id)).resolves.toBeUndefined();
    });
  });

  describe("getProjectedTransactions", () => {
    it("projects occurrences in range with synthetic negative ids", async () => {
      const { checking, rent } = await fixture();
      await createRecurringRule({
        name: "Rent", frequency: "monthly", startDate: "2026-01-15",
        nextDate: "2026-09-15", templateDescription: "Rent payment", bookId,
        templateSplits: [
          { accountId: rent.id, amount: 150000 },
          { accountId: checking.id, amount: -150000 },
        ],
      });

      const projected = await getProjectedTransactions(getDb(), bookId, {
        startDate: "2026-09-01",
        endDate: "2026-11-30",
      });

      expect(projected.map((p) => p.date)).toEqual(["2026-09-15", "2026-10-15", "2026-11-15"]);
      expect(projected.every((p) => p.id < 0)).toBe(true);
      expect(projected.every((p) => p.isProjected)).toBe(true);
      expect(projected[0].splits).toHaveLength(2);
    });

    it("dates a weekend occurrence on the Monday when businessDaysOnly is set", async () => {
      const { checking, rent } = await fixture();
      // 2026-08-15 is a Saturday.
      await createRecurringRule({
        name: "Weekend", frequency: "monthly", startDate: "2026-08-15",
        nextDate: "2026-08-15", businessDaysOnly: true, bookId,
        templateSplits: [
          { accountId: rent.id, amount: 100 },
          { accountId: checking.id, amount: -100 },
        ],
      });

      const projected = await getProjectedTransactions(getDb(), bookId, {
        startDate: "2026-08-01",
        endDate: "2026-08-31",
      });

      expect(projected.map((p) => p.date)).toEqual(["2026-08-17"]);
    });

    it("skips inactive rules", async () => {
      const { checking, rent } = await fixture();
      await createRecurringRule({
        name: "Off", frequency: "monthly", startDate: "2026-01-15",
        nextDate: "2026-09-15", isActive: false, bookId,
        templateSplits: [
          { accountId: rent.id, amount: 100 },
          { accountId: checking.id, amount: -100 },
        ],
      });

      const projected = await getProjectedTransactions(getDb(), bookId, {
        startDate: "2026-09-01", endDate: "2026-12-31",
      });
      expect(projected).toEqual([]);
    });

    it("filters by an account, matching a template split on it or on its parent", async () => {
      const { checking, rent } = await fixture();
      const utilities = await createAccount({
        name: "Utilities", type: "expense", subtype: "other", bookId,
      });
      const power = await createAccount({
        name: "Power", type: "expense", subtype: "other", parentId: utilities.id, bookId,
      });
      await createRecurringRule({
        name: "Rent", frequency: "monthly", startDate: "2026-01-15",
        nextDate: "2026-09-15", templateDescription: "Rent", bookId,
        templateSplits: [
          { accountId: rent.id, amount: 100 },
          { accountId: checking.id, amount: -100 },
        ],
      });
      await createRecurringRule({
        name: "Power bill", frequency: "monthly", startDate: "2026-01-20",
        nextDate: "2026-09-20", templateDescription: "Power bill", bookId,
        templateSplits: [
          { accountId: power.id, amount: 100 },
          { accountId: checking.id, amount: -100 },
        ],
      });

      const byParent = await getProjectedTransactions(getDb(), bookId, {
        startDate: "2026-09-01", endDate: "2026-09-30", accountId: utilities.id,
      });
      expect(byParent.map((p) => p.description)).toEqual(["Power bill"]);
    });

    it("defaults the window to tomorrow through the book's upcomingDays", async () => {
      const { checking, rent } = await fixture();
      await createRecurringRule({
        name: "Daily", frequency: "daily", interval: 1, startDate: "2026-06-01",
        nextDate: "2026-06-02", bookId,
        templateSplits: [
          { accountId: rent.id, amount: 100 },
          { accountId: checking.id, amount: -100 },
        ],
      });

      // The seeded test book's upcomingDays is 30. Pinning `today` keeps this
      // from drifting with the wall clock, the same escape hatch
      // processAllRecurringRules already takes.
      const projected = await getProjectedTransactions(getDb(), bookId, { today: "2026-06-10" });

      expect(projected[0].date).toBe("2026-06-11"); // tomorrow, not today
      expect(projected.at(-1)!.date).toBe("2026-07-10"); // today + 30
    });

    it("reads upcomingDays from the book when the caller does not pass it", async () => {
      const { checking, rent } = await fixture();
      await getDb()
        .update(books)
        .set({ upcomingDays: 3 })
        .where(eq(books.id, bookId));
      await createRecurringRule({
        name: "Daily", frequency: "daily", interval: 1, startDate: "2026-06-01",
        nextDate: "2026-06-02", bookId,
        templateSplits: [
          { accountId: rent.id, amount: 100 },
          { accountId: checking.id, amount: -100 },
        ],
      });

      const fromBook = await getProjectedTransactions(getDb(), bookId, { today: "2026-06-10" });
      const passedIn = await getProjectedTransactions(getDb(), bookId, {
        today: "2026-06-10",
        upcomingDays: 3,
      });

      expect(fromBook.map((p) => p.date)).toEqual(passedIn.map((p) => p.date));
      expect(fromBook.at(-1)!.date).toBe("2026-06-13");
    });
  });

  describe("listRecurringTransactions", () => {
    it("returns only transactions a rule created, with the rule's name", async () => {
      const { checking, rent } = await fixture();
      const rule = await createRecurringRule({
        name: "Rent", frequency: "monthly", startDate: "2026-01-15",
        nextDate: "2026-02-15", bookId,
        templateSplits: [
          { accountId: rent.id, amount: 100 },
          { accountId: checking.id, amount: -100 },
        ],
      });
      const fromRule = await createTransactionWithSplits({
        bookId, date: "2026-01-15", description: "Rent", recurringRuleId: rule.id,
        splits: [
          { accountId: rent.id, amount: 100 },
          { accountId: checking.id, amount: -100 },
        ],
      });
      await createTransactionWithSplits({
        bookId, date: "2026-01-16", description: "Manual",
        splits: [
          { accountId: rent.id, amount: 100 },
          { accountId: checking.id, amount: -100 },
        ],
      });

      const rows = await listRecurringTransactions(getDb(), bookId, {
        startDate: "2026-01-01",
        endDate: "2026-01-31",
      });

      expect(rows).toEqual([
        {
          transactionId: fromRule.id,
          date: "2026-01-15",
          recurringRuleId: rule.id,
          ruleName: "Rent",
        },
      ]);
    });

    it("excludes transactions outside the range", async () => {
      const { checking, rent } = await fixture();
      const rule = await createRecurringRule({
        name: "Rent", frequency: "monthly", startDate: "2026-01-15",
        nextDate: "2026-02-15", bookId,
        templateSplits: [
          { accountId: rent.id, amount: 100 },
          { accountId: checking.id, amount: -100 },
        ],
      });
      await createTransactionWithSplits({
        bookId, date: "2026-03-15", description: "Rent", recurringRuleId: rule.id,
        splits: [
          { accountId: rent.id, amount: 100 },
          { accountId: checking.id, amount: -100 },
        ],
      });

      const rows = await listRecurringTransactions(getDb(), bookId, {
        startDate: "2026-01-01",
        endDate: "2026-01-31",
      });
      expect(rows).toEqual([]);
    });
  });
});

describe("createRecurringRule", () => {
  it("computes nextDate from startDate rather than storing startDate", async () => {
    const { checking, rent } = await fixture();
    const rule = await createRule(getDb(), bookId, {
      name: "Rent",
      frequency: "monthly",
      startDate: "2020-01-15",
      templateSplits: [
        { accountId: rent.id, amount: 150000 },
        { accountId: checking.id, amount: -150000 },
      ],
    });
    // advanceNextDateToFuture walks the schedule forward past today, so a
    // rule created with a startDate years ago is not instantly overdue.
    expect(rule.nextDate > "2020-01-15").toBe(true);
    expect(rule.startDate).toBe("2020-01-15");
  });

  it("rejects template splits that do not sum to zero", async () => {
    const { checking, rent } = await fixture();
    await expect(
      createRule(getDb(), bookId, {
        name: "Bad",
        frequency: "monthly",
        startDate: "2026-01-15",
        templateSplits: [
          { accountId: rent.id, amount: 100 },
          { accountId: checking.id, amount: -99 },
        ],
      })
    ).rejects.toThrow(RecurringRuleValidationError);
  });

  it("rejects a template split on an account in another book", async () => {
    const { checking } = await fixture();
    const otherBook = await createBook({ name: "Other" });
    const theirs = await createAccount({
      name: "Theirs", type: "expense", subtype: "other", bookId: otherBook.id,
    });
    await expect(
      createRule(getDb(), bookId, {
        name: "Cross-book",
        frequency: "monthly",
        startDate: "2026-01-15",
        templateSplits: [
          { accountId: theirs.id, amount: 100 },
          { accountId: checking.id, amount: -100 },
        ],
      })
    ).rejects.toThrow(/do not belong to this book/);
  });

  it("rejects an endDate before the startDate", async () => {
    const { checking, rent } = await fixture();
    await expect(
      createRule(getDb(), bookId, {
        name: "Backwards",
        frequency: "monthly",
        startDate: "2026-06-01",
        endDate: "2026-01-01",
        templateSplits: [
          { accountId: rent.id, amount: 100 },
          { accountId: checking.id, amount: -100 },
        ],
      })
    ).rejects.toThrow(/endDate cannot be earlier than startDate/);
  });

  it("creates a payee by name and reuses an existing one case-insensitively", async () => {
    const { checking, rent } = await fixture();
    const splits = [
      { accountId: rent.id, amount: 100 },
      { accountId: checking.id, amount: -100 },
    ];
    const first = await createRule(getDb(), bookId, {
      name: "A", frequency: "monthly", startDate: "2026-01-15",
      payeeName: "Landlord", templateSplits: splits,
    });
    const second = await createRule(getDb(), bookId, {
      name: "B", frequency: "monthly", startDate: "2026-01-15",
      payeeName: "LANDLORD", templateSplits: splits,
    });
    expect(second.payeeId).toBe(first.payeeId);
  });

  it("ignores a payeeId from another book instead of failing", async () => {
    // Not a nicety — resolvePayeeId deliberately nulls an out-of-book id
    // rather than erroring, and both routes have always done so.
    const { checking, rent } = await fixture();
    const otherBook = await createBook({ name: "Other" });
    const theirPayee = await createPayee({ name: "Theirs", bookId: otherBook.id });
    const rule = await createRule(getDb(), bookId, {
      name: "A", frequency: "monthly", startDate: "2026-01-15",
      payeeId: theirPayee.id,
      templateSplits: [
        { accountId: rent.id, amount: 100 },
        { accountId: checking.id, amount: -100 },
      ],
    });
    expect(rule.payeeId).toBeNull();
  });
});

describe("updateRecurringRule", () => {
  it("replaces every template split when given templateSplits", async () => {
    // A mixed body — one rule column plus the splits — so this covers the
    // branch that issues the UPDATE. The splits-only body, which skips it,
    // has its own test below.
    const { checking, rent } = await fixture();
    const groceries = await createAccount({
      name: "Groceries", type: "expense", subtype: "other", bookId,
    });
    const rule = await createRecurringRule({
      name: "Rent", frequency: "monthly", startDate: "2026-01-15",
      nextDate: "2026-09-15", bookId,
      templateSplits: [
        { accountId: rent.id, amount: 100 },
        { accountId: checking.id, amount: -100 },
      ],
    });

    const updated = await updateRule(getDb(), bookId, rule.id, {
      name: "Rent (renamed)",
      templateSplits: [
        { accountId: groceries.id, amount: 250 },
        { accountId: checking.id, amount: -250 },
      ],
    });

    expect(updated.name).toBe("Rent (renamed)");
    expect(updated.templateSplits).toHaveLength(2);
    expect(updated.templateSplits.map((s) => s.accountId).sort()).toEqual(
      [groceries.id, checking.id].sort()
    );
  });

  it("replaces the splits when no rule column changes at all", async () => {
    // Until this change the PUT route answered 500 here — every field of the
    // `.set()` object is spread behind `x !== undefined`, so a body that
    // changes no rule column built `{}` and Drizzle refused it with "No
    // values to set". Verified against the unmodified route before the
    // extraction, so the 500 was pre-existing, not introduced by the move.
    // The request was always semantically valid, and replacing the splits
    // alone is the documented headline behavior of the MCP update tool, so
    // the UPDATE is now skipped rather than issued empty.
    const { checking, rent } = await fixture();
    const groceries = await createAccount({
      name: "Groceries", type: "expense", subtype: "other", bookId,
    });
    const rule = await createRecurringRule({
      name: "Rent", frequency: "monthly", startDate: "2026-01-15",
      nextDate: "2026-09-15", bookId,
      templateSplits: [
        { accountId: rent.id, amount: 100 },
        { accountId: checking.id, amount: -100 },
      ],
    });

    const updated = await updateRule(getDb(), bookId, rule.id, {
      templateSplits: [
        { accountId: groceries.id, amount: 250 },
        { accountId: checking.id, amount: -250 },
      ],
    });

    expect(updated.templateSplits.map((s) => s.accountId).sort()).toEqual(
      [groceries.id, checking.id].sort()
    );
    // The rule row itself is untouched.
    expect(updated.name).toBe("Rent");
    expect(updated.nextDate).toBe("2026-09-15");
  });

  it("refuses a splits-only update on another book's rule and leaves its splits alone", async () => {
    // Assert both halves. "It threw" on its own is satisfied by throwing for
    // the wrong reason: with no existence check the final book-scoped
    // rehydrate still throws not-found, but only after the transaction has
    // committed. Measured, not predicted — dropping the check makes the
    // length assertion below report 4 splits on the victim rule, because the
    // DELETE is scoped to the caller's book and matches nothing while the
    // INSERT names the victim's rule id directly. Nothing rejects that:
    // recurring_template_splits.recurring_rule_id is a plain FK to
    // recurring_rules.id, with no composite (bookId, recurringRuleId)
    // constraint behind it.
    const { checking } = await fixture();
    const otherBook = await createBook({ name: "Other" });
    const a = await createAccount({
      name: "A", type: "asset", subtype: "bank", bookId: otherBook.id,
    });
    const b = await createAccount({
      name: "B", type: "expense", subtype: "other", bookId: otherBook.id,
    });
    const theirs = await createRecurringRule({
      name: "Theirs", frequency: "monthly", startDate: "2026-01-01",
      nextDate: "2026-08-01", bookId: otherBook.id,
      templateSplits: [
        { accountId: b.id, amount: 100 },
        { accountId: a.id, amount: -100 },
      ],
    });
    const groceries = await createAccount({
      name: "Groceries", type: "expense", subtype: "other", bookId,
    });

    await expect(
      updateRule(getDb(), bookId, theirs.id, {
        templateSplits: [
          { accountId: groceries.id, amount: 250 },
          { accountId: checking.id, amount: -250 },
        ],
      })
    ).rejects.toThrow(RecurringRuleNotFoundError);

    const splits = await getDb()
      .select()
      .from(recurringTemplateSplits)
      .where(eq(recurringTemplateSplits.recurringRuleId, theirs.id));
    expect(splits).toHaveLength(2);
    expect(splits.map((s) => s.accountId).sort()).toEqual([a.id, b.id].sort());
  });

  it("refuses a mixed update on another book's rule and leaves its splits alone", async () => {
    // The sibling of the splits-only case above, through the other branch.
    // `{ name, templateSplits }` builds a non-empty `.set()`, so the UPDATE
    // runs — and matches zero rows, which Postgres does not treat as an
    // error and Drizzle does not check the count of. Execution reaches the
    // same split replace, with the same cross-book write, unless the
    // existence check covers this branch too.
    const { checking } = await fixture();
    const otherBook = await createBook({ name: "Other" });
    const a = await createAccount({
      name: "A", type: "asset", subtype: "bank", bookId: otherBook.id,
    });
    const b = await createAccount({
      name: "B", type: "expense", subtype: "other", bookId: otherBook.id,
    });
    const theirs = await createRecurringRule({
      name: "Theirs", frequency: "monthly", startDate: "2026-01-01",
      nextDate: "2026-08-01", bookId: otherBook.id,
      templateSplits: [
        { accountId: b.id, amount: 100 },
        { accountId: a.id, amount: -100 },
      ],
    });
    const groceries = await createAccount({
      name: "Groceries", type: "expense", subtype: "other", bookId,
    });

    await expect(
      updateRule(getDb(), bookId, theirs.id, {
        name: "Mine now",
        templateSplits: [
          { accountId: groceries.id, amount: 250 },
          { accountId: checking.id, amount: -250 },
        ],
      })
    ).rejects.toThrow(RecurringRuleNotFoundError);

    const splits = await getDb()
      .select()
      .from(recurringTemplateSplits)
      .where(eq(recurringTemplateSplits.recurringRuleId, theirs.id));
    expect(splits).toHaveLength(2);
    expect(splits.map((s) => s.accountId).sort()).toEqual([a.id, b.id].sort());
  });

  it("recomputes nextDate when a schedule field changes", async () => {
    const { checking, rent } = await fixture();
    const rule = await createRecurringRule({
      name: "Rent", frequency: "monthly", startDate: "2026-01-15",
      nextDate: "2026-09-15", bookId,
      templateSplits: [
        { accountId: rent.id, amount: 100 },
        { accountId: checking.id, amount: -100 },
      ],
    });

    const updated = await updateRule(getDb(), bookId, rule.id, { frequency: "yearly" });
    expect(updated.nextDate).not.toBe("2026-09-15");
  });

  it("leaves nextDate alone when only a non-schedule field changes", async () => {
    const { checking, rent } = await fixture();
    const rule = await createRecurringRule({
      name: "Rent", frequency: "monthly", startDate: "2026-01-15",
      nextDate: "2026-09-15", bookId,
      templateSplits: [
        { accountId: rent.id, amount: 100 },
        { accountId: checking.id, amount: -100 },
      ],
    });

    const updated = await updateRule(getDb(), bookId, rule.id, { name: "Rent (renamed)" });
    expect(updated.nextDate).toBe("2026-09-15");
  });

  it("honours an explicit nextDate over the recompute", async () => {
    const { checking, rent } = await fixture();
    const rule = await createRecurringRule({
      name: "Rent", frequency: "monthly", startDate: "2026-01-15",
      nextDate: "2026-09-15", bookId,
      templateSplits: [
        { accountId: rent.id, amount: 100 },
        { accountId: checking.id, amount: -100 },
      ],
    });

    const updated = await updateRule(getDb(), bookId, rule.id, {
      frequency: "yearly",
      nextDate: "2027-03-01",
    });
    expect(updated.nextDate).toBe("2027-03-01");
  });

  it("never recomputes nextDate back before a transaction the rule already created", async () => {
    const { checking, rent } = await fixture();
    const rule = await createRecurringRule({
      name: "Rent", frequency: "monthly", startDate: "2026-01-15",
      nextDate: "2026-09-15", bookId,
      templateSplits: [
        { accountId: rent.id, amount: 100 },
        { accountId: checking.id, amount: -100 },
      ],
    });
    await createTransactionWithSplits({
      bookId, date: "2026-08-15", description: "Rent", recurringRuleId: rule.id,
      splits: [
        { accountId: rent.id, amount: 100 },
        { accountId: checking.id, amount: -100 },
      ],
    });

    const updated = await updateRule(getDb(), bookId, rule.id, { endDate: "2030-01-01" });
    expect(updated.nextDate > "2026-08-15").toBe(true);
  });

  it("rejects a null nextDate instead of writing it to the NOT NULL column", async () => {
    // updateRuleSchema types nextDate as nullish, so toolShape publishes it
    // to an MCP client as nullable. recurringRules.nextDate is NOT NULL, so a
    // literal null must fail here, not at the database.
    const { checking, rent } = await fixture();
    const rule = await createRecurringRule({
      name: "Rent", frequency: "monthly", startDate: "2026-01-15",
      nextDate: "2026-09-15", bookId,
      templateSplits: [
        { accountId: rent.id, amount: 100 },
        { accountId: checking.id, amount: -100 },
      ],
    });

    await expect(
      updateRule(getDb(), bookId, rule.id, { nextDate: null })
    ).rejects.toThrow(RecurringRuleValidationError);
  });

  it("throws RecurringRuleNotFoundError for a rule in another book", async () => {
    const otherBook = await createBook({ name: "Other" });
    const a = await createAccount({
      name: "A", type: "asset", subtype: "bank", bookId: otherBook.id,
    });
    const b = await createAccount({
      name: "B", type: "expense", subtype: "other", bookId: otherBook.id,
    });
    const theirs = await createRecurringRule({
      name: "Theirs", frequency: "monthly", startDate: "2026-01-01",
      nextDate: "2026-08-01", bookId: otherBook.id,
      templateSplits: [
        { accountId: b.id, amount: 100 },
        { accountId: a.id, amount: -100 },
      ],
    });

    await expect(updateRule(getDb(), bookId, theirs.id, { name: "Mine now" })).rejects.toThrow(
      RecurringRuleNotFoundError
    );

    const [still] = await getDb()
      .select()
      .from(recurringRules)
      .where(eq(recurringRules.id, theirs.id));
    expect(still.name).toBe("Theirs");
  });
});

describe("deleteRecurringRule", () => {
  it("deletes the rule and its template splits", async () => {
    const { checking, rent } = await fixture();
    const rule = await createRecurringRule({
      name: "Rent", frequency: "monthly", startDate: "2026-01-15",
      nextDate: "2026-09-15", bookId,
      templateSplits: [
        { accountId: rent.id, amount: 100 },
        { accountId: checking.id, amount: -100 },
      ],
    });

    await deleteRule(getDb(), bookId, rule.id);

    const rules = await getDb()
      .select()
      .from(recurringRules)
      .where(eq(recurringRules.id, rule.id));
    const splits = await getDb()
      .select()
      .from(recurringTemplateSplits)
      .where(eq(recurringTemplateSplits.recurringRuleId, rule.id));
    expect(rules).toHaveLength(0);
    expect(splits).toHaveLength(0);
  });

  it("keeps transactions the rule created and clears their link", async () => {
    // transactions.recurring_rule_id is ON DELETE SET NULL; template splits
    // are ON DELETE CASCADE. Verified in db/schema.ts, and it is what
    // delete_recurring_rule's description promises.
    const { checking, rent } = await fixture();
    const rule = await createRecurringRule({
      name: "Rent", frequency: "monthly", startDate: "2026-01-15",
      nextDate: "2026-09-15", bookId,
      templateSplits: [
        { accountId: rent.id, amount: 100 },
        { accountId: checking.id, amount: -100 },
      ],
    });
    const created = await createTransactionWithSplits({
      bookId, date: "2026-08-15", description: "Rent", recurringRuleId: rule.id,
      splits: [
        { accountId: rent.id, amount: 100 },
        { accountId: checking.id, amount: -100 },
      ],
    });

    await deleteRule(getDb(), bookId, rule.id);

    const [tx] = await getDb()
      .select()
      .from(transactions)
      .where(eq(transactions.id, created.id));
    expect(tx).toBeDefined();
    expect(tx.recurringRuleId).toBeNull();
  });

  it("throws RecurringRuleNotFoundError for an unknown id", async () => {
    await expect(deleteRule(getDb(), bookId, 999999)).rejects.toThrow(
      RecurringRuleNotFoundError
    );
  });
});

describe("payee resolution rolls back with the rule write", () => {
  // resolvePayeeId INSERTs a payee for an unseen payeeName. Until this was
  // fixed it ran outside the write transaction, so a write that failed after
  // it — an amount too wide for the `integer` column, a rule in another book —
  // returned an error and still left the new payee in the book. There is no
  // way for the caller to tell that happened, and no way to undo it but to
  // find and delete the payee by hand. lib/transactions.ts resolves its payee
  // inside the transaction for the same reason.
  it("creates no payee when the rule insert fails", async () => {
    const { checking, rent } = await fixture();

    await expect(
      createRule(getDb(), bookId, {
        name: "Overflowing",
        frequency: "monthly",
        startDate: "2026-01-15",
        payeeName: "Ghost Landlord",
        // `interval` is one of the seven deliberately loose z.any() fields, so
        // nothing checks its range and it reaches the rule INSERT as-is, where
        // the `integer` column rejects it. An out-of-range split amount cannot
        // stand in here: validateSplits range-checks those before the payee is
        // ever resolved, which is exactly why this failure has to come from a
        // field that no validator sees.
        interval: 3_000_000_000,
        templateSplits: [
          { accountId: rent.id, amount: 150000 },
          { accountId: checking.id, amount: -150000 },
        ],
      })
    ).rejects.toThrow();

    const ghosts = await getDb()
      .select()
      .from(payees)
      .where(eq(payees.name, "Ghost Landlord"));
    expect(ghosts).toEqual([]);
  });

  it("creates no payee when the update targets another book's rule", async () => {
    await fixture();
    const otherBook = await createBook({ name: "Other" });
    const a = await createAccount({
      name: "A", type: "asset", subtype: "bank", bookId: otherBook.id,
    });
    const b = await createAccount({
      name: "B", type: "expense", subtype: "other", bookId: otherBook.id,
    });
    const theirs = await createRecurringRule({
      name: "Theirs", frequency: "monthly", startDate: "2026-01-01",
      nextDate: "2026-08-01", bookId: otherBook.id,
      templateSplits: [
        { accountId: b.id, amount: 100 },
        { accountId: a.id, amount: -100 },
      ],
    });

    await expect(
      updateRule(getDb(), bookId, theirs.id, { payeeName: "Ghost Landlord" })
    ).rejects.toThrow(RecurringRuleNotFoundError);

    const ghosts = await getDb()
      .select()
      .from(payees)
      .where(eq(payees.name, "Ghost Landlord"));
    expect(ghosts).toEqual([]);
  });

  it("still creates the payee when the write succeeds", async () => {
    // The guard against over-correcting: rolling back on failure must not
    // stop the ordinary path from creating a payee by name.
    const { checking, rent } = await fixture();

    const rule = await createRule(getDb(), bookId, {
      name: "Rent",
      frequency: "monthly",
      startDate: "2026-01-15",
      payeeName: "Real Landlord",
      templateSplits: [
        { accountId: rent.id, amount: 150000 },
        { accountId: checking.id, amount: -150000 },
      ],
    });

    const [created] = await getDb()
      .select()
      .from(payees)
      .where(eq(payees.name, "Real Landlord"));
    expect(created).toBeDefined();
    expect(rule.payeeId).toBe(created.id);
  });
});
