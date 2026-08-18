import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import {
  createAccount,
  createRecurringRule,
  resetTestDatabase,
  setupTestDatabase,
} from "@/tests/helpers/db";
import { db } from "@/tests/helpers/db-utils";
import { recurringRules, transactions } from "@/db/schema";
import {
  processAllRecurringRules,
  processRecurringRuleById,
} from "@/lib/recurring-processing";

beforeAll(async () => {
  await setupTestDatabase();
});

beforeEach(async () => {
  await resetTestDatabase();
});

/**
 * Run `processor` against a rule whose nextDate is being advanced by a competing
 * processor that commits first — the cron-vs-manual-click race.
 *
 * The open transaction holds the rule's row lock while `processor` starts on
 * another pooled connection: the processor reads the still-committed nextDate,
 * then blocks on its own write until this transaction commits. That makes the
 * interleaving deterministic instead of depending on scheduling luck.
 */
async function raceAgainstRuleAdvance<T>(
  ruleId: number,
  processor: () => Promise<T>
): Promise<T> {
  let pending: Promise<T> | undefined;

  await db.transaction(async (tx) => {
    await tx
      .update(recurringRules)
      .set({ nextDate: "2025-02-15" })
      .where(eq(recurringRules.id, ruleId));

    pending = processor();
    // Give the processor time to read and reach its (blocking) write.
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  return pending!;
}

async function createRuleFixture() {
  const checking = await createAccount({ name: "Checking", type: "asset" });
  const rent = await createAccount({ name: "Rent", type: "expense" });

  return {
    checking,
    rent,
  };
}

describe("processRecurringRuleById", () => {
  it("creates a transaction for the rule and advances nextDate", async () => {
    const { checking, rent } = await createRuleFixture();
    const rule = await createRecurringRule({
      name: "Monthly Rent",
      frequency: "monthly",
      startDate: "2025-01-15",
      nextDate: "2025-01-15",
      templateDescription: "Rent payment",
      templateSplits: [
        { accountId: rent.id, amount: 150000 },
        { accountId: checking.id, amount: -150000 },
      ],
    });

    const result = await processRecurringRuleById(db, 1, rule.id);

    expect(result).toEqual({
      transactionsCreated: 1,
      transactionIds: expect.arrayContaining([expect.any(Number)]),
      skipped: [],
    });

    const createdTransactions = await db.select().from(transactions);
    expect(createdTransactions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          date: "2025-01-15",
          description: "Rent payment",
          recurringRuleId: rule.id,
        }),
      ])
    );

    const [updatedRule] = await db
      .select()
      .from(recurringRules)
      .where(eq(recurringRules.id, rule.id));
    expect(updatedRule.nextDate).toBe("2025-02-15");
  });

  it("returns null when the rule does not exist", async () => {
    await createRuleFixture();

    await expect(processRecurringRuleById(db, 1, 9999)).resolves.toBeNull();
  });

  it("creates nothing when another processor claims the due date first", async () => {
    const { checking, rent } = await createRuleFixture();
    const rule = await createRecurringRule({
      name: "Monthly Rent",
      frequency: "monthly",
      startDate: "2025-01-15",
      nextDate: "2025-01-15",
      templateDescription: "Rent payment",
      templateSplits: [
        { accountId: rent.id, amount: 150000 },
        { accountId: checking.id, amount: -150000 },
      ],
    });

    const result = await raceAgainstRuleAdvance(rule.id, () =>
      processRecurringRuleById(db, 1, rule.id)
    );

    expect(result).toEqual({ transactionsCreated: 0, transactionIds: [], skipped: [] });

    const created = await db
      .select()
      .from(transactions)
      .where(eq(transactions.recurringRuleId, rule.id));
    expect(created).toHaveLength(0);
  });

  it("does not advance a rule that cannot produce a transaction", async () => {
    const rent = await createAccount({ name: "Rent", type: "expense" });
    const rule = await createRecurringRule({
      name: "Half a rule",
      frequency: "monthly",
      startDate: "2026-01-15",
      nextDate: "2026-01-15",
      templateDescription: "Rent",
      templateSplits: [{ accountId: rent.id, amount: 100000 }], // only one — cannot balance
    });

    const result = await processRecurringRuleById(getDb(), 1, rule.id);

    expect(result).toEqual({
      transactionsCreated: 0,
      transactionIds: [],
      skipped: [{ ruleId: rule.id, reason: "fewer than 2 template splits" }],
    });

    // The advance is what hid this: nextDate marching forward while nothing is
    // created makes a stuck bill look like a healthy rule that was processed.
    const [row] = await db.select().from(recurringRules).where(eq(recurringRules.id, rule.id));
    expect(row.nextDate).toBe("2026-01-15");

    const created = await db
      .select()
      .from(transactions)
      .where(eq(transactions.recurringRuleId, rule.id));
    expect(created).toHaveLength(0);
  });
});

