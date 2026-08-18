import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { GET } from "@/app/api/b/[bookId]/reports/realized-gains/route";
import {
  createAccount,
  createSecurity,
  resetTestDatabase,
  setupTestDatabase,
} from "@/tests/helpers/db";
import { db } from "@/tests/helpers/db-utils";
import { createTransaction } from "@/lib/transactions";

vi.mock("@/lib/api-auth", async () => {
  const { mockApiAuth } = await import("@/tests/helpers/db");
  return mockApiAuth();
});

const M = 1_000_000;
// mockApiAuth always resolves bookId: 1 regardless of the URL, and
// resetTestDatabase() re-inserts a book with id 1 on every reset — so fixtures
// use the default bookId (1) rather than creating a new book.
const BOOK_ID = 1;

describe("GET /api/b/[bookId]/reports/realized-gains", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  async function seedSale() {
    const brokerage = await createAccount({ name: "Brokerage", type: "asset", subtype: "investment" });
    const cash = await createAccount({ name: "Cash", type: "asset", subtype: "bank" });
    const security = await createSecurity({ name: "Vanguard Total", symbol: "VTI", securityType: "etf" });

    await createTransaction(db, BOOK_ID, {
      date: "2022-01-01",
      description: "buy VTI",
      splits: [
        { accountId: brokerage.id, amount: 100_000 },
        { accountId: cash.id, amount: -100_000 },
      ],
      investmentSplits: [
        { securityId: security.id, action: "buy", sharesMicros: 100 * M, priceMicros: 10 * M, feesCents: 0 },
      ],
    });
    await createTransaction(db, BOOK_ID, {
      date: "2024-09-01",
      description: "sell VTI",
      splits: [
        { accountId: brokerage.id, amount: -300_000 },
        { accountId: cash.id, amount: 300_000 },
      ],
      investmentSplits: [
        { securityId: security.id, action: "sell", sharesMicros: 100 * M, priceMicros: 30 * M, feesCents: 0 },
      ],
    });

    return { brokerage };
  }

  it("returns realized gain rows and totals for the book", async () => {
    await seedSale();

    const response = await GET(
      new Request("http://localhost/api/b/1/reports/realized-gains"),
      { params: Promise.resolve({ bookId: "1" }) }
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.rows).toHaveLength(1);
    expect(payload.rows[0]).toMatchObject({
      term: "long",
      sharesMicros: 100 * M,
      basisCents: 100_000,
    });
    expect(payload.totals.proceedsCents).toBe(300_000);
    expect(payload.totals.unknownBasisRows).toBe(0);
  });

  it("filters by startDate/endDate", async () => {
    await seedSale();

    const response = await GET(
      new Request(
        "http://localhost/api/b/1/reports/realized-gains?startDate=2020-01-01&endDate=2020-12-31"
      ),
      { params: Promise.resolve({ bookId: "1" }) }
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.rows).toHaveLength(0);
  });

  it("returns 400 when only startDate is supplied", async () => {
    const response = await GET(
      new Request("http://localhost/api/b/1/reports/realized-gains?startDate=2024-01-01"),
      { params: Promise.resolve({ bookId: "1" }) }
    );
    expect(response.status).toBe(400);
  });

  it("returns 400 when only endDate is supplied", async () => {
    const response = await GET(
      new Request("http://localhost/api/b/1/reports/realized-gains?endDate=2024-01-01"),
      { params: Promise.resolve({ bookId: "1" }) }
    );
    expect(response.status).toBe(400);
  });

  it("returns 400 for a non-numeric accountId", async () => {
    const response = await GET(
      new Request("http://localhost/api/b/1/reports/realized-gains?accountId=abc"),
      { params: Promise.resolve({ bookId: "1" }) }
    );
    expect(response.status).toBe(400);
  });

  it("returns 400 for a non-positive accountId", async () => {
    const response = await GET(
      new Request("http://localhost/api/b/1/reports/realized-gains?accountId=0"),
      { params: Promise.resolve({ bookId: "1" }) }
    );
    expect(response.status).toBe(400);
  });

  it("filters by accountId", async () => {
    const { brokerage } = await seedSale();
    const otherAccount = await createAccount({ name: "Other", type: "asset", subtype: "investment" });

    const matching = await GET(
      new Request(`http://localhost/api/b/1/reports/realized-gains?accountId=${brokerage.id}`),
      { params: Promise.resolve({ bookId: "1" }) }
    );
    const matchingPayload = await matching.json();
    expect(matchingPayload.rows).toHaveLength(1);

    const nonMatching = await GET(
      new Request(`http://localhost/api/b/1/reports/realized-gains?accountId=${otherAccount.id}`),
      { params: Promise.resolve({ bookId: "1" }) }
    );
    const nonMatchingPayload = await nonMatching.json();
    expect(nonMatchingPayload.rows).toHaveLength(0);
  });
});
