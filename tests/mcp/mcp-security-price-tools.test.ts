import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { setupTestDatabase, resetTestDatabase, createSecurity } from "@/tests/helpers/db-utils";
import { getDb } from "@/db";
import { securityPrices } from "@/db/schema";
import { eq } from "drizzle-orm";

// Mock MCP auth to return an authenticated user, same pattern as
// mcp-payee-tools.test.ts.
vi.mock("@/mcp/auth", () => ({
  getMcpAuth: vi.fn().mockReturnValue({ userId: 1, keyId: 1 }),
  verifyBookAccess: vi.fn().mockResolvedValue(true),
  requireAuth: vi.fn().mockReturnValue({ userId: 1, keyId: 1 }),
  requireBookAuth: vi.fn().mockResolvedValue({ userId: 1, keyId: 1 }),
}));

vi.mock("@/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db")>();
  return { ...actual };
});

let client: Client;
let server: McpServer;

async function callTool(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const isError = result.isError ?? false;
  const textContent = (result.content as Array<{ type: string; text: string }>)?.find(
    (c) => c.type === "text"
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let data: any;
  if (isError) {
    try {
      data = textContent ? JSON.parse(textContent.text) : undefined;
    } catch {
      data = { error: textContent?.text };
    }
  } else {
    data = textContent ? JSON.parse(textContent.text) : undefined;
  }
  return { data, isError };
}

describe("MCP Security Price Tools", () => {
  const bookId = 1;

  beforeAll(async () => {
    await setupTestDatabase();

    server = new McpServer({ name: "test", version: "0.0.1" });
    const { registerSecurityPriceTools } = await import("@/mcp/tools/security-prices");
    registerSecurityPriceTools(server);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "test-client", version: "0.0.1" });
    await client.connect(clientTransport);
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await client.close();
    await server.close();
  });

  describe("set_security_prices", () => {
    it("set_security_prices writes the valid entries and names the discarded ones", async () => {
      const sec = await createSecurity({ bookId, name: "A", symbol: "AAA", securityType: "etf" });

      const { data, isError } = await callTool("set_security_prices", {
        bookId,
        priceUpdates: [
          { securityId: sec.id, priceMicros: 1_000_000, priceDate: "2026-01-15" },
          { securityId: sec.id, priceMicros: -1, priceDate: "2026-01-16" },
        ],
      });

      expect(isError).toBe(false);
      expect(data.count).toBe(1);
      expect(data.discarded).toHaveLength(1);
      expect(data.discarded[0].index).toBe(1);

      const rows = await getDb().select().from(securityPrices);
      expect(rows).toHaveLength(1);
    });
  });

  describe("update_security_price", () => {
    it("update_security_price moves an entry to a new date", async () => {
      const sec = await createSecurity({ bookId, name: "A", symbol: "AAA", securityType: "etf" });
      await callTool("set_security_prices", {
        bookId,
        priceUpdates: [{ securityId: sec.id, priceMicros: 1_000_000, priceDate: "2026-01-15" }],
      });

      const { isError } = await callTool("update_security_price", {
        bookId, securityId: sec.id, currentDate: "2026-01-15",
        priceDate: "2026-01-20", priceMicros: 1_000_000,
      });

      expect(isError).toBe(false);
      const rows = await getDb().select().from(securityPrices).where(eq(securityPrices.securityId, sec.id));
      expect(rows).toHaveLength(1);
      expect(rows[0].priceDate).toBe("2026-01-20");
    });
  });

  describe("delete_security_price", () => {
    it("delete_security_price fails on a missing entry and deletes nothing", async () => {
      const sec = await createSecurity({ bookId, name: "A", symbol: "AAA", securityType: "etf" });
      await callTool("set_security_prices", {
        bookId,
        priceUpdates: [{ securityId: sec.id, priceMicros: 1_000_000, priceDate: "2026-01-15" }],
      });

      const { isError } = await callTool("delete_security_price", {
        bookId, securityId: sec.id, priceDate: "2026-01-20",
      });

      expect(isError).toBe(true);
      const rows = await getDb().select().from(securityPrices).where(eq(securityPrices.securityId, sec.id));
      expect(rows).toHaveLength(1);
    });

    it("rejects a malformed date rather than passing it to the database", async () => {
      // A not-found priceDate also comes back as isError: true (see the test
      // above), so isError alone cannot tell a schema rejection from a normal
      // "no row matched" failure — both look identical from that flag. The
      // MCP SDK reports a schema-validation failure as plain text naming the
      // offending field, so read that text directly, the same way
      // mcp-tools.test.ts's calendar-invalid-startDate test does.
      const security = await createSecurity({
        bookId,
        name: "Vanguard Total",
        symbol: "VTI",
        securityType: "etf",
      });

      const result = await client.callTool({
        name: "delete_security_price",
        arguments: { bookId, securityId: security.id, priceDate: "Feb 8" },
      });

      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      expect(text).toMatch(/priceDate/i);
    });
  });

  describe("list_prices_due", () => {
    it("list_prices_due returns an empty result for a book with no manual securities", async () => {
      await createSecurity({ bookId, name: "Auto", symbol: "AUTO", securityType: "etf", fetchPrices: true });

      const { data, isError } = await callTool("list_prices_due", { bookId });

      expect(isError).toBe(false);
      expect(data.dueDate).toBeNull();
      expect(data.securities).toEqual([]);
    });
  });

  describe("fetch_tiingo_prices", () => {
    const originalApiKey = process.env.TIINGO_API_KEY;

    afterEach(() => {
      vi.unstubAllGlobals();
      if (originalApiKey === undefined) {
        delete process.env.TIINGO_API_KEY;
      } else {
        process.env.TIINGO_API_KEY = originalApiKey;
      }
    });

    it("returns the prices the Tiingo client resolves", async () => {
      process.env.TIINGO_API_KEY = "test-key";
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => [{ date: "2026-03-10T00:00:00.000Z", close: 250.5 }],
        })
      );

      const { data, isError } = await callTool("fetch_tiingo_prices", {
        bookId,
        symbols: ["VTI"],
      });

      expect(isError).toBe(false);
      expect(data).toHaveProperty("prices");
      expect(data).toHaveProperty("errors");
    });

    it("fails with a clear message when TIINGO_API_KEY is not configured", async () => {
      delete process.env.TIINGO_API_KEY;
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);

      const { data, isError } = await callTool("fetch_tiingo_prices", {
        bookId,
        symbols: ["VTI"],
      });

      expect(isError).toBe(true);
      expect(data.error).toContain("TIINGO_API_KEY");
      // The guard must run before any request is attempted.
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});
