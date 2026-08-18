import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

vi.mock("@/lib/tiingo", () => ({
  isTiingoConfigured: vi.fn(),
  fetchLatestTiingoPrices: vi.fn(),
}));

import { GET } from "@/app/api/cron/price-sync/route";
import { fetchLatestTiingoPrices, isTiingoConfigured } from "@/lib/tiingo";
import {
  createBook,
  createSecurity,
  createSecurityPrice,
  resetTestDatabase,
  setupTestDatabase,
} from "@/tests/helpers/db";
import { db } from "@/tests/helpers/db-utils";
import { securityPrices } from "@/db/schema";

const originalCronSecret = process.env.CRON_SECRET;

function authedRequest() {
  return new Request("http://localhost/api/cron/price-sync", {
    headers: { authorization: "Bearer test-secret" },
  });
}

beforeAll(async () => {
  await setupTestDatabase();
});

beforeEach(async () => {
  vi.resetAllMocks();
  process.env.CRON_SECRET = "test-secret";
  vi.mocked(isTiingoConfigured).mockReturnValue(true);
  await resetTestDatabase();
});

afterEach(() => {
  if (originalCronSecret === undefined) {
    delete process.env.CRON_SECRET;
  } else {
    process.env.CRON_SECRET = originalCronSecret;
  }
});

describe("GET /api/cron/price-sync", () => {
  it("returns 401 without valid auth header", async () => {
    const response = await GET(new Request("http://localhost/api/cron/price-sync"));
    expect(response.status).toBe(401);
  });

  it("returns 401 with wrong auth header", async () => {
    const response = await GET(
      new Request("http://localhost/api/cron/price-sync", {
        headers: { authorization: "Bearer wrong" },
      })
    );
    expect(response.status).toBe(401);
  });

  it("returns 200 with skip message when Tiingo is not configured", async () => {
    vi.mocked(isTiingoConfigured).mockReturnValue(false);
    const response = await GET(authedRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.skipped).toBe(true);
    expect(fetchLatestTiingoPrices).not.toHaveBeenCalled();
  });

  it("inserts fetched prices for fetchPrices securities only", async () => {
    const vti = await createSecurity({
      name: "Vanguard Total Stock Market ETF",
      symbol: "VTI",
      securityType: "etf",
    });
    await createSecurity({
      name: "SPY Jun 2026 Call",
      symbol: "SPY260630C",
      securityType: "stock",
      fetchPrices: false,
    });
    vi.mocked(fetchLatestTiingoPrices).mockResolvedValue({
      prices: [{ symbol: "VTI", price: 299.123456, date: "2026-07-02" }],
      errors: [],
    });

    const response = await GET(authedRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.securitiesFound).toBe(1);
    expect(body.pricesInserted).toBe(1);
    expect(body.pricesSkipped).toBe(0);

    expect(fetchLatestTiingoPrices).toHaveBeenCalledTimes(1);
    expect(fetchLatestTiingoPrices).toHaveBeenCalledWith(["VTI"]);

    const rows = await db.select().from(securityPrices);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      securityId: vti.id,
      bookId: 1,
      priceDate: "2026-07-02",
      priceMicros: 299123456,
      source: "tiingo",
    });
  });

  it("does not overwrite an existing price for the same security and date", async () => {
    const vti = await createSecurity({
      name: "Vanguard Total Stock Market ETF",
      symbol: "VTI",
      securityType: "etf",
    });
    await createSecurityPrice({
      securityId: vti.id,
      priceDate: "2026-07-02",
      priceMicros: 100_000_000,
      source: "manual",
    });
    vi.mocked(fetchLatestTiingoPrices).mockResolvedValue({
      prices: [{ symbol: "VTI", price: 299.123456, date: "2026-07-02" }],
      errors: [],
    });

    const response = await GET(authedRequest());
    const body = await response.json();
    expect(body.pricesInserted).toBe(0);
    expect(body.pricesSkipped).toBe(1);

    const [row] = await db
      .select()
      .from(securityPrices)
      .where(
        and(
          eq(securityPrices.securityId, vti.id),
          eq(securityPrices.priceDate, "2026-07-02")
        )
      );
    expect(row.priceMicros).toBe(100_000_000);
    expect(row.source).toBe("manual");
  });

  it("fetches each symbol once across books, case-insensitively", async () => {
    const book2 = await createBook({ name: "Second Book" });
    const s1 = await createSecurity({
      name: "Vanguard Total Stock Market ETF",
      symbol: "VTI",
      securityType: "etf",
    });
    const s2 = await createSecurity({
      name: "Vanguard Total Stock Market ETF",
      symbol: "vti",
      securityType: "etf",
      bookId: book2.id,
    });
    vi.mocked(fetchLatestTiingoPrices).mockResolvedValue({
      prices: [{ symbol: "VTI", price: 100, date: "2026-07-02" }],
      errors: [],
    });

    const response = await GET(authedRequest());
    const body = await response.json();
    expect(fetchLatestTiingoPrices).toHaveBeenCalledWith(["VTI"]);
    expect(body.pricesInserted).toBe(2);

    const rows = await db.select().from(securityPrices);
    expect(rows.map((r) => r.securityId).sort()).toEqual([s1.id, s2.id].sort());
    expect(rows.map((r) => r.bookId).sort()).toEqual([1, book2.id].sort());
  });

  it("reports per-symbol fetch errors in the response", async () => {
    await createSecurity({
      name: "Delisted Corp",
      symbol: "GONE",
      securityType: "stock",
    });
    vi.mocked(fetchLatestTiingoPrices).mockResolvedValue({
      prices: [],
      errors: [{ symbol: "GONE", error: "No price data available for GONE" }],
    });

    const response = await GET(authedRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.pricesInserted).toBe(0);
    expect(body.errors).toEqual([
      { symbol: "GONE", error: "No price data available for GONE" },
    ]);
  });

  it("never fetches a fixed-price security, even if fetchPrices was left on", async () => {
    // Creating a security through the API forces fetchPrices off alongside a
    // fixed price, so this row (written straight to the table) is the state the
    // two flags can only reach by disagreeing. Tiingo has no feed for a money
    // market fund's fixed NAV, so the cron must not ask for one.
    await createSecurity({
      name: "Vanguard Federal Money Market",
      symbol: "VMFXX",
      securityType: "mutual_fund",
      fetchPrices: true,
      fixedPriceMicros: 1_000_000,
    });
    await createSecurity({ name: "VTI", symbol: "VTI", securityType: "etf" });
    vi.mocked(fetchLatestTiingoPrices).mockResolvedValue({
      prices: [{ symbol: "VTI", price: 299.12, date: "2026-07-02" }],
      errors: [],
    });

    const response = await GET(authedRequest());
    const body = await response.json();

    expect(fetchLatestTiingoPrices).toHaveBeenCalledWith(["VTI"]);
    expect(body.securitiesFound).toBe(1);
  });
});