describe("processAllRecurringRules", () => {
  it("processes only rules within the auto-create horizon", async () => {
    const { checking, rent } = await createRuleFixture();

    const dueRule = await createRecurringRule({
      name: "Due Soon",
      frequency: "daily",
      startDate: "2025-01-08",
      nextDate: "2025-01-09",
      autoCreateDaysBefore: 1,
      templateSplits: [
        { accountId: rent.id, amount: 1000 },
        { accountId: checking.id, amount: -1000 },
      ],
    });
    await createRecurringRule({
      name: "Future Rule",
      frequency: "daily",
      startDate: "2025-01-08",
      nextDate: "2025-01-11",
      autoCreateDaysBefore: 0,
      templateSplits: [
        { accountId: rent.id, amount: 2000 },
        { accountId: checking.id, amount: -2000 },
      ],
    });

    const result = await processAllRecurringRules(db, 1, "2025-01-08");

    expect(result.transactionsCreated).toBe(1);

    const createdTransactions = await db.select().from(transactions);
    expect(createdTransactions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ recurringRuleId: dueRule.id, date: "2025-01-09" }),
      ])
    );
  });

  it("creates nothing when another processor claims the due date first", async () => {
    const { checking, rent } = await createRuleFixture();
    const rule = await createRecurringRule({
      name: "Monthly Rent",
      frequency: "monthly",
      startDate: "2025-01-15",
      nextDate: "2025-01-15",
      templateDescription: "Rent payment",
      templateSplits: [
        { accountId: rent.id, amount: 150000 },
        { accountId: checking.id, amount: -150000 },
      ],
    });

    const result = await raceAgainstRuleAdvance(rule.id, () =>
      processAllRecurringRules(db, 1, "2025-01-15")
    );

    expect(result.transactionsCreated).toBe(0);

    const created = await db
      .select()
      .from(transactions)
      .where(eq(transactions.recurringRuleId, rule.id));
    expect(created).toHaveLength(0);
  });

  it("creates one transaction per due date when the same run repeats", async () => {
    const { checking, rent } = await createRuleFixture();
    const rule = await createRecurringRule({
      name: "Monthly Rent",
      frequency: "monthly",
      startDate: "2025-01-15",
      nextDate: "2025-01-15",
      templateDescription: "Rent payment",
      templateSplits: [
        { accountId: rent.id, amount: 150000 },
        { accountId: checking.id, amount: -150000 },
      ],
    });

    const results = await Promise.all([
      processAllRecurringRules(db, 1, "2025-01-15"),
      processAllRecurringRules(db, 1, "2025-01-15"),
    ]);

    const created = await db
      .select()
      .from(transactions)
      .where(eq(transactions.recurringRuleId, rule.id));
    expect(created).toHaveLength(1);

    const totalReported = results.reduce(
      (sum, result) => sum + result.transactionsCreated,
      0
    );
    expect(totalReported).toBe(1);

    const [updatedRule] = await db
      .select()
      .from(recurringRules)
      .where(eq(recurringRules.id, rule.id));
    expect(updatedRule.nextDate).toBe("2025-02-15");
  });

  it("does not advance a rule that cannot produce a transaction", async () => {
    const rent = await createAccount({ name: "Rent", type: "expense" });
    const rule = await createRecurringRule({
      name: "Half a rule",
      frequency: "monthly",
      startDate: "2026-01-15",
      nextDate: "2026-01-15",
      templateDescription: "Rent",
      templateSplits: [{ accountId: rent.id, amount: 100000 }], // only one — cannot balance
    });

    const result = await processAllRecurringRules(getDb(), 1, "2026-03-01");

    expect(result.transactionsCreated).toBe(0);
    expect(result.skipped).toEqual([
      { ruleId: rule.id, reason: "fewer than 2 template splits" },
    ]);

    // The advance is what hid this: nextDate marching forward while nothing is
    // created makes a stopped bill look like a healthy rule.
    const [row] = await db.select().from(recurringRules).where(eq(recurringRules.id, rule.id));
    expect(row.nextDate).toBe("2026-01-15");
  });

  it("deactivates rules that have passed their end date", async () => {
    const { checking, rent } = await createRuleFixture();
    const expiredRule = await createRecurringRule({
      name: "Expired Rule",
      frequency: "daily",
      startDate: "2025-01-01",
      nextDate: "2025-01-05",
      endDate: "2025-01-04",
      templateSplits: [
        { accountId: rent.id, amount: 1000 },
        { accountId: checking.id, amount: -1000 },
      ],
    });

    const result = await processAllRecurringRules(db, 1, "2025-01-05");

    expect(result.transactionsCreated).toBe(0);

    const [updatedRule] = await db
      .select()
      .from(recurringRules)
      .where(eq(recurringRules.id, expiredRule.id));
    expect(updatedRule.isActive).toBe(false);
  });
});
