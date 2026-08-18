import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { setupTestDatabase, resetTestDatabase } from "@/tests/helpers/db";

vi.mock("@/lib/session", () => ({
  getSession: vi.fn().mockResolvedValue({ userId: 1, sessionId: 1 }),
}));

vi.mock("@/lib/posthog-server", () => ({
  captureEvent: vi.fn(),
}));

import { POST } from "@/app/api/issue-reports/route";
import { PUT } from "@/app/api/issue-reports/[id]/route";

async function createReport(overrides: Record<string, string> = {}) {
  const res = await POST(
    new Request("http://localhost/api/issue-reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        description: "Test issue",
        type: "bug",
        page: "/b/1",
        ...overrides,
      }),
    })
  );
  return res.json();
}

function routeParams(id: number) {
  return { params: Promise.resolve({ id: String(id) }) };
}

beforeAll(async () => {
  await setupTestDatabase();
});

afterEach(async () => {
  await resetTestDatabase();
});

describe("POST /api/issue-reports validation wiring", () => {
  it("accepts a whitespace-only page (matches the un-trimmed original guard)", async () => {
    const request = new Request("http://localhost/api/issue-reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "test", page: "   " }),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.page).toBe("   ");
  });
});

describe("PUT /api/issue-reports/[id] validation wiring", () => {
  it("rejects an empty body with 400 and the 'no valid fields' message", async () => {
    const report = await createReport();
    const request = new Request(`http://localhost/api/issue-reports/${report.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const response = await PUT(request, routeParams(report.id));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("No valid fields to update");
  });

  it("rejects an empty-string description with its own message, not 'no valid fields'", async () => {
    const report = await createReport();
    const request = new Request(`http://localhost/api/issue-reports/${report.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "" }),
    });
    const response = await PUT(request, routeParams(report.id));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("Description cannot be empty");
  });
});
