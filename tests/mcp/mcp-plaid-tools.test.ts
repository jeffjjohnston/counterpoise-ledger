import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
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
import { connectMcpTestClient, type McpTestClient } from "@/tests/helpers/mcp-client";
import { count, row } from "@/tests/helpers/sql";
import type { PlaidAccount, PlaidToken, Transaction } from "@/types/db";

let mcp: McpTestClient;

const callTool = (name: string, args: Record<string, unknown> = {}) =>
  callMcpTool(mcp.client, name, args);

// A fake Plaid API that records each request. A stubbed global fetch does not
// reach the Rust process, and the Rust server reads its Plaid settings when
// it starts, so the server gets this URL in its environment. Every
// /transactions/sync call gets an empty page.
const plaidRequests: string[] = [];
let plaid: Server;

async function startPlaid() {
  plaid = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      plaidRequests.push(request.url ?? "");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          added: [], modified: [], removed: [], has_more: false,
          next_cursor: "cursor-next", request_id: "r",
        })
      );
    });
  });
  await new Promise<void>((resolve) => plaid.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(plaid.address() as AddressInfo).port}`;
}

describe("MCP Plaid Tools", () => {
  const bookId = 1;

  beforeAll(async () => {
    await setupTestDatabase();

    const env = {
      PLAID_CLIENT_ID: "client-id",
      PLAID_SECRET: "plaid-secret",
      PLAID_ENV: "sandbox",
      PLAID_API_URL: await startPlaid(),
    };
    Object.assign(process.env, env);
    mcp = await connectMcpTestClient({ env });
  }, 120_000);

  beforeEach(async () => {
    await resetTestDatabase();
    plaidRequests.length = 0;
  });

  afterAll(async () => {
    await mcp.close();
    await new Promise<void>((resolve) => plaid.close(() => resolve()));
    for (const name of ["PLAID_CLIENT_ID", "PLAID_SECRET", "PLAID_ENV", "PLAID_API_URL"]) {
      delete process.env[name];
    }
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
      expect(data.error).toBe(`Plaid token ${theirs.id} not found`);
    });

    // Proof for item 1: refresh must not exist on this tool's published
    // input schema, and a caller that sends it anyway must not reach Plaid.
    it("does not publish a refresh input, and never contacts Plaid even if one is sent anyway", async () => {
      const tools = (await mcp.client.listTools()).tools;
      const tool = tools.find((t) => t.name === "list_plaid_token_accounts");
      const properties = tool?.inputSchema.properties as Record<string, unknown> | undefined;
      expect(properties).not.toHaveProperty("refresh");

      const token = await createPlaidToken({
        bookId, financialInstitution: "Test Bank", itemId: "item-refresh-ignored",
        accessToken: "access-sandbox-refresh-ignored",
      });

      const { data, isError } = await callTool("list_plaid_token_accounts", {
        bookId, tokenId: token.id, refresh: true,
      });

      expect(isError).toBe(false);
      expect(data).toEqual([]);
      expect(plaidRequests).toEqual([]);
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
      expect(data.error).toBe(`Plaid token ${theirs.id} not found`);

      const stored = await row<PlaidToken>("SELECT * FROM plaid_tokens WHERE id = $1", [theirs.id]);
      expect(stored.financialInstitution).toBe("Theirs");
    });

    // Proof for item 2: accessToken must not exist on this tool's published
    // input schema, and a caller that sends one anyway must not change the
    // stored credential.
    it("does not publish an accessToken input, and never overwrites the stored credential even if one is sent anyway", async () => {
      const tools = (await mcp.client.listTools()).tools;
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

      const stored = await row<PlaidToken>("SELECT * FROM plaid_tokens WHERE id = $1", [token.id]);
      expect(stored.accessToken).toBe("access-sandbox-original");
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
      expect(data.error).toBe(`Plaid token ${theirs.id} not found`);

      const stored = await row<PlaidAccount>("SELECT * FROM plaid_accounts WHERE id = $1", [theirLink.id]);
      expect(stored.counterpoiseAccountId).toBeNull();
    });
  });

  describe("zod rules the JSON Schema cannot hold", () => {
    // zod trims before min(1) and refuses repeats; the published JSON Schema
    // holds neither, so the Rust server checks them before its schema check.
    // Each refusal is the SDK's plain-text input error.
    async function inputError(name: string, args: Record<string, unknown>) {
      const result = await mcp.client.callTool({ name, arguments: args });
      expect(result.isError).toBe(true);
      return (result.content as Array<{ type: string; text: string }>)[0].text;
    }

    it("refuses a token field of only whitespace", async () => {
      const text = await inputError("update_plaid_token", {
        bookId, tokenId: 1, financialInstitution: "  ", itemId: "item",
      });
      expect(text).toMatch(/^MCP error -32602: Input validation error: .*financialInstitution and itemId are required/s);
    });

    it("refuses a repeated plaidAccountId, as trimmed, and a repeated counterpoiseAccountId", async () => {
      const repeatedPlaid = await inputError("set_plaid_token_accounts", {
        bookId, tokenId: 1,
        assignments: [
          { plaidAccountId: "acct", counterpoiseAccountId: 1 },
          { plaidAccountId: " acct ", counterpoiseAccountId: 2 },
        ],
      });
      expect(repeatedPlaid).toMatch(/^MCP error -32602: Input validation error: .*Duplicate plaidAccountId in assignments/s);

      const repeatedLocal = await inputError("set_plaid_token_accounts", {
        bookId, tokenId: 1,
        assignments: [
          { plaidAccountId: "a", counterpoiseAccountId: 1 },
          { plaidAccountId: "b", counterpoiseAccountId: 1 },
          { plaidAccountId: "c", counterpoiseAccountId: null },
          { plaidAccountId: "d", counterpoiseAccountId: null },
        ],
      });
      expect(repeatedLocal).toMatch(
        /^MCP error -32602: Input validation error: .*A Counterpoise account cannot be assigned to more than one Plaid account/s
      );

      const blank = await inputError("set_plaid_token_accounts", {
        bookId, tokenId: 1, assignments: [{ plaidAccountId: " ", counterpoiseAccountId: 1 }],
      });
      expect(blank).toMatch(/^MCP error -32602: Input validation error: .*Each assignment must include plaidAccountId/s);

      // A null item, and an item with no counterpoiseAccountId: the failure
      // is the item's field, not the array.
      const nullItem = await inputError("set_plaid_token_accounts", {
        bookId, tokenId: 1, assignments: [null],
      });
      expect(nullItem).toMatch(/^MCP error -32602: Input validation error: .*Each assignment must include plaidAccountId/s);
      expect(nullItem).not.toMatch(/assignments must be an array/);

      const missingLocal = await inputError("set_plaid_token_accounts", {
        bookId, tokenId: 1, assignments: [{ plaidAccountId: "a" }],
      });
      expect(missingLocal).toMatch(
        /^MCP error -32602: Input validation error: .*counterpoiseAccountId must be a positive integer or null/s
      );

      // zod checks every item before it looks for repeats, so a malformed
      // item wins over a repeated counterpoiseAccountId.
      const malformedAndRepeated = await inputError("set_plaid_token_accounts", {
        bookId, tokenId: 1,
        assignments: [
          { plaidAccountId: "a", counterpoiseAccountId: 1 },
          { plaidAccountId: "b", counterpoiseAccountId: 1 },
          { counterpoiseAccountId: 2 },
        ],
      });
      expect(malformedAndRepeated).toMatch(/Each assignment must include plaidAccountId/);
      expect(malformedAndRepeated).not.toMatch(/more than one Plaid account/);

      const badLocal = await inputError("set_plaid_token_accounts", {
        bookId, tokenId: 1, assignments: [{ plaidAccountId: "a", counterpoiseAccountId: 0 }],
      });
      expect(badLocal).toMatch(
        /^MCP error -32602: Input validation error: .*counterpoiseAccountId must be a positive integer or null/s
      );
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
      expect(data.error).toBe(`Plaid token ${theirs.id} not found`);

      expect(await count("plaid_tokens", "id = $1", [theirs.id])).toBe(1);
    });
  });

  describe("sync_plaid_token", () => {
    it("sync_plaid_token refuses a demo connection with a clear message", async () => {
      const token = await createPlaidToken({
        bookId, financialInstitution: "Demo Bank", itemId: "item-demo",
        accessToken: "access-sandbox-demo-000000", isDemo: true,
      });
      const { data, isError } = await callTool("sync_plaid_token", {
        bookId, tokenId: token.id,
      });

      expect(isError).toBe(true);
      expect(data.error).toBe("This is a demo connection and cannot sync with Plaid");
      // The guard sits above the try block precisely so no request is made.
      expect(plaidRequests).toEqual([]);
    });

    it("syncs a linked connection through Plaid and reports the counts", async () => {
      const checking = await createAccount({ name: "Checking", type: "asset", subtype: "bank", bookId });
      const token = await createPlaidToken({
        bookId, financialInstitution: "Test Bank", itemId: "item-sync", accessToken: "access-sandbox-sync",
      });
      await createPlaidAccount({
        tokenId: token.id, plaidAccountId: "plaid-checking", name: "Checking", type: "depository",
        counterpoiseAccountId: checking.id,
      });

      const { data, isError } = await callTool("sync_plaid_token", { bookId, tokenId: token.id });

      expect(isError).toBe(false);
      expect(data).toMatchObject({
        synced: { added: 0, modified: 0, removed: 0 },
        autoMatched: 0,
        pendingCount: 0,
        reviewCount: 0,
      });
      expect(Object.keys(data)).toEqual(["synced", "autoMatched", "lastSyncedAt", "pendingCount", "reviewCount"]);
      expect(plaidRequests).toContain("/transactions/sync");
    });

    it("refuses a connection with no linked account", async () => {
      const token = await createPlaidToken({
        bookId, financialInstitution: "Bare Bank", itemId: "item-bare", accessToken: "access-sandbox-bare",
      });

      const { data, isError } = await callTool("sync_plaid_token", { bookId, tokenId: token.id });

      expect(isError).toBe(true);
      expect(data.error).toBe("No linked accounts found for this token");
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
      expect(data.error).toBe(`Plaid token ${theirs.id} not found`);

      const stored = await row<PlaidToken>("SELECT * FROM plaid_tokens WHERE id = $1", [theirs.id]);
      expect(stored.syncCursor).toBe("cursor-theirs");
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

      // accountId is z.coerce.number(): a numeric string filters as the
      // number does, and the JSON Schema alone would refuse it.
      const asString = await callTool("list_pending_plaid_transactions", {
        bookId, accountId: String(account.id),
      });
      expect(asString.isError).toBe(false);
      expect(asString.data).toEqual(data);
      const otherAccount = await callTool("list_pending_plaid_transactions", {
        bookId, accountId: String(account.id + 1000),
      });
      expect(otherAccount.data).toEqual([]);

      const bad = await mcp.client.callTool({
        name: "list_pending_plaid_transactions",
        arguments: { bookId, accountId: "abc" },
      });
      expect(bad.isError).toBe(true);
      expect((bad.content as Array<{ text: string }>)[0].text).toMatch(
        /^MCP error -32602: Input validation error: .*Invalid accountId/s
      );
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

      const stored = await row<Transaction>("SELECT * FROM transactions WHERE id = $1", [theirTxn.id]);
      expect(stored.isReconciled).toBe(true);
    });
  });
});
