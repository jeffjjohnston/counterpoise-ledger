import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { GET, POST } from "@/app/api/b/[bookId]/payees/route";
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

describe("GET /api/payees", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("filters payees by search query", async () => {
    await createPayee({ name: "Blue Bottle" });
    await createPayee({ name: "Whole Foods" });

    const response = await GET(
      new Request("http://localhost/api/payees?search=Blue"),
      { params: Promise.resolve({ bookId: "1" }) }
    );
    const payload = await response.json();

    expect(payload).toHaveLength(1);
    expect(payload[0].name).toBe("Blue Bottle");
  });

  it("returns transaction count and last transaction date for each payee", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const coffee = await createAccount({ name: "Coffee", type: "expense" });

    const blueBottle = await createPayee({ name: "Blue Bottle" });
    const cityUtilities = await createPayee({ name: "City Utilities" });
    const unusedPayee = await createPayee({ name: "Unused Payee" });

    await createTransactionWithSplits({
      date: "2024-01-01",
      description: "Latte",
      payeeId: blueBottle.id,
      splits: [
        { accountId: coffee.id, amount: 450 },
        { accountId: checking.id, amount: -450 },
      ],
    });

    await createTransactionWithSplits({
      date: "2024-03-05",
      description: "Coffee beans",
      payeeId: blueBottle.id,
      splits: [
        { accountId: coffee.id, amount: 1500 },
        { accountId: checking.id, amount: -1500 },
      ],
    });

    await createTransactionWithSplits({
      date: "2024-02-10",
      description: "Power bill",
      payeeId: cityUtilities.id,
      splits: [
        { accountId: coffee.id, amount: 2000 },
        { accountId: checking.id, amount: -2000 },
      ],
    });

    const response = await GET(
      new Request("http://localhost/api/payees"),
      { params: Promise.resolve({ bookId: "1" }) }
    );
    const payload = await response.json();

    const blueBottleSummary = payload.find((payee: { id: number }) => payee.id === blueBottle.id);
    expect(blueBottleSummary.transactionCount).toBe(2);
    expect(blueBottleSummary.lastTransactionDate).toBe("2024-03-05");

    const cityUtilitiesSummary = payload.find(
      (payee: { id: number }) => payee.id === cityUtilities.id
    );
    expect(cityUtilitiesSummary.transactionCount).toBe(1);
    expect(cityUtilitiesSummary.lastTransactionDate).toBe("2024-02-10");

    const unusedPayeeSummary = payload.find((payee: { id: number }) => payee.id === unusedPayee.id);
    expect(unusedPayeeSummary.transactionCount).toBe(0);
    expect(unusedPayeeSummary.lastTransactionDate).toBeNull();
  });
});

describe("POST /api/payees", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("creates a new payee and returns it", async () => {
    const response = await POST(
      new Request("http://localhost/api/payees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Blue Bottle" }),
      }),
      { params: Promise.resolve({ bookId: "1" }) }
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.name).toBe("Blue Bottle");
    expect(payload.id).toBeDefined();
  });

  it("returns existing payee for duplicate name (case-insensitive)", async () => {
    const existing = await createPayee({ name: "Blue Bottle" });

    const response = await POST(
      new Request("http://localhost/api/payees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "blue bottle" }),
      }),
      { params: Promise.resolve({ bookId: "1" }) }
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.id).toBe(existing.id);
  });

  it("normalizes whitespace in payee name", async () => {
    const response = await POST(
      new Request("http://localhost/api/payees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "  Blue   Bottle  " }),
      }),
      { params: Promise.resolve({ bookId: "1" }) }
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.name).toBe("Blue Bottle");
  });

  it("returns 400 when name is missing", async () => {
    const response = await POST(
      new Request("http://localhost/api/payees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
      { params: Promise.resolve({ bookId: "1" }) }
    );

    expect(response.status).toBe(400);
  });

  it("returns 400 when name is empty string", async () => {
    const response = await POST(
      new Request("http://localhost/api/payees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "   " }),
      }),
      { params: Promise.resolve({ bookId: "1" }) }
    );

    expect(response.status).toBe(400);
  });
});
