import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { createTransaction, updateTransaction } from "@/lib/transactions";
import { getDb } from "@/db";
import { setupTestDatabase, resetTestDatabase, createAccount } from "@/tests/helpers/db";
import { transactions, transactionSplits } from "@/db/schema";
import { and, eq, lte, sql } from "drizzle-orm";
import { effectiveDateSql } from "@/lib/accounting";
import { toDateString } from "@/lib/formatters";

describe("floating transactions", () => {
  const db = getDb();

  beforeAll(async () => {
    await setupTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  let checkingId: number;
  let expenseId: number;

  beforeEach(async () => {
    const checking = await createAccount({ name: "Checking", type: "asset", subtype: "bank" });
    const expense = await createAccount({ name: "Groceries", type: "expense", subtype: "other" });
    checkingId = checking.id;
    expenseId = expense.id;
  });

  it("creates a floating transaction with isFloating=true", async () => {
    const result = await createTransaction(db, 1, {
      date: "2026-04-01",
      description: "Check #1234",
      isFloating: true,
      splits: [
        { accountId: expenseId, amount: 5000 },
        { accountId: checkingId, amount: -5000 },
      ],
    });

    const [row] = await db.select().from(transactions).where(eq(transactions.id, result.id));
    expect(row.isFloating).toBe(true);
    expect(row.date).toBe("2026-04-01");
  });

  it("creates a non-floating transaction by default", async () => {
    const result = await createTransaction(db, 1, {
      date: "2026-04-01",
      splits: [
        { accountId: expenseId, amount: 5000 },
        { accountId: checkingId, amount: -5000 },
      ],
    });

    const [row] = await db.select().from(transactions).where(eq(transactions.id, result.id));
    expect(row.isFloating).toBe(false);
  });

  it("updates isFloating on an existing transaction", async () => {
    const result = await createTransaction(db, 1, {
      date: "2026-04-01",
      splits: [
        { accountId: expenseId, amount: 5000 },
        { accountId: checkingId, amount: -5000 },
      ],
    });

    await updateTransaction(db, 1, result.id, { isFloating: true });

    const [row] = await db.select().from(transactions).where(eq(transactions.id, result.id));
    expect(row.isFloating).toBe(true);
  });

  it("clears isFloating when reconciling a floating transaction", async () => {
    const result = await createTransaction(db, 1, {
      date: "2026-04-01",
      isFloating: true,
      splits: [
        { accountId: expenseId, amount: 5000 },
        { accountId: checkingId, amount: -5000 },
      ],
    });

    await updateTransaction(db, 1, result.id, {
      isReconciled: true,
      isFloating: false,
      date: "2026-04-10",
    });

    const [row] = await db.select().from(transactions).where(eq(transactions.id, result.id));
    expect(row.isFloating).toBe(false);
    expect(row.isReconciled).toBe(true);
    expect(row.date).toBe("2026-04-10");
  });
});

describe("effectiveDateSql in balance queries", () => {
  const db = getDb();

  beforeAll(async () => {
    await setupTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("floating transactions affect today's balance but not historical", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset", subtype: "bank" });
    const expense = await createAccount({ name: "Groceries", type: "expense", subtype: "other" });

    const today = toDateString(new Date());
    // Use a date safely in the past relative to today
    const pastDate = "2020-01-15";
    const historicalCutoff = "2020-06-01";

    // Non-floating transaction in the past
    await createTransaction(db, 1, {
      date: pastDate,
      splits: [
        { accountId: expense.id, amount: 5000 },
        { accountId: checking.id, amount: -5000 },
      ],
    });

    // Floating transaction (effective date = today, regardless of stored date)
    await createTransaction(db, 1, {
      date: pastDate,
      isFloating: true,
      splits: [
        { accountId: expense.id, amount: 3000 },
        { accountId: checking.id, amount: -3000 },
      ],
    });

    // Historical balance should NOT include the floating transaction
    const [historicalBalance] = await db
      .select({
        total: sql<number>`cast(coalesce(sum(${transactionSplits.amount}), 0) as integer)`,
      })
      .from(transactionSplits)
      .innerJoin(transactions, eq(transactions.id, transactionSplits.transactionId))
      .where(
        and(
          eq(transactionSplits.accountId, checking.id),
          lte(effectiveDateSql, historicalCutoff)
        )
      );

    expect(historicalBalance.total).toBe(-5000); // only the non-floating one

    // Balance as of today SHOULD include the floating transaction
    const [currentBalance] = await db
      .select({
        total: sql<number>`cast(coalesce(sum(${transactionSplits.amount}), 0) as integer)`,
      })
      .from(transactionSplits)
      .innerJoin(transactions, eq(transactions.id, transactionSplits.transactionId))
      .where(
        and(
          eq(transactionSplits.accountId, checking.id),
          lte(effectiveDateSql, today)
        )
      );

    expect(currentBalance.total).toBe(-8000); // both transactions
  });
});
