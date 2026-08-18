import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PUT } from "@/app/api/b/[bookId]/securities/[id]/route";
import {
  createSecurity,
  resetTestDatabase,
  setupTestDatabase,
} from "@/tests/helpers/db";

vi.mock("@/lib/api-auth", async () => {
  const { mockApiAuth } = await import("@/tests/helpers/db");
  return mockApiAuth();
});

describe("PUT /api/securities/:id", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("returns success when updating with existing values", async () => {
    const security = await createSecurity({
      name: "Acme Corp",
      symbol: "ACME",
      securityType: "stock",
    });

    const response = await PUT(
      new Request(`http://localhost/api/securities/${security.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: security.name,
          symbol: security.symbol,
          securityType: security.securityType,
        }),
      }),
      { params: Promise.resolve({ bookId: "1", id: String(security.id) }) }
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toMatchObject({
      id: security.id,
      name: security.name,
      symbol: security.symbol,
      securityType: security.securityType,
    });
  });

  it("sets a fixed price and turns off price fetching", async () => {
    const security = await createSecurity({
      name: "Vanguard Federal Money Market",
      symbol: "VMFXX",
      securityType: "mutual_fund",
    });

    const response = await PUT(
      new Request(`http://localhost/api/securities/${security.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fixedPriceMicros: 1_000_000 }),
      }),
      { params: Promise.resolve({ bookId: "1", id: String(security.id) }) }
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.fixedPriceMicros).toBe(1_000_000);
    expect(payload.fetchPrices).toBe(false);
  });

  it("clears a fixed price when it is set to null", async () => {
    const security = await createSecurity({
      name: "Vanguard Federal Money Market",
      symbol: "VMFXX",
      securityType: "mutual_fund",
      fetchPrices: false,
      fixedPriceMicros: 1_000_000,
    });

    const response = await PUT(
      new Request(`http://localhost/api/securities/${security.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fixedPriceMicros: null }),
      }),
      { params: Promise.resolve({ bookId: "1", id: String(security.id) }) }
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.fixedPriceMicros).toBeNull();
  });
});
