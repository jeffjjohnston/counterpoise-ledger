import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { plaidAccounts, plaidTokens, transactions } from "@/db/schema";
import {
  setupTestDatabase,
  resetTestDatabase,
  createAccount,
  createBook,
  createPlaidAccount,
  createPlaidReconciliation,
  createPlaidToken,
  createTransactionWithSplits,
} from "@/tests/helpers/db-utils";
import { callMcpTool } from "@/tests/helpers/mcp";

// Mock MCP auth to return an authenticated user, same pattern as
// mcp-account-tools.test.ts.
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

describe("MCP Plaid Tools", () => {
  const bookId = 1;

  beforeAll(async () => {
    await setupTestDatabase();

    server = new McpServer({ name: "test", version: "0.0.1" });
    const { registerPlaidTools } = await import("@/mcp/tools/plaid");
    registerPlaidTools(server);

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

  describe("get_plaid_status", () => {
    it("get_plaid_status returns the four sections with the token masked", async () => {
      await createPlaidToken({
        bookId, financialInstitution: "Test Bank", itemId: "item-1",
        accessToken: "access-sandbox-abcdefghijklmnop",
      });

      const { data, isError } = await callTool("get_plaid_status", { bookId });

      expect(isError).toBe(false);
      expect(data.tokens[0]).toHaveProperty("accessTokenMasked");
      expect(data.tokens[0]).not.toHaveProperty("accessToken");
      expect(data).toHaveProperty("pendingCount");
      expect(data).toHaveProperty("staleUnmatched");
      expect(data).toHaveProperty("assignedAccounts");
    });
  });

  describe("list_plaid_token_accounts", () => {
    it("list_plaid_token_accounts fails for a connection in another book", async () => {
      const other = await createBook({ name: "Other Book" });
      const theirs = await createPlaidToken({
        bookId: other.id, financialInstitution: "Their Bank", itemId: "item-theirs",
        accessToken: "access-sandbox-theirs",
      });

      const { data, isError } = await callTool("list_plaid_token_accounts", {
        bookId, tokenId: theirs.id,
      });

      expect(isError).toBe(true);
      expect(data.error).toContain("not found");
    });

    // Proof for item 1: refresh must not exist on this tool's published
    // input schema, and a caller that sends it anyway must not reach Plaid.
    it("does not publish a refresh input, and never contacts Plaid even if one is sent anyway", async () => {
      const tools = (await client.listTools()).tools;
      const tool = tools.find((t) => t.name === "list_plaid_token_accounts");
      const properties = tool?.inputSchema.properties as Record<string, unknown> | undefined;
      expect(properties).not.toHaveProperty("refresh");

      const token = await createPlaidToken({
        bookId, financialInstitution: "Test Bank", itemId: "item-refresh-ignored",
        accessToken: "access-sandbox-refresh-ignored",
      });

      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const { data, isError } = await callTool("list_plaid_token_accounts", {
        bookId, tokenId: token.id, refresh: true,
      });

      expect(isError).toBe(false);
      expect(data).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();

      vi.unstubAllGlobals();
    });
  });

  describe("update_plaid_token", () => {
    it("update_plaid_token fails for a connection in another book and leaves it unchanged", async () => {
      const other = await createBook({ name: "Other Book" });
      const theirs = await createPlaidToken({
        bookId: other.id, financialInstitution: "Theirs", itemId: "item-theirs",
        accessToken: "access-sandbox-theirs",
      });

      const { data, isError } = await callTool("update_plaid_token", {
        bookId, tokenId: theirs.id, financialInstitution: "Hijacked", itemId: "item-theirs",
      });

      expect(isError).toBe(true);
      expect(data.error).toContain("not found");

      const db = getDb();
      const [row] = await db.select().from(plaidTokens).where(eq(plaidTokens.id, theirs.id));
      expect(row.financialInstitution).toBe("Theirs");
    });

    // Proof for item 2: accessToken must not exist on this tool's published
    // input schema, and a caller that sends one anyway must not change the
    // stored credential.
    it("does not publish an accessToken input, and never overwrites the stored credential even if one is sent anyway", async () => {
      const tools = (await client.listTools()).tools;
      const tool = tools.find((t) => t.name === "update_plaid_token");
      const properties = tool?.inputSchema.properties as Record<string, unknown> | undefined;
      expect(properties).not.toHaveProperty("accessToken");

      const token = await createPlaidToken({
        bookId, financialInstitution: "Original Bank", itemId: "item-token-safe",
        accessToken: "access-sandbox-original",
      });

      const { data, isError } = await callTool("update_plaid_token", {
        bookId, tokenId: token.id,
        financialInstitution: "Renamed Bank", itemId: "item-token-safe",
        accessToken: "access-sandbox-hallucinated",
      });

      expect(isError).toBe(false);
      expect(data.financialInstitution).toBe("Renamed Bank");

      const db = getDb();
      const [row] = await db.select().from(plaidTokens).where(eq(plaidTokens.id, token.id));
      expect(row.accessToken).toBe("access-sandbox-original");
    });
  });

  describe("set_plaid_token_accounts", () => {
    it("set_plaid_token_accounts fails for a connection in another book, and writes nothing", async () => {
      const other = await createBook({ name: "Other Book" });
      const theirs = await createPlaidToken({
        bookId: other.id, financialInstitution: "Theirs", itemId: "item-theirs",
        accessToken: "access-sandbox-theirs",
      });
      const theirAccount = await createAccount({
        bookId: other.id, name: "Checking", type: "asset",
      });
      const theirLink = await createPlaidAccount({
        bookId: other.id, tokenId: theirs.id, plaidAccountId: "plaid-acct-1",
        name: "Checking", type: "depository", counterpoiseAccountId: null,
      });

      const { data, isError } = await callTool("set_plaid_token_accounts", {
        bookId, tokenId: theirs.id,
        assignments: [
          { plaidAccountId: "plaid-acct-1", counterpoiseAccountId: theirAccount.id },
        ],
      });

      expect(isError).toBe(true);
      expect(data.error).toContain("not found");

      const db = getDb();
      const [row] = await db
        .select()
        .from(plaidAccounts)
        .where(eq(plaidAccounts.id, theirLink.id));
      expect(row.counterpoiseAccountId).toBeNull();
    });
  });

  describe("delete_plaid_token", () => {
    it("delete_plaid_token fails for a connection in another book and the row survives", async () => {
      const other = await createBook({ name: "Other Book" });
      const theirs = await createPlaidToken({
        bookId: other.id, financialInstitution: "Theirs", itemId: "item-theirs",
        accessToken: "access-sandbox-theirs",
      });

      const { data, isError } = await callTool("delete_plaid_token", {
        bookId, tokenId: theirs.id,
      });

      expect(isError).toBe(true);
      expect(data.error).toContain("not found");

      const db = getDb();
      const rows = await db.select().from(plaidTokens).where(eq(plaidTokens.id, theirs.id));
      expect(rows).toHaveLength(1);
    });
  });

  describe("sync_plaid_token", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("sync_plaid_token refuses a demo connection with a clear message", async () => {
      const token = await createPlaidToken({
        bookId, financialInstitution: "Demo Bank", itemId: "item-demo",
        accessToken: "access-sandbox-demo-000000", isDemo: true,
      });
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);

      const { data, isError } = await callTool("sync_plaid_token", {
        bookId, tokenId: token.id,
      });

      expect(isError).toBe(true);
      expect(data.error).toContain("demo connection");
      // The guard sits above the try block precisely so no request is made.
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe("clear_plaid_sync_data", () => {
    it("clear_plaid_sync_data fails for a connection in another book, and clears nothing", async () => {
      const other = await createBook({ name: "Other Book" });
      const theirs = await createPlaidToken({
        bookId: other.id, financialInstitution: "Theirs", itemId: "item-theirs",
        accessToken: "access-sandbox-theirs", syncCursor: "cursor-theirs",
      });

      const { data, isError } = await callTool("clear_plaid_sync_data", {
        bookId, tokenId: theirs.id,
      });

      expect(isError).toBe(true);
      expect(data.error).toContain("not found");

      const db = getDb();
      const [row] = await db.select().from(plaidTokens).where(eq(plaidTokens.id, theirs.id));
      expect(row.syncCursor).toBe("cursor-theirs");
    });
  });

  describe("list_pending_plaid_transactions", () => {
    it("list_pending_plaid_transactions returns only this book's staged rows", async () => {
      const token = await createPlaidToken({
        bookId, financialInstitution: "Chase", itemId: "item-1",
        accessToken: "access-1",
      });
      const account = await createAccount({ bookId, name: "Checking", type: "asset" });
      const link = await createPlaidAccount({
        bookId, tokenId: token.id, plaidAccountId: "plaid-acct-1",
        name: "Chase Checking", type: "depository", counterpoiseAccountId: account.id,
      });
      await createPlaidReconciliation({
        bookId, plaidAccountLinkId: link.id,
        plaidTransactionId: "plaid-txn-1", date: "2026-02-01",
        amountCents: -4200, name: "Coffee Shop",
        resolutionStatus: "pending",
      });

      const other = await createBook({ name: "Other Book" });
      const theirToken = await createPlaidToken({
        bookId: other.id, financialInstitution: "Theirs", itemId: "item-theirs",
        accessToken: "access-theirs",
      });
      const theirAccount = await createAccount({
        bookId: other.id, name: "Checking", type: "asset",
      });
      const theirLink = await createPlaidAccount({
        bookId: other.id, tokenId: theirToken.id, plaidAccountId: "plaid-acct-theirs",
        name: "Their Checking", type: "depository", counterpoiseAccountId: theirAccount.id,
      });
      await createPlaidReconciliation({
        bookId: other.id, plaidAccountLinkId: theirLink.id,
        plaidTransactionId: "plaid-txn-1", date: "2026-02-01",
        amountCents: -4200, name: "Coffee Shop",
        resolutionStatus: "pending",
      });

      const { data, isError } = await callTool("list_pending_plaid_transactions", { bookId });

      expect(isError).toBe(false);
      expect(data).toHaveLength(1);
      expect(data[0].description).toBe("Coffee Shop");
    });
  });

  describe("unlink_plaid_transaction", () => {
    it("unlink_plaid_transaction fails for a transaction in another book and leaves it reconciled", async () => {
      const other = await createBook({ name: "Other Book" });
      const theirToken = await createPlaidToken({
        bookId: other.id, financialInstitution: "Theirs", itemId: "item-theirs",
        accessToken: "access-theirs",
      });
      const theirChecking = await createAccount({
        bookId: other.id, name: "Checking", type: "asset",
      });
      const theirGroceries = await createAccount({
        bookId: other.id, name: "Groceries", type: "expense",
      });
      const theirLink = await createPlaidAccount({
        bookId: other.id, tokenId: theirToken.id, plaidAccountId: "plaid-acct-theirs",
        name: "Their Checking", type: "depository", counterpoiseAccountId: theirChecking.id,
      });
      const theirTxn = await createTransactionWithSplits({
        bookId: other.id, date: "2026-02-01", description: "Grocery Store",
        isReconciled: true,
        splits: [
          { accountId: theirChecking.id, amount: -2000 },
          { accountId: theirGroceries.id, amount: 2000 },
        ],
      });
      await createPlaidReconciliation({
        bookId: other.id, plaidAccountLinkId: theirLink.id,
        plaidTransactionId: "plaid-txn-theirs", date: "2026-02-01",
        amountCents: -2000, name: "GROCERY STORE",
        resolutionStatus: "matched",
        matchedTransactionId: theirTxn.id,
      });

      const { data, isError } = await callTool("unlink_plaid_transaction", {
        bookId, transactionId: theirTxn.id,
      });

      expect(isError).toBe(true);
      expect(data.error).toContain("No Plaid link found");

      const db = getDb();
      const [row] = await db.select().from(transactions).where(eq(transactions.id, theirTxn.id));
      expect(row.isReconciled).toBe(true);
    });
  });
});
