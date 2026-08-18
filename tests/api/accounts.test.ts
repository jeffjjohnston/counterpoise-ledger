import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/api/b/[bookId]/accounts/route";
import {
  GET as GET_SINGLE,
  PUT,
  DELETE,
} from "@/app/api/b/[bookId]/accounts/[id]/route";
import {
  createAccount,
  createBook,
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

function getCollectionParams(bookId = "1") {
  return { params: Promise.resolve({ bookId }) };
}

function getResourceParams(id: string, bookId = "1") {
  return { params: Promise.resolve({ bookId, id }) };
}

function makeRequest(url: string, options?: RequestInit) {
  return new Request(`http://localhost${url}`, options);
}

// ---------------------------------------------------------------------------
// GET /api/b/[bookId]/accounts
// ---------------------------------------------------------------------------

describe("GET /api/b/[bookId]/accounts", () => {
  beforeAll(async () => { await setupTestDatabase(); });
  beforeEach(async () => { await resetTestDatabase(); });

  it("returns an empty array when no accounts exist", async () => {
    const res = await GET(makeRequest("/api/accounts"), getCollectionParams());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });

  it("returns only root accounts (no parentId)", async () => {
    const parent = await createAccount({ name: "Checking", type: "asset" });
    await createAccount({ name: "Savings Sub", type: "asset", parentId: parent.id });

    const res = await GET(makeRequest("/api/accounts"), getCollectionParams());
    const body = await res.json();

    expect(body).toHaveLength(1);
    expect(body[0].name).toBe("Checking");
  });

  it("nests child accounts under their parent", async () => {
    const parent = await createAccount({ name: "Checking", type: "asset" });
    await createAccount({ name: "Sub Account", type: "asset", parentId: parent.id });

    const res = await GET(makeRequest("/api/accounts"), getCollectionParams());
    const body = await res.json();

    expect(body).toHaveLength(1);
    expect(body[0].children).toHaveLength(1);
    expect(body[0].children[0].name).toBe("Sub Account");
  });

  it("returns balance=0 and hasTransactions=false for accounts without splits", async () => {
    await createAccount({ name: "Checking", type: "asset" });

    const res = await GET(makeRequest("/api/accounts"), getCollectionParams());
    const [account] = await res.json();

    expect(account.balance).toBe(0);
    expect(account.hasTransactions).toBe(false);
  });

  it("returns the summed balance of all transaction splits for an account", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const expense = await createAccount({ name: "Groceries", type: "expense" });

    await createTransactionWithSplits({
      date: "2025-01-01",
      splits: [
        { accountId: checking.id, amount: -5000 },
        { accountId: expense.id, amount: 5000 },
      ],
    });
    await createTransactionWithSplits({
      date: "2025-01-15",
      splits: [
        { accountId: checking.id, amount: -3000 },
        { accountId: expense.id, amount: 3000 },
      ],
    });

    const res = await GET(makeRequest("/api/accounts"), getCollectionParams());
    const body = await res.json();

    const checkingResult = body.find((a: { id: number }) => a.id === checking.id);
    expect(checkingResult.balance).toBe(-8000);
    expect(checkingResult.hasTransactions).toBe(true);
  });

  it("filters accounts by type query param", async () => {
    await createAccount({ name: "Checking", type: "asset" });
    await createAccount({ name: "Groceries", type: "expense" });

    const res = await GET(makeRequest("/api/accounts?type=asset"), getCollectionParams());
    const body = await res.json();

    expect(body).toHaveLength(1);
    expect(body[0].name).toBe("Checking");
  });

  it("excludes inactive accounts by default", async () => {
    await createAccount({ name: "Active Account", type: "asset", isActive: true });
    await createAccount({ name: "Closed Account", type: "asset", isActive: false });

    const res = await GET(makeRequest("/api/accounts"), getCollectionParams());
    const body = await res.json();

    expect(body).toHaveLength(1);
    expect(body[0].name).toBe("Active Account");
  });

  it("includes inactive accounts when includeInactive=true", async () => {
    await createAccount({ name: "Active Account", type: "asset", isActive: true });
    await createAccount({ name: "Closed Account", type: "asset", isActive: false });

    const res = await GET(
      makeRequest("/api/accounts?includeInactive=true"),
      getCollectionParams()
    );
    const body = await res.json();

    expect(body).toHaveLength(2);
  });

  it("filters balance by asOfDate — excludes splits from later transactions", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const expense = await createAccount({ name: "Groceries", type: "expense" });

    await createTransactionWithSplits({
      date: "2025-01-01",
      splits: [
        { accountId: checking.id, amount: -1000 },
        { accountId: expense.id, amount: 1000 },
      ],
    });
    await createTransactionWithSplits({
      date: "2025-06-01",
      splits: [
        { accountId: checking.id, amount: -2000 },
        { accountId: expense.id, amount: 2000 },
      ],
    });

    const res = await GET(
      makeRequest("/api/accounts?asOfDate=2025-03-01"),
      getCollectionParams()
    );
    const body = await res.json();

    const checkingResult = body.find((a: { id: number }) => a.id === checking.id);
    expect(checkingResult.balance).toBe(-1000);
  });
});

