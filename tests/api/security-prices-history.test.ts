import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/b/[bookId]/securities/[id]/prices/route";
import {
  createSecurity,
  createSecurityPrice,
  resetTestDatabase,
  setupTestDatabase,
} from "@/tests/helpers/db";

vi.mock("@/lib/api-auth", async () => {
  const { mockApiAuth } = await import("@/tests/helpers/db");
  return mockApiAuth();
});

describe("GET /api/securities/:id/prices", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("returns prices newest-first with pagination metadata", async () => {
    const security = await createSecurity({
      name: "Acme Corp",
      symbol: "ACME",
      securityType: "stock",
    });

    await createSecurityPrice({
      securityId: security.id,
      priceDate: "2024-01-10",
      priceMicros: 10_000_000,
      source: "manual",
    });
    await createSecurityPrice({
      securityId: security.id,
      priceDate: "2024-02-10",
      priceMicros: 11_000_000,
      source: "manual",
    });
    await createSecurityPrice({
      securityId: security.id,
      priceDate: "2024-03-10",
      priceMicros: 12_000_000,
      source: "manual",
    });

    const firstPageResponse = await GET(
      new Request(`http://localhost/api/securities/${security.id}/prices?limit=2&offset=0`),
      { params: Promise.resolve({ bookId: "1", id: String(security.id) }) }
    );
    expect(firstPageResponse.status).toBe(200);
    const firstPage = await firstPageResponse.json();

    expect(firstPage.prices).toEqual([
      expect.objectContaining({ priceDate: "2024-03-10", priceMicros: 12_000_000 }),
      expect.objectContaining({ priceDate: "2024-02-10", priceMicros: 11_000_000 }),
    ]);
    expect(firstPage.totalCount).toBe(3);
    expect(firstPage.hasMore).toBe(true);

    const secondPageResponse = await GET(
      new Request(`http://localhost/api/securities/${security.id}/prices?limit=2&offset=2`),
      { params: Promise.resolve({ bookId: "1", id: String(security.id) }) }
    );
    expect(secondPageResponse.status).toBe(200);
    const secondPage = await secondPageResponse.json();

    expect(secondPage.prices).toEqual([
      expect.objectContaining({ priceDate: "2024-01-10", priceMicros: 10_000_000 }),
    ]);
    expect(secondPage.totalCount).toBe(3);
    expect(secondPage.hasMore).toBe(false);
  });
});
