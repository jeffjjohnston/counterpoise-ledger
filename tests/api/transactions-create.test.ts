import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/b/[bookId]/transactions/route";
import {
  createAccount,
  createBook,
  createPayee,
  createSecurity,
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

function postBody(body: object) {
  return new Request("http://localhost/api/transactions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// POST /api/b/[bookId]/transactions — happy paths
// ---------------------------------------------------------------------------

describe("POST /api/b/[bookId]/transactions — happy paths", () => {
  beforeAll(async () => { await setupTestDatabase(); });
  beforeEach(async () => { await resetTestDatabase(); });

  it("creates a standard transaction and returns it with splits", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const expense = await createAccount({ name: "Groceries", type: "expense" });

    const res = await POST(
      postBody({
        date: "2025-04-01",
        description: "Weekly shopping",
        splits: [
          { accountId: checking.id, amount: -6000 },
          { accountId: expense.id, amount: 6000 },
        ],
      }),
      rp()
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBeDefined();
    expect(body.date).toBe("2025-04-01");
    expect(body.description).toBe("Weekly shopping");
    expect(body.splits).toHaveLength(2);
    expect(body.payee).toBeNull();
  });

  it("creates a new payee when payeeName doesn't match an existing one", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const expense = await createAccount({ name: "Groceries", type: "expense" });

    const res = await POST(
      postBody({
        date: "2025-04-01",
        payeeName: "Whole Foods",
        splits: [
          { accountId: checking.id, amount: -3000 },
          { accountId: expense.id, amount: 3000 },
        ],
      }),
      rp()
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.payee?.name).toBe("Whole Foods");
  });

  it("reuses an existing payee matched case-insensitively", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const expense = await createAccount({ name: "Groceries", type: "expense" });
    const existingPayee = await createPayee({ name: "Whole Foods" });

    const res = await POST(
      postBody({
        date: "2025-04-01",
        payeeName: "whole foods",
        splits: [
          { accountId: checking.id, amount: -3000 },
          { accountId: expense.id, amount: 3000 },
        ],
      }),
      rp()
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.payee?.id).toBe(existingPayee.id);
  });

  it("stores a checkNumber on a bank-account transaction", async () => {
    const bank = await createAccount({
      name: "Checking",
      type: "asset",
      subtype: "bank",
    });
    const expense = await createAccount({ name: "Rent", type: "expense" });

    const res = await POST(
      postBody({
        date: "2025-04-01",
        checkNumber: "1001",
        splits: [
          { accountId: bank.id, amount: -150000 },
          { accountId: expense.id, amount: 150000 },
        ],
      }),
      rp()
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.checkNumber).toBe("1001");
  });

  it("creates an investment transaction with investmentSplits", async () => {
    const investment = await createAccount({
      name: "Brokerage",
      type: "asset",
      subtype: "investment",
    });
    const cash = await createAccount({
      name: "Brokerage Cash",
      type: "asset",
      subtype: "cash",
      parentId: investment.id,
      isInvestmentCash: true,
    });
    const security = await createSecurity({
      name: "Acme Corp",
      symbol: "ACME",
      securityType: "stock",
    });

    const res = await POST(
      postBody({
        date: "2025-04-01",
        splits: [
          { accountId: investment.id, amount: 50000 },
          { accountId: cash.id, amount: -50000 },
        ],
        investmentSplits: [
          {
            securityId: security.id,
            action: "buy",
            sharesMicros: 10_000_000,
            priceMicros: 5_000_000,
            feesCents: 0,
          },
        ],
      }),
      rp()
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.investmentSplits).toHaveLength(1);
    expect(body.investmentSplits[0].action).toBe("buy");
    expect(body.investmentSplits[0].sharesMicros).toBe(10_000_000);
    expect(body.investmentSplits[0].security.symbol).toBe("ACME");
  });

  it("creates a transaction with notes", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const expense = await createAccount({ name: "Groceries", type: "expense" });

    const res = await POST(
      postBody({
        date: "2025-01-15",
        description: "Test",
        notes: "This is a **markdown** note",
        splits: [
          { accountId: checking.id, amount: -5000 },
          { accountId: expense.id, amount: 5000 },
        ],
      }),
      rp()
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.notes).toBe("This is a **markdown** note");
  });
});

// ---------------------------------------------------------------------------
// POST /api/b/[bookId]/transactions — validation
// ---------------------------------------------------------------------------

