import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GET,
  PUT,
  DELETE,
} from "@/app/api/b/[bookId]/transactions/[id]/route";
import {
  createAccount,
  createInvestmentSplit,
  createPayee,
  createPlaidAccount,
  createPlaidReconciliation,
  createPlaidToken,
  createSecurity,
  createTransactionWithSplits,
  resetTestDatabase,
  setupTestDatabase,
} from "@/tests/helpers/db";
import { db } from "@/tests/helpers/db-utils";
import { plaidTransactionReconciliation } from "@/db/schema";
import { eq } from "drizzle-orm";

vi.mock("@/lib/api-auth", async () => {
  const { mockApiAuth } = await import("@/tests/helpers/db");
  return mockApiAuth();
});

import { captureEvent } from "@/lib/posthog-server";

vi.mock("@/lib/posthog-server", async () => {
  const actual = await import("@/lib/posthog-server");
  return {
    ...actual,
    captureEvent: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rp(id: string | number) {
  return { params: Promise.resolve({ bookId: "1", id: String(id) }) };
}

function makeRequest(url: string, options?: RequestInit) {
  return new Request(`http://localhost${url}`, options);
}

function putBody(id: string | number, body: object) {
  return makeRequest(`/api/transactions/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// GET /api/b/[bookId]/transactions/[id]
// ---------------------------------------------------------------------------

describe("GET /api/b/[bookId]/transactions/[id]", () => {
  beforeAll(async () => { await setupTestDatabase(); });
  beforeEach(async () => { await resetTestDatabase(); });

  it("returns the transaction with splits and payee", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const expense = await createAccount({ name: "Groceries", type: "expense" });
    const payee = await createPayee({ name: "Whole Foods" });

    const tx = await createTransactionWithSplits({
      date: "2025-03-01",
      description: "Weekly shop",
      payeeId: payee.id,
      splits: [
        { accountId: checking.id, amount: -4500 },
        { accountId: expense.id, amount: 4500 },
      ],
    });

    const res = await GET(makeRequest(`/api/transactions/${tx.id}`), rp(tx.id));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(tx.id);
    expect(body.date).toBe("2025-03-01");
    expect(body.description).toBe("Weekly shop");
    expect(body.payee?.name).toBe("Whole Foods");
    expect(body.splits).toHaveLength(2);
  });

  it("returns 404 for a non-existent transaction", async () => {
    const res = await GET(makeRequest("/api/transactions/9999"), rp(9999));

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("includes investment splits with security info", async () => {
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

    const tx = await createTransactionWithSplits({
      date: "2025-01-10",
      description: "Buy ACME",
      splits: [
        { accountId: investment.id, amount: 10000 },
        { accountId: cash.id, amount: -10000 },
      ],
    });
    await createInvestmentSplit({
      transactionId: tx.id,
      securityId: security.id,
      accountId: investment.id,
      action: "buy",
      sharesMicros: 10_000_000,
      priceMicros: 10_000_000,
    });

    const res = await GET(makeRequest(`/api/transactions/${tx.id}`), rp(tx.id));
    const body = await res.json();

    expect(body.investmentSplits).toHaveLength(1);
    expect(body.investmentSplits[0].action).toBe("buy");
    expect(body.investmentSplits[0].security.symbol).toBe("ACME");
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/b/[bookId]/transactions/[id]
// ---------------------------------------------------------------------------

describe("DELETE /api/b/[bookId]/transactions/[id]", () => {
  beforeAll(async () => { await setupTestDatabase(); });
  beforeEach(async () => { await resetTestDatabase(); });

  it("deletes the transaction and returns success", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const expense = await createAccount({ name: "Groceries", type: "expense" });

    const tx = await createTransactionWithSplits({
      date: "2025-01-01",
      splits: [
        { accountId: checking.id, amount: -1000 },
        { accountId: expense.id, amount: 1000 },
      ],
    });

    const res = await DELETE(
      makeRequest(`/api/transactions/${tx.id}`, { method: "DELETE" }),
      rp(tx.id)
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it("returns 404 for a non-existent transaction", async () => {
    const res = await DELETE(
      makeRequest("/api/transactions/9999", { method: "DELETE" }),
      rp(9999)
    );

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("cascades deletion to transaction splits", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const expense = await createAccount({ name: "Groceries", type: "expense" });

    const tx = await createTransactionWithSplits({
      date: "2025-01-01",
      splits: [
        { accountId: checking.id, amount: -1000 },
        { accountId: expense.id, amount: 1000 },
      ],
    });

    await DELETE(
      makeRequest(`/api/transactions/${tx.id}`, { method: "DELETE" }),
      rp(tx.id)
    );

    // Trying to GET the deleted transaction should 404
    const getRes = await GET(makeRequest(`/api/transactions/${tx.id}`), rp(tx.id));
    expect(getRes.status).toBe(404);
  });

  it("returns a matched bank row to pending when its transaction is deleted", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const groceries = await createAccount({ name: "Groceries", type: "expense" });
    const token = await createPlaidToken({
      financialInstitution: "Chase",
      itemId: "item-del",
      accessToken: "tok-del",
    });
    const link = await createPlaidAccount({
      tokenId: token.id,
      plaidAccountId: "pa-del",
      name: "Plaid Checking",
      type: "depository",
      counterpoiseAccountId: checking.id,
    });
    const txn = await createTransactionWithSplits({
      date: "2026-04-01",
      description: "Blue Bottle",
      isReconciled: true,
      splits: [
        { accountId: checking.id, amount: -700 },
        { accountId: groceries.id, amount: 700 },
      ],
    });
    const recon = await createPlaidReconciliation({
      plaidAccountLinkId: link.id,
      plaidTransactionId: "txn-del",
      date: "2026-04-01",
      amountCents: -700,
      name: "Blue Bottle",
      resolutionStatus: "matched",
      matchedTransactionId: txn.id,
    });

    const response = await DELETE(
      new Request(`http://localhost/api/b/1/transactions/${txn.id}`, { method: "DELETE" }),
      { params: Promise.resolve({ bookId: "1", id: String(txn.id) }) }
    );
    expect(response.status).toBe(200);

    const [row] = await db
      .select()
      .from(plaidTransactionReconciliation)
      .where(eq(plaidTransactionReconciliation.id, recon.id));

    // Without the reset the row survives as status "matched" with a null
    // transaction id, and the queue renders only pending and review rows — so it
    // becomes permanently invisible rather than re-matchable.
    expect(row.resolutionStatus).toBe("pending");
    expect(row.matchedTransactionId).toBeNull();
    expect(row.resolvedAt).toBeNull();
  });

  it("sweeps a row stranded at matched/null-id back to pending on any delete", async () => {
    // Simulates the outcome of the narrow auto-match/delete race: if a
    // concurrent auto-match claim on some OTHER row commits mid-delete, the
    // FK's ON DELETE SET NULL clears its matchedTransactionId but leaves
    // resolutionStatus at "matched" — a stranding the id-scoped reset above
    // can't see because it only looks at rows matching *this* transaction's
    // id. The post-delete sweep catches any such row in the book, regardless
    // of which transaction triggered the delete.
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const groceries = await createAccount({ name: "Groceries", type: "expense" });
    const token = await createPlaidToken({
      financialInstitution: "Chase",
      itemId: "item-sweep",
      accessToken: "tok-sweep",
    });
    const link = await createPlaidAccount({
      tokenId: token.id,
      plaidAccountId: "pa-sweep",
      name: "Plaid Checking",
      type: "depository",
      counterpoiseAccountId: checking.id,
    });

    // Already stranded — not linked to the transaction we're about to delete.
    const stranded = await createPlaidReconciliation({
      plaidAccountLinkId: link.id,
      plaidTransactionId: "txn-stranded",
      date: "2026-04-01",
      amountCents: -700,
      name: "Stranded Row",
      resolutionStatus: "matched",
      matchedTransactionId: null,
    });

    // An unrelated transaction, deleted only to trigger the sweep.
    const unrelated = await createTransactionWithSplits({
      date: "2026-04-02",
      splits: [
        { accountId: checking.id, amount: -1000 },
        { accountId: groceries.id, amount: 1000 },
      ],
    });

    const response = await DELETE(
      new Request(`http://localhost/api/b/1/transactions/${unrelated.id}`, { method: "DELETE" }),
      { params: Promise.resolve({ bookId: "1", id: String(unrelated.id) }) }
    );
    expect(response.status).toBe(200);

    const [row] = await db
      .select()
      .from(plaidTransactionReconciliation)
      .where(eq(plaidTransactionReconciliation.id, stranded.id));

    expect(row.resolutionStatus).toBe("pending");
    expect(row.matchedTransactionId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PUT /api/b/[bookId]/transactions/[id] — field updates
// ---------------------------------------------------------------------------

describe("PUT /api/b/[bookId]/transactions/[id] — field updates", () => {
  beforeAll(async () => { await setupTestDatabase(); });
  beforeEach(async () => {
    await resetTestDatabase();
    vi.mocked(captureEvent).mockClear();
  });

  it("updates the date", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const expense = await createAccount({ name: "Groceries", type: "expense" });

    const tx = await createTransactionWithSplits({
      date: "2025-01-01",
      splits: [
        { accountId: checking.id, amount: -500 },
        { accountId: expense.id, amount: 500 },
      ],
    });

    const res = await PUT(putBody(tx.id, { date: "2025-06-15" }), rp(tx.id));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.date).toBe("2025-06-15");
  });

  it("updates the description", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const expense = await createAccount({ name: "Groceries", type: "expense" });

    const tx = await createTransactionWithSplits({
      date: "2025-01-01",
      description: "Old description",
      splits: [
        { accountId: checking.id, amount: -500 },
        { accountId: expense.id, amount: 500 },
      ],
    });

    const res = await PUT(
      putBody(tx.id, { description: "New description" }),
      rp(tx.id)
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.description).toBe("New description");
  });

  it("marks the transaction as reconciled", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const expense = await createAccount({ name: "Groceries", type: "expense" });

    const tx = await createTransactionWithSplits({
      date: "2025-01-01",
      splits: [
        { accountId: checking.id, amount: -500 },
        { accountId: expense.id, amount: 500 },
      ],
    });

    const res = await PUT(putBody(tx.id, { isReconciled: true }), rp(tx.id));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.isReconciled).toBe(true);
  });

  it("creates a new payee when payeeName doesn't match an existing one", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const expense = await createAccount({ name: "Groceries", type: "expense" });

    const tx = await createTransactionWithSplits({
      date: "2025-01-01",
      splits: [
        { accountId: checking.id, amount: -500 },
        { accountId: expense.id, amount: 500 },
      ],
    });

    const res = await PUT(putBody(tx.id, { payeeName: "Whole Foods" }), rp(tx.id));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.payee?.name).toBe("Whole Foods");
  });

  it("reuses an existing payee that matches by name (case-insensitive)", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const expense = await createAccount({ name: "Groceries", type: "expense" });
    const existingPayee = await createPayee({ name: "Whole Foods" });

    const tx = await createTransactionWithSplits({
      date: "2025-01-01",
      splits: [
        { accountId: checking.id, amount: -500 },
        { accountId: expense.id, amount: 500 },
      ],
    });

    const res = await PUT(putBody(tx.id, { payeeName: "whole foods" }), rp(tx.id));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.payee?.id).toBe(existingPayee.id);
  });

  it("clears the payee when payeeName is an empty string", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const expense = await createAccount({ name: "Groceries", type: "expense" });
    const payee = await createPayee({ name: "Whole Foods" });

    const tx = await createTransactionWithSplits({
      date: "2025-01-01",
      payeeId: payee.id,
      splits: [
        { accountId: checking.id, amount: -500 },
        { accountId: expense.id, amount: 500 },
      ],
    });

    const res = await PUT(putBody(tx.id, { payeeName: "" }), rp(tx.id));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.payee).toBeNull();
  });

  it("replaces splits when a new set of splits is provided", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const groceries = await createAccount({ name: "Groceries", type: "expense" });
    const dining = await createAccount({ name: "Dining", type: "expense" });

    const tx = await createTransactionWithSplits({
      date: "2025-01-01",
      splits: [
        { accountId: checking.id, amount: -500 },
        { accountId: groceries.id, amount: 500 },
      ],
    });

    const res = await PUT(
      putBody(tx.id, {
        splits: [
          { accountId: checking.id, amount: -750 },
          { accountId: dining.id, amount: 750 },
        ],
      }),
      rp(tx.id)
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.splits).toHaveLength(2);
    const accountIds = body.splits.map((s: { accountId: number }) => s.accountId);
    expect(accountIds).toContain(dining.id);
    expect(accountIds).not.toContain(groceries.id);
  });

  it("updates transaction notes", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const expense = await createAccount({ name: "Groceries", type: "expense" });

    const tx = await createTransactionWithSplits({
      date: "2025-01-01",
      splits: [
        { accountId: checking.id, amount: -500 },
        { accountId: expense.id, amount: 500 },
      ],
    });

    const res = await PUT(putBody(tx.id, { notes: "Updated note" }), rp(tx.id));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.notes).toBe("Updated note");
  });

  it("updates checkNumber on a bank-account transaction", async () => {
    const bank = await createAccount({
      name: "Checking",
      type: "asset",
      subtype: "bank",
    });
    const expense = await createAccount({ name: "Rent", type: "expense" });

    const tx = await createTransactionWithSplits({
      date: "2025-01-01",
      splits: [
        { accountId: bank.id, amount: -150000 },
        { accountId: expense.id, amount: 150000 },
      ],
    });

    const res = await PUT(putBody(tx.id, { checkNumber: "4321" }), rp(tx.id));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.checkNumber).toBe("4321");
  });

  it("tracks fieldsChanged on transaction_updated event", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const groceries = await createAccount({ name: "Groceries", type: "expense" });
    const dining = await createAccount({ name: "Dining", type: "expense" });

    const tx = await createTransactionWithSplits({
      date: "2025-03-01",
      description: "Weekly shop",
      splits: [
        { accountId: checking.id, amount: -4500 },
        { accountId: groceries.id, amount: 4500 },
      ],
    });

    const res = await PUT(
      putBody(tx.id, {
        date: "2025-03-02",
        description: "Weekly shop",
        payeeName: "",
        splits: [
          { accountId: checking.id, amount: -4500 },
          { accountId: dining.id, amount: 4500 },
        ],
      }),
      rp(tx.id)
    );

    expect(res.status).toBe(200);
    expect(captureEvent).toHaveBeenCalledWith(
      expect.any(Number),
      "transaction_updated",
      expect.objectContaining({
        bookId: 1,
        fieldsChanged: expect.arrayContaining(["date", "splits"]),
        splitsAccountsChanged: true,
      })
    );
  });

  it("tracks isReconciled-only update with no other fields", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const expense = await createAccount({ name: "Rent", type: "expense" });

    const tx = await createTransactionWithSplits({
      date: "2025-03-01",
      description: "Rent",
      splits: [
        { accountId: checking.id, amount: -100000 },
        { accountId: expense.id, amount: 100000 },
      ],
    });

    const res = await PUT(
      putBody(tx.id, { isReconciled: true }),
      rp(tx.id)
    );

    expect(res.status).toBe(200);
    expect(captureEvent).toHaveBeenCalledWith(
      expect.any(Number),
      "transaction_updated",
      expect.objectContaining({
        fieldsChanged: ["isReconciled"],
        splitsAccountsChanged: false,
      })
    );
  });
});

