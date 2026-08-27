import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  setupTestDatabase,
  resetTestDatabase,
  createAccount,
  createTransactionWithSplits,
  createPayee,
  createRecurringRule,
  createSecurity,
  createInvestmentSplit,
  createSecurityPrice,
  createBook,
} from "@/tests/helpers/db-utils";
import { callMcpTool } from "@/tests/helpers/mcp";
import { getDb } from "@/db";
import { books, securities, users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { toDateString } from "@/lib/formatters";
import { rebuildLots } from "@/lib/lots-db";
import { createTransaction } from "@/lib/transactions";

// Mock MCP auth — all tools now require authentication
vi.mock("@/mcp/auth", () => ({
  getMcpAuth: vi.fn().mockReturnValue({ userId: 1, keyId: 1 }),
  verifyBookAccess: vi.fn().mockResolvedValue(true),
  requireAuth: vi.fn().mockReturnValue({ userId: 1, keyId: 1 }),
  requireBookAuth: vi.fn().mockResolvedValue({ userId: 1, keyId: 1 }),
}));

// Mock @/db so MCP tools that call getBookDb() get our test DB.
// We use importOriginal to preserve getDb for db-utils.
vi.mock("@/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db")>();
  return {
    ...actual,
    getBookDb: () => actual.getDb(),
  };
});

let client: Client;
let server: McpServer;

/**
 * Call an MCP tool and parse the JSON text response.
 * Returns { data, isError } where data is the parsed first text content.
 */
const callTool = (name: string, args: Record<string, unknown> = {}) =>
  callMcpTool(client, name, args);

/**
 * Insert a test user into the meta DB and return it.
 * Uses id=1 by default to match the mocked auth userId.
 */
async function insertTestUser(username = "tester", id = 1) {
  const testDb = getDb();
  const [user] = await testDb
    .insert(users)
    .values({ id, username, passwordHash: "hash" })
    .returning();
  return user;
}