describe("POST /api/b/[bookId]/transactions — validation", () => {
  beforeAll(async () => { await setupTestDatabase(); });
  beforeEach(async () => { await resetTestDatabase(); });

  it("returns 400 when date is missing", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const expense = await createAccount({ name: "Groceries", type: "expense" });

    const res = await POST(
      postBody({
        splits: [
          { accountId: checking.id, amount: -1000 },
          { accountId: expense.id, amount: 1000 },
        ],
      }),
      rp()
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("returns 400 when date is not valid ISO format", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const expense = await createAccount({ name: "Groceries", type: "expense" });

    const res = await POST(
      postBody({
        date: "2025-4-1",
        splits: [
          { accountId: checking.id, amount: -1000 },
          { accountId: expense.id, amount: 1000 },
        ],
      }),
      rp()
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/YYYY-MM-DD/);
  });

  it("returns 400 when splits is missing", async () => {
    const res = await POST(
      postBody({ date: "2025-04-01" }),
      rp()
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("returns 400 when fewer than 2 splits are provided", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });

    const res = await POST(
      postBody({
        date: "2025-04-01",
        splits: [{ accountId: checking.id, amount: -1000 }],
      }),
      rp()
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/split/i);
  });

  it("returns 400 when splits do not sum to zero", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const expense = await createAccount({ name: "Groceries", type: "expense" });

    const res = await POST(
      postBody({
        date: "2025-04-01",
        splits: [
          { accountId: checking.id, amount: -1000 },
          { accountId: expense.id, amount: 999 }, // off-by-one
        ],
      }),
      rp()
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/zero/i);
  });

  it("returns 400 when checkNumber is a non-string type", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const expense = await createAccount({ name: "Groceries", type: "expense" });

    const res = await POST(
      postBody({
        date: "2025-04-01",
        checkNumber: 1001, // number, not string
        splits: [
          { accountId: checking.id, amount: -1000 },
          { accountId: expense.id, amount: 1000 },
        ],
      }),
      rp()
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/checkNumber/i);
  });

  it("returns 400 when checkNumber is used on a non-bank transaction", async () => {
    const cash = await createAccount({
      name: "Cash Wallet",
      type: "asset",
      subtype: "cash",
    });
    const expense = await createAccount({ name: "Groceries", type: "expense" });

    const res = await POST(
      postBody({
        date: "2025-04-01",
        checkNumber: "1001",
        splits: [
          { accountId: cash.id, amount: -1000 },
          { accountId: expense.id, amount: 1000 },
        ],
      }),
      rp()
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/bank/i);
  });

  it("returns 400 when splits include an investment account but no investmentSplits", async () => {
    const investment = await createAccount({
      name: "Brokerage",
      type: "asset",
      subtype: "investment",
    });
    const cash = await createAccount({
      name: "Brokerage Cash",
      type: "asset",
      subtype: "cash",
      parentId: investment.id,
      isInvestmentCash: true,
    });

    const res = await POST(
      postBody({
        date: "2025-04-01",
        splits: [
          { accountId: investment.id, amount: 10000 },
          { accountId: cash.id, amount: -10000 },
        ],
        // investmentSplits intentionally omitted
      }),
      rp()
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/investmentSplits/i);
  });

  it("returns 400 when investmentSplits is not an array", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const expense = await createAccount({ name: "Groceries", type: "expense" });

    const res = await POST(
      postBody({
        date: "2025-04-01",
        splits: [
          { accountId: checking.id, amount: -1000 },
          { accountId: expense.id, amount: 1000 },
        ],
        investmentSplits: "not-an-array",
      }),
      rp()
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/array/i);
  });

  it("returns 400 when an investment split references a security from another book", async () => {
    const investment = await createAccount({
      name: "Brokerage",
      type: "asset",
      subtype: "investment",
    });
    const cash = await createAccount({
      name: "Brokerage Cash",
      type: "asset",
      subtype: "cash",
      parentId: investment.id,
      isInvestmentCash: true,
    });
    const otherBook = await createBook({ name: "Other Book" });
    const foreignSecurity = await createSecurity({
      name: "Foreign Corp",
      symbol: "FCO",
      securityType: "stock",
      bookId: otherBook.id,
    });

    const res = await POST(
      postBody({
        date: "2025-04-01",
        splits: [
          { accountId: investment.id, amount: 50000 },
          { accountId: cash.id, amount: -50000 },
        ],
        investmentSplits: [
          {
            securityId: foreignSecurity.id,
            action: "buy",
            sharesMicros: 10_000_000,
            priceMicros: 5_000_000,
          },
        ],
      }),
      rp()
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/securit/i);
  });
});
