import { describe, it, expect, beforeEach } from "vitest";
import {
  setupTestDatabase,
  resetTestDatabase,
  createAccount,
  createPayee,
  createTransactionWithSplits,
  createRecurringRule,
} from "../helpers/db";
import { db } from "../helpers/db-utils";
import { searchBook } from "@/lib/search";

describe("searchBook", () => {
  beforeEach(async () => {
    await setupTestDatabase();
    await resetTestDatabase();
  });

  it("returns empty results for a blank query", async () => {
    const results = await searchBook(db, 1, "   ");
    expect(results).toEqual({ transactions: [], accounts: [], payees: [], recurringRules: [] });
  });

  it("matches transactions case-insensitively on description", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset", subtype: "bank" });
    const food = await createAccount({ name: "Food", type: "expense" });
    await createTransactionWithSplits({
      date: "2024-03-01",
      description: "Whole Foods Market",
      splits: [
        { accountId: food.id, amount: 4_000 },
        { accountId: checking.id, amount: -4_000 },
      ],
    });

    const results = await searchBook(db, 1, "whole foods");
    expect(results.transactions).toHaveLength(1);
    expect(results.transactions[0].description).toBe("Whole Foods Market");
    expect(results.transactions[0].splits.length).toBeGreaterThan(0);
  });

  it("matches a transaction by its amount, in either direction", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset", subtype: "bank" });
    const food = await createAccount({ name: "Food", type: "expense" });
    await createTransactionWithSplits({
      date: "2024-03-01",
      description: "Grocery run",
      splits: [
        { accountId: food.id, amount: 4_250 },
        { accountId: checking.id, amount: -4_250 },
      ],
    });

    // "42.50" -> 4250 cents; the debit is +4250 and the credit is -4250.
    const results = await searchBook(db, 1, "42.50");
    expect(results.transactions).toHaveLength(1);
    expect(results.transactions[0].description).toBe("Grocery run");
  });

  it("matches accounts, payees, and recurring rules", async () => {
    const savings = await createAccount({ name: "Vacation Savings", type: "asset", subtype: "bank" });
    const checking = await createAccount({ name: "Checking", type: "asset", subtype: "bank" });
    await createPayee({ name: "Vacation Rentals Inc" });
    await createRecurringRule({
      name: "Vacation Fund Transfer",
      frequency: "monthly",
      startDate: "2024-01-01",
      nextDate: "2024-02-01",
      templateSplits: [
        { accountId: savings.id, amount: 20_000 },
        { accountId: checking.id, amount: -20_000 },
      ],
    });

    const results = await searchBook(db, 1, "vacation");
    expect(results.accounts.map((a) => a.name)).toEqual(["Vacation Savings"]);
    expect(results.payees.map((p) => p.name)).toEqual(["Vacation Rentals Inc"]);
    expect(results.recurringRules.map((r) => r.name)).toEqual(["Vacation Fund Transfer"]);
  });

  // The search page shifts a weekend nextDate to the Monday it is observed on,
  // exactly as the recurring page does, so the flag has to reach it.
  it("carries businessDaysOnly through recurring rule results", async () => {
    const savings = await createAccount({ name: "Vacation Savings", type: "asset", subtype: "bank" });
    const checking = await createAccount({ name: "Checking", type: "asset", subtype: "bank" });
    await createRecurringRule({
      name: "Vacation Fund Transfer",
      frequency: "monthly",
      startDate: "2026-08-15",
      nextDate: "2026-08-15",
      businessDaysOnly: true,
      templateSplits: [
        { accountId: savings.id, amount: 20_000 },
        { accountId: checking.id, amount: -20_000 },
      ],
    });

    const results = await searchBook(db, 1, "vacation");
    expect(results.recurringRules).toHaveLength(1);
    expect(results.recurringRules[0].nextDate).toBe("2026-08-15");
    expect(results.recurringRules[0].businessDaysOnly).toBe(true);
  });

  it("restricts transactions to a date range using the effective date", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset", subtype: "bank" });
    const food = await createAccount({ name: "Food", type: "expense" });
    for (const date of ["2024-01-10", "2024-09-10"]) {
      await createTransactionWithSplits({
        date,
        description: "Market run",
        splits: [
          { accountId: food.id, amount: 1_000 },
          { accountId: checking.id, amount: -1_000 },
        ],
      });
    }

    const results = await searchBook(db, 1, "market", {
      startDate: "2024-01-01",
      endDate: "2024-06-30",
    });
    expect(results.transactions).toHaveLength(1);
    expect(results.transactions[0].date).toBe("2024-01-10");
  });
});