// ---------------------------------------------------------------------------
// POST /api/b/[bookId]/accounts
// ---------------------------------------------------------------------------

describe("POST /api/b/[bookId]/accounts", () => {
  beforeAll(async () => { await setupTestDatabase(); });
  beforeEach(async () => { await resetTestDatabase(); });

  it("creates a basic account and returns it", async () => {
    const res = await POST(
      makeRequest("/api/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Checking", type: "asset" }),
      }),
      getCollectionParams()
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("Checking");
    expect(body.type).toBe("asset");
    expect(body.balance).toBe(0);
    expect(body.hasTransactions).toBe(false);
    expect(body.children).toEqual([]);
  });

  it("returns 400 when parentId belongs to another book", async () => {
    const otherBook = await createBook({ name: "Other Book" });
    const otherParent = await createAccount({
      name: "Other Parent",
      type: "asset",
      bookId: otherBook.id,
    });

    const res = await POST(
      makeRequest("/api/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Child",
          type: "asset",
          parentId: otherParent.id,
        }),
      }),
      getCollectionParams()
    );

    expect(res.status).toBe(400);
  });

  it("returns 400 when name is missing", async () => {
    const res = await POST(
      makeRequest("/api/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "asset" }),
      }),
      getCollectionParams()
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("returns 400 when type is missing", async () => {
    const res = await POST(
      makeRequest("/api/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Checking" }),
      }),
      getCollectionParams()
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("stores subtype when provided", async () => {
    const res = await POST(
      makeRequest("/api/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Checking", type: "asset", subtype: "bank" }),
      }),
      getCollectionParams()
    );

    const body = await res.json();
    expect(body.subtype).toBe("bank");
  });

  it("stores parentId when provided", async () => {
    const parent = await createAccount({ name: "Expenses", type: "expense" });

    const res = await POST(
      makeRequest("/api/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Dining",
          type: "expense",
          parentId: parent.id,
        }),
      }),
      getCollectionParams()
    );

    const body = await res.json();
    expect(body.parentId).toBe(parent.id);
  });

  it("auto-creates an investment cash account when type=asset subtype=investment", async () => {
    const res = await POST(
      makeRequest("/api/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Brokerage",
          type: "asset",
          subtype: "investment",
        }),
      }),
      getCollectionParams()
    );

    expect(res.status).toBe(200);
    const body = await res.json();

    // Fetch full list to check cash sub-account was created
    const listRes = await GET(
      makeRequest("/api/accounts?includeInactive=true"),
      getCollectionParams()
    );
    const list = await listRes.json();
    const brokerage = list.find((a: { id: number }) => a.id === body.id);
    expect(brokerage.children).toHaveLength(1);
    expect(brokerage.children[0].name).toBe("Brokerage Cash");
    expect(brokerage.children[0].isInvestmentCash).toBe(true);
  });

  it("does not auto-create a cash account for non-investment accounts", async () => {
    const res = await POST(
      makeRequest("/api/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Checking", type: "asset", subtype: "bank" }),
      }),
      getCollectionParams()
    );

    const body = await res.json();
    expect(body.children).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// GET /api/b/[bookId]/accounts/[id]
