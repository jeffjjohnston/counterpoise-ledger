import { describe, it, expect, beforeEach } from "vitest";
import {
  setupTestDatabase,
  resetTestDatabase,
  createAccount,
  createTransactionWithSplits,
} from "../helpers/db";
import { db } from "../helpers/db-utils";
import { getAccountsWithBalances } from "@/lib/accounts";

describe("getAccountsWithBalances", () => {
  beforeEach(async () => {
    await setupTestDatabase();
    await resetTestDatabase();
  });

  it("returns accounts with zero balance when they have no splits", async () => {
    await createAccount({ name: "Checking", type: "asset", subtype: "bank" });

    const rows = await getAccountsWithBalances(db, 1);

    expect(rows).toHaveLength(1);
    expect(rows[0].balanceCents).toBe(0);
    expect(rows[0].hasTransactions).toBe(false);
  });

  it("sums splits into balanceCents and flags hasTransactions", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset", subtype: "bank" });
    const expense = await createAccount({ name: "Groceries", type: "expense" });
    await createTransactionWithSplits({
      date: "2024-03-01",
      description: "Market",
      splits: [
        { accountId: expense.id, amount: 5000 },
        { accountId: checking.id, amount: -5000 },
      ],
    });

    const rows = await getAccountsWithBalances(db, 1);
    const byName = new Map(rows.map((r) => [r.name, r]));

    expect(byName.get("Checking")!.balanceCents).toBe(-5000);
    expect(byName.get("Checking")!.hasTransactions).toBe(true);
    expect(byName.get("Groceries")!.balanceCents).toBe(5000);
  });

  it("excludes inactive accounts unless includeInactive is set", async () => {
    await createAccount({ name: "Open", type: "asset", subtype: "bank" });
    await createAccount({ name: "Closed", type: "asset", subtype: "bank", isActive: false });

    const active = await getAccountsWithBalances(db, 1);
    expect(active.map((r) => r.name)).toEqual(["Open"]);

    const all = await getAccountsWithBalances(db, 1, { includeInactive: true });
    expect(all.map((r) => r.name).sort()).toEqual(["Closed", "Open"]);
  });

  it("filters by account type", async () => {
    await createAccount({ name: "Checking", type: "asset", subtype: "bank" });
    await createAccount({ name: "Groceries", type: "expense" });

    const rows = await getAccountsWithBalances(db, 1, { type: "expense" });
    expect(rows.map((r) => r.name)).toEqual(["Groceries"]);
  });

  it("honors asOfDate using the EFFECTIVE date, not the stored date", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset", subtype: "bank" });
    const expense = await createAccount({ name: "Groceries", type: "expense" });

    // A fixed-date transaction inside the window.
    await createTransactionWithSplits({
      date: "2024-01-10",
      description: "Early",
      splits: [
        { accountId: expense.id, amount: 1000 },
        { accountId: checking.id, amount: -1000 },
      ],
    });
    // A fixed-date transaction after the window.
    await createTransactionWithSplits({
      date: "2024-06-01",
      description: "Late",
      splits: [
        { accountId: expense.id, amount: 2500 },
        { accountId: checking.id, amount: -2500 },
      ],
    });

    const rows = await getAccountsWithBalances(db, 1, { asOfDate: "2024-02-01" });
    const groceries = rows.find((r) => r.name === "Groceries")!;
    expect(groceries.balanceCents).toBe(1000);
  });

  it("orders by type then name", async () => {
    await createAccount({ name: "Zebra", type: "asset", subtype: "bank" });
    await createAccount({ name: "Apple", type: "asset", subtype: "bank" });
    await createAccount({ name: "Groceries", type: "expense" });

    const rows = await getAccountsWithBalances(db, 1);
    expect(rows.map((r) => r.name)).toEqual(["Apple", "Zebra", "Groceries"]);
  });
});
