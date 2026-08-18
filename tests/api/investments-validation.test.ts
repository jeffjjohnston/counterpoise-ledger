import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as getPositions } from "@/app/api/b/[bookId]/investments/positions/route";
import { GET as getAccountValues } from "@/app/api/b/[bookId]/investments/account-values/route";
import { resetTestDatabase, setupTestDatabase } from "@/tests/helpers/db";

vi.mock("@/lib/api-auth", async () => {
  const { mockApiAuth } = await import("@/tests/helpers/db");
  return mockApiAuth();
});

// Regression guards for the positionsQuery / accountValuesQuery wiring. If a
// future edit hands a route raw, unparsed searchParams again, these are the
// tests that catch it.

function rp() {
  return { params: Promise.resolve({ bookId: "1" }) };
}

describe("GET /api/b/[bookId]/investments/positions validation", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("returns 200 (no accountId filter, not a coerced 0) when accountId is omitted", async () => {
    const res = await getPositions(
      new Request("http://localhost/api/b/1/investments/positions"),
      rp()
    );
    expect(res.status).toBe(200);
  });

  it("rejects an explicit empty accountId, unlike the other routes in this task", async () => {
    const res = await getPositions(
      new Request("http://localhost/api/b/1/investments/positions?accountId="),
      rp()
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid accountId");
  });
});

describe("GET /api/b/[bookId]/investments/account-values validation", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("returns 200 (no filter) when asOfDate is omitted", async () => {
    const res = await getAccountValues(
      new Request("http://localhost/api/b/1/investments/account-values"),
      rp()
    );
    expect(res.status).toBe(200);
  });

  it("treats an explicit empty asOfDate as absent, not a validation error", async () => {
    const res = await getAccountValues(
      new Request("http://localhost/api/b/1/investments/account-values?asOfDate="),
      rp()
    );
    expect(res.status).toBe(200);
  });

  it("rejects a malformed asOfDate with the schema's message", async () => {
    const res = await getAccountValues(
      new Request(
        "http://localhost/api/b/1/investments/account-values?asOfDate=not-a-date"
      ),
      rp()
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid ISO date");
  });
});
