import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import {
  setupTestDatabase,
  resetTestDatabase,
  createAccount,
} from "@/tests/helpers/db";
import { transactions, transactionSplits } from "@/db/schema";
import { db } from "@/tests/helpers/db-utils";

vi.mock("@/lib/api-auth", async () => {
  const { mockApiAuth } = await import("@/tests/helpers/db");
  return mockApiAuth();
});

const { POST } = await import("@/app/api/b/[bookId]/transactions/route");
const { PUT } = await import("@/app/api/b/[bookId]/transactions/[id]/route");

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

function putBody(body: object) {
  return new Request("http://localhost/api/transactions/1", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function putParams(id: number) {
  return { params: Promise.resolve({ bookId: "1", id: String(id) }) };
}

// ---------------------------------------------------------------------------
// Transaction create atomicity
// ---------------------------------------------------------------------------

describe("Transaction create atomicity", () => {
  let checking: Awaited<ReturnType<typeof createAccount>>;
  let groceries: Awaited<ReturnType<typeof createAccount>>;

  beforeAll(async () => {
    await setupTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  beforeEach(async () => {
    checking = await createAccount({
      name: "Checking",
      type: "asset",
      subtype: "bank",
    });
    groceries = await createAccount({ name: "Groceries", type: "expense" });
  });

  it("creates transaction and splits atomically on success", async () => {
    const response = await POST(
      postBody({
        date: "2025-01-15",
        description: "Test atomicity",
        splits: [
          { accountId: checking.id, amount: -5000 },
          { accountId: groceries.id, amount: 5000 },
        ],
      }),
      rp()
    );
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.id).toBeDefined();

    const txnRows = await db.select().from(transactions);
    expect(txnRows).toHaveLength(1);

    const splitRows = await db.select().from(transactionSplits);
    expect(splitRows).toHaveLength(2);
  });

  it("leaves no orphaned transaction header if split insert fails", async () => {
    // Count rows before
    const txnCountBefore = (await db.select().from(transactions)).length;
    const splitCountBefore = (await db.select().from(transactionSplits)).length;

    // Use a split referencing a non-existent account (id 999999).
    // With FK enforcement off, this may still succeed. With FK on or
    // db.transaction() wrapping, a failure in splits rolls back the header.
    const response = await POST(
      postBody({
        date: "2025-01-15",
        description: "Should rollback",
        splits: [
          { accountId: checking.id, amount: -5000 },
          { accountId: 999999, amount: 5000 },
        ],
      }),
      rp()
    );

    // Book-scoping validation rejects the unknown account before insert
    expect(response.status).toBe(400);

    const txnCountAfter = (await db.select().from(transactions)).length;
    const splitCountAfter = (await db.select().from(transactionSplits)).length;
    expect(txnCountAfter).toBe(txnCountBefore);
    expect(splitCountAfter).toBe(splitCountBefore);
  });

  it("rolls back all writes when an internal error occurs", async () => {
    // Trigger rollback by including an investment split with a non-existent
    // securityId (999999). With FK enforcement on, this fails after the header
    // and regular splits are written, proving the db.transaction() block rolls
    // back all three inserts atomically.
    const txnCountBefore = (await db.select().from(transactions)).length;
    const investmentAccount = await createAccount({
      name: "Brokerage",
      type: "asset",
      subtype: "investment",
    });
    const cashAccount = await createAccount({
      name: "Brokerage Cash",
      type: "asset",
      subtype: "bank",
      isInvestmentCash: true,
    });

    const response = await POST(
      postBody({
        date: "2025-01-15",
        description: "Should rollback on investment split error",
        splits: [
          { accountId: investmentAccount.id, amount: 5000 },
          { accountId: cashAccount.id, amount: -5000 },
        ],
        investmentSplits: [
          {
            securityId: 999999, // non-existent security
            action: "buy",
            sharesMicros: 100_000_000,
            priceMicros: 50_000_000,
            feesCents: 0,
          },
        ],
      }),
      rp()
    );

    // Validation now catches the foreign security before insert, so no writes land.
    expect(response.status).toBe(400);

    const txnCountAfter = (await db.select().from(transactions)).length;
    expect(txnCountAfter).toBe(txnCountBefore);
  });
});

// ---------------------------------------------------------------------------
// Transaction update atomicity
// ---------------------------------------------------------------------------

describe("Transaction update atomicity", () => {
  let checking: Awaited<ReturnType<typeof createAccount>>;
  let groceries: Awaited<ReturnType<typeof createAccount>>;

  beforeAll(async () => {
    await setupTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  beforeEach(async () => {
    checking = await createAccount({
      name: "Checking",
      type: "asset",
      subtype: "bank",
    });
    groceries = await createAccount({ name: "Groceries", type: "expense" });
  });

  it("rolls back update when new splits reference a non-existent account", async () => {
    // Step 1: Create a valid transaction
    const createRes = await POST(
      postBody({
        date: "2025-01-15",
        description: "Original transaction",
        splits: [
          { accountId: checking.id, amount: -5000 },
          { accountId: groceries.id, amount: 5000 },
        ],
      }),
      rp()
    );
    expect(createRes.status).toBe(200);
    const created = await createRes.json();
    const txnId: number = created.id;

    // Step 2: Try to update with a split referencing non-existent account
    const updateRes = await PUT(
      putBody({
        date: "2025-06-01",
        description: "Updated description",
        splits: [
          { accountId: checking.id, amount: -9999 },
          { accountId: 999999, amount: 9999 }, // non-existent account
        ],
      }),
      putParams(txnId)
    );

    // Step 3: Verify the update fails before any writes occur
    expect(updateRes.status).toBe(400);

    // Step 4: Verify the original transaction is UNCHANGED
    const txnRows = await db.select().from(transactions);
    expect(txnRows).toHaveLength(1);
    expect(txnRows[0].date).toBe("2025-01-15");
    expect(txnRows[0].description).toBe("Original transaction");

    const splitRows = await db
      .select()
      .from(transactionSplits);
    expect(splitRows).toHaveLength(2);
    expect(splitRows.map((s: { amount: number }) => s.amount).sort((a: number, b: number) => a - b)).toEqual([
      -5000, 5000,
    ]);
  });
});
