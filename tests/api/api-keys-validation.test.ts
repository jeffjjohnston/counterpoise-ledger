import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { setupTestDatabase, resetTestDatabase } from "@/tests/helpers/db-utils";
import { getDb } from "@/db";

vi.mock("@/lib/session", () => ({
  getSession: vi.fn().mockResolvedValue({ userId: 1, sessionId: 1 }),
  getSessionCookieName: () => "counterpoise_session",
}));

vi.mock("@/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db")>();
  return { ...actual, getDb: vi.fn(actual.getDb) };
});

describe("POST /api/auth/api-keys validation wiring", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
    vi.mocked(getDb).mockImplementation(
      (await vi.importActual<typeof import("@/db")>("@/db")).getDb
    );
  });

  it("trims the stored name", async () => {
    const { POST } = await import("@/app/api/auth/api-keys/route");
    const request = new Request("http://localhost/api/auth/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "  My MCP Key  " }),
    });
    const response = await POST(request);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.name).toBe("My MCP Key");
  });

  it("rejects a whitespace-only name with 400 and the ported message", async () => {
    const { POST } = await import("@/app/api/auth/api-keys/route");
    const request = new Request("http://localhost/api/auth/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "   " }),
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("Name is required");
  });
});

describe("api-keys routes: try/catch envelope", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
    // These tests deliberately force a throw to exercise the routes' own
    // console.error(...) logging (api-keys/route.ts:31,75 and
    // api-keys/[id]/route.ts:35) — suppress it so the forced error's stack
    // trace doesn't pollute test output. tests/setup.ts only stubs
    // console.log globally, not console.error, and vi.restoreAllMocks() in
    // its afterEach restores this automatically after each test.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("GET /api/auth/api-keys returns a JSON error envelope (not an unhandled throw) when the database call fails", async () => {
    vi.mocked(getDb).mockImplementationOnce(() => {
      throw new Error("connection lost");
    });

    const { GET } = await import("@/app/api/auth/api-keys/route");
    const response = await GET();

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe("Failed to fetch API keys");
  });

  it("POST /api/auth/api-keys returns a JSON error envelope when the database call fails", async () => {
    vi.mocked(getDb).mockImplementationOnce(() => {
      throw new Error("connection lost");
    });

    const { POST } = await import("@/app/api/auth/api-keys/route");
    const request = new Request("http://localhost/api/auth/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Valid Name" }),
    });
    const response = await POST(request);

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe("Failed to create API key");
  });

  it("DELETE /api/auth/api-keys/[id] returns a JSON error envelope when the database call fails", async () => {
    vi.mocked(getDb).mockImplementationOnce(() => {
      throw new Error("connection lost");
    });

    const { DELETE: deleteHandler } = await import("@/app/api/auth/api-keys/[id]/route");
    const request = new Request("http://localhost/api/auth/api-keys/1", { method: "DELETE" });
    const response = await deleteHandler(request, { params: Promise.resolve({ id: "1" }) });

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe("Failed to delete API key");
  });
});
