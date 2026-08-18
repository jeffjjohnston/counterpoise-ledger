import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as getPayee, DELETE as deletePayee } from "@/app/api/b/[bookId]/payees/[id]/route";
import { GET as getLastAccount } from "@/app/api/b/[bookId]/payees/[id]/last-account/route";
import {
  createAccount,
  createPayee,
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

function rp(id: string | number) {
  return { params: Promise.resolve({ bookId: "1", id: String(id) }) };
}

// ---------------------------------------------------------------------------
// GET /api/b/[bookId]/payees/[id]
// ---------------------------------------------------------------------------

describe("GET /api/b/[bookId]/payees/[id]", () => {
  beforeAll(async () => { await setupTestDatabase(); });
  beforeEach(async () => { await resetTestDatabase(); });

  it("returns the payee with transactionCount 0 when no transactions exist", async () => {
    const payee = await createPayee({ name: "Whole Foods" });

    const res = await getPayee(
      new Request(`http://localhost/api/payees/${payee.id}`),
      rp(payee.id)
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(payee.id);
    expect(body.name).toBe("Whole Foods");
    expect(body.transactionCount).toBe(0);
  });

  it("returns the correct transactionCount", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const expense = await createAccount({ name: "Groceries", type: "expense" });
    const payee = await createPayee({ name: "Whole Foods" });

    await createTransactionWithSplits({
      date: "2025-01-01",
      payeeId: payee.id,
      splits: [
        { accountId: checking.id, amount: -2000 },
        { accountId: expense.id, amount: 2000 },
      ],
    });
    await createTransactionWithSplits({
      date: "2025-01-02",
      payeeId: payee.id,
      splits: [
        { accountId: checking.id, amount: -3000 },
        { accountId: expense.id, amount: 3000 },
      ],
    });

    const res = await getPayee(
      new Request(`http://localhost/api/payees/${payee.id}`),
      rp(payee.id)
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.transactionCount).toBe(2);
  });

  it("returns 404 for an unknown payee id", async () => {
    const res = await getPayee(
      new Request("http://localhost/api/payees/9999"),
      rp(9999)
    );

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("returns 400 for a non-numeric id", async () => {
    const res = await getPayee(
      new Request("http://localhost/api/payees/abc"),
      rp("abc")
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// GET /api/b/[bookId]/payees/[id]/last-account
// ---------------------------------------------------------------------------

describe("GET /api/b/[bookId]/payees/[id]/last-account", () => {
  beforeAll(async () => { await setupTestDatabase(); });
  beforeEach(async () => { await resetTestDatabase(); });

  it("returns { accountId: null } when the payee has no transactions", async () => {
    const payee = await createPayee({ name: "Blue Bottle" });

    const res = await getLastAccount(
      new Request(`http://localhost/api/payees/${payee.id}/last-account`),
      rp(payee.id)
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accountId).toBeNull();
  });

  it("returns the accountId of the largest debit split in the most recent transaction", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const groceries = await createAccount({ name: "Groceries", type: "expense" });
    const dining = await createAccount({ name: "Dining", type: "expense" });
    const payee = await createPayee({ name: "Whole Foods" });

    // Older transaction
    await createTransactionWithSplits({
      date: "2025-01-01",
      payeeId: payee.id,
      splits: [
        { accountId: checking.id, amount: -1000 },
        { accountId: groceries.id, amount: 1000 },
      ],
    });

    // More recent transaction — dining is the debit
    await createTransactionWithSplits({
      date: "2025-01-10",
      payeeId: payee.id,
      splits: [
        { accountId: checking.id, amount: -5000 },
        { accountId: dining.id, amount: 5000 },
      ],
    });

    const res = await getLastAccount(
      new Request(`http://localhost/api/payees/${payee.id}/last-account`),
      rp(payee.id)
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accountId).toBe(dining.id);
  });

  it("returns the largest-amount debit when a transaction has multiple debit splits", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const groceries = await createAccount({ name: "Groceries", type: "expense" });
    const misc = await createAccount({ name: "Misc", type: "expense" });
    const payee = await createPayee({ name: "Target" });

    // Split purchase: $30 to groceries, $10 to misc
    await createTransactionWithSplits({
      date: "2025-01-05",
      payeeId: payee.id,
      splits: [
        { accountId: checking.id, amount: -4000 },
        { accountId: groceries.id, amount: 3000 },
        { accountId: misc.id, amount: 1000 },
      ],
    });

    const res = await getLastAccount(
      new Request(`http://localhost/api/payees/${payee.id}/last-account`),
      rp(payee.id)
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accountId).toBe(groceries.id);
  });

  it("returns 400 for a non-numeric id", async () => {
    const res = await getLastAccount(
      new Request("http://localhost/api/payees/abc/last-account"),
      rp("abc")
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/b/[bookId]/payees/[id]
// ---------------------------------------------------------------------------

describe("DELETE /api/b/[bookId]/payees/[id]", () => {
  beforeAll(async () => { await setupTestDatabase(); });
  beforeEach(async () => { await resetTestDatabase(); });

  it("deletes a payee with no transactions", async () => {
    const payee = await createPayee({ name: "Unused Payee" });

    const response = await deletePayee(
      new Request(`http://localhost/api/payees/${payee.id}`, { method: "DELETE" }),
      { params: Promise.resolve({ bookId: "1", id: String(payee.id) }) }
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.success).toBe(true);
  });

  it("returns 409 when payee has associated transactions", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const coffee = await createAccount({ name: "Coffee", type: "expense" });
    const payee = await createPayee({ name: "Blue Bottle" });

    await createTransactionWithSplits({
      date: "2024-01-01",
      payeeId: payee.id,
      splits: [
        { accountId: coffee.id, amount: 450 },
        { accountId: checking.id, amount: -450 },
      ],
    });

    const response = await deletePayee(
      new Request(`http://localhost/api/payees/${payee.id}`, { method: "DELETE" }),
      { params: Promise.resolve({ bookId: "1", id: String(payee.id) }) }
    );

    expect(response.status).toBe(409);
    const payload = await response.json();
    expect(payload.error).toContain("associated transactions");
  });

  it("returns 404 for nonexistent payee", async () => {
    const response = await deletePayee(
      new Request("http://localhost/api/payees/99999", { method: "DELETE" }),
      { params: Promise.resolve({ bookId: "1", id: "99999" }) }
    );

    expect(response.status).toBe(404);
  });

  it("returns 400 for non-numeric id", async () => {
    const response = await deletePayee(
      new Request("http://localhost/api/payees/abc", { method: "DELETE" }),
      { params: Promise.resolve({ bookId: "1", id: "abc" }) }
    );

    expect(response.status).toBe(400);
  });
});
