import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { flattenAccounts } from "@/lib/accounting";
import { computeNetWorth } from "@/lib/net-worth";
import type { AccountWithBalance } from "@/types";
import { toDateString } from "../../lib/formatters";
import {
  createAccount, createInvestmentSplit, createSecurity, createSecurityPrice,
  createTransactionWithSplits, resetTestDatabase, setupTestDatabase,
} from "../helpers/db-utils";
import { rustSeed } from "../helpers/rust-seed";
import { rows, scalar } from "../helpers/sql";
import { sessionHttpClient, startHttpTestServer } from "../helpers/http-parity";

/** The id of the newest transaction of book 1. */
async function lastTransactionId(): Promise<number> {
  return Number(await scalar("SELECT MAX(id) FROM transactions WHERE book_id = 1"));
}

describe("net worth history", () => {
  let baseUrl: string;
  let stop: () => Promise<void>;
  let client: Awaited<ReturnType<typeof sessionHttpClient>>;
  beforeAll(async () => {
    await setupTestDatabase();
    ({ baseUrl, stop } = await startHttpTestServer());
  }, 120_000);
  beforeEach(async () => {
    await resetTestDatabase();
    client = await sessionHttpClient(baseUrl);
  });
  afterAll(async () => { await stop?.(); });

  async function points(query = "") {
    const response = await client.request(`/api/b/1/reports/net-worth-history${query}`);
    expect(response.status).toBe(200);
    return (await response.json()).points as { date: string; netWorthCents: number }[];
  }

  it("uses book balances, and market value for investment accounts, at each month end", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset", subtype: "bank" });
    const card = await createAccount({ name: "Card", type: "liability", subtype: "credit_card" });
    const salary = await createAccount({ name: "Salary", type: "income" });
    const food = await createAccount({ name: "Food", type: "expense" });
    const brokerage = await createAccount({ name: "Brokerage", type: "asset", subtype: "investment" });
    const cash = await createAccount({ name: "Brokerage Cash", type: "asset", parentId: brokerage.id, isInvestmentCash: true });
    const fund = await createSecurity({ name: "Fund", symbol: "FND", securityType: "etf" });
    await createTransactionWithSplits({ date: "2026-01-05", splits: [
      { accountId: checking.id, amount: 500_000 }, { accountId: salary.id, amount: -500_000 }] });
    await createTransactionWithSplits({ date: "2026-01-20", splits: [
      { accountId: food.id, amount: 20_000 }, { accountId: card.id, amount: -20_000 }] });
    await createTransactionWithSplits({ date: "2026-02-01", splits: [
      { accountId: checking.id, amount: -200_000 }, { accountId: cash.id, amount: 200_000 }] });
    await createTransactionWithSplits({ date: "2026-02-10", splits: [
      { accountId: brokerage.id, amount: 100_000 }, { accountId: cash.id, amount: -100_000 }] });
    await createInvestmentSplit({ transactionId: await lastTransactionId(), accountId: brokerage.id,
      securityId: fund.id, action: "buy", sharesMicros: 10_000_000, priceMicros: 100_000_000 });
    await createSecurityPrice({ securityId: fund.id, priceDate: "2026-02-10", priceMicros: 100_000_000 });
    await createSecurityPrice({ securityId: fund.id, priceDate: "2026-03-15", priceMicros: 120_000_000 });

    // Rows after the end date must not change the last point.
    await createTransactionWithSplits({ date: "2026-03-25", splits: [
      { accountId: checking.id, amount: 70_000 }, { accountId: salary.id, amount: -70_000 }] });
    await createTransactionWithSplits({ date: "2026-03-25", splits: [
      { accountId: brokerage.id, amount: 50_000 }, { accountId: cash.id, amount: -50_000 }] });
    await createInvestmentSplit({ transactionId: await lastTransactionId(), accountId: brokerage.id,
      securityId: fund.id, action: "buy", sharesMicros: 5_000_000, priceMicros: 100_000_000 });

    expect(await points("?startDate=2026-01-01&endDate=2026-03-20")).toEqual([
      { date: "2026-01-31", netWorthCents: 480_000 },
      { date: "2026-02-28", netWorthCents: 480_000 },
      { date: "2026-03-20", netWorthCents: 500_000 },
    ]);
    // A start before the first transaction gives the same three points.
    expect(await points("?startDate=2025-01-01&endDate=2026-03-20")).toEqual([
      { date: "2026-01-31", netWorthCents: 480_000 },
      { date: "2026-02-28", netWorthCents: 480_000 },
      { date: "2026-03-20", netWorthCents: 500_000 },
    ]);
  });

  it("counts a floating transaction in the current month only", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const salary = await createAccount({ name: "Salary", type: "income" });
    const now = new Date();
    const earlier = toDateString(new Date(now.getFullYear(), now.getMonth() - 2, 10));
    await createTransactionWithSplits({ date: earlier, splits: [
      { accountId: checking.id, amount: 500 }, { accountId: salary.id, amount: -500 }] });
    await createTransactionWithSplits({ date: "2020-01-01", isFloating: true, splits: [
      { accountId: checking.id, amount: 1000 }, { accountId: salary.id, amount: -1000 }] });

    const series = await points();
    expect(series.at(-1)).toEqual({ date: toDateString(now), netWorthCents: 1500 });
    expect(series.slice(0, -1).map((point) => point.netWorthCents)).toEqual([500, 500]);
  });

  it("includes the past balance of an account that is now inactive", async () => {
    const old = await createAccount({ name: "Old Savings", type: "asset", isActive: false });
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const salary = await createAccount({ name: "Salary", type: "income" });
    await createTransactionWithSplits({ date: "2026-01-05", splits: [
      { accountId: old.id, amount: 1000 }, { accountId: salary.id, amount: -1000 }] });
    await createTransactionWithSplits({ date: "2026-02-05", splits: [
      { accountId: old.id, amount: -1000 }, { accountId: checking.id, amount: 1000 }] });

    expect(await points("?startDate=2026-01-01&endDate=2026-02-28")).toEqual([
      { date: "2026-01-31", netWorthCents: 1000 },
      { date: "2026-02-28", netWorthCents: 1000 },
    ]);
  });

  it("gives no points for an empty book or a book that starts after the end date", async () => {
    expect(await points()).toEqual([]);
    expect(await points("?startDate=2025-01-01")).toEqual([]);
    expect(await points("?startDate=0001-01-01")).toEqual([]);
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const salary = await createAccount({ name: "Salary", type: "income" });
    await createTransactionWithSplits({ date: "2026-03-01", splits: [
      { accountId: checking.id, amount: 100 }, { accountId: salary.id, amount: -100 }] });
    expect(await points("?endDate=2026-02-01")).toEqual([]);
  });

  it("rejects bad dates, a start after the end, and a book that is not yours", async () => {
    for (const [query, message] of [
      ["?startDate=2026-02-30", "Invalid ISO date"],
      ["?startDate=2026-03-01&endDate=2026-02-01", "startDate must not be after endDate"],
    ] as const) {
      const response = await client.request(`/api/b/1/reports/net-worth-history${query}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: message });
    }
    const missing = await client.request("/api/b/999999/reports/net-worth-history");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Book not found" });
  });

  it("ends at the dashboard net worth on the seed data", async () => {
    await rustSeed("--book-id", "1");
    const now = new Date();
    const today = toDateString(now);
    // A price dated 7 days ahead for each security without a fixed price. The account values use the
    // newest price with no date limit, so the last point must use it too. At 7 days, a server TZ that
    // is not the test TZ cannot make the price date the server's today.
    const future = toDateString(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7));
    const securities = await rows<{ id: number }>(
      "SELECT id FROM securities WHERE book_id = 1 AND fixed_price_micros IS NULL");
    expect(securities.length).toBeGreaterThan(0);
    for (const { id } of securities) {
      await createSecurityPrice({ securityId: id, priceDate: future, priceMicros: 987_650_000 });
    }
    const accounts = flattenAccounts(await (await client.request(
      `/api/b/1/accounts?includeInactive=true&asOfDate=${today}`)).json() as AccountWithBalance[]);
    const values = await (await client.request(
      `/api/b/1/investments/account-values?asOfDate=${today}`)).json();
    // The card skips inactive accounts and the history does not. They agree
    // only while each inactive account has a zero balance.
    expect(accounts.filter((account) => !account.isActive && account.balance !== 0)).toEqual([]);
    const { netWorth } = computeNetWorth(accounts, values);
    expect((await points()).at(-1)).toEqual({ date: today, netWorthCents: netWorth });
  }, 180_000);

  type Grouped = {
    groups: { accountId: number; name: string }[];
    points: { date: string; netWorthCents: number; groups: { accountId: number; valueCents: number }[] }[];
  };

  async function grouped(query: string): Promise<Grouped> {
    const response = await client.request(`/api/b/1/reports/net-worth-history${query}`);
    expect(response.status).toBe(200);
    return await response.json() as Grouped;
  }

  it("gives each top-level account its descendants and its market value with groupBy=account", async () => {
    const bank = await createAccount({ name: "Bank", type: "asset" });
    const checking = await createAccount({ name: "Checking", type: "asset", subtype: "bank", parentId: bank.id });
    const savings = await createAccount({ name: "Joint Savings", type: "asset", parentId: checking.id });
    const card = await createAccount({ name: "Card", type: "liability", subtype: "credit_card" });
    await createAccount({ name: "Empty", type: "asset" });
    const salary = await createAccount({ name: "Salary", type: "income" });
    const food = await createAccount({ name: "Food", type: "expense" });
    const brokerage = await createAccount({ name: "Brokerage", type: "asset", subtype: "investment" });
    const cash = await createAccount({ name: "Brokerage Cash", type: "asset", parentId: brokerage.id, isInvestmentCash: true });
    const fund = await createSecurity({ name: "Fund", symbol: "FND", securityType: "etf" });
    await createTransactionWithSplits({ date: "2026-01-05", splits: [
      { accountId: checking.id, amount: 400_000 }, { accountId: savings.id, amount: 100_000 },
      { accountId: salary.id, amount: -500_000 }] });
    await createTransactionWithSplits({ date: "2026-01-20", splits: [
      { accountId: food.id, amount: 20_000 }, { accountId: card.id, amount: -20_000 }] });
    await createTransactionWithSplits({ date: "2026-02-01", splits: [
      { accountId: checking.id, amount: -200_000 }, { accountId: cash.id, amount: 200_000 }] });
    await createTransactionWithSplits({ date: "2026-02-10", splits: [
      { accountId: brokerage.id, amount: 100_000 }, { accountId: cash.id, amount: -100_000 }] });
    await createInvestmentSplit({ transactionId: await lastTransactionId(), accountId: brokerage.id,
      securityId: fund.id, action: "buy", sharesMicros: 10_000_000, priceMicros: 100_000_000 });
    await createSecurityPrice({ securityId: fund.id, priceDate: "2026-02-10", priceMicros: 100_000_000 });
    await createSecurityPrice({ securityId: fund.id, priceDate: "2026-03-15", priceMicros: 120_000_000 });

    // Bank holds Checking and its child Joint Savings. Brokerage holds its cash and
    // the market value of 10 shares. Empty, Salary and Food have no group.
    expect(await grouped("?startDate=2026-01-01&endDate=2026-03-20&groupBy=account")).toEqual({
      groups: [
        { accountId: bank.id, name: "Bank" },
        { accountId: brokerage.id, name: "Brokerage" },
        { accountId: card.id, name: "Card" },
      ],
      points: [
        { date: "2026-01-31", netWorthCents: 480_000, groups: [
          { accountId: bank.id, valueCents: 500_000 },
          { accountId: brokerage.id, valueCents: 0 },
          { accountId: card.id, valueCents: -20_000 }] },
        { date: "2026-02-28", netWorthCents: 480_000, groups: [
          { accountId: bank.id, valueCents: 300_000 },
          { accountId: brokerage.id, valueCents: 200_000 },
          { accountId: card.id, valueCents: -20_000 }] },
        { date: "2026-03-20", netWorthCents: 500_000, groups: [
          { accountId: bank.id, valueCents: 300_000 },
          { accountId: brokerage.id, valueCents: 220_000 },
          { accountId: card.id, valueCents: -20_000 }] },
      ],
    });
    // Without groupBy, the points have no groups.
    expect(await points("?startDate=2026-01-01&endDate=2026-03-20")).toEqual([
      { date: "2026-01-31", netWorthCents: 480_000 },
      { date: "2026-02-28", netWorthCents: 480_000 },
      { date: "2026-03-20", netWorthCents: 500_000 },
    ]);
  });

  it("gives no groups and no points for an empty book with groupBy=account", async () => {
    expect(await grouped("?groupBy=account")).toEqual({ groups: [], points: [] });
  });

  it("rejects a groupBy other than account", async () => {
    for (const query of ["?groupBy=payee", "?groupBy=", "?groupBy=Account"]) {
      const response = await client.request(`/api/b/1/reports/net-worth-history${query}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Invalid groupBy" });
    }
  });

  it("adds the groups up to the net worth at each point on the seed data", async () => {
    await rustSeed("--book-id", "1");
    const plain = await points("?startDate=2024-01-01");
    const result = await grouped("?startDate=2024-01-01&groupBy=account");
    expect(result.points.map(({ date, netWorthCents }) => ({ date, netWorthCents }))).toEqual(plain);
    expect(plain.length).toBeGreaterThan(12);
    const topLevel = await rows<{ id: number; name: string }>(
      `SELECT id, name FROM accounts WHERE book_id = 1 AND parent_id IS NULL AND type IN ('asset', 'liability')`);
    const names = new Map(topLevel.map((account) => [account.id, account.name]));
    expect(result.groups.length).toBeGreaterThan(1);
    for (const group of result.groups) expect(names.get(group.accountId)).toBe(group.name);
    const sorted = [...result.groups].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.accountId - b.accountId));
    expect(result.groups).toEqual(sorted);
    for (const point of result.points) {
      expect(point.groups.map((group) => group.accountId)).toEqual(result.groups.map((group) => group.accountId));
      expect(point.groups.reduce((sum, group) => sum + group.valueCents, 0)).toBe(point.netWorthCents);
    }
    for (const group of result.groups) {
      expect(result.points.some((point) => point.groups.find((value) => value.accountId === group.accountId)!.valueCents !== 0))
        .toBe(true);
    }
  }, 180_000);
});
