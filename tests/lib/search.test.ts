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
    const emptyBucket = { items: [], total: 0, truncated: false };
    expect(results).toEqual({
      transactions: [],
      accounts: emptyBucket,
      payees: emptyBucket,
      recurringRules: emptyBucket,
    });
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
    expect(results.accounts.items.map((a) => a.name)).toEqual(["Vacation Savings"]);
    expect(results.payees.items.map((p) => p.name)).toEqual(["Vacation Rentals Inc"]);
    expect(results.recurringRules.items.map((r) => r.name)).toEqual(["Vacation Fund Transfer"]);
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
    expect(results.recurringRules.items).toHaveLength(1);
    expect(results.recurringRules.items[0].nextDate).toBe("2026-08-15");
    expect(results.recurringRules.items[0].businessDaysOnly).toBe(true);
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

  // The id tiebreak at lib/search.ts decides WHICH transactions survive the
  // LIMIT, not only the order they come back in. Transactions that share an
  // effective date are the normal case, so the cut runs through the middle of
  // a tied group. This test forces that tie rather than waiting for one.
  it("cuts a same-effective-date group at the LIMIT by descending id", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset", subtype: "bank" });
    const food = await createAccount({ name: "Food", type: "expense" });

    // 30 transactions, one shared date and one shared search term, so the
    // default LIMIT of 25 falls inside the tie.
    const ids: number[] = [];
    for (let i = 1; i <= 30; i++) {
      const txn = await createTransactionWithSplits({
        date: "2024-05-01",
        description: `Tiebreak probe ${i}`,
        splits: [
          { accountId: food.id, amount: 1_000 },
          { accountId: checking.id, amount: -1_000 },
        ],
      });
      ids.push(txn.id);
    }
    // id is a serial, thus insertion order is ascending id order.
    expect(ids).toEqual([...ids].sort((a, b) => a - b));

    const results = await searchBook(db, 1, "tiebreak probe");

    // The 25 highest ids, newest first. Asserting the ids themselves — not
    // only that they are sorted — is what catches the wrong 25 in the right
    // order, which is the failure the tiebreak prevents.
    const expected = [...ids].sort((a, b) => b - a).slice(0, 25);
    expect(results.transactions.map((t) => t.id)).toEqual(expected);
  });

  // Without a relevance band, plain alphabetical sorting can push an exact
  // match past the LIMIT: "Big Zebra Store 01".."25" all sort ahead of
  // "Zebra" alphabetically (B < Z), so a naive ORDER BY name would cut the
  // exact match entirely. This also proves the total/truncated fields report
  // the true 26-row match count, not just the 25 returned.
  it("ranks an exact payee match ahead of alphabetically earlier substring matches, and reports the true total when truncated", async () => {
    await createPayee({ name: "Zebra" });
    for (let i = 1; i <= 25; i++) {
      await createPayee({ name: `Big Zebra Store ${String(i).padStart(2, "0")}` });
    }

    const results = await searchBook(db, 1, "zebra");

    expect(results.payees.items).toHaveLength(25);
    expect(results.payees.items[0].name).toBe("Zebra");
    expect(results.payees.total).toBe(26);
    expect(results.payees.truncated).toBe(true);
  });

  // Two assertions in one order: the BAND decides first (an exact match beats
  // an alphabetically earlier prefix match, which beats a substring match),
  // and the name decides only WITHIN a band. Each band below holds two rows
  // inserted in reverse-alphabetical order, so insertion order and id order
  // both disagree with the expected result; only the secondary name key
  // produces it.
  it("bands accounts by exact, then prefix, then substring match, and sorts by name within a band", async () => {
    await createAccount({ name: "Zed Vacation Reserve", type: "asset" }); // substring
    await createAccount({ name: "My Vacation Fund", type: "asset" }); // substring
    await createAccount({ name: "Vacationland", type: "asset" }); // prefix
    await createAccount({ name: "Vacation Home", type: "asset" }); // prefix
    await createAccount({ name: "Vacation", type: "asset" }); // exact

    const results = await searchBook(db, 1, "vacation");

    expect(results.accounts.items.map((a) => a.name)).toEqual([
      "Vacation",
      "Vacation Home",
      "Vacationland",
      "My Vacation Fund",
      "Zed Vacation Reserve",
    ]);
    expect(results.accounts.total).toBe(5);
    expect(results.accounts.truncated).toBe(false);
  });

  // (relevance, lower(name)) is not a total order: "IKEA" and "Ikea" share
  // both keys, so without an id tiebreak their relative order is up to the
  // planner. Each test below seeds that exact tie for one bucket and checks
  // the fixed order, desc(id) — the same tiebreak the transaction query in
  // lib/search.ts applies with desc(transactions.id). The lower-id row is
  // always seeded FIRST, so the expected order is the reverse of insertion
  // order and an ascending tiebreak cannot satisfy it.
  it("breaks a payee name tie (same relevance band, same lowered name) by descending id", async () => {
    const first = await createPayee({ name: "IKEA" });
    const second = await createPayee({ name: "Ikea" });
    expect(second.id).toBeGreaterThan(first.id);

    const results = await searchBook(db, 1, "ikea");

    expect(results.payees.items.map((p) => p.id)).toEqual([second.id, first.id]);
  });

  it("breaks an account name tie (same relevance band, same lowered name) by descending id", async () => {
    const first = await createAccount({ name: "Vacation", type: "expense" });
    const second = await createAccount({ name: "vacation", type: "expense" });
    expect(second.id).toBeGreaterThan(first.id);

    const results = await searchBook(db, 1, "vacation");

    expect(results.accounts.items.map((a) => a.id)).toEqual([second.id, first.id]);
  });

  // Rule names carry no unique index at all, so this tie is tighter than the
  // other two: the RAW names are equal, not only their lowered forms.
  it("breaks a recurring rule name tie (same relevance band, same name) by descending id", async () => {
    const expense = await createAccount({ name: "Housing", type: "expense" });
    const checking = await createAccount({ name: "Checking", type: "asset", subtype: "bank" });
    const templateSplits = [
      { accountId: expense.id, amount: 150_000 },
      { accountId: checking.id, amount: -150_000 },
    ];
    const first = await createRecurringRule({
      name: "Rent",
      frequency: "monthly",
      startDate: "2024-01-01",
      nextDate: "2024-02-01",
      templateSplits,
    });
    const second = await createRecurringRule({
      name: "Rent",
      frequency: "monthly",
      startDate: "2024-01-01",
      nextDate: "2024-02-01",
      templateSplits,
    });
    expect(second.id).toBeGreaterThan(first.id);

    const results = await searchBook(db, 1, "rent");

    expect(results.recurringRules.items.map((r) => r.id)).toEqual([second.id, first.id]);
  });
});
