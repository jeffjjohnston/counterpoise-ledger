import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as searchGet } from "@/app/api/b/[bookId]/search/route";
import { GET as plaidGet } from "@/app/api/b/[bookId]/transactions/[id]/plaid/route";
import { POST as plaidUnlinkPost } from "@/app/api/b/[bookId]/transactions/[id]/plaid/unlink/route";
import { resetTestDatabase, setupTestDatabase } from "@/tests/helpers/db";

// Regression guard for the searchQuery wiring in search/route.ts, and for
// the try/catch envelope newly added to all three routes in this file
// (search/route.ts, transactions/[id]/plaid/route.ts,
// transactions/[id]/plaid/unlink/route.ts — none had a try block before).
// tests/api/search.test.ts and tests/api/transaction-plaid.test.ts already
// cover these routes' happy-path behavior; this file only covers what those
// don't: schema-level 400s and the 500 envelope.

vi.mock("@/lib/api-auth", async () => {
  const { mockApiAuth } = await import("@/tests/helpers/db");
  return mockApiAuth();
});

import { authenticateBookRequest } from "@/lib/api-auth";

function rp() {
  return { params: Promise.resolve({ bookId: "1" }) };
}

function rpWithId(id: string) {
  return { params: Promise.resolve({ bookId: "1", id }) };
}

describe("GET /api/b/[bookId]/search validation", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("returns 200 (empty buckets, not a 400) when q is omitted entirely", async () => {
    const res = await searchGet(new Request("http://localhost/api/b/1/search"), rp());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ transactions: [], accounts: [], payees: [], recurringRules: [] });
  });

  it("returns 200 (empty buckets, not a 400) when q is an explicit empty string", async () => {
    const res = await searchGet(new Request("http://localhost/api/b/1/search?q="), rp());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ transactions: [], accounts: [], payees: [], recurringRules: [] });
  });

  it("rejects a malformed startDate with the schema's message", async () => {
    const res = await searchGet(
      new Request("http://localhost/api/b/1/search?q=rent&startDate=not-a-date"),
      rp()
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid ISO date");
  });

  it("rejects a malformed endDate with the schema's message", async () => {
    const res = await searchGet(
      new Request("http://localhost/api/b/1/search?q=rent&endDate=01/31/2025"),
      rp()
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid ISO date");
  });

  it("treats explicit empty startDate/endDate as absent, not a validation error", async () => {
    const res = await searchGet(
      new Request("http://localhost/api/b/1/search?q=rent&startDate=&endDate="),
      rp()
    );
    expect(res.status).toBe(200);
  });
});

describe("try/catch envelope for search and plaid routes", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
    // These tests deliberately force a throw during the auth lookup, which
    // is inside each route's try block, to prove the whole handler body is
    // wrapped (not just the DB call) and to exercise the route's own
    // console.error(...) logging. Suppress it so the forced error's stack
    // trace doesn't pollute test output. tests/setup.ts only stubs
    // console.log globally, not console.error, and vi.restoreAllMocks() in
    // its afterEach restores this automatically after each test.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("GET /api/b/[bookId]/search returns a JSON error envelope (not an unhandled throw) when auth fails", async () => {
    vi.mocked(authenticateBookRequest).mockRejectedValueOnce(new Error("connection lost"));

    const res = await searchGet(new Request("http://localhost/api/b/1/search?q=rent"), rp());

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to search");
  });

  it("GET /api/b/[bookId]/transactions/[id]/plaid returns a JSON error envelope when auth fails", async () => {
    vi.mocked(authenticateBookRequest).mockRejectedValueOnce(new Error("connection lost"));

    const res = await plaidGet(
      new Request("http://localhost/api/b/1/transactions/1/plaid"),
      rpWithId("1")
    );

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to fetch Plaid link");
  });

  it("POST /api/b/[bookId]/transactions/[id]/plaid/unlink returns a JSON error envelope when auth fails", async () => {
    vi.mocked(authenticateBookRequest).mockRejectedValueOnce(new Error("connection lost"));

    const res = await plaidUnlinkPost(
      new Request("http://localhost/api/b/1/transactions/1/plaid/unlink", { method: "POST" }),
      rpWithId("1")
    );

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to unlink from Plaid");
  });
});
