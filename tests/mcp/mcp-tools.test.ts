import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import {
  setupTestDatabase,
  resetTestDatabase,
  createAccount,
  createTransactionWithSplits,
  createPayee,
  createRecurringRule,
  createSecurity,
  createInvestmentSplit,
} from "@/tests/helpers/db-utils";
import { callMcpTool } from "@/tests/helpers/mcp";
import { connectMcpTestClient, type McpTestClient } from "@/tests/helpers/mcp-client";
import { toDateString } from "@/lib/formatters";

// The client sends a real key of user 1, who owns book 1.
let mcp: McpTestClient;

/**
 * Call an MCP tool and parse the JSON text response.
 * Returns { data, isError } where data is the parsed first text content.
 */
const callTool = (name: string, args: Record<string, unknown> = {}) =>
  callMcpTool(mcp.client, name, args);

describe("MCP Tools", () => {
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

    it("returns isFloating and the effective date that the sort uses", async () => {
      // A floating row sorts by today's date. Without these fields the client
      // sees an old date at the top of the list and cannot explain the order.
      const checking = await createAccount({ name: "Checking", type: "asset" });
      const groceries = await createAccount({ name: "Groceries", type: "expense" });
      await createTransactionWithSplits({
        date: "2020-01-05",
        description: "Floating groceries",
        isFloating: true,
        splits: [
          { accountId: checking.id, amount: -2500 },
          { accountId: groceries.id, amount: 2500 },
        ],
      });
      await createTransactionWithSplits({
        date: "2025-01-15",
        description: "Settled groceries",
        splits: [
          { accountId: checking.id, amount: -1000 },
          { accountId: groceries.id, amount: 1000 },
        ],
      });

      const { data, isError } = await callTool("list_transactions", { bookId: 1 });

      expect(isError).toBe(false);
      const [floating, settled] = data.transactions;
      expect(floating).toMatchObject({
        description: "Floating groceries",
        date: "2020-01-05",
        isFloating: true,
        effectiveDate: toDateString(new Date()),
      });
      expect(settled).toMatchObject({
        description: "Settled groceries",
        date: "2025-01-15",
        isFloating: false,
        effectiveDate: "2025-01-15",
      });
    });

    // The tool changes each argument into the register route's query. The
    // route's filters have their own tests in tests/http/transactions.test.ts.
    // This test makes sure that each argument gets to the route, and that the
    // tool gives the limit and offset defaults.
    it("sends each filter, the limit and the offset to the register route", async () => {
      const checking = await createAccount({ name: "Checking", type: "asset" });
      const savings = await createAccount({ name: "Savings", type: "asset" });
      const vacation = await createAccount({ name: "Vacation Fund", type: "asset" });
      const groceries = await createAccount({ name: "Groceries", type: "expense" });
      const market = await createPayee({ name: "Market" });
      const add = (date: string, description: string, from: number, payeeId?: number) =>
        createTransactionWithSplits({
          date, description, payeeId,
          splits: [
            { accountId: from, amount: -100 },
            { accountId: groceries.id, amount: 100 },
          ],
        });
      await add("2026-01-10", "Checking at market", checking.id, market.id);
      await add("2026-01-11", "Savings", savings.id);
      await add("2026-01-12", "Vacation", vacation.id);
      await add("2026-02-15", "Checking later", checking.id);

      const list = async (args: Record<string, unknown>) => {
        const { data, isError } = await callTool("list_transactions", { bookId: 1, ...args });
        expect(isError, JSON.stringify(args)).toBe(false);
        return {
          ...data,
          descriptions: data.transactions.map((t: { description: string }) => t.description),
        };
      };

      const all = await list({});
      expect(all.descriptions).toEqual(["Checking later", "Vacation", "Savings", "Checking at market"]);
      expect(all).toMatchObject({ totalCount: 4, limit: 50, offset: 0 });

      expect((await list({ accountId: checking.id })).descriptions)
        .toEqual(["Checking later", "Checking at market"]);
      // The tool joins the accountIds array into one comma-separated value.
      expect((await list({ accountIds: [checking.id, savings.id] })).descriptions)
        .toEqual(["Checking later", "Savings", "Checking at market"]);
      expect((await list({ payeeId: market.id })).descriptions).toEqual(["Checking at market"]);
      expect((await list({ startDate: "2026-01-11", endDate: "2026-01-31" })).descriptions)
        .toEqual(["Vacation", "Savings"]);

      const page = await list({ limit: 1, offset: 1 });
      expect(page.descriptions).toEqual(["Vacation"]);
      expect(page).toMatchObject({ totalCount: 4, limit: 1, offset: 1 });
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
      const result = await mcp.client.callTool({
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
    // MCP search shares the web route's implementation (`search_book()` in
    // rust-api/server/src/routes/search.rs), so
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

      expect(data.recurringRules.items).toHaveLength(1);
      expect(data.recurringRules.items[0].name).toBe("Roofing Maintenance Plan");

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
      expect(byAccount.data.accounts.items[0]).toHaveProperty("isActive", true);

      const byTxn = await callTool("search", { bookId: 1, query: "Shopping trip" });
      expect(byTxn.data.transactions[0].payeeName).toBe("Whole Foods Market");
      expect(byTxn.data.transactions[0].notes).toBeDefined();
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

});
