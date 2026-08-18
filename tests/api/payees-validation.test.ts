import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/api/b/[bookId]/payees/route";
import { createPayee, resetTestDatabase, setupTestDatabase } from "@/tests/helpers/db";

vi.mock("@/lib/api-auth", async () => {
  const { mockApiAuth } = await import("@/tests/helpers/db");
  return mockApiAuth();
});

// Regression guards for the createPayeeSchema / listPayeesQuery wiring. If a
// future edit hands the route raw, unparsed input again, these are the
// tests that catch it.

function rp() {
  return { params: Promise.resolve({ bookId: "1" }) };
}

describe("GET /api/b/[bookId]/payees validation", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("returns 200 (no limit, not a coerced 0) when limit is omitted", async () => {
    await createPayee({ name: "Blue Bottle" });
    const res = await GET(new Request("http://localhost/api/b/1/payees"), rp());
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload).toHaveLength(1);
  });

  it("never 400s for a garbage limit; falls back to no limit", async () => {
    await createPayee({ name: "Blue Bottle" });
    await createPayee({ name: "Whole Foods" });
    const res = await GET(
      new Request("http://localhost/api/b/1/payees?limit=abc"),
      rp()
    );
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload).toHaveLength(2);
  });
});

describe("POST /api/b/[bookId]/payees validation", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("rejects a missing name with the ported message", async () => {
    const res = await POST(
      new Request("http://localhost/api/b/1/payees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
      rp()
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Name is required");
  });
});
