import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as getProjected } from "@/app/api/b/[bookId]/recurring/projected/route";
import { GET as getRecurringTxns } from "@/app/api/b/[bookId]/recurring/transactions/route";
import {
  createAccount,
  createRecurringRule,
  createTransactionWithSplits,
  resetTestDatabase,
  setupTestDatabase,
} from "@/tests/helpers/db";
import { getDb } from "@/db";
import { toDateString } from "@/lib/formatters";

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

// Insert a transaction linked to a recurring rule directly via Drizzle
async function linkTransactionToRule(
  transactionId: number,
  recurringRuleId: number
) {
  const db = getDb();
  const { transactions } = await import("@/db/schema");
  const { eq } = await import("drizzle-orm");
  await db.update(transactions)
    .set({ recurringRuleId })
    .where(eq(transactions.id, transactionId));
}

// ---------------------------------------------------------------------------
// GET /api/b/[bookId]/recurring/projected
// ---------------------------------------------------------------------------

describe("GET /api/b/[bookId]/recurring/projected", () => {
  beforeAll(async () => { await setupTestDatabase(); });
  beforeEach(async () => { await resetTestDatabase(); });

  it("returns an empty array when there are no active recurring rules", async () => {
    const res = await getProjected(
      new Request(
        "http://localhost/api/recurring/projected?startDate=2025-06-01&endDate=2025-06-30"
      ),
      rp()
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });

  it("uses book.upcomingDays as the default window when endDate is omitted", async () => {
    // Override mock to use upcomingDays = 14
    const { authenticateBookRequest } = await import("@/lib/api-auth");
    vi.mocked(authenticateBookRequest).mockResolvedValueOnce({
      db: (await import("@/db")).getDb(),
      bookId: 1,
      userId: 1,
      book: { id: 1, userId: 1, name: "Test Book", upcomingDays: 14, createdAt: new Date(), updatedAt: new Date() },
    });

    const checking = await createAccount({ name: "Checking", type: "asset" });
    const expense = await createAccount({ name: "Rent", type: "expense" });

    // Create a monthly rule with nextDate = tomorrow
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = toDateString(tomorrow);

    // Create a next occurrence 20 days out (beyond the 14-day window)
    const farDate = new Date();
    farDate.setDate(farDate.getDate() + 20);
    await createRecurringRule({
      name: "Monthly Rent",
      frequency: "monthly",
      startDate: "2025-01-01",
      nextDate: tomorrowStr,
      templateSplits: [
        { accountId: checking.id, amount: -150000 },
        { accountId: expense.id, amount: 150000 },
      ],
    });

    // Request without endDate — should use book.upcomingDays (14 days)
    const res = await getProjected(
      new Request("http://localhost/api/recurring/projected"),
      rp()
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    // The rule's next occurrence (tomorrow) falls within 14 days, so it should appear
    expect(body.length).toBeGreaterThanOrEqual(1);
    // All dates should be within 14 days from today
    const maxDate = new Date();
    maxDate.setDate(maxDate.getDate() + 14);
    const maxDateStr = toDateString(maxDate);
    for (const tx of body) {
      expect(tx.date <= maxDateStr).toBe(true);
    }
  });

  it("returns projected occurrences within the date window", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const expense = await createAccount({ name: "Rent", type: "expense" });

    await createRecurringRule({
      name: "Monthly Rent",
      frequency: "monthly",
      startDate: "2025-01-01",
      nextDate: "2025-06-01",
      templateSplits: [
        { accountId: checking.id, amount: -150000 },
        { accountId: expense.id, amount: 150000 },
      ],
    });

    const res = await getProjected(
      new Request(
        "http://localhost/api/recurring/projected?startDate=2025-06-01&endDate=2025-06-30"
      ),
      rp()
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].date).toBe("2025-06-01");
    expect(body[0].isProjected).toBe(true);
  });

  it("returns multiple occurrences for a weekly rule", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const coffee = await createAccount({ name: "Coffee", type: "expense" });

    await createRecurringRule({
      name: "Weekly Coffee",
      frequency: "weekly",
      startDate: "2025-06-01",
      nextDate: "2025-06-02", // Monday
      templateSplits: [
        { accountId: checking.id, amount: -500 },
        { accountId: coffee.id, amount: 500 },
      ],
    });

    const res = await getProjected(
      new Request(
        "http://localhost/api/recurring/projected?startDate=2025-06-01&endDate=2025-06-30"
      ),
      rp()
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    // A weekly rule over ~4 weeks yields ~4 occurrences
    expect(body.length).toBeGreaterThanOrEqual(4);
    expect(body.length).toBeLessThanOrEqual(5);
    // All projected
    expect(body.every((t: { isProjected: boolean }) => t.isProjected)).toBe(true);
  });

  it("filters projected transactions to those touching a specific accountId", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const rent = await createAccount({ name: "Rent", type: "expense" });
    const savings = await createAccount({ name: "Savings", type: "asset" });
    const misc = await createAccount({ name: "Misc", type: "expense" });

    await createRecurringRule({
      name: "Monthly Rent",
      frequency: "monthly",
      startDate: "2025-01-01",
      nextDate: "2025-06-01",
      templateSplits: [
        { accountId: checking.id, amount: -150000 },
        { accountId: rent.id, amount: 150000 },
      ],
    });

    await createRecurringRule({
      name: "Savings Transfer",
      frequency: "monthly",
      startDate: "2025-01-01",
      nextDate: "2025-06-01",
      templateSplits: [
        { accountId: savings.id, amount: 50000 },
        { accountId: misc.id, amount: -50000 },
      ],
    });

    const res = await getProjected(
      new Request(
        `http://localhost/api/recurring/projected?startDate=2025-06-01&endDate=2025-06-30&accountId=${checking.id}`
      ),
      rp()
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].splits.some(
      (s: { accountId: number }) => s.accountId === checking.id
    )).toBe(true);
  });

  it("does not include inactive rules", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const expense = await createAccount({ name: "Expense", type: "expense" });

    await createRecurringRule({
      name: "Inactive Rule",
      frequency: "monthly",
      startDate: "2025-01-01",
      nextDate: "2025-06-01",
      isActive: false,
      templateSplits: [
        { accountId: checking.id, amount: -1000 },
        { accountId: expense.id, amount: 1000 },
      ],
    });

    const res = await getProjected(
      new Request(
        "http://localhost/api/recurring/projected?startDate=2025-06-01&endDate=2025-06-30"
      ),
      rp()
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });

  it("returns occurrences in ascending date order", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const expense = await createAccount({ name: "Expense", type: "expense" });

    await createRecurringRule({
      name: "Bi-monthly A",
      frequency: "monthly",
      startDate: "2025-01-01",
      nextDate: "2025-06-01",
      templateSplits: [
        { accountId: checking.id, amount: -1000 },
        { accountId: expense.id, amount: 1000 },
      ],
    });
    await createRecurringRule({
      name: "Bi-monthly B",
      frequency: "monthly",
      startDate: "2025-01-01",
      nextDate: "2025-06-15",
      templateSplits: [
        { accountId: checking.id, amount: -2000 },
        { accountId: expense.id, amount: 2000 },
      ],
    });

    const res = await getProjected(
      new Request(
        "http://localhost/api/recurring/projected?startDate=2025-06-01&endDate=2025-07-31"
      ),
      rp()
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.length).toBeGreaterThanOrEqual(2);
    // Dates should be non-decreasing
    for (let i = 1; i < body.length; i++) {
      expect(body[i].date >= body[i - 1].date).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// GET /api/b/[bookId]/recurring/transactions
// ---------------------------------------------------------------------------

describe("GET /api/b/[bookId]/recurring/transactions", () => {
  beforeAll(async () => { await setupTestDatabase(); });
  beforeEach(async () => { await resetTestDatabase(); });

  it("returns 400 when startDate or endDate is missing", async () => {
    const res = await getRecurringTxns(
      new Request("http://localhost/api/recurring/transactions?startDate=2025-01-01"),
      rp()
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("returns transactions linked to recurring rules within the date range", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const expense = await createAccount({ name: "Rent", type: "expense" });

    const rule = await createRecurringRule({
      name: "Monthly Rent",
      frequency: "monthly",
      startDate: "2025-01-01",
      nextDate: "2025-05-01",
      templateSplits: [
        { accountId: checking.id, amount: -150000 },
        { accountId: expense.id, amount: 150000 },
      ],
    });

    const tx = await createTransactionWithSplits({
      date: "2025-01-01",
      description: "Jan rent",
      splits: [
        { accountId: checking.id, amount: -150000 },
        { accountId: expense.id, amount: 150000 },
      ],
    });
    await linkTransactionToRule(tx.id, rule.id);

    const res = await getRecurringTxns(
      new Request(
        "http://localhost/api/recurring/transactions?startDate=2025-01-01&endDate=2025-01-31"
      ),
      rp()
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].transactionId).toBe(tx.id);
    expect(body[0].ruleName).toBe("Monthly Rent");
  });

  it("excludes transactions outside the date range", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const expense = await createAccount({ name: "Rent", type: "expense" });

    const rule = await createRecurringRule({
      name: "Monthly Rent",
      frequency: "monthly",
      startDate: "2025-01-01",
      nextDate: "2025-05-01",
      templateSplits: [
        { accountId: checking.id, amount: -150000 },
        { accountId: expense.id, amount: 150000 },
      ],
    });

    const tx = await createTransactionWithSplits({
      date: "2025-03-01",
      splits: [
        { accountId: checking.id, amount: -150000 },
        { accountId: expense.id, amount: 150000 },
      ],
    });
    await linkTransactionToRule(tx.id, rule.id);

    const res = await getRecurringTxns(
      new Request(
        "http://localhost/api/recurring/transactions?startDate=2025-01-01&endDate=2025-01-31"
      ),
      rp()
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(0);
  });

  it("returns an empty array when no transactions are linked to rules", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const expense = await createAccount({ name: "Groceries", type: "expense" });

    // Unlinked transaction
    await createTransactionWithSplits({
      date: "2025-01-15",
      splits: [
        { accountId: checking.id, amount: -500 },
        { accountId: expense.id, amount: 500 },
      ],
    });

    const res = await getRecurringTxns(
      new Request(
        "http://localhost/api/recurring/transactions?startDate=2025-01-01&endDate=2025-01-31"
      ),
      rp()
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(0);
  });
});
