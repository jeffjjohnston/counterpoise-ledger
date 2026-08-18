import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { db } from "@/tests/helpers/db-utils";
import {
  setupTestDatabase, resetTestDatabase, createAccount, createSecurity,
} from "@/tests/helpers/db";
import { createTransaction } from "@/lib/transactions";

vi.mock("@/lib/api-auth", async () => {
  const { mockApiAuth } = await import("@/tests/helpers/db");
  return mockApiAuth();
});

const M = 1_000_000;

describe("GET /api/b/[bookId]/securities/[id]/lots", () => {
  beforeAll(async () => { await setupTestDatabase(); });
  beforeEach(async () => { await resetTestDatabase(); });

  it("returns only open lots, newest acquisition last", async () => {
    const { GET } = await import("@/app/api/b/[bookId]/securities/[id]/lots/route");

    // resetTestDatabase always re-inserts book id 1, and mockApiAuth resolves to
    // that same book — so this test must use it rather than creating its own.
    const book = { id: 1 };
    const brokerage = await createAccount({
      name: "Brokerage", type: "asset", subtype: "investment", bookId: book.id,
    });
    const cash = await createAccount({ name: "Cash", type: "asset", subtype: "bank", bookId: book.id });
    const security = await createSecurity({ name: "VTI", symbol: "VTI", securityType: "etf", bookId: book.id });

    const trade = (date: string, action: "buy" | "sell", shares: number, price: number) => {
      const amount = Math.round((shares / M) * (price / M) * 100);
      const signed = action === "buy" ? amount : -amount;
      return createTransaction(db, book.id, {
        date, description: `${action} VTI`,
        splits: [
          { accountId: brokerage.id, amount: signed },
          { accountId: cash.id, amount: -signed },
        ],
        investmentSplits: [
          { securityId: security.id, action, sharesMicros: shares, priceMicros: price, feesCents: 0 },
        ],
      });
    };

    await trade("2024-01-01", "buy", 100 * M, 10 * M);
    await trade("2024-02-01", "buy", 50 * M, 20 * M);
    await trade("2024-06-01", "sell", 100 * M, 30 * M); // closes the first lot

    const response = await GET(new Request("http://test/lots"), {
      params: Promise.resolve({ bookId: "1", id: String(security.id) }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      acquiredDate: "2024-02-01",
      sharesMicros: 50 * M,
      basisCents: 100_000,
      accountName: "Brokerage",
    });
  });
});