// ---------------------------------------------------------------------------
// PUT /api/b/[bookId]/transactions/[id] — validation
// ---------------------------------------------------------------------------

describe("PUT /api/b/[bookId]/transactions/[id] — validation", () => {
  beforeAll(async () => { await setupTestDatabase(); });
  beforeEach(async () => { await resetTestDatabase(); });

  it("returns 400 when fewer than 2 splits are provided", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const expense = await createAccount({ name: "Groceries", type: "expense" });

    const tx = await createTransactionWithSplits({
      date: "2025-01-01",
      splits: [
        { accountId: checking.id, amount: -500 },
        { accountId: expense.id, amount: 500 },
      ],
    });

    const res = await PUT(
      putBody(tx.id, {
        splits: [{ accountId: checking.id, amount: -500 }],
      }),
      rp(tx.id)
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/split/i);
  });

  it("returns 400 when splits do not sum to zero", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const expense = await createAccount({ name: "Groceries", type: "expense" });

    const tx = await createTransactionWithSplits({
      date: "2025-01-01",
      splits: [
        { accountId: checking.id, amount: -500 },
        { accountId: expense.id, amount: 500 },
      ],
    });

    const res = await PUT(
      putBody(tx.id, {
        splits: [
          { accountId: checking.id, amount: -500 },
          { accountId: expense.id, amount: 999 }, // doesn't balance
        ],
      }),
      rp(tx.id)
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/zero/i);
  });

  it("returns 400 when date is not valid ISO format", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const expense = await createAccount({ name: "Groceries", type: "expense" });

    const tx = await createTransactionWithSplits({
      date: "2025-01-01",
      splits: [
        { accountId: checking.id, amount: -500 },
        { accountId: expense.id, amount: 500 },
      ],
    });

    const res = await PUT(putBody(tx.id, { date: "2025-1-01" }), rp(tx.id));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/YYYY-MM-DD/);
  });

  it("returns 400 when checkNumber is a non-string type", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const expense = await createAccount({ name: "Groceries", type: "expense" });

    const tx = await createTransactionWithSplits({
      date: "2025-01-01",
      splits: [
        { accountId: checking.id, amount: -500 },
        { accountId: expense.id, amount: 500 },
      ],
    });

    const res = await PUT(
      putBody(tx.id, { checkNumber: 1234 }), // number, not string
      rp(tx.id)
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/checkNumber/i);
  });

  it("returns 400 when checkNumber is set on a non-bank transaction", async () => {
    const checking = await createAccount({
      name: "Checking",
      type: "asset",
      subtype: "cash", // not "bank"
    });
    const expense = await createAccount({ name: "Groceries", type: "expense" });

    const tx = await createTransactionWithSplits({
      date: "2025-01-01",
      splits: [
        { accountId: checking.id, amount: -500 },
        { accountId: expense.id, amount: 500 },
      ],
    });

    const res = await PUT(
      putBody(tx.id, {
        checkNumber: "1234",
        splits: [
          { accountId: checking.id, amount: -500 },
          { accountId: expense.id, amount: 500 },
        ],
      }),
      rp(tx.id)
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/bank/i);
  });

  it("returns 400 when investmentSplits is not an array", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const expense = await createAccount({ name: "Groceries", type: "expense" });

    const tx = await createTransactionWithSplits({
      date: "2025-01-01",
      splits: [
        { accountId: checking.id, amount: -500 },
        { accountId: expense.id, amount: 500 },
      ],
    });

    const res = await PUT(
      putBody(tx.id, { investmentSplits: "not-an-array" }),
      rp(tx.id)
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/array/i);
  });
});

