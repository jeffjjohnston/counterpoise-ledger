import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { POST as POSTSecurities } from "@/app/api/b/[bookId]/securities/route";
import { PUT as PUTSecurity } from "@/app/api/b/[bookId]/securities/[id]/route";
import { GET as GETPrices } from "@/app/api/b/[bookId]/securities/[id]/prices/route";
import { GET as GETSplits } from "@/app/api/b/[bookId]/securities/[id]/splits/route";
import { PUT as PUTSecurityPrice } from "@/app/api/b/[bookId]/securities/[id]/prices/[date]/route";
import { POST as POSTBulkPrices } from "@/app/api/b/[bookId]/security-prices/bulk/route";
import { POST as POSTTiingo } from "@/app/api/b/[bookId]/security-prices/tiingo/route";
import {
  createSecurity,
  createSecurityPrice,
  resetTestDatabase,
  setupTestDatabase,
} from "@/tests/helpers/db";
import { db } from "@/tests/helpers/db-utils";
import { securityPrices } from "@/db/schema";

vi.mock("@/lib/api-auth", async () => {
  const { mockApiAuth } = await import("@/tests/helpers/db");
  return mockApiAuth();
});

function rp() {
  return { params: Promise.resolve({ bookId: "1" }) };
}
function rpId(id: string | number) {
  return { params: Promise.resolve({ bookId: "1", id: String(id) }) };
}
function rpDate(id: string | number, date: string) {
  return { params: Promise.resolve({ bookId: "1", id: String(id), date }) };
}

function jsonRequest(method: string, url: string, body: unknown) {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Regression guards for the createSecuritySchema / updateSecuritySchema /
// securityPriceListQuery / securitySplitListQuery / updateSecurityPriceSchema
// / bulkPricesSchema / tiingoFetchSchema wiring across all seven routes. If a
// future edit hands a route raw, unparsed input again, these are the tests
// that catch it.

describe("POST /api/b/[bookId]/securities schema wiring", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("rejects an unknown securityType with 400, not a silent write", async () => {
    // securities.security_type is a plain `text` column with no CHECK
    // constraint (Drizzle's `{ enum: [...] }` is TypeScript-only — see
    // CLAUDE.md), so this used to be silently persisted.
    const res = await POSTSecurities(
      jsonRequest("POST", "http://localhost/api/b/1/securities", {
        name: "Acme Corp",
        symbol: "ACME",
        securityType: "bond",
      }),
      rp()
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(
      "securityType must be one of: etf, mutual_fund, stock"
    );
  });
});

describe("PUT /api/b/[bookId]/securities/[id] schema wiring", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("rejects an unknown securityType with 400, not a silent write", async () => {
    // PUT never validated securityType at all before this task — any string
    // was persisted uncomplaining.
    const security = await createSecurity({
      name: "Acme Corp",
      symbol: "ACME",
      securityType: "stock",
    });

    const res = await PUTSecurity(
      jsonRequest(
        "PUT",
        `http://localhost/api/b/1/securities/${security.id}`,
        { securityType: "bond" }
      ),
      rpId(security.id)
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(
      "securityType must be one of: etf, mutual_fund, stock"
    );
  });
});

describe("GET /api/b/[bookId]/securities/[id]/prices schema wiring", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("falls back to the default limit instead of 400ing on a non-numeric value", async () => {
    const security = await createSecurity({
      name: "Acme Corp",
      symbol: "ACME",
      securityType: "stock",
    });

    const res = await GETPrices(
      new Request(
        `http://localhost/api/b/1/securities/${security.id}/prices?limit=abc`
      ),
      rpId(security.id)
    );

    expect(res.status).toBe(200);
  });
});

describe("GET /api/b/[bookId]/securities/[id]/splits schema wiring", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("falls back to the default offset instead of 400ing on a negative value", async () => {
    const security = await createSecurity({
      name: "Acme Corp",
      symbol: "ACME",
      securityType: "stock",
    });

    const res = await GETSplits(
      new Request(
        `http://localhost/api/b/1/securities/${security.id}/splits?offset=-5`
      ),
      rpId(security.id)
    );

    expect(res.status).toBe(200);
  });
});

describe("PUT /api/b/[bookId]/securities/[id]/prices/[date] schema wiring", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("rejects a missing priceDate with the ported message", async () => {
    const security = await createSecurity({
      name: "Acme Corp",
      symbol: "ACME",
      securityType: "stock",
    });

    const res = await PUTSecurityPrice(
      jsonRequest(
        "PUT",
        `http://localhost/api/b/1/securities/${security.id}/prices/2025-01-15`,
        { priceMicros: 5_000_000 }
      ),
      rpDate(security.id, "2025-01-15")
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("priceDate is required");
  });

  it("rejects a non-calendar priceDate ('banana') with 400 instead of deleting the real price and writing a bogus one", async () => {
    // This route deletes the
    // (security, date) row named in the URL and inserts a new one keyed on
    // the body's priceDate whenever the two differ. Before z.iso.date(),
    // "banana" passed shape validation, so the real 2025-01-15 price was
    // deleted and a bogus "banana"-dated row took its place — and because
    // getPositions()/getMarketValuesByAccount() pick "latest price" by plain
    // string comparison (lib/investments.ts), "banana" sorts above every
    // real "20xx-…" date and would win as the security's market price.
    const security = await createSecurity({
      name: "Acme Corp",
      symbol: "ACME",
      securityType: "stock",
    });
    await createSecurityPrice({
      securityId: security.id,
      priceDate: "2025-01-15",
      priceMicros: 5_000_000,
    });

    const res = await PUTSecurityPrice(
      jsonRequest(
        "PUT",
        `http://localhost/api/b/1/securities/${security.id}/prices/2025-01-15`,
        { priceDate: "banana", priceMicros: 1 }
      ),
      rpDate(security.id, "2025-01-15")
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("priceDate is required");

    const rows = await db
      .select()
      .from(securityPrices)
      .where(eq(securityPrices.securityId, security.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].priceDate).toBe("2025-01-15");
    expect(rows[0].priceMicros).toBe(5_000_000);
    expect(
      rows.some((row) => row.priceDate === "banana")
    ).toBe(false);
  });
});

describe("POST /api/b/[bookId]/security-prices/bulk schema wiring", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("drops a calendar-invalid date instead of writing it, and 400s if nothing survives", async () => {
    const res = await POSTBulkPrices(
      jsonRequest("POST", "http://localhost/api/b/1/security-prices/bulk", {
        priceUpdates: [{ securityId: 1, priceMicros: 100, priceDate: "2026-02-30" }],
      }),
      rp()
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("No valid price updates provided");
  });
});

describe("POST /api/b/[bookId]/security-prices/tiingo schema wiring", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("rejects a non-array symbols with 400 instead of throwing downstream", async () => {
    process.env.TIINGO_API_KEY = "test-key";
    const res = await POSTTiingo(
      jsonRequest("POST", "http://localhost/api/b/1/security-prices/tiingo", {
        symbols: "ACME",
      }),
      rp()
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("symbols must be a non-empty array");
  });
});
