import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import {
  setupTestDatabase,
  resetTestDatabase,
  createAccount,
  createTransactionWithSplits,
  createUser,
} from "@/tests/helpers/db-utils";
import { callMcpTool } from "@/tests/helpers/mcp";
import { connectMcpTestClient, type McpTestClient } from "@/tests/helpers/mcp-client";
import { getDb } from "@/db";
import { transactions } from "@/db/schema";
import { eq } from "drizzle-orm";

let mcp: McpTestClient;

const callTool = (name: string, args: Record<string, unknown> = {}) =>
  callMcpTool(mcp.client, name, args);

describe("MCP Write Transaction Tools", () => {
  const bookId = 1;

  beforeAll(async () => {
    await setupTestDatabase();

    mcp = await connectMcpTestClient();
  }, 120_000);

  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await mcp.close();
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

    // The key check itself is in rust-transport.test.ts and rust-stdio.test.ts.
    it("returns book access error when not authorized", async () => {
      const stranger = await createUser({ username: "stranger" });
      const { data, isError } = await mcp.callAs(stranger.id, "create_transaction", {
        bookId,
        date: "2025-01-15",
        splits: [
          { accountId: 1, amount: 5000 },
          { accountId: 2, amount: -5000 },
        ],
      });

      expect(isError).toBe(true);
      expect(data).toEqual({ error: "You do not have access to this book" });
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
  });

  describe("update_transaction conflict check", () => {
    it("fails with the conflict message for a stale expectedUpdatedAt", async () => {
      const checking = await createAccount({ name: "Checking", type: "asset", subtype: "bank", bookId });
      const groceries = await createAccount({ name: "Groceries", type: "expense", subtype: "other", bookId });

      const created = await callTool("create_transaction", {
        bookId, date: "2026-01-01", description: "A",
        splits: [{ accountId: groceries.id, amount: 100 }, { accountId: checking.id, amount: -100 }],
      });
      const stale = created.data.updatedAt;
      await new Promise((r) => setTimeout(r, 5));
      await callTool("update_transaction", { bookId, transactionId: created.data.id, description: "B" });
      const { data, isError } = await callTool("update_transaction", {
        bookId, transactionId: created.data.id, description: "C", expectedUpdatedAt: stale,
      });
      expect(isError).toBe(true);
      expect(data).toEqual({ error: "Another user changed this transaction. Showing the latest version." });
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
      // Without expectedUpdatedAt, the library's delete names the
      // transaction and the book; the HTTP route does not.
      expect(data.error).toBe(`Transaction 999999 not found in book ${bookId}`);
    });

    // expectedUpdatedAt makes the delete conditional. These tests use the
    // tools to create and change the row, so updatedAt comes from the tool
    // output as a client sees it.
    async function createThroughTool() {
      const checking = await createAccount({ name: "Checking", type: "asset", subtype: "bank", bookId });
      const groceries = await createAccount({ name: "Groceries", type: "expense", subtype: "other", bookId });
      const created = await callTool("create_transaction", {
        bookId, date: "2026-01-01", description: "A",
        splits: [{ accountId: groceries.id, amount: 100 }, { accountId: checking.id, amount: -100 }],
      });
      expect(created.isError).toBe(false);
      return created.data as { id: number; updatedAt: string };
    }

    async function rowExists(id: number) {
      const rows = await getDb().select().from(transactions).where(eq(transactions.id, id));
      return rows.length === 1;
    }

    it("deletes when expectedUpdatedAt matches the row", async () => {
      const created = await createThroughTool();
      const { data, isError } = await callTool("delete_transaction", {
        bookId, transactionId: created.id, expectedUpdatedAt: created.updatedAt,
      });
      expect(isError).toBe(false);
      expect(data).toEqual({ success: true, transactionId: created.id });
      expect(await rowExists(created.id)).toBe(false);
    });

    it("fails with the conflict message for a stale expectedUpdatedAt, and keeps the row", async () => {
      const created = await createThroughTool();
      await new Promise((r) => setTimeout(r, 5));
      const changed = await callTool("update_transaction", {
        bookId, transactionId: created.id, description: "B",
      });
      expect(changed.isError).toBe(false);
      expect(changed.data.updatedAt).not.toBe(created.updatedAt);

      const { data, isError } = await callTool("delete_transaction", {
        bookId, transactionId: created.id, expectedUpdatedAt: created.updatedAt,
      });
      expect(isError).toBe(true);
      expect(data).toEqual({ error: "Another user changed this transaction. Showing the latest version." });
      expect(await rowExists(created.id)).toBe(true);
    });

    // The HTTP route parses the same value with expectedUpdatedAtQuerySchema
    // and answers 400 with this message. The tool must refuse the same input
    // with the same message. The SDK refuses it before the handler runs, so
    // the body is plain text, not the JSON envelope from fail().
    it("refuses a malformed expectedUpdatedAt with the HTTP route's message, and keeps the row", async () => {
      const created = await createThroughTool();
      const result = await mcp.client.callTool({
        name: "delete_transaction",
        arguments: { bookId, transactionId: created.id, expectedUpdatedAt: "yesterday" },
      });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      expect(text).toContain("expectedUpdatedAt must be an ISO timestamp");
      expect(await rowExists(created.id)).toBe(true);
    });
  });

  describe("expectedUpdatedAt", () => {
    it("says a missing transaction is not found, as the lock check says it", async () => {
      const { data, isError } = await callTool("delete_transaction", {
        bookId,
        transactionId: 999999,
        expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
      });

      expect(isError).toBe(true);
      expect(data.error).toBe("Transaction not found");
    });

    it("refuses an offset and a non-string with zod's message", async () => {
      // z.iso.datetime() refuses an offset, which the JSON Schema date-time
      // format accepts, and gives its custom message for any failure.
      for (const [name, extra] of [
        ["delete_transaction", {}],
        ["update_transaction", { description: "B" }],
      ] as const) {
        for (const expectedUpdatedAt of ["2026-01-01T00:00:00+02:00", 5]) {
          const result = await mcp.client.callTool({
            name,
            arguments: { bookId, transactionId: 1, expectedUpdatedAt, ...extra },
          });
          expect(result.isError).toBe(true);
          const text = (result.content as Array<{ type: string; text: string }>)[0].text;
          expect(text).toMatch(/^MCP error -32602: Input validation error: .*expectedUpdatedAt must be an ISO timestamp/s);
        }
      }
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
      const result = await mcp.client.callTool({
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
