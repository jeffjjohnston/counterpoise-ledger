import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/b/[bookId]/search/route";
import {
  createAccount,
  createPayee,
  createRecurringRule,
  createTransactionWithSplits,
  resetTestDatabase,
  setupTestDatabase,
} from "@/tests/helpers/db";

vi.mock("@/lib/api-auth", async () => {
  const { mockApiAuth } = await import("@/tests/helpers/db");
  return mockApiAuth();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rp() {
  return { params: Promise.resolve({ bookId: "1" }) };
}

function search(q: string, extra?: Record<string, string>) {
  const params = new URLSearchParams({ q, ...extra });
  return new Request(`http://localhost/api/search?${params}`);
}

// ---------------------------------------------------------------------------
// GET /api/b/[bookId]/search
// ---------------------------------------------------------------------------

describe("GET /api/b/[bookId]/search", () => {
  beforeAll(async () => { await setupTestDatabase(); });
  beforeEach(async () => { await resetTestDatabase(); });

  it("returns empty buckets for a blank query", async () => {
    const res = await GET(
      new Request("http://localhost/api/search?q="),
      rp()
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.transactions).toEqual([]);
    expect(body.accounts).toEqual([]);
    expect(body.payees).toEqual([]);
    expect(body.recurringRules).toEqual([]);
  });

  it("finds a transaction by description (case-insensitive)", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const expense = await createAccount({ name: "Groceries", type: "expense" });

    const tx = await createTransactionWithSplits({
      date: "2025-03-01",
      description: "Weekly Shopping Trip",
      splits: [
        { accountId: checking.id, amount: -5000 },
        { accountId: expense.id, amount: 5000 },
      ],
    });

    const res = await GET(search("weekly shopping"), rp());
    const body = await res.json();

    expect(body.transactions).toHaveLength(1);
    expect(body.transactions[0].id).toBe(tx.id);
  });

  it("finds a transaction by payee name", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const expense = await createAccount({ name: "Groceries", type: "expense" });
    const payee = await createPayee({ name: "Whole Foods" });

    const tx = await createTransactionWithSplits({
      date: "2025-03-01",
      payeeId: payee.id,
      splits: [
        { accountId: checking.id, amount: -4000 },
        { accountId: expense.id, amount: 4000 },
      ],
    });

    // Unrelated transaction
    await createTransactionWithSplits({
      date: "2025-03-02",
      description: "Unrelated",
      splits: [
        { accountId: checking.id, amount: -100 },
        { accountId: expense.id, amount: 100 },
      ],
    });

    const res = await GET(search("whole foods"), rp());
    const body = await res.json();

    expect(body.transactions).toHaveLength(1);
    expect(body.transactions[0].id).toBe(tx.id);
  });

  it("finds a transaction by notes", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const expense = await createAccount({ name: "Office", type: "expense" });

    const tx = await createTransactionWithSplits({
      date: "2025-03-05",
      description: "Staples",
      notes: "printer ink",
      splits: [
        { accountId: checking.id, amount: -2500 },
        { accountId: expense.id, amount: 2500 },
      ],
    });

    const res = await GET(search("printer"), rp());
    const body = await res.json();

    expect(body.transactions).toHaveLength(1);
    expect(body.transactions[0].id).toBe(tx.id);
  });

  it("finds accounts by name", async () => {
    await createAccount({ name: "Main Checking", type: "asset", subtype: "bank" });
    await createAccount({ name: "Savings", type: "asset" });

    const res = await GET(search("main"), rp());
    const body = await res.json();

    expect(body.accounts).toHaveLength(1);
    expect(body.accounts[0].name).toBe("Main Checking");
  });

  it("finds payees by name", async () => {
    const target = await createPayee({ name: "Blue Bottle Coffee" });
    await createPayee({ name: "Starbucks" });

    const res = await GET(search("blue bottle"), rp());
    const body = await res.json();

    expect(body.payees).toHaveLength(1);
    expect(body.payees[0].id).toBe(target.id);
  });

  it("finds recurring rules by name", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const expense = await createAccount({ name: "Rent", type: "expense" });

    const rule = await createRecurringRule({
      name: "Monthly Rent",
      frequency: "monthly",
      startDate: "2025-01-01",
      nextDate: "2025-04-01",
      templateSplits: [
        { accountId: checking.id, amount: -150000 },
        { accountId: expense.id, amount: 150000 },
      ],
    });

    await createRecurringRule({
      name: "Annual Subscription",
      frequency: "yearly",
      startDate: "2025-01-01",
      nextDate: "2026-01-01",
      templateSplits: [
        { accountId: checking.id, amount: -5000 },
        { accountId: expense.id, amount: 5000 },
      ],
    });

    const res = await GET(search("monthly rent"), rp());
    const body = await res.json();

    expect(body.recurringRules).toHaveLength(1);
    expect(body.recurringRules[0].id).toBe(rule.id);
  });

  it("finds transactions by currency amount", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const expense = await createAccount({ name: "Groceries", type: "expense" });

    const tx = await createTransactionWithSplits({
      date: "2025-03-01",
      description: "Big purchase",
      splits: [
        { accountId: checking.id, amount: -7500 }, // $75.00
        { accountId: expense.id, amount: 7500 },
      ],
    });

    // Noise transaction with a different amount
    await createTransactionWithSplits({
      date: "2025-03-02",
      description: "Small purchase",
      splits: [
        { accountId: checking.id, amount: -100 }, // $1.00
        { accountId: expense.id, amount: 100 },
      ],
    });

    const res = await GET(search("75.00"), rp());
    const body = await res.json();

    expect(body.transactions.some((t: { id: number }) => t.id === tx.id)).toBe(true);
  });

  it("filters transactions by date range", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const expense = await createAccount({ name: "Groceries", type: "expense" });

    await createTransactionWithSplits({
      date: "2025-01-05",
      description: "Early purchase",
      splits: [
        { accountId: checking.id, amount: -1000 },
        { accountId: expense.id, amount: 1000 },
      ],
    });

    const inRange = await createTransactionWithSplits({
      date: "2025-03-10",
      description: "In range purchase",
      splits: [
        { accountId: checking.id, amount: -1000 },
        { accountId: expense.id, amount: 1000 },
      ],
    });

    await createTransactionWithSplits({
      date: "2025-06-01",
      description: "Late purchase",
      splits: [
        { accountId: checking.id, amount: -1000 },
        { accountId: expense.id, amount: 1000 },
      ],
    });

    const res = await GET(
      search("purchase", { startDate: "2025-03-01", endDate: "2025-03-31" }),
      rp()
    );
    const body = await res.json();

    expect(body.transactions).toHaveLength(1);
    expect(body.transactions[0].id).toBe(inRange.id);
  });

  it("returns empty transactions array for a query that matches nothing", async () => {
    const res = await GET(search("xyzzy_no_match_42"), rp());
    const body = await res.json();

    expect(body.transactions).toEqual([]);
    expect(body.accounts).toEqual([]);
    expect(body.payees).toEqual([]);
    expect(body.recurringRules).toEqual([]);
  });

  it("returns transactions in descending date order", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const expense = await createAccount({ name: "Groceries", type: "expense" });

    await createTransactionWithSplits({
      date: "2025-01-01",
      description: "Alpha first",
      splits: [
        { accountId: checking.id, amount: -100 },
        { accountId: expense.id, amount: 100 },
      ],
    });
    await createTransactionWithSplits({
      date: "2025-03-01",
      description: "Alpha third",
      splits: [
        { accountId: checking.id, amount: -100 },
        { accountId: expense.id, amount: 100 },
      ],
    });
    await createTransactionWithSplits({
      date: "2025-02-01",
      description: "Alpha second",
      splits: [
        { accountId: checking.id, amount: -100 },
        { accountId: expense.id, amount: 100 },
      ],
    });

    const res = await GET(search("alpha"), rp());
    const body = await res.json();

    expect(body.transactions).toHaveLength(3);
    expect(body.transactions[0].date >= body.transactions[1].date).toBe(true);
    expect(body.transactions[1].date >= body.transactions[2].date).toBe(true);
  });
});
