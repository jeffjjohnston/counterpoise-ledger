import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import {
  setupTestDatabase,
  resetTestDatabase,
  createAccount,
  createTransactionWithSplits,
  createSecurity,
  createInvestmentSplit,
  createSecurityPrice,
  createBook,
  createUser,
} from "@/tests/helpers/db-utils";
import { callMcpTool } from "@/tests/helpers/mcp";
import { connectMcpTestClient, type McpTestClient } from "@/tests/helpers/mcp-client";
import { count, row } from "@/tests/helpers/sql";
import { workerDatabasePath } from "@/tests/helpers/test-database";
import type { Security } from "@/types/db";

let mcp: McpTestClient;

const run = promisify(execFile);
const CLI = resolve("rust-api/target/debug/ledger-cli");

/**
 * Rebuilds the lots of every pair with the Rust `ledger-cli`, on this worker's
 * database. The test database holds only this test's pairs.
 */
async function rebuildAllLots() {
  await run(CLI, ["rebuild-lots", "--force"], {
    env: {
      ...process.env,
      DATABASE_PATH: workerDatabasePath(),
      DATABASE_URL: "",
      TZ: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
  });
}

const callTool = (name: string, args: Record<string, unknown> = {}) =>
  callMcpTool(mcp.client, name, args);

/** Writes a transaction in book 1 through the server, which rebuilds its lots. */
async function createTransaction(body: Record<string, unknown>) {
  const { data, isError } = await callTool("create_transaction", { bookId: 1, ...body });
  if (isError) throw new Error(`create_transaction failed: ${JSON.stringify(data)}`);
  return data as { id: number };
}

describe("MCP Security and Investment Tools", () => {
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

      // createInvestmentSplit is a low-level helper that bypasses the
      // transaction write path, which is what normally rebuilds the lots
      // after a write. Rebuild explicitly so
      // investment_lots reflects this pair, same as a real write-path call
      // would produce — getPositions now sources costBasis from lots.
      await rebuildAllLots();

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
      return createTransaction({
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
      const result = await mcp.client.callTool({
        name: "get_realized_gains",
        arguments: { bookId: 1, accountId: 0 },
      });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      expect(text).toMatch(/accountId/i);
    });

    // The key check itself is in rust-transport.test.ts and rust-stdio.test.ts.
    it("refuses a user who is not a member of the book", async () => {
      const stranger = await createUser({ username: "stranger" });
      const { data, isError } = await mcp.callAs(stranger.id, "get_realized_gains", { bookId: 1 });

      expect(isError).toBe(true);
      expect(data).toEqual({ error: "You do not have access to this book" });
    });
  });

  /**
   * Seed a held investment position: an investment account, its cash
   * sub-account, an income account, a security, and one buy transaction.
   * The buy goes through the create_transaction tool rather than the raw
   * fixtures so the lot rebuild runs and produces a real FIFO lot — a bare
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

    await createTransaction({
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

    it("update_security refuses another security's symbol with the library's message", async () => {
      // The library throws SecurityDuplicateError, which the tool does not
      // catch, so the SDK reports its text as a plain-text error. The HTTP
      // route answers the same case with a 409 and the same text in a JSON error body.
      const vti = await createSecurity({ bookId: 1, name: "Total", symbol: "VTI", securityType: "etf" });
      const bnd = await createSecurity({ bookId: 1, name: "Bond", symbol: "BND", securityType: "etf" });

      const result = await mcp.client.callTool({
        name: "update_security",
        arguments: { bookId: 1, securityId: bnd.id, symbol: " vti " },
      });

      expect(result.isError).toBe(true);
      const [content] = result.content as Array<{ type: string; text: string }>;
      expect(content.text).toBe(`A security with symbol "vti" already exists (id ${vti.id})`);
      const after = await row<Security>("SELECT * FROM securities WHERE id = $1", [bnd.id]);
      expect(after.symbol).toBe("BND");
    });

    it("update_security fails for a security in another book and leaves it unchanged", async () => {
      const other = await createBook({ name: "Other" });
      const theirs = await createSecurity({
        bookId: other.id, name: "Theirs", symbol: "THRS", securityType: "etf",
      });

      const { data, isError } = await callTool("update_security", {
        bookId: 1, securityId: theirs.id, name: "Hijacked",
      });

      expect(isError).toBe(true);
      // The library names the ID; the HTTP route does not.
      expect(data.error).toBe(`Security ${theirs.id} not found`);
      const after = await row<Security>("SELECT * FROM securities WHERE id = $1", [theirs.id]);
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
      expect(await count("securities", "id = $1", [sec.id])).toBe(1);
    });
  });
});
