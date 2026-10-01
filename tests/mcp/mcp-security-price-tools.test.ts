import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { setupTestDatabase, resetTestDatabase, createBook, createSecurity } from "@/tests/helpers/db-utils";
import { callMcpTool } from "@/tests/helpers/mcp";
import { connectMcpTestClient, type McpTestClient } from "@/tests/helpers/mcp-client";
import { count, rows } from "@/tests/helpers/sql";
import type { SecurityPrice } from "@/types/db";

let mcp: McpTestClient;

const callTool = (name: string, args: Record<string, unknown> = {}) =>
  callMcpTool(mcp.client, name, args);

// A fake Tiingo daily-prices API. A stubbed global fetch does not reach the
// Rust process, and the Rust server reads its Tiingo settings when it
// starts, so the server gets this URL and key in its environment.
const TIINGO_KEY = "test-key";
let tiingo: Server;
let tiingoUrl: string;
const tiingoRequests: string[] = [];

async function startTiingo() {
  tiingo = createServer((request, response) => {
    tiingoRequests.push(request.url ?? "");
    const url = new URL(request.url ?? "/", "http://fake");
    const ok = url.pathname === "/tiingo/daily/VTI/prices" && url.searchParams.get("token") === TIINGO_KEY;
    response.writeHead(ok ? 200 : 404, { "content-type": "application/json" });
    response.end(
      ok
        ? JSON.stringify([{ date: "2026-03-10T00:00:00.000Z", adjClose: 250.5 }])
        : JSON.stringify({ detail: "Not found." })
    );
  });
  await new Promise<void>((resolve) => tiingo.listen(0, "127.0.0.1", resolve));
  tiingoUrl = `http://127.0.0.1:${(tiingo.address() as AddressInfo).port}`;
}

describe("MCP Security Price Tools", () => {
  const bookId = 1;

  beforeAll(async () => {
    await setupTestDatabase();

    await startTiingo();
    mcp = await connectMcpTestClient({
      env: { TIINGO_API_KEY: TIINGO_KEY, TIINGO_API_URL: tiingoUrl },
    });
  }, 120_000);

  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await mcp.close();
    await new Promise<void>((resolve) => tiingo.close(() => resolve()));
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
      // The reason is zod's first issue for the item.
      expect(data.discarded).toEqual([{ index: 1, reason: "Too small: expected number to be >0" }]);
      expect(data.written).toEqual([
        { securityId: sec.id, priceMicros: 1_000_000, priceDate: "2026-01-15" },
      ]);

      expect(await count("security_prices")).toBe(1);
    });
  });

  it("reports zod's first issue for each malformed entry", async () => {
    const sec = await createSecurity({ bookId, name: "A", symbol: "AAA", securityType: "etf" });

    const { data } = await callTool("set_security_prices", {
      bookId,
      priceUpdates: [
        "x",
        {},
        { securityId: 1.5 },
        { securityId: sec.id, priceMicros: 2 ** 60, priceDate: "2026-01-15" },
        { securityId: sec.id, priceMicros: 1, priceDate: "2025-02-30" },
        { securityId: sec.id, priceMicros: 1, priceDate: null },
        { securityId: sec.id, priceMicros: 1, priceDate: "2026-01-15" },
      ],
    });

    expect(data.discarded).toEqual([
      { index: 0, reason: "Invalid input: expected object, received string" },
      { index: 1, reason: "Invalid input: expected number, received undefined" },
      { index: 2, reason: "Invalid input: expected int, received number" },
      { index: 3, reason: "Too big: expected int to be <=9007199254740991" },
      { index: 4, reason: "Invalid ISO date" },
      { index: 5, reason: "Invalid input: expected string, received null" },
    ]);
    expect(data.count).toBe(1);
  });

  it("refuses a batch with a security from another book, and writes nothing", async () => {
    const other = await createBook({ name: "Other" });
    const mine = await createSecurity({ bookId, name: "A", symbol: "AAA", securityType: "etf" });
    const theirs = await createSecurity({ bookId: other.id, name: "B", symbol: "BBB", securityType: "etf" });

    const { data, isError } = await callTool("set_security_prices", {
      bookId,
      priceUpdates: [
        { securityId: mine.id, priceMicros: 1, priceDate: "2026-01-15" },
        { securityId: theirs.id, priceMicros: 1, priceDate: "2026-01-15" },
      ],
    });

    expect(isError).toBe(true);
    expect(data.error).toBe("One or more securities do not belong to this book");
    expect(await count("security_prices")).toBe(0);
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
      const stored = await rows<SecurityPrice>("SELECT * FROM security_prices WHERE security_id = $1", [sec.id]);
      expect(stored).toHaveLength(1);
      expect(stored[0].priceDate).toBe("2026-01-20");
    });
  });

  describe("delete_security_price", () => {
    it("delete_security_price fails on a missing entry and deletes nothing", async () => {
      const sec = await createSecurity({ bookId, name: "A", symbol: "AAA", securityType: "etf" });
      await callTool("set_security_prices", {
        bookId,
        priceUpdates: [{ securityId: sec.id, priceMicros: 1_000_000, priceDate: "2026-01-15" }],
      });

      const { data, isError } = await callTool("delete_security_price", {
        bookId, securityId: sec.id, priceDate: "2026-01-20",
      });

      expect(isError).toBe(true);
      // The library names the date; the HTTP route does not.
      expect(data.error).toBe("Price entry for 2026-01-20 not found");
      expect(await count("security_prices", "security_id = $1", [sec.id])).toBe(1);
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

      const result = await mcp.client.callTool({
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
    beforeEach(() => {
      tiingoRequests.length = 0;
    });

    it("returns the prices Tiingo gives, and the symbols that failed", async () => {
      const { data, isError } = await callTool("fetch_tiingo_prices", {
        bookId,
        symbols: ["VTI", "NOPE"],
      });

      expect(isError).toBe(false);
      expect(data.prices).toEqual([{ symbol: "VTI", price: 250.5, date: "2026-03-10" }]);
      expect(data.errors).toEqual([
        { symbol: "NOPE", error: "Failed to fetch price for NOPE: Not Found" },
      ]);
    });

    it("fails with a clear message when TIINGO_API_KEY is not configured", async () => {
      // The Rust server reads the key when it starts, so this case needs a
      // server started without one.
      const unconfigured = await connectMcpTestClient({
        env: { TIINGO_API_KEY: "", TIINGO_API_URL: tiingoUrl },
      });
      try {
        const { data, isError } = await callMcpTool(unconfigured.client, "fetch_tiingo_prices", {
          bookId,
          symbols: ["VTI"],
        });

        expect(isError).toBe(true);
        expect(data.error).toBe("TIINGO_API_KEY environment variable not configured");
        // The guard must run before any request is attempted.
        expect(tiingoRequests).toEqual([]);
      } finally {
        await unconfigured.close();
      }
    });
  });
});