// ---------------------------------------------------------------------------

describe("GET /api/b/[bookId]/accounts/[id]", () => {
  beforeAll(async () => { await setupTestDatabase(); });
  beforeEach(async () => { await resetTestDatabase(); });

  it("returns the account with balance and hasTransactions", async () => {
    const account = await createAccount({ name: "Checking", type: "asset" });

    const res = await GET_SINGLE(
      makeRequest(`/api/accounts/${account.id}`),
      getResourceParams(String(account.id))
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(account.id);
    expect(body.name).toBe("Checking");
    expect(body.balance).toBe(0);
    expect(body.hasTransactions).toBe(false);
  });

  it("returns 404 for a non-existent account", async () => {
    const res = await GET_SINGLE(
      makeRequest("/api/accounts/9999"),
      getResourceParams("9999")
    );

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("reflects the correct balance from transaction splits", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const expense = await createAccount({ name: "Groceries", type: "expense" });

    await createTransactionWithSplits({
      date: "2025-01-01",
      splits: [
        { accountId: checking.id, amount: 10000 },
        { accountId: expense.id, amount: -10000 },
      ],
    });

    const res = await GET_SINGLE(
      makeRequest(`/api/accounts/${checking.id}`),
      getResourceParams(String(checking.id))
    );
    const body = await res.json();

    expect(body.balance).toBe(10000);
    expect(body.hasTransactions).toBe(true);
  });

  it("returns children nested under the account", async () => {
    const parent = await createAccount({ name: "Expenses", type: "expense" });
    await createAccount({ name: "Dining", type: "expense", parentId: parent.id });

    const res = await GET_SINGLE(
      makeRequest(`/api/accounts/${parent.id}`),
      getResourceParams(String(parent.id))
    );
    const body = await res.json();

    expect(body.children).toHaveLength(1);
    expect(body.children[0].name).toBe("Dining");
  });
});

// ---------------------------------------------------------------------------
// PUT /api/b/[bookId]/accounts/[id]
// ---------------------------------------------------------------------------

describe("PUT /api/b/[bookId]/accounts/[id]", () => {
  beforeAll(async () => { await setupTestDatabase(); });
  beforeEach(async () => { await resetTestDatabase(); });

  it("updates the account name", async () => {
    const account = await createAccount({ name: "Old Name", type: "asset" });

    const res = await PUT(
      makeRequest(`/api/accounts/${account.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "New Name" }),
      }),
      getResourceParams(String(account.id))
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("New Name");
  });

  it("returns 400 when parentId belongs to another book", async () => {
    const account = await createAccount({ name: "Checking", type: "asset" });
    const otherBook = await createBook({ name: "Other Book" });
    const otherParent = await createAccount({
      name: "Other Parent",
      type: "asset",
      bookId: otherBook.id,
    });

    const res = await PUT(
      makeRequest(`/api/accounts/${account.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parentId: otherParent.id }),
      }),
      getResourceParams(String(account.id))
    );

    expect(res.status).toBe(400);
  });

  it("marks an account as inactive", async () => {
    const account = await createAccount({ name: "Checking", type: "asset", isActive: true });

    const res = await PUT(
      makeRequest(`/api/accounts/${account.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: false }),
      }),
      getResourceParams(String(account.id))
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.isActive).toBe(false);
  });

  it("marks an account as a favorite", async () => {
    const account = await createAccount({
      name: "Checking",
      type: "asset",
      isFavorite: false,
    });

    const res = await PUT(
      makeRequest(`/api/accounts/${account.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isFavorite: true }),
      }),
      getResourceParams(String(account.id))
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.isFavorite).toBe(true);
  });

  it("returns 404 for a non-existent account", async () => {
    const res = await PUT(
      makeRequest("/api/accounts/9999", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Ghost" }),
      }),
      getResourceParams("9999")
    );

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("renames the investment cash sub-account when the investment account is renamed", async () => {
    // Create investment account (auto-creates cash sub-account)
    const createRes = await POST(
      makeRequest("/api/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Brokerage", type: "asset", subtype: "investment" }),
      }),
      getCollectionParams()
    );
    const investment = await createRes.json();

    // Rename the investment account
    await PUT(
      makeRequest(`/api/accounts/${investment.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "My Brokerage" }),
      }),
      getResourceParams(String(investment.id))
    );

    // Verify cash sub-account was renamed
    const detailRes = await GET_SINGLE(
      makeRequest(`/api/accounts/${investment.id}`),
      getResourceParams(String(investment.id))
    );
    const detail = await detailRes.json();
    const cashChild = detail.children.find(
      (c: { isInvestmentCash: boolean }) => c.isInvestmentCash
    );
    expect(cashChild?.name).toBe("My Brokerage Cash");
  });

  it("syncs isActive to the investment cash sub-account", async () => {
    const createRes = await POST(
      makeRequest("/api/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Brokerage", type: "asset", subtype: "investment" }),
      }),
      getCollectionParams()
    );
    const investment = await createRes.json();

    await PUT(
      makeRequest(`/api/accounts/${investment.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: false }),
      }),
      getResourceParams(String(investment.id))
    );

    const detailRes = await GET_SINGLE(
      makeRequest(`/api/accounts/${investment.id}`),
      getResourceParams(String(investment.id))
    );
    const detail = await detailRes.json();
    const cashChild = detail.children.find(
      (c: { isInvestmentCash: boolean }) => c.isInvestmentCash
    );
    expect(cashChild?.isActive).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/b/[bookId]/accounts/[id]
