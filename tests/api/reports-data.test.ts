import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/b/[bookId]/reports/data/route";
import {
  createAccount,
  createTransactionWithSplits,
  resetTestDatabase,
  setupTestDatabase,
} from "@/tests/helpers/db";
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

function get(params: Record<string, string> = {}) {
  const qs = new URLSearchParams(params);
  return new Request(`http://localhost/api/reports/data?${qs}`);
}

// ---------------------------------------------------------------------------
// GET /api/b/[bookId]/reports/data
// ---------------------------------------------------------------------------

describe("GET /api/b/[bookId]/reports/data", () => {
  beforeAll(async () => { await setupTestDatabase(); });
  beforeEach(async () => { await resetTestDatabase(); });

  it("returns all splits and all accounts when no filters are applied", async () => {
    const checking = await createAccount({
      name: "Checking",
      type: "asset",
      subtype: "bank",
    });
    const expense = await createAccount({ name: "Groceries", type: "expense" });

    await createTransactionWithSplits({
      date: "2025-01-10",
      splits: [
        { accountId: checking.id, amount: -2000 },
        { accountId: expense.id, amount: 2000 },
      ],
    });

    const res = await GET(get(), rp());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.splits).toHaveLength(2);
    expect(body.accounts).toHaveLength(2);
  });

  it("filters splits by date range", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const expense = await createAccount({ name: "Groceries", type: "expense" });

    await createTransactionWithSplits({
      date: "2025-01-05",
      description: "Before range",
      splits: [
        { accountId: checking.id, amount: -1000 },
        { accountId: expense.id, amount: 1000 },
      ],
    });

    await createTransactionWithSplits({
      date: "2025-02-15",
      description: "In range",
      splits: [
        { accountId: checking.id, amount: -2000 },
        { accountId: expense.id, amount: 2000 },
      ],
    });

    await createTransactionWithSplits({
      date: "2025-04-01",
      description: "After range",
      splits: [
        { accountId: checking.id, amount: -3000 },
        { accountId: expense.id, amount: 3000 },
      ],
    });

    const res = await GET(
      get({ startDate: "2025-02-01", endDate: "2025-02-28" }),
      rp()
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    // Only the Feb transaction's 2 splits
    expect(body.splits).toHaveLength(2);
    expect(body.splits.every((s: { date: string }) => s.date === "2025-02-15")).toBe(true);
    // But ALL accounts are still returned
    expect(body.accounts).toHaveLength(2);
  });

  it("filters splits by accountIds", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const groceries = await createAccount({ name: "Groceries", type: "expense" });
    const dining = await createAccount({ name: "Dining", type: "expense" });

    await createTransactionWithSplits({
      date: "2025-01-10",
      splits: [
        { accountId: checking.id, amount: -1500 },
        { accountId: groceries.id, amount: 1000 },
        { accountId: dining.id, amount: 500 },
      ],
    });

    const res = await GET(
      get({ accountIds: `${groceries.id}` }),
      rp()
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    // Only the groceries split
    expect(body.splits).toHaveLength(1);
    expect(body.splits[0].accountId).toBe(groceries.id);
    // All accounts returned regardless
    expect(body.accounts).toHaveLength(3);
  });

  it("filters splits by accountTypes", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const groceries = await createAccount({ name: "Groceries", type: "expense" });
    const dining = await createAccount({ name: "Dining", type: "expense" });

    await createTransactionWithSplits({
      date: "2025-01-10",
      splits: [
        { accountId: checking.id, amount: -3000 },
        { accountId: groceries.id, amount: 2000 },
        { accountId: dining.id, amount: 1000 },
      ],
    });

    const res = await GET(get({ accountTypes: "expense" }), rp());

    expect(res.status).toBe(200);
    const body = await res.json();
    // Only expense splits (groceries + dining)
    expect(body.splits).toHaveLength(2);
    expect(
      body.splits.every((s: { accountType: string }) => s.accountType === "expense")
    ).toBe(true);
  });

  it("returns splits ordered by date then transaction id", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const expense = await createAccount({ name: "Groceries", type: "expense" });

    await createTransactionWithSplits({
      date: "2025-03-01",
      splits: [
        { accountId: checking.id, amount: -500 },
        { accountId: expense.id, amount: 500 },
      ],
    });

    await createTransactionWithSplits({
      date: "2025-01-01",
      splits: [
        { accountId: checking.id, amount: -200 },
        { accountId: expense.id, amount: 200 },
      ],
    });

    const res = await GET(get(), rp());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.splits).toHaveLength(4);
    // Jan splits come before Mar splits
    expect(body.splits[0].date).toBe("2025-01-01");
    expect(body.splits[2].date).toBe("2025-03-01");
  });

  it("places floating transactions in their effective period, not their stored one", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const expense = await createAccount({ name: "Groceries", type: "expense" });

    // Stored date is long past; a floating transaction is effectively "today".
    await createTransactionWithSplits({
      date: "2020-01-05",
      description: "Floating",
      isFloating: true,
      splits: [
        { accountId: checking.id, amount: -2500 },
        { accountId: expense.id, amount: 2500 },
      ],
    });

    const today = toDateString(new Date());

    const effectiveRes = await GET(
      get({ startDate: today, endDate: today }),
      rp()
    );
    const effectiveBody = await effectiveRes.json();
    expect(effectiveBody.splits).toHaveLength(2);
    expect(
      effectiveBody.splits.every((s: { date: string }) => s.date === today)
    ).toBe(true);

    const storedRes = await GET(
      get({ startDate: "2020-01-01", endDate: "2020-01-31" }),
      rp()
    );
    const storedBody = await storedRes.json();
    expect(storedBody.splits).toHaveLength(0);
  });

  it("returns an empty splits array when no transactions exist", async () => {
    await createAccount({ name: "Checking", type: "asset" });

    const res = await GET(get(), rp());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.splits).toHaveLength(0);
    expect(body.accounts).toHaveLength(1);
  });
});
