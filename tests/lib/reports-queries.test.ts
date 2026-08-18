import { describe, it, expect, beforeEach } from "vitest";
import {
  setupTestDatabase,
  resetTestDatabase,
  createAccount,
  createTransactionWithSplits,
} from "../helpers/db";
import { db } from "../helpers/db-utils";
import { getIncomeStatement, getReportSplits } from "@/lib/reports-queries";

describe("getIncomeStatement", () => {
  beforeEach(async () => {
    await setupTestDatabase();
    await resetTestDatabase();
  });

  it("returns raw signed balances — income negative, expense positive", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset", subtype: "bank" });
    const salary = await createAccount({ name: "Salary", type: "income" });
    const food = await createAccount({ name: "Food", type: "expense" });

    await createTransactionWithSplits({
      date: "2024-03-01",
      description: "Paycheck",
      splits: [
        { accountId: checking.id, amount: 100_000 },
        { accountId: salary.id, amount: -100_000 },
      ],
    });
    await createTransactionWithSplits({
      date: "2024-03-05",
      description: "Market",
      splits: [
        { accountId: food.id, amount: 4_000 },
        { accountId: checking.id, amount: -4_000 },
      ],
    });

    const rows = await getIncomeStatement(db, 1);
    const byName = new Map(rows.map((r) => [r.name, r]));

    expect(byName.get("Salary")!.balanceCents).toBe(-100_000);
    expect(byName.get("Food")!.balanceCents).toBe(4_000);
    // Asset accounts are not part of an income statement.
    expect(byName.has("Checking")).toBe(false);
  });

  it("keeps zero-balance accounts", async () => {
    await createAccount({ name: "Unused", type: "expense" });

    const rows = await getIncomeStatement(db, 1);
    expect(rows.map((r) => r.name)).toEqual(["Unused"]);
    expect(rows[0].balanceCents).toBe(0);
  });

  it("restricts to the date range using the effective date", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset", subtype: "bank" });
    const food = await createAccount({ name: "Food", type: "expense" });

    await createTransactionWithSplits({
      date: "2024-01-15",
      description: "In range",
      splits: [
        { accountId: food.id, amount: 1_000 },
        { accountId: checking.id, amount: -1_000 },
      ],
    });
    await createTransactionWithSplits({
      date: "2024-09-15",
      description: "Out of range",
      splits: [
        { accountId: food.id, amount: 9_000 },
        { accountId: checking.id, amount: -9_000 },
      ],
    });

    const rows = await getIncomeStatement(db, 1, {
      startDate: "2024-01-01",
      endDate: "2024-06-30",
    });
    expect(rows.find((r) => r.name === "Food")!.balanceCents).toBe(1_000);
  });

  it("excludes inactive accounts unless asked", async () => {
    await createAccount({ name: "Open", type: "expense" });
    await createAccount({ name: "Closed", type: "expense", isActive: false });

    expect((await getIncomeStatement(db, 1)).map((r) => r.name)).toEqual(["Open"]);
    expect(
      (await getIncomeStatement(db, 1, { includeInactive: true })).map((r) => r.name).sort()
    ).toEqual(["Closed", "Open"]);
  });
});

describe("getReportSplits", () => {
  beforeEach(async () => {
    await setupTestDatabase();
    await resetTestDatabase();
  });

  it("returns one row per split with account and payee detail", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset", subtype: "bank" });
    const food = await createAccount({ name: "Food", type: "expense" });
    await createTransactionWithSplits({
      date: "2024-03-01",
      description: "Market",
      splits: [
        { accountId: food.id, amount: 4_000 },
        { accountId: checking.id, amount: -4_000 },
      ],
    });

    const { splits, totalCount } = await getReportSplits(db, 1);

    expect(splits).toHaveLength(2);
    expect(totalCount).toBe(2);
    const foodRow = splits.find((s) => s.accountName === "Food")!;
    expect(foodRow.amount).toBe(4_000);
    expect(foodRow.accountType).toBe("expense");
    expect(foodRow.date).toBe("2024-03-01");
    expect(foodRow.description).toBe("Market");
  });

  it("filters by date range, account ids, and account types", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset", subtype: "bank" });
    const food = await createAccount({ name: "Food", type: "expense" });
    await createTransactionWithSplits({
      date: "2024-01-10",
      description: "In range",
      splits: [
        { accountId: food.id, amount: 1_000 },
        { accountId: checking.id, amount: -1_000 },
      ],
    });
    await createTransactionWithSplits({
      date: "2024-09-10",
      description: "Out of range",
      splits: [
        { accountId: food.id, amount: 2_000 },
        { accountId: checking.id, amount: -2_000 },
      ],
    });

    const ranged = await getReportSplits(db, 1, {
      startDate: "2024-01-01",
      endDate: "2024-06-30",
    });
    expect(ranged.splits).toHaveLength(2);

    const byAccount = await getReportSplits(db, 1, { accountIds: [food.id] });
    expect(byAccount.splits.every((s) => s.accountId === food.id)).toBe(true);

    const byType = await getReportSplits(db, 1, { accountTypes: ["expense"] });
    expect(byType.splits.every((s) => s.accountType === "expense")).toBe(true);
  });

  it("reports totalCount beyond the limit and orders deterministically", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset", subtype: "bank" });
    const food = await createAccount({ name: "Food", type: "expense" });
    // Three transactions on the SAME date: without an id tiebreak their order
    // is whatever PostgreSQL returns, which can vary between identical queries.
    for (const desc of ["A", "B", "C"]) {
      await createTransactionWithSplits({
        date: "2024-04-01",
        description: desc,
        splits: [
          { accountId: food.id, amount: 1_000 },
          { accountId: checking.id, amount: -1_000 },
        ],
      });
    }

    const limited = await getReportSplits(db, 1, { limit: 2 });
    expect(limited.splits).toHaveLength(2);
    expect(limited.totalCount).toBe(6);

    // Assert the ordering INVARIANT rather than comparing two runs. Comparing
    // runs only proves PostgreSQL happened to agree with itself; it passes even
    // when the ORDER BY is underspecified. Every transaction here holds two
    // splits sharing a date AND a transaction id, so (date, transaction_id)
    // alone leaves their order undefined — the split id is what settles it.
    const { splits } = await getReportSplits(db, 1);
    const sortKey = (s: { date: string; transactionId: number; splitId: number }) =>
      [s.date, s.transactionId, s.splitId] as const;
    const sorted = [...splits].sort((a, b) => {
      const [ad, at, as_] = sortKey(a);
      const [bd, bt, bs] = sortKey(b);
      return ad.localeCompare(bd) || at - bt || as_ - bs;
    });
    expect(splits.map((s) => s.splitId)).toEqual(sorted.map((s) => s.splitId));
  });
});
