import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import {
  setupTestDatabase,
  resetTestDatabase,
  createAccount,
  createTransactionWithSplits,
} from "@/tests/helpers/db-utils";
import { callMcpTool } from "@/tests/helpers/mcp";
import { connectMcpTestClient, type McpTestClient } from "@/tests/helpers/mcp-client";
import { getDb } from "@/db";
import { accounts } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { toDateString } from "@/lib/formatters";

let mcp: McpTestClient;

const callTool = (name: string, args: Record<string, unknown> = {}) =>
  callMcpTool(mcp.client, name, args);

/** The text of a result that the SDK reports as plain text, not fail()'s JSON. */
async function rawCall(name: string, args: Record<string, unknown>) {
  const result = await mcp.client.callTool({ name, arguments: args });
  const [content] = result.content as Array<{ type: string; text: string }>;
  return { isError: Boolean(result.isError), text: content.text };
}

describe("MCP Account Tools", () => {
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

  // ---------- list_accounts ----------
  describe("list_accounts", () => {
    it("returns all active accounts with balances", async () => {
      const checking = await createAccount({ name: "Checking", type: "asset", subtype: "bank" });
      const groceries = await createAccount({ name: "Groceries", type: "expense" });

      // Debit checking +5000, credit groceries -5000
      await createTransactionWithSplits({
        date: "2025-01-15",
        description: "Grocery shopping",
        splits: [
          { accountId: checking.id, amount: -5000 },
          { accountId: groceries.id, amount: 5000 },
        ],
      });

      const { data, isError } = await callTool("list_accounts", { bookId: 1 });

      expect(isError).toBe(false);
      expect(data).toHaveLength(2);

      const checkingResult = data.find((a: { name: string }) => a.name === "Checking");
      const groceriesResult = data.find((a: { name: string }) => a.name === "Groceries");

      // Checking: raw balance -5000, asset is debit-normal so displayBalance = -5000
      expect(checkingResult.balanceCents).toBe(-5000);
      expect(checkingResult.displayBalance).toBe(-5000);
      expect(checkingResult.formattedBalance).toBe("−$50.00");

      // Groceries: raw balance +5000, expense is debit-normal so displayBalance = 5000
      expect(groceriesResult.balanceCents).toBe(5000);
      expect(groceriesResult.displayBalance).toBe(5000);
      expect(groceriesResult.formattedBalance).toBe("$50.00");
    });

    it("filters by account type", async () => {
      await createAccount({ name: "Checking", type: "asset", subtype: "bank" });
      await createAccount({ name: "Groceries", type: "expense" });

      const { data, isError } = await callTool("list_accounts", { bookId: 1, type: "asset" });

      expect(isError).toBe(false);
      expect(data).toHaveLength(1);
      expect(data[0].name).toBe("Checking");
      expect(data[0].type).toBe("asset");
    });

    it("excludes inactive accounts by default", async () => {
      await createAccount({ name: "Active Account", type: "asset" });
      await createAccount({ name: "Inactive Account", type: "asset", isActive: false });

      const { data, isError } = await callTool("list_accounts", { bookId: 1 });

      expect(isError).toBe(false);
      expect(data).toHaveLength(1);
      expect(data[0].name).toBe("Active Account");
    });

    it("includes inactive accounts when requested", async () => {
      await createAccount({ name: "Active Account", type: "asset" });
      await createAccount({ name: "Inactive Account", type: "asset", isActive: false });

      const { data, isError } = await callTool("list_accounts", {
        bookId: 1,
        includeInactive: true,
      });

      expect(isError).toBe(false);
      expect(data).toHaveLength(2);
      const names = data.map((a: { name: string }) => a.name);
      expect(names).toContain("Active Account");
      expect(names).toContain("Inactive Account");
    });

    it("keeps an active account whose parent is inactive", async () => {
      // GET /accounts gives a tree of roots and drops such an account. The
      // tool gives the flat list, so it must not be built from that route.
      const parent = await createAccount({ name: "Old Bank", type: "asset", isActive: false });
      await createAccount({ name: "Checking", type: "asset", parentId: parent.id });

      const { data, isError } = await callTool("list_accounts", { bookId: 1 });

      expect(isError).toBe(false);
      expect(data).toEqual([
        {
          id: expect.any(Number),
          name: "Checking",
          type: "asset",
          subtype: null,
          parentId: parent.id,
          isActive: true,
          isFavorite: false,
          isInvestmentCash: false,
          balanceCents: 0,
          displayBalance: 0,
          formattedBalance: "$0.00",
        },
      ]);
    });

    it("gives a credit-normal account a positive display balance", async () => {
      const card = await createAccount({ name: "Visa", type: "liability", subtype: "credit_card" });
      const dining = await createAccount({ name: "Dining", type: "expense" });
      await createTransactionWithSplits({
        date: "2025-01-15",
        description: "Dinner",
        splits: [
          { accountId: dining.id, amount: 123456 },
          { accountId: card.id, amount: -123456 },
        ],
      });

      const { data } = await callTool("list_accounts", { bookId: 1, type: "liability" });

      expect(data[0].balanceCents).toBe(-123456);
      expect(data[0].displayBalance).toBe(123456);
      expect(data[0].formattedBalance).toBe("$1234.56");
    });

    it("computes balances as of a specific date", async () => {
      const checking = await createAccount({ name: "Checking", type: "asset" });
      const groceries = await createAccount({ name: "Groceries", type: "expense" });

      // January transaction
      await createTransactionWithSplits({
        date: "2025-01-15",
        description: "January groceries",
        splits: [
          { accountId: checking.id, amount: -3000 },
          { accountId: groceries.id, amount: 3000 },
        ],
      });

      // March transaction
      await createTransactionWithSplits({
        date: "2025-03-15",
        description: "March groceries",
        splits: [
          { accountId: checking.id, amount: -2000 },
          { accountId: groceries.id, amount: 2000 },
        ],
      });

      // As of end of January, only the first transaction should be counted
      const { data, isError } = await callTool("list_accounts", {
        bookId: 1,
        asOfDate: "2025-01-31",
      });

      expect(isError).toBe(false);
      const checkingResult = data.find((a: { name: string }) => a.name === "Checking");
      expect(checkingResult.balanceCents).toBe(-3000);
    });

    it("uses the effective date of floating transactions for as-of balances", async () => {
      const checking = await createAccount({ name: "Checking", type: "asset" });
      const groceries = await createAccount({ name: "Groceries", type: "expense" });

      // Stored date is long past; a floating transaction is effectively "today".
      await createTransactionWithSplits({
        date: "2020-01-05",
        description: "Floating groceries",
        isFloating: true,
        splits: [
          { accountId: checking.id, amount: -3000 },
          { accountId: groceries.id, amount: 3000 },
        ],
      });

      const stale = await callTool("list_accounts", {
        bookId: 1,
        asOfDate: "2020-12-31",
      });
      expect(stale.isError).toBe(false);
      expect(
        stale.data.find((a: { name: string }) => a.name === "Checking").balanceCents
      ).toBe(0);

      const current = await callTool("list_accounts", {
        bookId: 1,
        asOfDate: toDateString(new Date()),
      });
      expect(
        current.data.find((a: { name: string }) => a.name === "Checking").balanceCents
      ).toBe(-3000);
    });
  });

  // ---------- get_account_tree ----------
  describe("get_account_tree", () => {
    it("returns accounts grouped by type", async () => {
      await createAccount({ name: "Checking", type: "asset" });
      await createAccount({ name: "Groceries", type: "expense" });
      await createAccount({ name: "Salary", type: "income" });

      const { data, isError } = await callTool("get_account_tree", { bookId: 1 });

      expect(isError).toBe(false);
      expect(data).toHaveProperty("asset");
      expect(data).toHaveProperty("expense");
      expect(data).toHaveProperty("income");

      expect(data.asset).toHaveLength(1);
      expect(data.asset[0].name).toBe("Checking");
      expect(data.expense).toHaveLength(1);
      expect(data.expense[0].name).toBe("Groceries");
      expect(data.income).toHaveLength(1);
      expect(data.income[0].name).toBe("Salary");
    });

    it("nests child accounts under parents", async () => {
      const parent = await createAccount({ name: "Bank Accounts", type: "asset" });
      await createAccount({ name: "Checking", type: "asset", parentId: parent.id });
      await createAccount({ name: "Savings", type: "asset", parentId: parent.id });

      const { data, isError } = await callTool("get_account_tree", { bookId: 1 });

      expect(isError).toBe(false);
      // Root level should have only the parent
      expect(data.asset).toHaveLength(1);
      expect(data.asset[0].name).toBe("Bank Accounts");
      expect(data.asset[0].children).toHaveLength(2);

      const childNames = data.asset[0].children.map((c: { name: string }) => c.name);
      expect(childNames).toContain("Checking");
      expect(childNames).toContain("Savings");
    });

    it("makes an account whose parent is inactive a root, and sorts by name", async () => {
      const parent = await createAccount({ name: "Old Bank", type: "asset", isActive: false });
      await createAccount({ name: "Zeta Savings", type: "asset", parentId: parent.id });
      await createAccount({ name: "alpha Checking", type: "asset" });

      const { data } = await callTool("get_account_tree", { bookId: 1 });

      expect(data.asset.map((a: { name: string }) => a.name)).toEqual([
        "alpha Checking",
        "Zeta Savings",
      ]);
    });

    it("gives each node its row, the ledger-signed balance, and children", async () => {
      const card = await createAccount({ name: "Visa", type: "liability" });
      const dining = await createAccount({ name: "Dining", type: "expense" });
      await createTransactionWithSplits({
        date: "2025-01-15",
        description: "Dinner",
        splits: [
          { accountId: dining.id, amount: 2500 },
          { accountId: card.id, amount: -2500 },
        ],
      });

      const { data } = await callTool("get_account_tree", { bookId: 1 });

      expect(Object.keys(data)).toEqual(["expense", "liability"]);
      expect(Object.keys(data.liability[0])).toEqual([
        "id", "bookId", "name", "type", "subtype", "parentId", "isActive", "isFavorite",
        "isInvestmentCash", "icon", "createdAt", "updatedAt", "balanceCents",
        "hasTransactions", "balance", "children",
      ]);
      expect(data.liability[0].balance).toBe(-2500);
      expect(data.liability[0].balanceCents).toBe(-2500);
    });

    it("excludes inactive accounts", async () => {
      await createAccount({ name: "Active", type: "asset" });
      await createAccount({ name: "Inactive", type: "asset", isActive: false });

      const { data, isError } = await callTool("get_account_tree", { bookId: 1 });

      expect(isError).toBe(false);
      expect(data.asset).toHaveLength(1);
      expect(data.asset[0].name).toBe("Active");
    });

    it("computes hasTransactions from split count", async () => {
      const checking = await createAccount({ name: "Checking", type: "asset" });
      await createAccount({ name: "Empty", type: "asset" });
      const salary = await createAccount({ name: "Salary", type: "income" });

      await createTransactionWithSplits({
        date: "2025-01-15",
        description: "Paycheck",
        splits: [
          { accountId: checking.id, amount: 1000 },
          { accountId: salary.id, amount: -1000 },
        ],
      });

      const { data, isError } = await callTool("get_account_tree", { bookId: 1 });

      expect(isError).toBe(false);

      const checkingResult = data.asset.find((a: { name: string }) => a.name === "Checking");
      const emptyResult = data.asset.find((a: { name: string }) => a.name === "Empty");

      expect(checkingResult.hasTransactions).toBe(true);
      expect(emptyResult.hasTransactions).toBe(false);
    });
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
      // The route adds these for the web form; the tool gives the stored row.
      expect(data).not.toHaveProperty("balance");
      expect(data).not.toHaveProperty("hasTransactions");
      expect(data).not.toHaveProperty("children");
    });

    it("refuses an icon of more than one character at the schema boundary, before the book gate", async () => {
      // The zod refine is not in the JSON Schema. Book 999 does not exist: a
      // gate that runs first gives an access error instead of the input error.
      for (const target of [bookId, 999]) {
        const { isError, text } = await rawCall("create_account", {
          bookId: target,
          name: "Dining",
          type: "expense",
          icon: "ab",
        });
        expect(isError).toBe(true);
        expect(text).toMatch(/^MCP error -32602: Input validation error: .*Icon must be a single character/s);
      }
      const rows = await getDb().select().from(accounts).where(eq(accounts.bookId, bookId));
      expect(rows).toHaveLength(0);
    });

    it("trims the icon, and stores a blank icon as null", async () => {
      const trimmed = await callTool("create_account", {
        bookId,
        name: "Dining",
        type: "expense",
        icon: " 🍔 ",
      });
      const blank = await callTool("create_account", {
        bookId,
        name: "Travel",
        type: "expense",
        icon: "   ",
      });

      expect(trimmed.data.icon).toBe("🍔");
      expect(blank.data.icon).toBeNull();
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
      expect(data.children).toEqual([]);
    });

    it("refuses an icon of more than one character at the schema boundary, before the book gate", async () => {
      const dining = await createAccount({ name: "Dining", type: "expense", bookId });
      for (const target of [bookId, 999]) {
        const { isError, text } = await rawCall("update_account", {
          bookId: target,
          accountId: dining.id,
          icon: "ab",
        });
        expect(isError).toBe(true);
        expect(text).toMatch(/^MCP error -32602: Input validation error: .*Icon must be a single character/s);
      }
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
