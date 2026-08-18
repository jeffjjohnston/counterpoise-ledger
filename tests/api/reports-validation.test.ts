import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as getReportData } from "@/app/api/b/[bookId]/reports/data/route";
import { GET as getIncomeStatement } from "@/app/api/b/[bookId]/reports/income-statement/route";
import { GET as getRealizedGains } from "@/app/api/b/[bookId]/reports/realized-gains/route";
import { resetTestDatabase, setupTestDatabase } from "@/tests/helpers/db";

vi.mock("@/lib/api-auth", async () => {
  const { mockApiAuth } = await import("@/tests/helpers/db");
  return mockApiAuth();
});

// Regression guards for the reportDataQuery / incomeStatementQuery /
// realizedGainsQuery wiring across all three reports routes. If a future
// edit hands a route raw, unparsed searchParams again, these are the tests
// that catch it.

function rp() {
  return { params: Promise.resolve({ bookId: "1" }) };
}

describe("GET /api/b/[bookId]/reports/data validation", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("returns 200 (no filter, not a coerced accountId 0) when accountIds is omitted", async () => {
    const res = await getReportData(
      new Request("http://localhost/api/b/1/reports/data"),
      rp()
    );
    expect(res.status).toBe(200);
  });

  it("rejects a malformed startDate with the schema's message", async () => {
    const res = await getReportData(
      new Request("http://localhost/api/b/1/reports/data?startDate=not-a-date"),
      rp()
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid ISO date");
  });

  it("treats an explicit empty startDate as absent, not a validation error", async () => {
    const res = await getReportData(
      new Request("http://localhost/api/b/1/reports/data?startDate="),
      rp()
    );
    expect(res.status).toBe(200);
  });
});

describe("GET /api/b/[bookId]/reports/income-statement validation", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("rejects startDate without endDate with the ported combined message", async () => {
    const res = await getIncomeStatement(
      new Request(
        "http://localhost/api/b/1/reports/income-statement?startDate=2025-01-01"
      ),
      rp()
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Both startDate and endDate are required");
  });

  it("rejects a malformed startDate even when endDate is also supplied", async () => {
    const res = await getIncomeStatement(
      new Request(
        "http://localhost/api/b/1/reports/income-statement?startDate=not-a-date&endDate=2025-01-31"
      ),
      rp()
    );
    expect(res.status).toBe(400);
  });

  it("treats both dates empty as absent, not a validation error", async () => {
    const res = await getIncomeStatement(
      new Request(
        "http://localhost/api/b/1/reports/income-statement?startDate=&endDate="
      ),
      rp()
    );
    expect(res.status).toBe(200);
  });
});

describe("GET /api/b/[bookId]/reports/realized-gains validation", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("rejects endDate without startDate with the ported combined message", async () => {
    const res = await getRealizedGains(
      new Request(
        "http://localhost/api/b/1/reports/realized-gains?endDate=2025-01-31"
      ),
      rp()
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Both startDate and endDate are required");
  });

  it("rejects a non-numeric accountId with the ported message", async () => {
    const res = await getRealizedGains(
      new Request(
        "http://localhost/api/b/1/reports/realized-gains?accountId=abc"
      ),
      rp()
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid accountId");
  });

  it("reports the date-requirement message ahead of an invalid accountId", async () => {
    const res = await getRealizedGains(
      new Request(
        "http://localhost/api/b/1/reports/realized-gains?startDate=2025-01-01&accountId=abc"
      ),
      rp()
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Both startDate and endDate are required");
  });

  it("returns 200 (no accountId filter, not a coerced 0) when accountId is omitted", async () => {
    const res = await getRealizedGains(
      new Request("http://localhost/api/b/1/reports/realized-gains"),
      rp()
    );
    expect(res.status).toBe(200);
  });
});
