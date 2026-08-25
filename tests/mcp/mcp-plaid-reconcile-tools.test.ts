import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { transactions } from "@/db/schema";
import {
  setupTestDatabase,
  resetTestDatabase,
  createAccount,
  createPlaidAccount,
  createPlaidReconciliation,
  createPlaidToken,
  createTransactionWithSplits,
} from "@/tests/helpers/db-utils";

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
  // `raw` is the untouched wire text. fail() emits genuine JSON
  // (JSON.stringify({ error: message })); an uncaught error thrown past
  // fail() reaches the client as the SDK's own plain-text wrapping, which
  // `data`'s catch fallback above quietly reshapes to look the same. Only
  // `raw` lets a test tell those two paths apart.
  return { data, isError, raw: textContent?.text };
}

describe("MCP Plaid reconcile tools", () => {
  const bookId = 1;

  beforeAll(async () => {
    await setupTestDatabase();

    server = new McpServer({ name: "test", version: "0.0.1" });
    const { registerPlaidReconcileTools } = await import("@/mcp/tools/plaid-reconcile");
    registerPlaidReconcileTools(server);

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

  it("returns the queue with ranked candidates", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const groceries = await createAccount({ name: "Groceries", type: "expense" });

    const token = await createPlaidToken({
      financialInstitution: "Chase",
      itemId: "item-mcp-1",
      accessToken: "token",
    });
    const link = await createPlaidAccount({
      tokenId: token.id,
      plaidAccountId: "plaid-mcp-1",
      name: "Plaid Checking",
      type: "depository",
      subtype: "checking",
      counterpoiseAccountId: checking.id,
    });

    const txn = await createTransactionWithSplits({
      date: "2026-02-08",
      description: "Blue Bottle",
      splits: [
        { accountId: checking.id, amount: -1500 },
        { accountId: groceries.id, amount: 1500 },
      ],
    });
    await createPlaidReconciliation({
      plaidAccountLinkId: link.id,
      plaidTransactionId: "txn-mcp-1",
      date: "2026-02-08",
      amountCents: 1500,
      name: "BLUE BOTTLE",
      merchantName: null,
      resolutionStatus: "pending",
    });

    const { data, isError } = await callTool("get_reconcile_candidates", {
      bookId,
      plaidAccountLinkId: link.id,
    });

    expect(isError).toBe(false);
    expect(data.totalCount).toBe(1);
    expect(data.items[0].candidates[0].transactionId).toBe(txn.id);
  });

  it("fails cleanly for an unknown link", async () => {
    const { data, isError, raw } = await callTool("get_reconcile_candidates", {
      bookId,
      plaidAccountLinkId: 987654,
    });

    expect(isError).toBe(true);
    expect(data.error).toBe("Linked sync account not found");
    // Proves this came from fail(), not an uncaught throw the SDK wrapped as
    // plain text and the callTool fallback reshaped to look the same. fail()
    // is the only path that puts real JSON on the wire.
    expect(JSON.parse(raw!)).toEqual({ error: "Linked sync account not found" });
  });

  it("fails cleanly for a link on a non-reconcilable account", async () => {
    const groceries = await createAccount({ name: "Groceries", type: "expense" });
    const token = await createPlaidToken({
      financialInstitution: "Chase",
      itemId: "item-mcp-2",
      accessToken: "token",
    });
    const link = await createPlaidAccount({
      tokenId: token.id,
      plaidAccountId: "plaid-mcp-2",
      name: "Plaid Guard",
      type: "depository",
      subtype: "checking",
      counterpoiseAccountId: groceries.id,
    });

    const { data, isError, raw } = await callTool("get_reconcile_candidates", {
      bookId,
      plaidAccountLinkId: link.id,
    });

    const message =
      "Only asset or liability Counterpoise accounts can be reconciled against Plaid transactions";
    expect(isError).toBe(true);
    expect(data.error).toBe(message);
    // Same proof as above, for the validation-error branch.
    expect(JSON.parse(raw!)).toEqual({ error: message });
  });

  it("matches a transaction and marks it reconciled", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const groceries = await createAccount({ name: "Groceries", type: "expense" });

    const token = await createPlaidToken({
      financialInstitution: "Chase",
      itemId: "item-mcp-3",
      accessToken: "token",
    });
    const link = await createPlaidAccount({
      tokenId: token.id,
      plaidAccountId: "plaid-mcp-3",
      name: "Plaid Checking",
      type: "depository",
      subtype: "checking",
      counterpoiseAccountId: checking.id,
    });

    const txn = await createTransactionWithSplits({
      date: "2026-02-08",
      description: "Blue Bottle",
      splits: [
        { accountId: checking.id, amount: -1500 },
        { accountId: groceries.id, amount: 1500 },
      ],
    });
    const recon = await createPlaidReconciliation({
      plaidAccountLinkId: link.id,
      plaidTransactionId: "txn-mcp-3",
      date: "2026-02-08",
      amountCents: 1500,
      name: "BLUE BOTTLE",
      merchantName: null,
      resolutionStatus: "pending",
    });

    const { data, isError } = await callTool("reconcile_plaid_transaction", {
      bookId,
      plaidAccountLinkId: link.id,
      reconciliationId: recon.id,
      action: "match",
      transactionId: txn.id,
    });

    expect(isError).toBe(false);
    expect(data.resolutionStatus).toBe("matched");

    const stored = await getDb().query.transactions.findFirst({
      where: eq(transactions.id, txn.id),
    });
    expect(stored?.isReconciled).toBe(true);
  });

  it("enforces the action's required field, which spreading the schema drops", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const token = await createPlaidToken({
      financialInstitution: "Chase",
      itemId: "item-mcp-4",
      accessToken: "token",
    });
    const link = await createPlaidAccount({
      tokenId: token.id,
      plaidAccountId: "plaid-mcp-4",
      name: "Plaid Checking",
      type: "depository",
      subtype: "checking",
      counterpoiseAccountId: checking.id,
    });
    const recon = await createPlaidReconciliation({
      plaidAccountLinkId: link.id,
      plaidTransactionId: "txn-mcp-4",
      date: "2026-02-08",
      amountCents: 1500,
      name: "BLUE BOTTLE",
      merchantName: null,
      resolutionStatus: "pending",
    });

    // toolShape() spreads .shape and drops reconcileSchema's superRefine, so
    // this rule reaches the tool only through resolveReconciliation(). Without
    // it the call would reach Drizzle with an undefined transactionId.
    const { data, isError, raw } = await callTool("reconcile_plaid_transaction", {
      bookId,
      plaidAccountLinkId: link.id,
      reconciliationId: recon.id,
      action: "match",
    });

    expect(isError).toBe(true);
    expect(data.error).toBe("transactionId is required for match");
    // Proves this came from fail(), not an uncaught throw the SDK wrapped as
    // plain text and the callTool fallback reshaped to look the same.
    expect(JSON.parse(raw!)).toEqual({ error: "transactionId is required for match" });
  });

  it("ignores a staged transaction", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const token = await createPlaidToken({
      financialInstitution: "Chase",
      itemId: "item-mcp-5",
      accessToken: "token",
    });
    const link = await createPlaidAccount({
      tokenId: token.id,
      plaidAccountId: "plaid-mcp-5",
      name: "Plaid Checking",
      type: "depository",
      subtype: "checking",
      counterpoiseAccountId: checking.id,
    });
    const recon = await createPlaidReconciliation({
      plaidAccountLinkId: link.id,
      plaidTransactionId: "txn-mcp-5",
      date: "2026-02-08",
      amountCents: 1500,
      name: "BLUE BOTTLE",
      merchantName: null,
      resolutionStatus: "pending",
    });

    const { data, isError } = await callTool("reconcile_plaid_transaction", {
      bookId,
      plaidAccountLinkId: link.id,
      reconciliationId: recon.id,
      action: "ignore",
    });

    expect(isError).toBe(false);
    expect(data.resolutionStatus).toBe("ignored");
  });
});
