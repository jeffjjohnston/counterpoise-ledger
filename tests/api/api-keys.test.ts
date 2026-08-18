import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import {
  setupTestDatabase,
  resetTestDatabase,
} from "@/tests/helpers/db-utils";
import { getDb } from "@/db";
import { apiKeys } from "@/db/schema";
import { hashApiKey } from "@/lib/api-keys";

vi.mock("@/lib/session", () => ({
  getSession: vi.fn().mockResolvedValue({ userId: 1, sessionId: 1 }),
  getSessionCookieName: () => "counterpoise_session",
}));

describe("API Key routes", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  describe("POST /api/auth/api-keys", () => {
    it("creates a new API key and returns the plaintext key once", async () => {
      const { POST } = await import("@/app/api/auth/api-keys/route");
      const request = new Request("http://localhost/api/auth/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "My MCP Key" }),
      });
      const response = await POST(request);
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.key).toMatch(/^cpk_/);
      expect(data.name).toBe("My MCP Key");
      expect(data.keyPrefix).toBe(data.key.slice(0, 8));
    });

    it("rejects empty name", async () => {
      const { POST } = await import("@/app/api/auth/api-keys/route");
      const request = new Request("http://localhost/api/auth/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "" }),
      });
      const response = await POST(request);
      expect(response.status).toBe(400);
    });
  });

  describe("GET /api/auth/api-keys", () => {
    it("lists keys without exposing hashes", async () => {
      const db = getDb();
      await db.insert(apiKeys).values({
        userId: 1,
        name: "Test Key",
        keyHash: await hashApiKey("cpk_test"),
        keyPrefix: "cpk_test",
      });
      const { GET } = await import("@/app/api/auth/api-keys/route");
      const response = await GET();
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toHaveLength(1);
      expect(data[0].name).toBe("Test Key");
      expect(data[0].keyPrefix).toBe("cpk_test");
      expect(data[0]).not.toHaveProperty("keyHash");
    });
  });

  describe("DELETE /api/auth/api-keys/[id]", () => {
    it("deletes a key owned by the user", async () => {
      const db = getDb();
      const [key] = await db.insert(apiKeys).values({
        userId: 1,
        name: "Delete Me",
        keyHash: await hashApiKey("cpk_test"),
        keyPrefix: "cpk_test",
      }).returning();
      const { DELETE: deleteHandler } = await import(
        "@/app/api/auth/api-keys/[id]/route"
      );
      const request = new Request(
        `http://localhost/api/auth/api-keys/${key.id}`,
        { method: "DELETE" }
      );
      const response = await deleteHandler(request, {
        params: Promise.resolve({ id: String(key.id) }),
      });
      expect(response.status).toBe(200);
    });
  });
});
