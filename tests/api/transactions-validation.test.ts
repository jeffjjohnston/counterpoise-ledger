import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/api/b/[bookId]/transactions/route";
import { PUT } from "@/app/api/b/[bookId]/transactions/[id]/route";
import {
  createAccount,
  createSecurity,
  createTransactionWithSplits,
  resetTestDatabase,
  setupTestDatabase,
} from "@/tests/helpers/db";

vi.mock("@/lib/api-auth", async () => {
  const { mockApiAuth } = await import("@/tests/helpers/db");
  return mockApiAuth();
});

function rp() {
  return { params: Promise.resolve({ bookId: "1" }) };
}

function idRp(id: number) {
  return { params: Promise.resolve({ bookId: "1", id: String(id) }) };
}

function postBody(body: object) {
  return new Request("http://localhost/api/b/1/transactions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function putBody(id: number, body: object) {
  return new Request(`http://localhost/api/b/1/transactions/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Regression guards for the createTransactionBodySchema /
// updateTransactionBodySchema / listTransactionsQuery wiring. If a future edit
// hands a route raw, unparsed input again, these are the tests that catch it.

describe("POST /api/b/[bookId]/transactions schema wiring", () => {
  beforeAll(async () => { await setupTestDatabase(); });
  beforeEach(async () => { await resetTestDatabase(); });

  it("rejects an impossible date that the old regex accepted", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const expense = await createAccount({ name: "Groceries", type: "expense" });

    const res = await POST(
      postBody({
        date: "2026-13-45",
        splits: [
          { accountId: checking.id, amount: -1000 },
          { accountId: expense.id, amount: 1000 },
        ],
      }),
      rp()
    );

    // The guard this replaces matched /^\d{4}-\d{2}-\d{2}$/, which "2026-13-45"
    // satisfies — it was stored, then fed to lot ordering and holding-term
    // classification as if it were a real date.
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Date must be in YYYY-MM-DD format");
  });

  it("rejects an unknown investment split action with 400, not a silent write", async () => {
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
            action: "banana",
            sharesMicros: 10_000_000,
            priceMicros: 5_000_000,
          },
        ],
      }),
      rp()
    );

    // investment_splits.action is a plain `text` column with no CHECK
    // constraint, so this used to be persisted verbatim.
    expect(res.status).toBe(400);
  });

  it("still runs the book-scoped security check, which no schema can express", async () => {
    // The shape guards moved into zod; the business rules did not.
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
          { accountId: investment.id, amount: 50000 },
          { accountId: cash.id, amount: -50000 },
        ],
        investmentSplits: [
          {
            securityId: 99999,
            action: "buy",
            sharesMicros: 10_000_000,
            priceMicros: 5_000_000,
          },
        ],
      }),
      rp()
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/do not belong to this book/);
  });
});

describe("PUT /api/b/[bookId]/transactions/[id] schema wiring", () => {
  beforeAll(async () => { await setupTestDatabase(); });
  beforeEach(async () => { await resetTestDatabase(); });

  it("rejects an impossible date that the old regex accepted", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const expense = await createAccount({ name: "Groceries", type: "expense" });
    const tx = await createTransactionWithSplits({
      date: "2025-01-01",
      splits: [
        { accountId: checking.id, amount: -500 },
        { accountId: expense.id, amount: 500 },
      ],
    });

    const res = await PUT(putBody(tx.id, { date: "2026-13-45" }), idRp(tx.id));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Date must be in YYYY-MM-DD format");
  });

  it("still accepts the single-field reconcile body the transactions page sends", async () => {
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
      putBody(tx.id, { isReconciled: true, isFloating: false, date: "2025-01-05" }),
      idRp(tx.id)
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.isReconciled).toBe(true);
    expect(body.date).toBe("2025-01-05");
  });
});

describe("GET /api/b/[bookId]/transactions schema wiring", () => {
  beforeAll(async () => { await setupTestDatabase(); });
  beforeEach(async () => { await resetTestDatabase(); });

  it("rejects a malformed startDate instead of handing it to SQL", async () => {
    const res = await GET(
      new Request("http://localhost/api/b/1/transactions?startDate=not-a-date"),
      rp()
    );

    // Previously this reached the query builder and came back as a 500.
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid ISO date");
  });

  it("rejects an empty accountId rather than filtering by account 0", async () => {
    const res = await GET(
      new Request("http://localhost/api/b/1/transactions?accountId="),
      rp()
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid accountId");
  });

  it("still treats limit=0 as 'return everything'", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const expense = await createAccount({ name: "Groceries", type: "expense" });
    for (const day of ["01", "02", "03"]) {
      await createTransactionWithSplits({
        date: `2025-01-${day}`,
        splits: [
          { accountId: checking.id, amount: -100 },
          { accountId: expense.id, amount: 100 },
        ],
      });
    }

    const res = await GET(
      new Request(`http://localhost/api/b/1/transactions?accountId=${checking.id}&limit=0`),
      rp()
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toHaveLength(3);
  });
});