// ---------------------------------------------------------------------------

describe("DELETE /api/b/[bookId]/accounts/[id]", () => {
  beforeAll(async () => { await setupTestDatabase(); });
  beforeEach(async () => { await resetTestDatabase(); });

  it("deletes an account and returns success", async () => {
    const account = await createAccount({ name: "Temp Account", type: "expense" });

    const res = await DELETE(
      makeRequest(`/api/accounts/${account.id}`, { method: "DELETE" }),
      getResourceParams(String(account.id))
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it("returns 404 for a non-existent account", async () => {
    const res = await DELETE(
      makeRequest("/api/accounts/9999", { method: "DELETE" }),
      getResourceParams("9999")
    );

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("returns 400 and refuses to delete an account that has transactions", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const expense = await createAccount({ name: "Groceries", type: "expense" });

    await createTransactionWithSplits({
      date: "2025-01-01",
      splits: [
        { accountId: checking.id, amount: -500 },
        { accountId: expense.id, amount: 500 },
      ],
    });

    const res = await DELETE(
      makeRequest(`/api/accounts/${expense.id}`, { method: "DELETE" }),
      getResourceParams(String(expense.id))
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/transaction/i);
  });

  it("returns 400 and refuses to delete an account that has sub-accounts", async () => {
    const parent = await createAccount({ name: "Expenses", type: "expense" });
    await createAccount({ name: "Dining", type: "expense", parentId: parent.id });

    const res = await DELETE(
      makeRequest(`/api/accounts/${parent.id}`, { method: "DELETE" }),
      getResourceParams(String(parent.id))
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/sub-account/i);
  });

  it("the account no longer appears in the list after deletion", async () => {
    const account = await createAccount({ name: "Temp Account", type: "expense" });

    await DELETE(
      makeRequest(`/api/accounts/${account.id}`, { method: "DELETE" }),
      getResourceParams(String(account.id))
    );

    const listRes = await GET(makeRequest("/api/accounts"), getCollectionParams());
    const list = await listRes.json();
    expect(list.find((a: { id: number }) => a.id === account.id)).toBeUndefined();
  });
});
