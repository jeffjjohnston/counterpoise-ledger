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
import { getDb } from "@/db";
import { accounts } from "@/db/schema";
import { and, eq } from "drizzle-orm";

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

async function callTool(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const isError = result.isError ?? false;
  const textContent = (result.content as Array<{ type: string; text: string }>)?.find(
    (c) => c.type === "text"
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let data: any;
  if (isError) {
    // A schema-level rejection is caught at the MCP SDK boundary before the
    // handler runs, so the body is the SDK's plain-text message rather than
    // our JSON envelope. Only error results can legitimately be non-JSON —
    // fall back to wrapping the raw text the same way fail() would.
    try {
      data = textContent ? JSON.parse(textContent.text) : undefined;
    } catch {
      data = { error: textContent?.text };
    }
  } else {
    // A success result is always our own ok(), so it is always JSON. Leave
    // this path exactly as strict as it always was: a non-JSON body here is
    // a real bug and should throw loudly, not degrade silently.
    data = textContent ? JSON.parse(textContent.text) : undefined;
  }
  return { data, isError };
}

describe("MCP Account Tools", () => {
  const bookId = 1;

  beforeAll(async () => {
    await setupTestDatabase();

    server = new McpServer({ name: "test", version: "0.0.1" });
    const { registerAccountTools } = await import("@/mcp/tools/accounts");
    registerAccountTools(server);

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

  describe("create_account", () => {
    it("creates an account", async () => {
      const { data, isError } = await callTool("create_account", {
        bookId,
        name: "Checking",
        type: "asset",
        subtype: "bank",
      });

      expect(isError).toBe(false);
      expect(data.id).toBeDefined();
      expect(data.name).toBe("Checking");
      expect(data.bookId).toBe(bookId);
    });

    it("creates the paired cash sub-account for an investment account", async () => {
      const { data, isError } = await callTool("create_account", {
        bookId,
        name: "Brokerage",
        type: "asset",
        subtype: "investment",
      });

      expect(isError).toBe(false);

      const children = await getDb()
        .select()
        .from(accounts)
        .where(and(eq(accounts.parentId, data.id), eq(accounts.bookId, bookId)));
      expect(children).toHaveLength(1);
      expect(children[0].isInvestmentCash).toBe(true);
      expect(children[0].name).toBe("Brokerage Cash");
    });

    it("returns an error for an invalid parentId", async () => {
      const { data, isError } = await callTool("create_account", {
        bookId,
        name: "Child",
        type: "asset",
        subtype: "bank",
        parentId: 999999,
      });

      expect(isError).toBe(true);
      expect(data.error).toMatch(/parentId/i);
    });
  });

  describe("update_account", () => {
    it("updates an account's fields", async () => {
      const checking = await createAccount({
        name: "Checking",
        type: "asset",
        subtype: "bank",
        bookId,
      });

      const { data, isError } = await callTool("update_account", {
        bookId,
        accountId: checking.id,
        name: "Primary Checking",
        isFavorite: true,
      });

      expect(isError).toBe(false);
      expect(data.name).toBe("Primary Checking");
      expect(data.isFavorite).toBe(true);
    });

    it("returns an error for an unknown account", async () => {
      const { data, isError } = await callTool("update_account", {
        bookId,
        accountId: 999999,
        name: "Renamed",
      });

      expect(isError).toBe(true);
      expect(data.error).toMatch(/not found/i);
    });
  });

  describe("delete_account", () => {
    it("refuses to delete an account with transactions", async () => {
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
      await createTransactionWithSplits({
        bookId,
        date: "2026-01-15",
        description: "Food",
        splits: [
          { accountId: groceries.id, amount: 500 },
          { accountId: checking.id, amount: -500 },
        ],
      });

      const { data, isError } = await callTool("delete_account", {
        bookId,
        accountId: checking.id,
      });

      expect(isError).toBe(true);
      expect(data.error).toMatch(/transactions/i);
    });

    it("deletes an empty account", async () => {
      const spare = await createAccount({
        name: "Spare",
        type: "expense",
        subtype: "other",
        bookId,
      });

      const { data, isError } = await callTool("delete_account", {
        bookId,
        accountId: spare.id,
      });

      expect(isError).toBe(false);
      expect(data.success).toBe(true);

      const rows = await getDb().select().from(accounts).where(eq(accounts.id, spare.id));
      expect(rows).toHaveLength(0);
    });

    it("returns an error for an unknown account", async () => {
      const { data, isError } = await callTool("delete_account", {
        bookId,
        accountId: 999999,
      });

      expect(isError).toBe(true);
      expect(data.error).toMatch(/not found/i);
    });
  });
});
