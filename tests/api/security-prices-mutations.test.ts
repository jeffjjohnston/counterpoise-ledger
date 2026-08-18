import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { securityPrices } from "@/db/schema";
import { POST as postBulkPrices } from "@/app/api/b/[bookId]/security-prices/bulk/route";
import { POST as postTiingoPrices } from "@/app/api/b/[bookId]/security-prices/tiingo/route";
import {
  createSecurity,
  createSecurityPrice,
  resetTestDatabase,
  setupTestDatabase,
} from "@/tests/helpers/db";
import { authenticateBookRequest } from "@/lib/api-auth";

vi.mock("@/lib/api-auth", async () => {
  const { mockApiAuth } = await import("@/tests/helpers/db");
  return mockApiAuth();
});

const db = getDb();
const ORIGINAL_ENV = { ...process.env };

function getParams(bookId = "1") {
  return { params: Promise.resolve({ bookId }) };
}

function postJson(url: string, body: object) {
  return new Request(`http://localhost${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  await setupTestDatabase();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await resetTestDatabase();
  process.env = { ...ORIGINAL_ENV };
});

describe("POST /api/b/[bookId]/security-prices/bulk", () => {
  it("returns the auth error response when authentication fails", async () => {
    vi.mocked(authenticateBookRequest).mockResolvedValueOnce({
      error: Response.json({ error: "Unauthorized" }, { status: 401 }),
    } as never);

    const res = await postBulkPrices(
      postJson("/api/security-prices/bulk", { priceUpdates: [] }),
      getParams()
    );

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("returns 400 when priceUpdates is not an array", async () => {
    const res = await postBulkPrices(
      postJson("/api/security-prices/bulk", { priceUpdates: null }),
      getParams()
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: "priceUpdates must be an array",
    });
  });

  it("returns 400 when every update is invalid", async () => {
    const res = await postBulkPrices(
      postJson("/api/security-prices/bulk", {
        priceUpdates: [
          { securityId: 1, priceMicros: null, priceDate: "2025-01-01" },
          { securityId: 1, priceMicros: 0, priceDate: "2025-01-02" },
        ],
      }),
      getParams()
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: "No valid price updates provided",
    });
  });

  it("inserts new prices and updates existing ones", async () => {
    const security = await createSecurity({
      name: "Acme Corp",
      symbol: "ACME",
      securityType: "stock",
    });

    await createSecurityPrice({
      securityId: security.id,
      priceDate: "2025-01-01",
      priceMicros: 10_000_000,
      source: "manual",
    });

    const res = await postBulkPrices(
      postJson("/api/security-prices/bulk", {
        priceUpdates: [
          {
            securityId: security.id,
            priceMicros: 11_500_000,
            priceDate: "2025-01-01",
          },
          {
            securityId: security.id,
            priceMicros: 12_250_000,
            priceDate: "2025-01-02",
          },
        ],
      }),
      getParams()
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      message: "Successfully updated 2 price(s)",
      count: 2,
    });

    const persisted = await db.select().from(securityPrices);
    expect(persisted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          securityId: security.id,
          priceDate: "2025-01-01",
          priceMicros: 11_500_000,
        }),
        expect.objectContaining({
          securityId: security.id,
          priceDate: "2025-01-02",
          priceMicros: 12_250_000,
          source: "manual",
        }),
      ])
    );
  });
});

describe("POST /api/b/[bookId]/security-prices/tiingo", () => {
  it("returns the auth error response when authentication fails", async () => {
    vi.mocked(authenticateBookRequest).mockResolvedValueOnce({
      error: Response.json({ error: "Unauthorized" }, { status: 401 }),
    } as never);

    const res = await postTiingoPrices(
      postJson("/api/security-prices/tiingo", { symbols: ["ACME"] }),
      getParams()
    );

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("returns 500 when TIINGO_API_KEY is missing", async () => {
    delete process.env.TIINGO_API_KEY;

    const res = await postTiingoPrices(
      postJson("/api/security-prices/tiingo", { symbols: ["ACME"] }),
      getParams()
    );

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({
      error: "TIINGO_API_KEY environment variable not configured",
    });
  });

  it("returns 400 for an empty symbols array", async () => {
    process.env.TIINGO_API_KEY = "test-key";

    const res = await postTiingoPrices(
      postJson("/api/security-prices/tiingo", { symbols: [] }),
      getParams()
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: "symbols must be a non-empty array",
    });
  });

  it("returns successful prices alongside per-symbol errors", async () => {
    process.env.TIINGO_API_KEY = "test-key";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/ACME/prices")) {
        return {
          ok: true,
          json: async () => [
            {
              ticker: "ACME",
              date: "2025-01-02T00:00:00.000Z",
              close: 11,
              adjClose: 11.25,
            },
          ],
        } as Response;
      }

      return {
        ok: false,
        statusText: "Not Found",
      } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await postTiingoPrices(
      postJson("/api/security-prices/tiingo", { symbols: ["ACME", "MISS"] }),
      getParams()
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      prices: [
        {
          symbol: "ACME",
          price: 11.25,
          date: "2025-01-02",
        },
      ],
      errors: [
        {
          symbol: "MISS",
          error: "Failed to fetch price for MISS: Not Found",
        },
      ],
    });
  });
});
