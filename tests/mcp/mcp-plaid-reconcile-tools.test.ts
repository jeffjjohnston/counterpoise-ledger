import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
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
import { callMcpTool } from "@/tests/helpers/mcp";
import { connectMcpTestClient, type McpTestClient } from "@/tests/helpers/mcp-client";

// The client sends a real key of user 1, who owns book 1.
let mcp: McpTestClient;

const callTool = (name: string, args: Record<string, unknown> = {}) =>
  callMcpTool(mcp.client, name, args);

describe("MCP Plaid reconcile tools", () => {
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

  it("returns the queue for every linked account when no link is given", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const card = await createAccount({ name: "Card", type: "liability" });
    const links = [];
    for (const [accountId, suffix] of [
      [checking.id, "checking"],
      [card.id, "card"],
    ] as const) {
      const token = await createPlaidToken({
        financialInstitution: "Chase",
        itemId: `item-mcp-all-${suffix}`,
        accessToken: "token",
      });
      links.push(
        await createPlaidAccount({
          tokenId: token.id,
          plaidAccountId: `plaid-mcp-all-${suffix}`,
          name: suffix,
          type: "depository",
          counterpoiseAccountId: accountId,
        })
      );
    }
    await createPlaidReconciliation({
      plaidAccountLinkId: links[0].id,
      plaidTransactionId: "older",
      date: "2026-02-01",
      amountCents: 100,
      name: "OLDER",
    });
    await createPlaidReconciliation({
      plaidAccountLinkId: links[1].id,
      plaidTransactionId: "newer",
      date: "2026-02-02",
      amountCents: 200,
      name: "NEWER",
    });

    const { data, isError } = await callTool("get_reconcile_candidates", { bookId });

    expect(isError).toBe(false);
    expect(data.totalCount).toBe(2);
    expect(
      data.items.map((item: { plaidTransactionId: string; plaidAccountLinkId: number }) => [
        item.plaidTransactionId,
        item.plaidAccountLinkId,
      ])
    ).toEqual([
      ["newer", links[1].id],
      ["older", links[0].id],
    ]);
  });

  it("fails cleanly for an unknown link", async () => {
    const { data, isError } = await callTool("get_reconcile_candidates", {
      bookId,
      plaidAccountLinkId: 987654,
    });

    expect(isError).toBe(true);
    expect(data.error).toBe("Linked sync account not found");
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

    const { data, isError } = await callTool("get_reconcile_candidates", {
      bookId,
      plaidAccountLinkId: link.id,
    });

    const message =
      "Only asset or liability Counterpoise accounts can be reconciled against Plaid transactions";
    expect(isError).toBe(true);
    expect(data.error).toBe(message);
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

    // The tool's JSON Schema cannot hold reconcileSchema's superRefine, so
    // this rule reaches the tool only through the route. Without it the call
    // would reach the database with no transactionId.
    const { data, isError } = await callTool("reconcile_plaid_transaction", {
      bookId,
      plaidAccountLinkId: link.id,
      reconciliationId: recon.id,
      action: "match",
    });

    expect(isError).toBe(true);
    expect(data.error).toBe("transactionId is required for match");
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
