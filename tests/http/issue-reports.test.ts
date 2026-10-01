import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createUser, resetTestDatabase, setupTestDatabase } from "../helpers/db-utils";
import { insert } from "../helpers/sql";
import { sessionHttpClient, startHttpTestServer } from "../helpers/http-parity";

type Client = Awaited<ReturnType<typeof sessionHttpClient>>;

describe("issue report HTTP parity", () => {
  let baseUrl: string;
  let stop: () => Promise<void>;
  let client: Client;
  beforeAll(async () => {
    await setupTestDatabase();
    ({ baseUrl, stop } = await startHttpTestServer({ TZ: "America/New_York" }));
  }, 120_000);
  beforeEach(async () => {
    await resetTestDatabase();
    client = await sessionHttpClient(baseUrl);
  });
  afterAll(async () => { await stop?.(); });

  function request(method: string, body: unknown): RequestInit {
    return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
  }

  it("creates, orders, updates, and deletes reports for the caller", async () => {
    const other = await createUser({ username: "other" });
    await insert("issue_reports", { userId: other.id, description: "private", page: "/other" });
    const before = Date.now();
    const first = await client.request("/api/issue-reports", request("POST", { description: "  First  ", page: "/one", bookId: 99 }));
    expect(first.status).toBe(200);
    const report = await first.json();
    expect(report).toMatchObject({ userId: 1, description: "First", page: "/one", type: "bug", status: "new" });
    expect(report).not.toHaveProperty("bookId");
    expect(typeof report.createdAt).toBe("string");
    expect(new Date(report.createdAt).getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(new Date(report.createdAt).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    const second = await client.request("/api/issue-reports", request("POST", { description: "Second", page: "/two", type: "other" }));
    const secondReport = await second.json();
    const listed = await client.request("/api/issue-reports");
    expect(listed.status).toBe(200);
    expect((await listed.json()).map((row: { id: number }) => row.id)).toEqual([secondReport.id, report.id]);
    const updated = await client.request(`/api/issue-reports/${report.id}`, request("PUT", { description: "  Fixed  ", status: "resolved" }));
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ id: report.id, description: "Fixed", status: "resolved", page: "/one" });
    const deleted = await client.request(`/api/issue-reports/${report.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ success: true });
  });

  it("preserves validation, missing-row, and authentication responses", async () => {
    for (const [path, init, status, body] of [
      ["/api/issue-reports", request("POST", { description: " ", page: "/" }), 400, { error: "Description is required" }],
      ["/api/issue-reports", request("POST", { description: "A", page: "/", type: "bad" }), 400, { error: "Invalid type. Must be one of: bug, improvement, other" }],
      ["/api/issue-reports/not-an-id", request("PUT", { description: "A" }), 400, { error: "Invalid ID" }],
      ["/api/issue-reports/999999", request("PUT", {}), 400, { error: "No valid fields to update" }],
      ["/api/issue-reports/999999", { method: "DELETE" }, 404, { error: "Issue report not found" }],
    ] as const) {
      const response = await client.request(path, init);
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual(body);
    }
    expect((await client.anonymous("/api/issue-reports")).status).toBe(401);
  });

  it("accepts Number-compatible path IDs", async () => {
    const created = await client.request("/api/issue-reports", request("POST", { description: "Numeric", page: "/" }));
    const report = await created.json();
    const updated = await client.request(`/api/issue-reports/0x${report.id.toString(16)}`, request("PUT", { status: "resolved" }));
    expect(updated.status).toBe(200);
    expect((await updated.json()).status).toBe("resolved");
    const deleted = await client.request(`/api/issue-reports/%20${report.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
  });
});