// ---------------------------------------------------------------------------
// PUT /api/b/[bookId]/transactions/[id] — investment splits
// ---------------------------------------------------------------------------

describe("PUT /api/b/[bookId]/transactions/[id] — investment splits", () => {
  beforeAll(async () => { await setupTestDatabase(); });
  beforeEach(async () => { await resetTestDatabase(); });

  it("replaces investment splits when new ones are provided", async () => {
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

    const tx = await createTransactionWithSplits({
      date: "2025-01-10",
      splits: [
        { accountId: investment.id, amount: 10000 },
        { accountId: cash.id, amount: -10000 },
      ],
    });
    await createInvestmentSplit({
      transactionId: tx.id,
      securityId: security.id,
      accountId: investment.id,
      action: "buy",
      sharesMicros: 5_000_000, // 5 shares at original price
      priceMicros: 2_000_000,
    });

    const res = await PUT(
      putBody(tx.id, {
        investmentSplits: [
          {
            securityId: security.id,
            action: "buy",
            sharesMicros: 10_000_000, // corrected to 10 shares
            priceMicros: 1_000_000,
            feesCents: 0,
          },
        ],
      }),
      rp(tx.id)
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.investmentSplits).toHaveLength(1);
    expect(body.investmentSplits[0].sharesMicros).toBe(10_000_000);
  });

  // "rejects investment lots from another book" was removed along with
  // InvestmentSplitInput.lotId: lot assignment is no longer client-supplied
  // input, it's derived entirely by the FIFO replay engine in
  // lib/lots-db.ts. See tests/lib/lots-db.test.ts and
  // tests/lib/transactions-lots.test.ts for the replacement coverage.

  it("clears investment splits when an empty array is provided", async () => {
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

    const tx = await createTransactionWithSplits({
      date: "2025-01-10",
      splits: [
        { accountId: investment.id, amount: 10000 },
        { accountId: cash.id, amount: -10000 },
      ],
    });
    await createInvestmentSplit({
      transactionId: tx.id,
      securityId: security.id,
      accountId: investment.id,
      action: "buy",
      sharesMicros: 10_000_000,
      priceMicros: 1_000_000,
    });

    const res = await PUT(putBody(tx.id, { investmentSplits: [] }), rp(tx.id));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.investmentSplits).toHaveLength(0);
  });
});