describe("MCP Tools", () => {
  beforeAll(async () => {
    // Set up the book test database (creates tables)
    await setupTestDatabase();

    // Create MCP server and register all tool groups
    server = new McpServer({ name: "counterpoise-test", version: "0.0.1" });

    // Dynamically import tool registration functions so mocks are in effect
    const { registerBooksTools } = await import("@/mcp/tools/books");
    const { registerAccountTools } = await import("@/mcp/tools/accounts");
    const { registerTransactionTools } = await import("@/mcp/tools/transactions");
    const { registerReportTools } = await import("@/mcp/tools/reports");
    const { registerInvestmentTools } = await import("@/mcp/tools/investments");
    const { registerSecurityTools } = await import("@/mcp/tools/securities");

    registerBooksTools(server);
    registerAccountTools(server);
    registerTransactionTools(server);
    registerReportTools(server);
    registerInvestmentTools(server);
    registerSecurityTools(server);

    // Connect server and client via in-memory transport
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    client = new Client({ name: "test-client", version: "0.0.1" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await client.close();
    await server.close();
  });

  // ---------- list_books ----------
  describe("list_books", () => {
    // list_books tests need an empty books table to control test data
    beforeEach(async () => {
      const testDb = getDb();
      await testDb.delete(books);
      await testDb.delete(users);
    });

    it("returns an empty array when there are no books", async () => {
      const { data, isError } = await callTool("list_books");
      expect(isError).toBe(false);
      expect(data).toEqual([]);
    });

    it("returns books with id, name, and createdAt", async () => {
      const testDb = getDb();
      const user = await insertTestUser();

      await testDb
        .insert(books)
        .values([
          { userId: user.id, name: "Personal" },
          { userId: user.id, name: "Business" },
        ]);

      const { data, isError } = await callTool("list_books");

      expect(isError).toBe(false);
      expect(data).toHaveLength(2);

      // Verify each book has the expected fields
      for (const book of data) {
        expect(book).toHaveProperty("id");
        expect(book).toHaveProperty("name");
        expect(book).toHaveProperty("createdAt");
      }

      // Verify names are present
      const names = data.map((b: { name: string }) => b.name);
      expect(names).toContain("Personal");
      expect(names).toContain("Business");
    });

    it("does NOT expose userId in the response", async () => {
      const testDb = getDb();
      const user = await insertTestUser();

      await testDb
        .insert(books)
        .values({ userId: user.id, name: "Secret Book" });

      const { data } = await callTool("list_books");

      expect(data).toHaveLength(1);
      expect(data[0]).not.toHaveProperty("userId");
      expect(data[0]).not.toHaveProperty("user_id");
    });

    it("does NOT expose updatedAt in the response", async () => {
      const testDb = getDb();
      const user = await insertTestUser();

      await testDb
        .insert(books)
        .values({ userId: user.id, name: "A Book" });

      const { data } = await callTool("list_books");

      expect(data).toHaveLength(1);
      expect(data[0]).not.toHaveProperty("updatedAt");
      expect(data[0]).not.toHaveProperty("updated_at");
    });
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

  // ---------- list_transactions ----------
  describe("list_transactions", () => {
    it("returns transactions with splits and pagination", async () => {
      const checking = await createAccount({ name: "Checking", type: "asset" });
      const groceries = await createAccount({ name: "Groceries", type: "expense" });

      await createTransactionWithSplits({
        date: "2025-01-15",
        description: "Grocery run",
        splits: [
          { accountId: checking.id, amount: -5000 },
          { accountId: groceries.id, amount: 5000 },
        ],
      });

      const { data, isError } = await callTool("list_transactions", { bookId: 1 });

      expect(isError).toBe(false);
      expect(data.transactions).toHaveLength(1);
      expect(data.totalCount).toBe(1);

      const txn = data.transactions[0];
      expect(txn.description).toBe("Grocery run");
      expect(txn.splits).toHaveLength(2);

      // Splits should have accountName
      const splitNames = txn.splits.map((s: { accountName: string }) => s.accountName);
      expect(splitNames).toContain("Checking");
      expect(splitNames).toContain("Groceries");
    });

    it("filters by accountId", async () => {
      const checking = await createAccount({ name: "Checking", type: "asset" });
      const savings = await createAccount({ name: "Savings", type: "asset" });
      const groceries = await createAccount({ name: "Groceries", type: "expense" });

      await createTransactionWithSplits({
        date: "2025-01-15",
        description: "Checking transaction",
        splits: [
          { accountId: checking.id, amount: -3000 },
          { accountId: groceries.id, amount: 3000 },
        ],
      });

      await createTransactionWithSplits({
        date: "2025-01-16",
        description: "Savings transaction",
        splits: [
          { accountId: savings.id, amount: -2000 },
          { accountId: groceries.id, amount: 2000 },
        ],
      });

      const { data, isError } = await callTool("list_transactions", {
        bookId: 1,
        accountId: checking.id,
      });

      expect(isError).toBe(false);
      expect(data.transactions).toHaveLength(1);
      expect(data.transactions[0].description).toBe("Checking transaction");
    });

    it("filters by date range", async () => {
      const checking = await createAccount({ name: "Checking", type: "asset" });
      const groceries = await createAccount({ name: "Groceries", type: "expense" });

      await createTransactionWithSplits({
        date: "2025-01-15",
        description: "January",
        splits: [
          { accountId: checking.id, amount: -1000 },
          { accountId: groceries.id, amount: 1000 },
        ],
      });

      await createTransactionWithSplits({
        date: "2025-02-15",
        description: "February",
        splits: [
          { accountId: checking.id, amount: -2000 },
          { accountId: groceries.id, amount: 2000 },
        ],
      });

      await createTransactionWithSplits({
        date: "2025-03-15",
        description: "March",
        splits: [
          { accountId: checking.id, amount: -3000 },
          { accountId: groceries.id, amount: 3000 },
        ],
      });

      const { data, isError } = await callTool("list_transactions", {
        bookId: 1,
        startDate: "2025-02-01",
        endDate: "2025-02-28",
      });

      expect(isError).toBe(false);
      expect(data.transactions).toHaveLength(1);
      expect(data.transactions[0].description).toBe("February");
    });

    it("includes payee information", async () => {
      const checking = await createAccount({ name: "Checking", type: "asset" });
      const groceries = await createAccount({ name: "Groceries", type: "expense" });
      const payee = await createPayee({ name: "Whole Foods" });

      await createTransactionWithSplits({
        date: "2025-01-15",
        description: "Weekly groceries",
        payeeId: payee.id,
        splits: [
          { accountId: checking.id, amount: -7500 },
          { accountId: groceries.id, amount: 7500 },
        ],
      });

      const { data, isError } = await callTool("list_transactions", { bookId: 1 });

      expect(isError).toBe(false);
      const txn = data.transactions[0];
      expect(txn.payee).not.toBeNull();
      expect(txn.payee.id).toBe(payee.id);
      expect(txn.payee.name).toBe("Whole Foods");
    });

    it("includes investment splits when present", async () => {
      const investmentAcct = await createAccount({
        name: "Brokerage",
        type: "asset",
        subtype: "investment",
      });
      const cashAcct = await createAccount({
        name: "Brokerage Cash",
        type: "asset",
        isInvestmentCash: true,
      });
      const security = await createSecurity({
        name: "Vanguard Total Stock",
        symbol: "VTI",
        securityType: "etf",
      });

      const txn = await createTransactionWithSplits({
        date: "2025-01-15",
        description: "Buy VTI",
        splits: [
          { accountId: investmentAcct.id, amount: 10000 },
          { accountId: cashAcct.id, amount: -10000 },
        ],
      });

      await createInvestmentSplit({
        transactionId: txn.id,
        accountId: investmentAcct.id,
        securityId: security.id,
        action: "buy",
        sharesMicros: 50_000_000, // 50 shares
        priceMicros: 200_000_000, // $200
      });

      const { data, isError } = await callTool("list_transactions", { bookId: 1 });

      expect(isError).toBe(false);
      const result = data.transactions[0];
      expect(result.investmentSplits).toBeDefined();
      expect(result.investmentSplits).toHaveLength(1);
      expect(result.investmentSplits[0].action).toBe("buy");
      expect(result.investmentSplits[0].securitySymbol).toBe("VTI");
      expect(result.investmentSplits[0].sharesMicros).toBe(50_000_000);
    });

    it("respects limit and offset", async () => {
      const checking = await createAccount({ name: "Checking", type: "asset" });
      const groceries = await createAccount({ name: "Groceries", type: "expense" });

      // Create 5 transactions
      for (let i = 1; i <= 5; i++) {
        await createTransactionWithSplits({
          date: `2025-01-${String(i).padStart(2, "0")}`,
          description: `Transaction ${i}`,
          splits: [
            { accountId: checking.id, amount: -1000 * i },
            { accountId: groceries.id, amount: 1000 * i },
          ],
        });
      }

      const { data, isError } = await callTool("list_transactions", {
        bookId: 1,
        limit: 2,
        offset: 0,
      });

      expect(isError).toBe(false);
      expect(data.transactions).toHaveLength(2);
      expect(data.totalCount).toBe(5);
      // Ordered by date DESC, so most recent first
      expect(data.transactions[0].description).toBe("Transaction 5");
      expect(data.transactions[1].description).toBe("Transaction 4");
    });

    it("filters by accountIds across several accounts", async () => {
      const checking = await createAccount({ name: "Checking", type: "asset" });
      const savings = await createAccount({ name: "Savings", type: "asset" });
      const groceries = await createAccount({ name: "Groceries", type: "expense" });
      // Neither leg of this one is in the accountIds filter below — it must
      // be excluded. Without it, a filter that's ignored entirely would
      // still pass: the book would contain exactly the two matching rows.
      const vacationFund = await createAccount({ name: "Vacation Fund", type: "asset" });
      const rent = await createAccount({ name: "Rent", type: "expense" });
      await createTransactionWithSplits({
        date: "2026-01-10", description: "From checking",
        splits: [
          { accountId: checking.id, amount: -100 },
          { accountId: groceries.id, amount: 100 },
        ],
      });
      await createTransactionWithSplits({
        date: "2026-01-11", description: "From savings",
        splits: [
          { accountId: savings.id, amount: -200 },
          { accountId: groceries.id, amount: 200 },
        ],
      });
      await createTransactionWithSplits({
        date: "2026-01-12", description: "From vacation fund",
        splits: [
          { accountId: vacationFund.id, amount: -300 },
          { accountId: rent.id, amount: 300 },
        ],
      });

      const { data, isError } = await callTool("list_transactions", {
        bookId: 1,
        accountIds: [checking.id, savings.id],
      });

      expect(isError).toBe(false);
      expect(data.totalCount).toBe(2);
      const descriptions = data.transactions
        .map((t: { description: string }) => t.description)
        .sort();
      expect(descriptions).toEqual(["From checking", "From savings"]);
      expect(descriptions).not.toContain("From vacation fund");
    });

    it("returns each transaction once when accountIds matches both of its legs", async () => {
      const checking = await createAccount({ name: "Checking", type: "asset" });
      const groceries = await createAccount({ name: "Groceries", type: "expense" });
      // Not in the accountIds filter below — proves toHaveLength(1) is
      // distinguishing rather than trivially true from an empty book.
      const savings = await createAccount({ name: "Savings", type: "asset" });
      const rent = await createAccount({ name: "Rent", type: "expense" });
      await createTransactionWithSplits({
        date: "2026-01-10", description: "Both legs",
        splits: [
          { accountId: checking.id, amount: -100 },
          { accountId: groceries.id, amount: 100 },
        ],
      });
      await createTransactionWithSplits({
        date: "2026-01-11", description: "Unrelated",
        splits: [
          { accountId: savings.id, amount: -200 },
          { accountId: rent.id, amount: 200 },
        ],
      });

      const { data } = await callTool("list_transactions", {
        bookId: 1,
        accountIds: [checking.id, groceries.id],
      });

      expect(data.transactions).toHaveLength(1);
      expect(data.transactions[0].description).toBe("Both legs");
      expect(data.totalCount).toBe(1);
    });

    it("errors on a payeeId from another book rather than returning an empty list", async () => {
      // An empty list reads as "this payee has no transactions", which is a
      // wrong answer rather than an empty one.
      const otherBook = await createBook({ name: "Other Book" });
      const theirPayee = await createPayee({ name: "Theirs", bookId: otherBook.id });

      const { data, isError } = await callTool("list_transactions", {
        bookId: 1,
        payeeId: theirPayee.id,
      });

      expect(isError).toBe(true);
      expect(data.error).toBe("Invalid payeeId");
    });

    it("errors on an accountIds entry from another book rather than returning an empty list", async () => {
      // Same failure shape as the payeeId case above: an empty list reads as
      // "this account has no transactions", a wrong answer rather than an
      // empty one.
      const checking = await createAccount({ name: "Checking", type: "asset" });
      const otherBook = await createBook({ name: "Other Book" });
      const theirAccount = await createAccount({
        name: "Theirs", type: "asset", bookId: otherBook.id,
      });

      const { data, isError } = await callTool("list_transactions", {
        bookId: 1,
        accountIds: [checking.id, theirAccount.id],
      });

      expect(isError).toBe(true);
      expect(data.error).toBe("One or more accounts do not belong to this book");
    });

    it("accountIds wins over accountId when both are given and would select different rows", async () => {
      const checking = await createAccount({ name: "Checking", type: "asset" });
      const savings = await createAccount({ name: "Savings", type: "asset" });
      const groceries = await createAccount({ name: "Groceries", type: "expense" });
      await createTransactionWithSplits({
        date: "2026-01-10", description: "From checking",
        splits: [
          { accountId: checking.id, amount: -100 },
          { accountId: groceries.id, amount: 100 },
        ],
      });
      await createTransactionWithSplits({
        date: "2026-01-11", description: "From savings",
        splits: [
          { accountId: savings.id, amount: -200 },
          { accountId: groceries.id, amount: 200 },
        ],
      });

      const { data, isError } = await callTool("list_transactions", {
        bookId: 1,
        accountId: checking.id,
        accountIds: [savings.id],
      });

      expect(isError).toBe(false);
      expect(data.totalCount).toBe(1);
      expect(data.transactions[0].description).toBe("From savings");
    });

    it("rejects a calendar-invalid startDate at the schema boundary instead of silently answering a wrong range", async () => {
      // z.iso.date() checks the calendar, not just the shape — 2026-02-30
      // does not exist. The MCP SDK reports schema-validation failures as a
      // normal (non-JSON) error result rather than a rejected promise, so
      // inspect it directly instead of going through the JSON-parsing
      // callTool() helper.
      const result = await client.callTool({
        name: "list_transactions",
        arguments: { bookId: 1, startDate: "2026-02-30" },
      });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      expect(text).toMatch(/startDate/i);
    });
  });

  // ---------- search ----------
  describe("search", () => {
    it("finds accounts by name", async () => {
      await createAccount({ name: "Checking Account", type: "asset" });
      await createAccount({ name: "Savings Account", type: "asset" });
      await createAccount({ name: "Groceries", type: "expense" });

      const { data, isError } = await callTool("search", { bookId: 1, query: "Account" });

      expect(isError).toBe(false);
      expect(data.accounts).toHaveLength(2);
      const names = data.accounts.map((a: { name: string }) => a.name);
      expect(names).toContain("Checking Account");
      expect(names).toContain("Savings Account");
    });

    it("finds payees by name", async () => {
      await createPayee({ name: "Whole Foods Market" });
      await createPayee({ name: "Trader Joe's" });

      const { data, isError } = await callTool("search", { bookId: 1, query: "Foods" });

      expect(isError).toBe(false);
      expect(data.payees).toHaveLength(1);
      expect(data.payees[0].name).toBe("Whole Foods Market");
    });

    it("finds transactions by description", async () => {
      const checking = await createAccount({ name: "Checking", type: "asset" });
      const groceries = await createAccount({ name: "Groceries", type: "expense" });

      await createTransactionWithSplits({
        date: "2025-01-15",
        description: "Weekly grocery shopping at Costco",
        splits: [
          { accountId: checking.id, amount: -15000 },
          { accountId: groceries.id, amount: 15000 },
        ],
      });

      await createTransactionWithSplits({
        date: "2025-01-16",
        description: "Gas station fill up",
        splits: [
          { accountId: checking.id, amount: -6000 },
          { accountId: groceries.id, amount: 6000 },
        ],
      });

      const { data, isError } = await callTool("search", { bookId: 1, query: "Costco" });

      expect(isError).toBe(false);
      expect(data.transactions).toHaveLength(1);
      expect(data.transactions[0].description).toBe("Weekly grocery shopping at Costco");
    });

    it("matches text case-insensitively, like the web search", async () => {
      const checking = await createAccount({ name: "Checking Account", type: "asset" });
      const groceries = await createAccount({ name: "Groceries", type: "expense" });
      const payee = await createPayee({ name: "Whole Foods Market" });

      await createTransactionWithSplits({
        date: "2025-01-15",
        description: "Weekly shopping at Costco",
        payeeId: payee.id,
        splits: [
          { accountId: checking.id, amount: -15000 },
          { accountId: groceries.id, amount: 15000 },
        ],
      });

      const { data, isError } = await callTool("search", {
        bookId: 1,
        query: "cosTCo",
      });
      expect(isError).toBe(false);
      expect(data.transactions).toHaveLength(1);

      const accountHit = await callTool("search", { bookId: 1, query: "cHeCKing" });
      expect(accountHit.data.accounts).toHaveLength(1);

      const payeeHit = await callTool("search", { bookId: 1, query: "whole foods" });
      expect(payeeHit.data.payees).toHaveLength(1);
    });

    // MCP search now shares the web route's implementation (lib/search.ts), so
    // it gained the capabilities its own query never had: recurring rules,
    // check-number matching, and per-transaction split detail.
    it("returns recurring rules, check numbers, and split detail", async () => {
      const checking = await createAccount({ name: "Checking", type: "asset" });
      const groceries = await createAccount({ name: "Groceries", type: "expense" });

      await createTransactionWithSplits({
        date: "2025-01-15",
        description: "Roof repair",
        checkNumber: "4021",
        splits: [
          { accountId: checking.id, amount: -15000 },
          { accountId: groceries.id, amount: 15000 },
        ],
      });

      await createRecurringRule({
        name: "Roofing Maintenance Plan",
        frequency: "monthly",
        startDate: "2025-01-01",
        nextDate: "2025-02-01",
        templateSplits: [
          { accountId: groceries.id, amount: 5000 },
          { accountId: checking.id, amount: -5000 },
        ],
      });

      const { data, isError } = await callTool("search", { bookId: 1, query: "roof" });
      expect(isError).toBe(false);

      expect(data.recurringRules).toHaveLength(1);
      expect(data.recurringRules[0].name).toBe("Roofing Maintenance Plan");

      expect(data.transactions).toHaveLength(1);
      expect(data.transactions[0].splits.length).toBe(2);

      // Check-number matching: MCP's own query never looked at this column.
      const byCheck = await callTool("search", { bookId: 1, query: "4021" });
      expect(byCheck.data.transactions).toHaveLength(1);
      expect(byCheck.data.transactions[0].checkNumber).toBe("4021");
    });

    // The capability expansion above must be purely additive. Sharing the query
    // with the web route made it easy to return the shared row verbatim, which
    // would have silently dropped these two fields from this tool's contract.
    it("preserves the fields existing clients already read", async () => {
      const checking = await createAccount({ name: "Checking", type: "asset" });
      const groceries = await createAccount({ name: "Groceries", type: "expense" });
      const payee = await createPayee({ name: "Whole Foods Market" });

      await createTransactionWithSplits({
        date: "2025-01-15",
        description: "Shopping trip",
        payeeId: payee.id,
        splits: [
          { accountId: checking.id, amount: -15000 },
          { accountId: groceries.id, amount: 15000 },
        ],
      });

      const byAccount = await callTool("search", { bookId: 1, query: "Checking" });
      expect(byAccount.data.accounts[0]).toHaveProperty("isActive", true);

      const byTxn = await callTool("search", { bookId: 1, query: "Shopping trip" });
      expect(byTxn.data.transactions[0].payeeName).toBe("Whole Foods Market");
      expect(byTxn.data.transactions[0].notes).toBeDefined();
    });

    it("finds transactions by numeric amount", async () => {
      const checking = await createAccount({ name: "Checking", type: "asset" });
      const groceries = await createAccount({ name: "Groceries", type: "expense" });

      await createTransactionWithSplits({
        date: "2025-01-15",
        description: "Specific purchase",
        splits: [
          { accountId: checking.id, amount: -4299 },
          { accountId: groceries.id, amount: 4299 },
        ],
      });

      await createTransactionWithSplits({
        date: "2025-01-16",
        description: "Other purchase",
        splits: [
          { accountId: checking.id, amount: -9999 },
          { accountId: groceries.id, amount: 9999 },
        ],
      });

      const { data, isError } = await callTool("search", { bookId: 1, query: "42.99" });

      expect(isError).toBe(false);
      expect(data.transactions).toHaveLength(1);
      expect(data.transactions[0].description).toBe("Specific purchase");
    });

    it("respects date range filters", async () => {
      const checking = await createAccount({ name: "Checking", type: "asset" });
      const groceries = await createAccount({ name: "Groceries", type: "expense" });

      await createTransactionWithSplits({
        date: "2025-01-15",
        description: "January shopping trip",
        splits: [
          { accountId: checking.id, amount: -5000 },
          { accountId: groceries.id, amount: 5000 },
        ],
      });

      await createTransactionWithSplits({
        date: "2025-03-15",
        description: "March shopping trip",
        splits: [
          { accountId: checking.id, amount: -6000 },
          { accountId: groceries.id, amount: 6000 },
        ],
      });

      const { data, isError } = await callTool("search", {
        bookId: 1,
        query: "shopping",
        startDate: "2025-03-01",
        endDate: "2025-03-31",
      });

      expect(isError).toBe(false);
      expect(data.transactions).toHaveLength(1);
      expect(data.transactions[0].description).toBe("March shopping trip");
    });
  });

  // ---------- get_income_statement ----------
  describe("get_income_statement", () => {
    it("returns income and expense totals for date range", async () => {
      const checking = await createAccount({ name: "Checking", type: "asset", subtype: "bank" });
      const salary = await createAccount({ name: "Salary", type: "income" });
      const groceries = await createAccount({ name: "Groceries", type: "expense" });
      const rent = await createAccount({ name: "Rent", type: "expense" });

      // Salary deposit: credit income -8000, debit checking +8000
      await createTransactionWithSplits({
        date: "2025-01-15",
        description: "Paycheck",
        splits: [
          { accountId: checking.id, amount: 8000 },
          { accountId: salary.id, amount: -8000 },
        ],
      });

      // Grocery purchase: credit checking -3000, debit groceries +3000
      await createTransactionWithSplits({
        date: "2025-01-20",
        description: "Grocery run",
        splits: [
          { accountId: checking.id, amount: -3000 },
          { accountId: groceries.id, amount: 3000 },
        ],
      });

      // Rent payment: credit checking -2000, debit rent +2000
      await createTransactionWithSplits({
        date: "2025-01-25",
        description: "Rent payment",
        splits: [
          { accountId: checking.id, amount: -2000 },
          { accountId: rent.id, amount: 2000 },
        ],
      });

      const { data, isError } = await callTool("get_income_statement", {
        bookId: 1,
        startDate: "2025-01-01",
        endDate: "2025-01-31",
      });

      expect(isError).toBe(false);
      expect(data.income).toHaveLength(1);
      expect(data.income[0].name).toBe("Salary");
      // Income raw balance is -8000; getDisplayBalance flips sign → 8000
      expect(data.income[0].balanceCents).toBe(8000);

      expect(data.expenses).toHaveLength(2);
      const expenseNames = data.expenses.map((e: { name: string }) => e.name);
      expect(expenseNames).toContain("Groceries");
      expect(expenseNames).toContain("Rent");

      expect(data.totals.incomeCents).toBe(8000);
      expect(data.totals.expensesCents).toBe(5000);
      expect(data.totals.netIncomeCents).toBe(3000);
    });

    it("excludes transactions outside date range", async () => {
      const checking = await createAccount({ name: "Checking", type: "asset" });
      const salary = await createAccount({ name: "Salary", type: "income" });

      await createTransactionWithSplits({
        date: "2025-01-15",
        description: "January pay",
        splits: [
          { accountId: checking.id, amount: 5000 },
          { accountId: salary.id, amount: -5000 },
        ],
      });

      await createTransactionWithSplits({
        date: "2025-03-15",
        description: "March pay",
        splits: [
          { accountId: checking.id, amount: 5000 },
          { accountId: salary.id, amount: -5000 },
        ],
      });

      // Query February only — should find nothing
      const { data, isError } = await callTool("get_income_statement", {
        bookId: 1,
        startDate: "2025-02-01",
        endDate: "2025-02-28",
      });

      expect(isError).toBe(false);
      expect(data.income).toHaveLength(0);
      expect(data.expenses).toHaveLength(0);
      expect(data.totals.incomeCents).toBe(0);
      expect(data.totals.expensesCents).toBe(0);
      expect(data.totals.netIncomeCents).toBe(0);
    });

    it("counts floating transactions in their effective period", async () => {
      const checking = await createAccount({ name: "Checking", type: "asset" });
      const groceries = await createAccount({ name: "Groceries", type: "expense" });

      // Stored date is long past; a floating transaction is effectively "today".
      await createTransactionWithSplits({
        date: "2020-01-05",
        description: "Floating groceries",
        isFloating: true,
        splits: [
          { accountId: checking.id, amount: -2500 },
          { accountId: groceries.id, amount: 2500 },
        ],
      });

      const today = toDateString(new Date());
      const effective = await callTool("get_income_statement", {
        bookId: 1,
        startDate: today,
        endDate: today,
      });
      expect(effective.isError).toBe(false);
      expect(effective.data.totals.expensesCents).toBe(2500);

      const stale = await callTool("get_income_statement", {
        bookId: 1,
        startDate: "2020-01-01",
        endDate: "2020-01-31",
      });
      expect(stale.data.totals.expensesCents).toBe(0);
    });

    it("excludes inactive accounts by default", async () => {
      const checking = await createAccount({ name: "Checking", type: "asset" });
      const activeSalary = await createAccount({ name: "Active Salary", type: "income" });
      const inactiveSalary = await createAccount({
        name: "Inactive Salary",
        type: "income",
        isActive: false,
      });

      await createTransactionWithSplits({
        date: "2025-01-15",
        description: "Active pay",
        splits: [
          { accountId: checking.id, amount: 5000 },
          { accountId: activeSalary.id, amount: -5000 },
        ],
      });

      await createTransactionWithSplits({
        date: "2025-01-16",
        description: "Inactive pay",
        splits: [
          { accountId: checking.id, amount: 3000 },
          { accountId: inactiveSalary.id, amount: -3000 },
        ],
      });

      const { data, isError } = await callTool("get_income_statement", {
        bookId: 1,
        startDate: "2025-01-01",
        endDate: "2025-01-31",
      });

      expect(isError).toBe(false);
      expect(data.income).toHaveLength(1);
      expect(data.income[0].name).toBe("Active Salary");
      expect(data.totals.incomeCents).toBe(5000);
    });
  });

  // ---------- get_report_data ----------
  describe("get_report_data", () => {
    it("returns raw split data for date range", async () => {
      const checking = await createAccount({ name: "Checking", type: "asset" });
      const groceries = await createAccount({ name: "Groceries", type: "expense" });

      await createTransactionWithSplits({
        date: "2025-01-15",
        description: "Grocery run",
        splits: [
          { accountId: checking.id, amount: -5000 },
          { accountId: groceries.id, amount: 5000 },
        ],
      });

      const { data, isError } = await callTool("get_report_data", {
        bookId: 1,
        startDate: "2025-01-01",
        endDate: "2025-01-31",
      });

      expect(isError).toBe(false);
      expect(data.rowCount).toBe(2);
      expect(data.totalCount).toBe(2);
      expect(data.truncated).toBe(false);

      // Each row should have date, accountName, amountCents
      for (const row of data.data) {
        expect(row).toHaveProperty("date");
        expect(row).toHaveProperty("accountName");
        expect(row).toHaveProperty("amountCents");
      }
    });

    it("filters by account types", async () => {
      const checking = await createAccount({ name: "Checking", type: "asset" });
      const groceries = await createAccount({ name: "Groceries", type: "expense" });

      await createTransactionWithSplits({
        date: "2025-01-15",
        description: "Shopping",
        splits: [
          { accountId: checking.id, amount: -5000 },
          { accountId: groceries.id, amount: 5000 },
        ],
      });

      const { data, isError } = await callTool("get_report_data", {
        bookId: 1,
        startDate: "2025-01-01",
        endDate: "2025-01-31",
        accountTypes: ["expense"],
      });

      expect(isError).toBe(false);
      expect(data.rowCount).toBe(1);
      expect(data.data[0].accountName).toBe("Groceries");
      expect(data.data[0].accountType).toBe("expense");
    });

    it("filters by specific account IDs", async () => {
      const checking = await createAccount({ name: "Checking", type: "asset" });
      const groceries = await createAccount({ name: "Groceries", type: "expense" });

      await createTransactionWithSplits({
        date: "2025-01-15",
        description: "Shopping",
        splits: [
          { accountId: checking.id, amount: -5000 },
          { accountId: groceries.id, amount: 5000 },
        ],
      });

      const { data, isError } = await callTool("get_report_data", {
        bookId: 1,
        startDate: "2025-01-01",
        endDate: "2025-01-31",
        accountIds: [checking.id],
      });

      expect(isError).toBe(false);
      expect(data.rowCount).toBe(1);
      expect(data.data[0].accountName).toBe("Checking");
    });

    it("reports truncated flag when limit exceeded", async () => {
      const checking = await createAccount({ name: "Checking", type: "asset" });
      const groceries = await createAccount({ name: "Groceries", type: "expense" });

      // Create 5 transactions = 10 splits
      for (let i = 1; i <= 5; i++) {
        await createTransactionWithSplits({
          date: `2025-01-${String(i).padStart(2, "0")}`,
          description: `Transaction ${i}`,
          splits: [
            { accountId: checking.id, amount: -1000 * i },
            { accountId: groceries.id, amount: 1000 * i },
          ],
        });
      }

      const { data, isError } = await callTool("get_report_data", {
        bookId: 1,
        startDate: "2025-01-01",
        endDate: "2025-01-31",
        limit: 3,
      });

      expect(isError).toBe(false);
      expect(data.truncated).toBe(true);
      expect(data.totalCount).toBe(10);
      expect(data.rowCount).toBe(3);
    });
  });

  // ---------- get_account_balance_history ----------
  describe("get_account_balance_history", () => {
    it("returns running balance entries", async () => {
      const checking = await createAccount({ name: "Checking", type: "asset" });
      const groceries = await createAccount({ name: "Groceries", type: "expense" });

      await createTransactionWithSplits({
        date: "2025-01-10",
        description: "Deposit",
        splits: [
          { accountId: checking.id, amount: 10000 },
          { accountId: groceries.id, amount: -10000 },
        ],
      });

      await createTransactionWithSplits({
        date: "2025-01-20",
        description: "Withdrawal",
        splits: [
          { accountId: checking.id, amount: -3000 },
          { accountId: groceries.id, amount: 3000 },
        ],
      });

      const { data, isError } = await callTool("get_account_balance_history", {
        bookId: 1,
        accountId: checking.id,
      });

      expect(isError).toBe(false);
      expect(data.account.name).toBe("Checking");
      expect(data.entries).toHaveLength(2);

      // First entry: +10000, running balance = 10000
      expect(data.entries[0].changeCents).toBe(10000);
      expect(data.entries[0].balanceCents).toBe(10000);

      // Second entry: -3000, running balance = 7000
      expect(data.entries[1].changeCents).toBe(-3000);
      expect(data.entries[1].balanceCents).toBe(7000);
    });

    it("computes starting balance when startDate is provided", async () => {
      const checking = await createAccount({ name: "Checking", type: "asset" });
      const groceries = await createAccount({ name: "Groceries", type: "expense" });

      // January transaction
      await createTransactionWithSplits({
        date: "2025-01-15",
        description: "January deposit",
        splits: [
          { accountId: checking.id, amount: 10000 },
          { accountId: groceries.id, amount: -10000 },
        ],
      });

      // February transaction
      await createTransactionWithSplits({
        date: "2025-02-15",
        description: "February withdrawal",
        splits: [
          { accountId: checking.id, amount: -4000 },
          { accountId: groceries.id, amount: 4000 },
        ],
      });

      const { data, isError } = await callTool("get_account_balance_history", {
        bookId: 1,
        accountId: checking.id,
        startDate: "2025-02-01",
      });

      expect(isError).toBe(false);
      // Starting balance should include January's +10000
      expect(data.startingBalanceCents).toBe(10000);
      expect(data.entries).toHaveLength(1);
      // Running balance = startingBalance + change = 10000 + (-4000) = 6000
      expect(data.entries[0].balanceCents).toBe(6000);
    });

    it("returns error for nonexistent account", async () => {
      const { data, isError } = await callTool("get_account_balance_history", {
        bookId: 1,
        accountId: 99999,
      });

      expect(isError).toBe(true);
      expect(data.error).toMatch(/99999/);
    });

    it("respects endDate filter", async () => {
      const checking = await createAccount({ name: "Checking", type: "asset" });
      const groceries = await createAccount({ name: "Groceries", type: "expense" });

      await createTransactionWithSplits({
        date: "2025-01-15",
        description: "January deposit",
        splits: [
          { accountId: checking.id, amount: 10000 },
          { accountId: groceries.id, amount: -10000 },
        ],
      });

      await createTransactionWithSplits({
        date: "2025-06-15",
        description: "June deposit",
        splits: [
          { accountId: checking.id, amount: 5000 },
          { accountId: groceries.id, amount: -5000 },
        ],
      });

      const { data, isError } = await callTool("get_account_balance_history", {
        bookId: 1,
        accountId: checking.id,
        endDate: "2025-03-31",
      });

      expect(isError).toBe(false);
      expect(data.entries).toHaveLength(1);
      expect(data.entries[0].description).toBe("January deposit");
    });
  });

  // ---------- get_investment_positions ----------
  describe("get_investment_positions", () => {
    it("returns positions with shares, cost basis, and market value", async () => {
      const investmentAcct = await createAccount({
        name: "Brokerage",
        type: "asset",
        subtype: "investment",
      });
      const cashAcct = await createAccount({
        name: "Brokerage Cash",
        type: "asset",
        isInvestmentCash: true,
      });
      const security = await createSecurity({
        name: "Vanguard Total Stock",
        symbol: "VTI",
        securityType: "etf",
      });

      // Buy 1 share at $100
      const txn = await createTransactionWithSplits({
        date: "2025-01-15",
        description: "Buy VTI",
        splits: [
          { accountId: investmentAcct.id, amount: 10000 },
          { accountId: cashAcct.id, amount: -10000 },
        ],
      });

      await createInvestmentSplit({
        transactionId: txn.id,
        accountId: investmentAcct.id,
        securityId: security.id,
        action: "buy",
        sharesMicros: 1_000_000, // 1 share
        priceMicros: 100_000_000, // $100
      });

      // createInvestmentSplit is a low-level helper that bypasses
      // lib/transactions.ts's createTransaction(), which is what normally
      // triggers rebuildLots after a write. Rebuild explicitly so
      // investment_lots reflects this pair, same as a real write-path call
      // would produce — getPositions now sources costBasis from lots.
      await rebuildLots(getDb(), 1, investmentAcct.id, security.id);

      // Add current price at $120
      await createSecurityPrice({
        securityId: security.id,
        priceDate: "2025-01-20",
        priceMicros: 120_000_000,
      });

      const { data, isError } = await callTool("get_investment_positions", {
        bookId: 1,
      });

      expect(isError).toBe(false);
      expect(data.positions).toHaveLength(1);

      const pos = data.positions[0];
      expect(pos.securitySymbol).toBe("VTI");
      expect(pos.shares).toBe(1);
      expect(pos.costBasis).toBe(100);
      expect(pos.currentPrice).toBe(120);
      expect(pos.marketValue).toBe(120);
      expect(pos.gainLoss).toBe(20);
      expect(pos.gainLossPercent).toBe("20.00%");
    });

    it("returns empty positions when no investments", async () => {
      const { data, isError } = await callTool("get_investment_positions", {
        bookId: 1,
      });

      expect(isError).toBe(false);
      expect(data.positions).toHaveLength(0);
    });

    it("includes accountValues when requested", async () => {
      const investmentAcct = await createAccount({
        name: "Brokerage",
        type: "asset",
        subtype: "investment",
      });
      const cashAcct = await createAccount({
        name: "Brokerage Cash",
        type: "asset",
        isInvestmentCash: true,
      });
      const security = await createSecurity({
        name: "Vanguard Total Stock",
        symbol: "VTI",
        securityType: "etf",
      });

      const txn = await createTransactionWithSplits({
        date: "2025-01-15",
        description: "Buy VTI",
        splits: [
          { accountId: investmentAcct.id, amount: 10000 },
          { accountId: cashAcct.id, amount: -10000 },
        ],
      });

      await createInvestmentSplit({
        transactionId: txn.id,
        accountId: investmentAcct.id,
        securityId: security.id,
        action: "buy",
        sharesMicros: 1_000_000,
        priceMicros: 100_000_000,
      });

      await createSecurityPrice({
        securityId: security.id,
        priceDate: "2025-01-20",
        priceMicros: 120_000_000,
      });

      const { data, isError } = await callTool("get_investment_positions", {
        bookId: 1,
        includeAccountValues: true,
      });

      expect(isError).toBe(false);
      expect(data.accountValues).toBeDefined();
      expect(data.accountValues.length).toBeGreaterThanOrEqual(1);
      const acctVal = data.accountValues.find(
        (av: { accountId: number }) => av.accountId === investmentAcct.id
      );
      expect(acctVal).toBeDefined();
      expect(acctVal.marketValue).toBe(120);
    });
  });

  // ---------- get_realized_gains ----------
  describe("get_realized_gains", () => {
    const M = 1_000_000;

    async function trade(
      brokerageId: number,
      cashId: number,
      securityId: number,
      date: string,
      action: "buy" | "sell",
      shares: number,
      price: number
    ) {
      const amount = Math.round((shares / M) * (price / M) * 100);
      const signed = action === "buy" ? amount : -amount;
      return createTransaction(getDb(), 1, {
        date,
        description: `${action} VTI`,
        splits: [
          { accountId: brokerageId, amount: signed },
          { accountId: cashId, amount: -signed },
        ],
        investmentSplits: [
          { securityId, action, sharesMicros: shares, priceMicros: price, feesCents: 0 },
        ],
      });
    }

    async function setupAccounts() {
      const brokerage = await createAccount({
        name: "Brokerage",
        type: "asset",
        subtype: "investment",
      });
      const cash = await createAccount({ name: "Cash", type: "asset", subtype: "bank" });
      const security = await createSecurity({
        name: "Vanguard Total Stock",
        symbol: "VTI",
        securityType: "etf",
      });
      return { brokerage, cash, security };
    }

    it("returns dollar-denominated disposals with the documented field names", async () => {
      const { brokerage, cash, security } = await setupAccounts();

      await trade(brokerage.id, cash.id, security.id, "2024-01-01", "buy", 10 * M, 10 * M);
      await trade(brokerage.id, cash.id, security.id, "2024-06-01", "sell", 10 * M, 15 * M);

      const { data, isError } = await callTool("get_realized_gains", { bookId: 1 });

      expect(isError).toBe(false);
      expect(data.disposals).toHaveLength(1);

      // Values are dollars, not cents: 10 shares bought at $10, sold at $15.
      expect(data.disposals[0]).toMatchObject({
        sellDate: "2024-06-01",
        security: "VTI",
        account: "Brokerage",
        shares: 10,
        acquired: "2024-01-01",
        proceeds: 150,
        costBasis: 100,
        gainLoss: 50,
        term: "short",
      });

      expect(data.totals).toMatchObject({
        shortTermGain: 50,
        longTermGain: 0,
        proceeds: 150,
        costBasis: 100,
        unknownBasisDisposals: 0,
      });
    });

    it("produces one disposal row per lot when a sell spans multiple lots", async () => {
      const { brokerage, cash, security } = await setupAccounts();

      // 100 shares in 2022 (long-term by the 2024-09 sale), 50 more in
      // May 2024 (short-term), then a single sell that draws from both lots.
      await trade(brokerage.id, cash.id, security.id, "2022-01-01", "buy", 100 * M, 10 * M);
      await trade(brokerage.id, cash.id, security.id, "2024-05-01", "buy", 50 * M, 20 * M);
      await trade(brokerage.id, cash.id, security.id, "2024-09-01", "sell", 120 * M, 30 * M);

      const { data, isError } = await callTool("get_realized_gains", { bookId: 1 });

      expect(isError).toBe(false);
      expect(data.disposals).toHaveLength(2);
      const terms = data.disposals.map((d: { term: string }) => d.term).sort();
      expect(terms).toEqual(["long", "short"]);

      // 100 sh @ $10 basis / $30 proceeds (long) + 20 sh @ $20 basis / $30 proceeds (short)
      expect(data.totals).toMatchObject({
        proceeds: 3600,
        costBasis: 1400,
        longTermGain: 2000,
        shortTermGain: 200,
        unknownBasisDisposals: 0,
      });
    });

    it("surfaces an unknown-basis disposal with null costBasis/gainLoss and counts it separately", async () => {
      const { brokerage, cash, security } = await setupAccounts();

      await trade(brokerage.id, cash.id, security.id, "2024-01-01", "buy", 10 * M, 100 * M);
      // Sell more shares than were ever bought — 15 of the 25 sold shares
      // have no lot to draw from.
      await trade(brokerage.id, cash.id, security.id, "2024-06-01", "sell", 25 * M, 120 * M);

      const { data, isError } = await callTool("get_realized_gains", { bookId: 1 });

      expect(isError).toBe(false);
      expect(data.disposals).toHaveLength(2);

      const unknown = data.disposals.find((d: { term: string }) => d.term === "unknown");
      expect(unknown).toBeDefined();
      expect(unknown.shares).toBe(15);
      expect(unknown.costBasis).toBeNull();
      expect(unknown.gainLoss).toBeNull();
      expect(unknown.proceeds).toBe(1800); // 15 shares * $120, real proceeds despite unknown basis

      // The known 10-share allocation still contributes to totals; the
      // unknown row is counted separately and excluded from the gain totals.
      expect(data.totals.unknownBasisDisposals).toBe(1);
      expect(data.totals.costBasis).toBe(1000);
    });

    it("filters by date range", async () => {
      const { brokerage, cash, security } = await setupAccounts();

      await trade(brokerage.id, cash.id, security.id, "2024-01-01", "buy", 10 * M, 10 * M);
      await trade(brokerage.id, cash.id, security.id, "2024-06-01", "sell", 10 * M, 15 * M);

      const { data, isError } = await callTool("get_realized_gains", {
        bookId: 1,
        startDate: "2025-01-01",
        endDate: "2025-12-31",
      });

      expect(isError).toBe(false);
      expect(data.disposals).toHaveLength(0);
      expect(data.totals.proceeds).toBe(0);
    });

    it("rejects a non-positive accountId at the schema boundary instead of silently dropping the filter", async () => {
      // getRealizedGains itself uses a truthy check on accountId (a known,
      // separately-tracked gap), so the schema is the only thing standing
      // between accountId: 0 and "no filter applied". The MCP SDK reports
      // schema-validation failures as a normal (non-JSON) error result
      // rather than a rejected promise, so inspect it directly instead of
      // going through the JSON-parsing callTool() helper.
      const result = await client.callTool({
        name: "get_realized_gains",
        arguments: { bookId: 1, accountId: 0 },
      });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      expect(text).toMatch(/accountId/i);
    });

    it("returns auth error when not authenticated", async () => {
      const { requireBookAuth } = await import("@/mcp/auth");
      vi.mocked(requireBookAuth).mockResolvedValueOnce({
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: "A valid COUNTERPOISE_API_KEY is required" }),
          },
        ],
        isError: true,
      });

      const { data, isError } = await callTool("get_realized_gains", { bookId: 1 });

      expect(isError).toBe(true);
      expect(data.error).toContain("COUNTERPOISE_API_KEY");
    });
  });

  /**
   * Seed a held investment position: an investment account, its cash
   * sub-account, an income account, a security, and one buy transaction.
   * The buy goes through createTransaction() rather than the raw fixtures
   * so rebuildLots() runs and produces a real FIFO lot — a bare
   * createInvestmentSplit fixture writes no lot at all.
   */
  async function seedHeldPosition() {
    const account = await createAccount({
      name: "Brokerage",
      type: "asset",
      subtype: "investment",
    });
    const cashAccount = await createAccount({
      name: "Brokerage Cash",
      type: "asset",
      isInvestmentCash: true,
    });
    const incomeAccount = await createAccount({
      name: "Dividend Income",
      type: "income",
    });
    const security = await createSecurity({
      name: "Held Fund",
      symbol: "HELD",
      securityType: "etf",
    });

    await createTransaction(getDb(), 1, {
      date: "2026-01-15",
      description: "Buy HELD",
      splits: [
        { accountId: account.id, amount: 10000 },
        { accountId: cashAccount.id, amount: -10000 },
      ],
      investmentSplits: [
        {
          securityId: security.id,
          action: "buy",
          sharesMicros: 2_000_000,
          priceMicros: 50_000_000,
        },
      ],
    });

    return {
      account,
      security,
      cashAccountId: cashAccount.id,
      incomeAccountId: incomeAccount.id,
    };
  }

  // ---------- get_security_detail ----------
  describe("get_security_detail", () => {
    it("returns security info, prices, transactions, and position", async () => {
      const investmentAcct = await createAccount({
        name: "Brokerage",
        type: "asset",
        subtype: "investment",
      });
      const cashAcct = await createAccount({
        name: "Brokerage Cash",
        type: "asset",
        isInvestmentCash: true,
      });
      const security = await createSecurity({
        name: "Vanguard Total Stock",
        symbol: "VTI",
        securityType: "etf",
      });

      // Buy 2 shares at $50
      const txn = await createTransactionWithSplits({
        date: "2025-01-15",
        description: "Buy VTI",
        splits: [
          { accountId: investmentAcct.id, amount: 10000 },
          { accountId: cashAcct.id, amount: -10000 },
        ],
      });

      await createInvestmentSplit({
        transactionId: txn.id,
        accountId: investmentAcct.id,
        securityId: security.id,
        action: "buy",
        sharesMicros: 2_000_000, // 2 shares
        priceMicros: 50_000_000, // $50
      });

      // Add 2 price records
      await createSecurityPrice({
        securityId: security.id,
        priceDate: "2025-01-18",
        priceMicros: 52_000_000,
      });
      await createSecurityPrice({
        securityId: security.id,
        priceDate: "2025-01-20",
        priceMicros: 55_000_000,
      });

      const { data, isError } = await callTool("get_security_detail", {
        bookId: 1,
        securityId: security.id,
      });

      expect(isError).toBe(false);
      expect(data.security.symbol).toBe("VTI");
      expect(data.recentPrices).toHaveLength(2);

      expect(data.transactions).toHaveLength(1);
      expect(data.transactions[0].action).toBe("buy");
      expect(data.transactions[0].shares).toBe(2);

      expect(data.position).not.toBeNull();
      expect(data.position.shares).toBe(2);
    });

    it("reports a fixed-price security's position at its fixed price", async () => {
      // The position comes from getPositions, so this is the fixed-price rule
      // reaching MCP through the same path the web app uses. recentPrices stays
      // raw on purpose: it is the recorded history, not the valuation.
      const investmentAcct = await createAccount({
        name: "Brokerage",
        type: "asset",
        subtype: "investment",
      });
      const cashAcct = await createAccount({
        name: "Brokerage Cash",
        type: "asset",
        isInvestmentCash: true,
      });
      const mmf = await createSecurity({
        name: "Vanguard Federal Money Market",
        symbol: "VMFXX",
        securityType: "mutual_fund",
        fetchPrices: false,
        fixedPriceMicros: 1_000_000,
      });

      const txn = await createTransactionWithSplits({
        date: "2025-01-15",
        description: "Buy VMFXX",
        splits: [
          { accountId: investmentAcct.id, amount: 250_000 },
          { accountId: cashAcct.id, amount: -250_000 },
        ],
      });
      await createInvestmentSplit({
        transactionId: txn.id,
        accountId: investmentAcct.id,
        securityId: mmf.id,
        action: "buy",
        sharesMicros: 2_500_000_000,
        priceMicros: 1_000_000,
      });

      const { data, isError } = await callTool("get_security_detail", {
        bookId: 1,
        securityId: mmf.id,
      });

      expect(isError).toBe(false);
      expect(data.position.latestPrice).toBe(1);
      expect(data.position.marketValue).toBe(2500);
    });

    it("returns error for nonexistent security", async () => {
      const { data, isError } = await callTool("get_security_detail", {
        bookId: 1,
        securityId: 99999,
      });

      expect(isError).toBe(true);
      expect(data.error).toMatch(/99999/);
    });

    it("respects priceLimit parameter", async () => {
      const security = await createSecurity({
        name: "Vanguard Total Stock",
        symbol: "VTI",
        securityType: "etf",
      });

      // Create 10 price records
      for (let i = 1; i <= 10; i++) {
        await createSecurityPrice({
          securityId: security.id,
          priceDate: `2025-01-${String(i).padStart(2, "0")}`,
          priceMicros: 50_000_000 + i * 1_000_000,
        });
      }

      const { data, isError } = await callTool("get_security_detail", {
        bookId: 1,
        securityId: security.id,
        priceLimit: 3,
      });

      expect(isError).toBe(false);
      expect(data.recentPrices).toHaveLength(3);
    });

    it("priceOffset skips the newest prices instead of re-returning them", async () => {
      const security = await createSecurity({
        name: "Vanguard Total Stock",
        symbol: "VTI",
        securityType: "etf",
      });

      // 10 prices, newest first once sorted: 2025-01-10 down to 2025-01-01.
      for (let i = 1; i <= 10; i++) {
        await createSecurityPrice({
          securityId: security.id,
          priceDate: `2025-01-${String(i).padStart(2, "0")}`,
          priceMicros: 50_000_000 + i * 1_000_000,
        });
      }

      const page1 = await callTool("get_security_detail", {
        bookId: 1,
        securityId: security.id,
        priceLimit: 3,
      });
      const page2 = await callTool("get_security_detail", {
        bookId: 1,
        securityId: security.id,
        priceLimit: 3,
        priceOffset: 3,
      });

      expect(page1.data.recentPrices.map((p: { date: string }) => p.date)).toEqual([
        "2025-01-10", "2025-01-09", "2025-01-08",
      ]);
      expect(page2.data.recentPrices.map((p: { date: string }) => p.date)).toEqual([
        "2025-01-07", "2025-01-06", "2025-01-05",
      ]);
    });

    it("get_security_detail omits lots unless includeLots is set", async () => {
      const { account, security } = await seedHeldPosition();

      const withoutLots = await callTool("get_security_detail", {
        bookId: 1, securityId: security.id,
      });
      expect(withoutLots.data).not.toHaveProperty("lots");

      const withLots = await callTool("get_security_detail", {
        bookId: 1, securityId: security.id, includeLots: true,
      });
      expect(withLots.data.lots).toHaveLength(1);
      expect(withLots.data.lots[0].accountId).toBe(account.id);
      expect(withLots.data.lots[0]).toHaveProperty("acquiredDate");
      expect(withLots.data.lots[0].shares).toBeGreaterThan(0);
    });

    it("get_security_detail reports the cash amount on dividend transactions", async () => {
      const { account, security, cashAccountId, incomeAccountId } = await seedHeldPosition();
      const txn = await createTransactionWithSplits({
        bookId: 1, date: "2026-02-01", description: "Dividend",
        splits: [
          { accountId: cashAccountId, amount: 5000 },
          { accountId: incomeAccountId, amount: -5000 },
        ],
      });
      await createInvestmentSplit({
        bookId: 1, transactionId: txn.id, accountId: account.id, securityId: security.id,
        action: "dividend", sharesMicros: 0, priceMicros: 0,
      });

      const { data } = await callTool("get_security_detail", { bookId: 1, securityId: security.id });

      const dividend = data.transactions.find((t: { action: string }) => t.action === "dividend");
      expect(dividend.cashAmount).toBe(50);
      const buy = data.transactions.find((t: { action: string }) => t.action === "buy");
      expect(buy.cashAmount).toBeNull();
    });

    it("get_security_detail counts only the cash leg when a dividend withholds tax", async () => {
      // A withheld-tax dividend has TWO positive debits: $85 to cash and $15
      // to a tax expense account. Only the asset leg is cash received, so
      // this must report 85 — summing every positive amount reports 100.
      const { account, security, cashAccountId, incomeAccountId } = await seedHeldPosition();
      const taxAccount = await createAccount({
        bookId: 1, name: "Dividend Withholding", type: "expense", subtype: "other",
      });
      const txn = await createTransactionWithSplits({
        bookId: 1, date: "2026-02-15", description: "Dividend, tax withheld",
        splits: [
          { accountId: cashAccountId, amount: 8500 },
          { accountId: taxAccount.id, amount: 1500 },
          { accountId: incomeAccountId, amount: -10000 },
        ],
      });
      await createInvestmentSplit({
        bookId: 1, transactionId: txn.id, accountId: account.id, securityId: security.id,
        action: "dividend", sharesMicros: 0, priceMicros: 0,
      });

      const { data } = await callTool("get_security_detail", { bookId: 1, securityId: security.id });

      const withheld = data.transactions.find(
        (t: { description: string }) => t.description === "Dividend, tax withheld"
      );
      expect(withheld.cashAmount).toBe(85);
    });

    it("get_security_detail reports the ratio on a stock split transaction", async () => {
      // A split is written with sharesMicros: 0, priceMicros: 0, so shares
      // reads as 0 regardless — splitNumerator/splitDenominator are the only
      // fields that carry the 4-for-1 ratio.
      const { account, cashAccountId, security } = await seedHeldPosition();
      const txn = await createTransactionWithSplits({
        bookId: 1, date: "2026-03-01", description: "4-for-1 split",
        splits: [{ accountId: cashAccountId, amount: 0 }],
      });
      await createInvestmentSplit({
        bookId: 1, transactionId: txn.id, accountId: account.id, securityId: security.id,
        action: "split", sharesMicros: 0, priceMicros: 0,
        splitNumerator: 4, splitDenominator: 1,
      });

      const { data } = await callTool("get_security_detail", { bookId: 1, securityId: security.id });

      const split = data.transactions.find((t: { action: string }) => t.action === "split");
      expect(split.shares).toBe(0);
      expect(split.splitNumerator).toBe(4);
      expect(split.splitDenominator).toBe(1);
      const buy = data.transactions.find((t: { action: string }) => t.action === "buy");
      expect(buy.splitNumerator).toBeNull();
      expect(buy.splitDenominator).toBeNull();
    });
  });

  // ---------- list_securities ----------
  describe("list_securities", () => {
    it("list_securities returns a book's securities with position fields", async () => {
      await createSecurity({ name: "Alpha Fund", symbol: "AAA", securityType: "etf" });

      const { data, isError } = await callTool("list_securities", { bookId: 1 });

      expect(isError).toBe(false);
      expect(data).toHaveLength(1);
      expect(data[0].symbol).toBe("AAA");
      expect(data[0]).toHaveProperty("incomeCents", 0);
    });
  });

  // ---------- update_security ----------
  describe("update_security", () => {
    it("update_security changes only the fields passed", async () => {
      const sec = await createSecurity({ bookId: 1, name: "Old", symbol: "OLD", securityType: "etf" });

      const { data, isError } = await callTool("update_security", {
        bookId: 1, securityId: sec.id, name: "New",
      });

      expect(isError).toBe(false);
      expect(data.name).toBe("New");
      expect(data.symbol).toBe("OLD");
    });

    it("update_security fails for a security in another book and leaves it unchanged", async () => {
      const other = await createBook({ name: "Other" });
      const theirs = await createSecurity({
        bookId: other.id, name: "Theirs", symbol: "THRS", securityType: "etf",
      });

      const { isError } = await callTool("update_security", {
        bookId: 1, securityId: theirs.id, name: "Hijacked",
      });

      expect(isError).toBe(true);
      const [after] = await getDb().select().from(securities).where(eq(securities.id, theirs.id));
      expect(after.name).toBe("Theirs");
    });
  });

  // ---------- delete_security ----------
  describe("delete_security", () => {
    it("delete_security refuses a security with investment transactions", async () => {
      const account = await createAccount({
        bookId: 1, name: "Brokerage", type: "asset", subtype: "investment",
      });
      const sec = await createSecurity({ bookId: 1, name: "Held", symbol: "HELD", securityType: "etf" });
      const txn = await createTransactionWithSplits({
        bookId: 1, date: "2026-01-15", description: "Buy",
        splits: [
          { accountId: account.id, amount: 100000 },
          { accountId: account.id, amount: -100000 },
        ],
      });
      await createInvestmentSplit({
        bookId: 1, transactionId: txn.id, accountId: account.id, securityId: sec.id,
        action: "buy", sharesMicros: 10_000_000, priceMicros: 10_000_000,
      });

      const { data, isError } = await callTool("delete_security", { bookId: 1, securityId: sec.id });

      expect(isError).toBe(true);
      expect(data.error).toContain("investment transactions");
      const rows = await getDb().select().from(securities).where(eq(securities.id, sec.id));
      expect(rows).toHaveLength(1);
    });
  });
});
