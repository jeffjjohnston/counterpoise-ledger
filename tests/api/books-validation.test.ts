import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PUT } from "@/app/api/books/[bookId]/route";
import { resetTestDatabase, setupTestDatabase } from "@/tests/helpers/db-utils";
import { getSession } from "@/lib/session";

vi.mock("@/lib/session", () => ({
  getSession: vi.fn(),
}));

function makeRequest(url: string, init?: RequestInit) {
  return new Request(`http://localhost${url}`, init);
}

function getParams(bookId = "1") {
  return { params: Promise.resolve({ bookId }) };
}

beforeAll(async () => {
  await setupTestDatabase();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await resetTestDatabase();
  vi.mocked(getSession).mockResolvedValue({ userId: 1, sessionId: 1 });
});

describe("PUT /api/books/[bookId] validation wiring", () => {
  it("rejects an out-of-range upcomingDays with 400 and the ported message", async () => {
    const res = await PUT(
      makeRequest("/api/books/1", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Renamed", upcomingDays: 400 }),
      }),
      getParams("1")
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("upcomingDays must be an integer between 1 and 365");
  });

  it("accepts a valid upcomingDays and persists it", async () => {
    const res = await PUT(
      makeRequest("/api/books/1", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Renamed", upcomingDays: 45 }),
      }),
      getParams("1")
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.upcomingDays).toBe(45);
  });
});
