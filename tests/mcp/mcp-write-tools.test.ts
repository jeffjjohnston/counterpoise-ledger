import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  setupTestDatabase,
  resetTestDatabase,
  createAccount,
  createTransactionWithSplits,
} from "@/tests/helpers/db-utils";
import { callMcpTool } from "@/tests/helpers/mcp";
import { getDb } from "@/db";
import { transactions } from "@/db/schema";
import { eq } from "drizzle-orm";

// Mock MCP auth to return authenticated user
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

const callTool = (name: string, args: Record<string, unknown> = {}) =>
  callMcpTool(client, name, args);

describe("MCP Write Transaction Tools", () => {
  const bookId = 1;

  beforeAll(async () => {
    await setupTestDatabase();

    server = new McpServer({ name: "test", version: "0.0.1" });
    const { registerWriteTransactionTools } = await import(
      "@/mcp/tools/write-transactions"
    );
    const { registerSecurityTools } = await import("@/mcp/tools/securities");
    registerWriteTransactionTools(server);
    registerSecurityTools(server);

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

  describe("create_transaction", () => {
    it("creates a basic transaction", async () => {
      const checking = await createAccount({
        name: "Checking",
        type: "asset",
        subtype: "bank",
        bookId,
      });
      const groceries = await createAccount({
        name: "Groceries",
        type: "expense",
        subtype: "other",
        bookId,
      });

      const { data, isError } = await callTool("create_transaction", {
        bookId,
        date: "2025-01-15",
        description: "Grocery store",
        splits: [
          { accountId: groceries.id, amount: 5000 },
          { accountId: checking.id, amount: -5000 },
        ],
      });

      expect(isError).toBe(false);
      expect(data.id).toBeDefined();
      expect(data.splits).toHaveLength(2);
    });

    it("rejects unbalanced splits", async () => {
      const checking = await createAccount({
        name: "Checking",
        type: "asset",
        subtype: "bank",
        bookId,
      });
      const groceries = await createAccount({
        name: "Groceries",
        type: "expense",
        subtype: "other",
        bookId,
      });

      const { data, isError } = await callTool("create_transaction", {
        bookId,
        date: "2025-01-15",
        splits: [
          { accountId: groceries.id, amount: 5000 },
          { accountId: checking.id, amount: -4000 },
        ],
      });

      expect(isError).toBe(true);
      expect(data.error).toContain("sum to zero");
    });

    it("creates a transaction already marked reconciled", async () => {
      const checking = await createAccount({ name: "Checking", type: "asset", subtype: "bank", bookId });
      const groceries = await createAccount({ name: "Groceries", type: "expense", subtype: "other", bookId });

      const { data, isError } = await callTool("create_transaction", {
        bookId,
        date: "2025-01-15",
        description: "Grocery store",
        isReconciled: true,
        splits: [
          { accountId: groceries.id, amount: 5000 },
          { accountId: checking.id, amount: -5000 },
        ],
      });

      expect(isError).toBe(false);
      expect(data.isReconciled).toBe(true);

      const [row] = await getDb()
        .select()
        .from(transactions)
        .where(eq(transactions.id, data.id));
      expect(row.isReconciled).toBe(true);
    });

    it("creates transaction with payee", async () => {
      const checking = await createAccount({ name: "Checking", type: "asset", subtype: "bank", bookId });
      const groceries = await createAccount({ name: "Groceries", type: "expense", subtype: "other", bookId });

      const { data, isError } = await callTool("create_transaction", {
        bookId,
        date: "2025-01-15",
        payeeName: "Whole Foods",
        splits: [
          { accountId: groceries.id, amount: 5000 },
          { accountId: checking.id, amount: -5000 },
        ],
      });

      expect(isError).toBe(false);
      expect(data.payee.name).toBe("Whole Foods");
    });

    it("returns auth error when not authenticated", async () => {
      const { requireBookAuth } = await import("@/mcp/auth");
      vi.mocked(requireBookAuth).mockResolvedValueOnce({
        content: [{ type: "text" as const, text: JSON.stringify({ error: "A valid COUNTERPOISE_API_KEY is required" }) }],
        isError: true,
      });

      const { data, isError } = await callTool("create_transaction", {
        bookId,
        date: "2025-01-15",
        splits: [
          { accountId: 1, amount: 5000 },
          { accountId: 2, amount: -5000 },
        ],
      });

      expect(isError).toBe(true);
      expect(data.error).toContain("COUNTERPOISE_API_KEY");
    });

    it("returns book access error when not authorized", async () => {
      const { requireBookAuth } = await import("@/mcp/auth");
      vi.mocked(requireBookAuth).mockResolvedValueOnce({
        content: [{ type: "text" as const, text: JSON.stringify({ error: "You do not have access to this book" }) }],
        isError: true,
      });

      const { data, isError } = await callTool("create_transaction", {
        bookId,
        date: "2025-01-15",
        splits: [
          { accountId: 1, amount: 5000 },
          { accountId: 2, amount: -5000 },
        ],
      });

      expect(isError).toBe(true);
      expect(data.error).toContain("access");
    });
  });

  describe("update_transaction", () => {
    it("updates transaction description", async () => {
      const checking = await createAccount({ name: "Checking", type: "asset", subtype: "bank", bookId });
      const groceries = await createAccount({ name: "Groceries", type: "expense", subtype: "other", bookId });

      const { data: created } = await callTool("create_transaction", {
        bookId,
        date: "2025-01-15",
        description: "Original",
        splits: [
          { accountId: groceries.id, amount: 5000 },
          { accountId: checking.id, amount: -5000 },
        ],
      });

      const { data: updated, isError } = await callTool("update_transaction", {
        bookId,
        transactionId: created.id,
        description: "Updated",
      });

      expect(isError).toBe(false);
      expect(updated.description).toBe("Updated");
    });

    it("updates transaction splits", async () => {
      const checking = await createAccount({ name: "Checking", type: "asset", subtype: "bank", bookId });
      const groceries = await createAccount({ name: "Groceries", type: "expense", subtype: "other", bookId });
      const dining = await createAccount({ name: "Dining", type: "expense", subtype: "other", bookId });

      const { data: created } = await callTool("create_transaction", {
        bookId,
        date: "2025-01-15",
        description: "Dinner",
        splits: [
          { accountId: groceries.id, amount: 5000 },
          { accountId: checking.id, amount: -5000 },
        ],
      });

      const { data: updated, isError } = await callTool("update_transaction", {
        bookId,
        transactionId: created.id,
        splits: [
          { accountId: dining.id, amount: 7500 },
          { accountId: checking.id, amount: -7500 },
        ],
      });

      expect(isError).toBe(false);
      expect(updated.splits).toHaveLength(2);
      // Verify the new split amounts
      const amounts = updated.splits.map((s: { amount: number }) => s.amount).sort((a: number, b: number) => a - b);
      expect(amounts).toEqual([-7500, 7500]);
    });

    it("marks a transaction reconciled", async () => {
      const checking = await createAccount({ name: "Checking", type: "asset", subtype: "bank", bookId });
      const groceries = await createAccount({ name: "Groceries", type: "expense", subtype: "other", bookId });

      const { data: created } = await callTool("create_transaction", {
        bookId,
        date: "2025-01-15",
        description: "Original",
        splits: [
          { accountId: groceries.id, amount: 5000 },
          { accountId: checking.id, amount: -5000 },
        ],
      });

      const { data: updated, isError } = await callTool("update_transaction", {
        bookId,
        transactionId: created.id,
        isReconciled: true,
      });

      expect(isError).toBe(false);
      expect(updated.isReconciled).toBe(true);

      const [row] = await getDb()
        .select()
        .from(transactions)
        .where(eq(transactions.id, created.id));
      expect(row.isReconciled).toBe(true);
    });

    it("returns auth error when not authenticated", async () => {
      const { requireBookAuth } = await import("@/mcp/auth");
      vi.mocked(requireBookAuth).mockResolvedValueOnce({
        content: [{ type: "text" as const, text: JSON.stringify({ error: "A valid COUNTERPOISE_API_KEY is required" }) }],
        isError: true,
      });

      const { data, isError } = await callTool("update_transaction", {
        bookId,
        transactionId: 1,
        description: "Updated",
      });

      expect(isError).toBe(true);
      expect(data.error).toContain("COUNTERPOISE_API_KEY");
    });
  });

  describe("delete_transaction", () => {
    it("deletes a transaction", async () => {
      const checking = await createAccount({
        name: "Checking",
        type: "asset",
        subtype: "bank",
        bookId,
      });
      const supplies = await createAccount({
        name: "Supplies",
        type: "expense",
        subtype: "other",
        bookId,
      });
      const txn = await createTransactionWithSplits({
        bookId,
        date: "2026-02-01",
        description: "To be deleted",
        splits: [
          { accountId: supplies.id, amount: 2500 },
          { accountId: checking.id, amount: -2500 },
        ],
      });

      const { data, isError } = await callTool("delete_transaction", {
        bookId,
        transactionId: txn.id,
      });

      expect(isError).toBe(false);
      expect(data.success).toBe(true);

      const rows = await getDb()
        .select()
        .from(transactions)
        .where(eq(transactions.id, txn.id));
      expect(rows).toHaveLength(0);
    });

    it("returns an error for an unknown transaction", async () => {
      const { data, isError } = await callTool("delete_transaction", {
        bookId,
        transactionId: 999999,
      });

      expect(isError).toBe(true);
      expect(data.error).toMatch(/not found/i);
    });
  });

  describe("create_security", () => {
    it("creates a security and returns it", async () => {
      const { data, isError } = await callTool("create_security", {
        bookId,
        name: "Vanguard Total Stock",
        symbol: "VTI",
        securityType: "etf",
      });

      expect(isError).toBe(false);
      expect(data.id).toBeDefined();
      expect(data.name).toBe("Vanguard Total Stock");
      expect(data.symbol).toBe("VTI");
      expect(data.securityType).toBe("etf");
      expect(data.fetchPrices).toBe(true); // DB default
    });

    it("respects fetchPrices when provided", async () => {
      const { data, isError } = await callTool("create_security", {
        bookId,
        name: "My Fund",
        symbol: "MYF",
        securityType: "mutual_fund",
        fetchPrices: false,
      });

      expect(isError).toBe(false);
      expect(data.fetchPrices).toBe(false);
    });

    it("returns isError on duplicate symbol (case-insensitive)", async () => {
      // First create succeeds
      const first = await callTool("create_security", {
        bookId,
        name: "Vanguard Total Stock",
        symbol: "VTI",
        securityType: "etf",
      });
      expect(first.isError).toBe(false);

      // Second create with different-case symbol returns isError
      const dup = await callTool("create_security", {
        bookId,
        name: "Vanguard Total Stock Market",
        symbol: "vti",
        securityType: "etf",
      });

      expect(dup.isError).toBe(true);
      expect(dup.data.error).toMatch(/already exists/i);
    });

    it("creates a fixed-price security", async () => {
      const { data, isError } = await callTool("create_security", {
        bookId,
        name: "Vanguard Federal Money Market",
        symbol: "VMFXX",
        securityType: "mutual_fund",
        fixedPriceMicros: 1_000_000,
      });

      expect(isError).toBe(false);
      expect(data.fixedPriceMicros).toBe(1_000_000);
      // createSecurity() forces fetching off so the two cannot contradict.
      expect(data.fetchPrices).toBe(false);
    });

    it("rejects a fixed price that is not a positive whole number of micros", async () => {
      // The zod schema rejects this before the handler runs, so the SDK
      // reports it as a plain-text error result rather than our JSON
      // envelope. That is the one error body callMcpTool() refuses to
      // decode, so inspect the result directly — the same way the
      // schema-boundary tests in mcp-tools.test.ts do.
      const result = await client.callTool({
        name: "create_security",
        arguments: {
          bookId,
          name: "Bad Fixed Price",
          symbol: "BADFX",
          securityType: "mutual_fund",
          fixedPriceMicros: 0,
        },
      });

      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      expect(text).toMatch(/positive whole number of micros/);
    });
  });
});
