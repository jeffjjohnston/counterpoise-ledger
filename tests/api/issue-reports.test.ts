import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { setupTestDatabase, resetTestDatabase } from "@/tests/helpers/db";

vi.mock("@/lib/session", () => ({
  getSession: vi.fn().mockResolvedValue({ userId: 1, sessionId: 1 }),
}));

vi.mock("@/lib/posthog-server", () => ({
  captureEvent: vi.fn(),
}));

import { GET, POST } from "@/app/api/issue-reports/route";
import { PUT, DELETE as DELETE_REPORT } from "@/app/api/issue-reports/[id]/route";

async function createReport(overrides: Record<string, string> = {}) {
  const res = await POST(new Request("http://localhost/api/issue-reports", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      description: "Test issue",
      type: "bug",
      page: "/b/1",
      ...overrides,
    }),
  }));
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

describe("POST /api/issue-reports", () => {
  it("creates an issue report with valid input", async () => {
    const request = new Request("http://localhost/api/issue-reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        description: "The balance is wrong on the dashboard",
        type: "bug",
        page: "/b/1/transactions",
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.id).toBeDefined();
    expect(body.description).toBe("The balance is wrong on the dashboard");
    expect(body.type).toBe("bug");
    expect(body.page).toBe("/b/1/transactions");
    expect(body.status).toBe("new");
    expect(body.userId).toBe(1);
  });

  it("defaults type to bug when not provided", async () => {
    const request = new Request("http://localhost/api/issue-reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        description: "Something is off",
        page: "/b/1",
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.type).toBe("bug");
  });

  it("rejects empty description", async () => {
    const request = new Request("http://localhost/api/issue-reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        description: "",
        page: "/b/1",
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(400);
  });

  it("rejects missing description", async () => {
    const request = new Request("http://localhost/api/issue-reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        page: "/b/1",
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(400);
  });

  it("rejects invalid type", async () => {
    const request = new Request("http://localhost/api/issue-reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        description: "test",
        type: "invalid",
        page: "/b/1",
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(400);
  });

  it("rejects missing page", async () => {
    const request = new Request("http://localhost/api/issue-reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        description: "test",
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(400);
  });
});

describe("GET /api/issue-reports", () => {
  it("returns all issue reports for the authenticated user", async () => {
    // Create two reports first via POST
    await POST(new Request("http://localhost/api/issue-reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "Bug A", type: "bug", page: "/b/1" }),
    }));
    await POST(new Request("http://localhost/api/issue-reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "Improvement B", type: "improvement", page: "/b/1/accounts" }),
    }));

    const response = await GET();
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toHaveLength(2);
    // Newest first
    expect(body[0].description).toBe("Improvement B");
    expect(body[1].description).toBe("Bug A");
  });

  it("returns empty array when user has no reports", async () => {
    const response = await GET();
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toEqual([]);
  });
});

describe("PUT /api/issue-reports/[id]", () => {
  it("updates description and status of an issue report", async () => {
    const report = await createReport();
    const request = new Request(`http://localhost/api/issue-reports/${report.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "Updated description", status: "resolved" }),
    });
    const response = await PUT(request, routeParams(report.id));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.description).toBe("Updated description");
    expect(body.status).toBe("resolved");
    expect(body.type).toBe("bug"); // unchanged
  });

  it("rejects invalid status", async () => {
    const report = await createReport();
    const request = new Request(`http://localhost/api/issue-reports/${report.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "invalid" }),
    });
    const response = await PUT(request, routeParams(report.id));
    expect(response.status).toBe(400);
  });

  it("returns 404 for non-existent report", async () => {
    const request = new Request("http://localhost/api/issue-reports/9999", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "resolved" }),
    });
    const response = await PUT(request, routeParams(9999));
    expect(response.status).toBe(404);
  });
});

describe("DELETE /api/issue-reports/[id]", () => {
  it("deletes an issue report", async () => {
    const report = await createReport();
    const request = new Request(`http://localhost/api/issue-reports/${report.id}`, {
      method: "DELETE",
    });
    const response = await DELETE_REPORT(request, routeParams(report.id));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);

    // Verify it's gone
    const listResponse = await GET();
    const reports = await listResponse.json();
    expect(reports).toHaveLength(0);
  });

  it("returns 404 for non-existent report", async () => {
    const request = new Request("http://localhost/api/issue-reports/9999", {
      method: "DELETE",
    });
    const response = await DELETE_REPORT(request, routeParams(9999));
    expect(response.status).toBe(404);
  });
});
