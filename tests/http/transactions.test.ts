import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { toDateString } from "../../lib/formatters";
import {
  createAccount, createBook, createInvestmentSplit, createPayee, createRecurringRule, createSecurity,
  createTransactionWithSplits, resetTestDatabase, setupTestDatabase,
} from "../helpers/db-utils";
import { sessionHttpClient, startHttpTestServer } from "../helpers/http-parity";
import { contract } from "../helpers/contract";

type RowBody = { id: number; description: string; investmentSplits: { action: string }[]; [field: string]: unknown };
const transactionListSchema = contract<RowBody[]>("TransactionList");
const transactionPageSchema = contract<{ transactions: RowBody[]; totalCount: number; startingBalance: number }>(
  "TransactionPage"
);

/** Timestamps and today's date differ between runs, so snapshots replace them. */
function normalized(body: unknown): unknown {
  return JSON.parse(
    JSON.stringify(body)
      .replaceAll(toDateString(new Date()), "<today>")
      .replace(/"(createdAt|updatedAt)":"[^"]+"/g, '"$1":"<timestamp>"')
  );
}

type Row = { id: number; description: string | null };

// The register: REGISTER_ORDER, the floating tie-break, pagination, the
// starting-balance boundary, and the ownership checks. Full bodies are
// snapshots that the Node run writes and the Rust run must match.
describe("transaction register HTTP parity", () => {
  let baseUrl: string;
  let stop: () => Promise<void>;
  let client: Awaited<ReturnType<typeof sessionHttpClient>>;
  let ids: Record<string, number>;

  beforeAll(async () => {
    await setupTestDatabase();
    ({ baseUrl, stop } = await startHttpTestServer());
  }, 120_000);
  beforeEach(async () => {
    await resetTestDatabase();
    client = await sessionHttpClient(baseUrl);
    const checking = await createAccount({ name: "Checking", type: "asset", subtype: "bank" });
    const savings = await createAccount({ name: "Savings", type: "asset", subtype: "bank" });
    const groceries = await createAccount({ name: "Groceries", type: "expense" });
    const salary = await createAccount({ name: "Salary", type: "income" });
    const market = await createPayee({ name: "Market" });
    const employer = await createPayee({ name: "Employer" });
    const rule = await createRecurringRule({
      name: "Pay", frequency: "monthly", startDate: "2025-01-15", nextDate: "2025-03-15",
      templateSplits: [{ accountId: checking.id, amount: 100_000 }, { accountId: salary.id, amount: -100_000 }],
    });
    const today = toDateString(new Date());
    const add = (date: string, description: string, amount: number, extra: Record<string, unknown> = {}) =>
      createTransactionWithSplits({
        date, description, ...extra,
        splits: [{ accountId: checking.id, amount: -amount }, { accountId: groceries.id, amount }],
      });
    await createTransactionWithSplits({
      date: "2025-01-15", description: "Pay January", payeeId: employer.id, recurringRuleId: rule.id,
      splits: [{ accountId: checking.id, amount: 100_000 }, { accountId: salary.id, amount: -100_000 }],
    });
    await add("2025-01-20", "Market A", 1_500, { payeeId: market.id, checkNumber: "101", notes: "weekly" });
    await add("2025-02-01", "Market B", 2_500, { payeeId: market.id });
    // Same date: the higher ID sorts first.
    await add("2025-02-10", "Tie low", 100);
    await add("2025-02-10", "Tie high", 200, { isReconciled: true });
    // One transaction with splits on two filtered accounts appears once.
    await createTransactionWithSplits({
      date: "2025-02-12", description: "Transfer",
      splits: [{ accountId: checking.id, amount: -5_000 }, { accountId: savings.id, amount: 5_000 }],
    });
    await createTransactionWithSplits({
      date: "2025-02-15", description: "Pay February", payeeId: employer.id, recurringRuleId: rule.id,
      splits: [{ accountId: checking.id, amount: 100_000 }, { accountId: salary.id, amount: -100_000 }],
    });
    // A settled row dated today with a higher ID than the floating row: the
    // floating row still sorts above it.
    const floating = await add("2024-12-01", "Floating check", 700, { isFloating: true });
    await add(today, "Today settled", 300);
    await add("2030-01-01", "Future", 900);
    const other = await createBook({ name: "Other" });
    const otherAccount = await createAccount({ name: "Other", type: "asset", bookId: other.id });
    const otherPayee = await createPayee({ name: "Other", bookId: other.id });
    const otherRule = await createRecurringRule({
      name: "Other", frequency: "monthly", startDate: "2025-01-01", nextDate: "2025-02-01", bookId: other.id,
      templateSplits: [{ accountId: otherAccount.id, amount: 1 }, { accountId: otherAccount.id, amount: -1 }],
    });
    ids = {
      checking: checking.id, savings: savings.id, groceries: groceries.id, market: market.id,
      rule: rule.id, floating: floating.id, otherAccount: otherAccount.id, otherPayee: otherPayee.id,
      otherRule: otherRule.id,
    };
  });
  afterAll(async () => { await stop?.(); });

  async function ok(path: string) {
    const response = await client.request(path);
    expect(response.status, path).toBe(200);
    return response.json();
  }

  async function page(query: string) {
    return transactionPageSchema.parse(await ok(`/api/b/1/transactions?includeMeta=true&${query}`));
  }

  const descriptions = (rows: Row[]) => rows.map((row) => row.description);

  it("pages the register with the floating tie-break and the starting balance below the page", async () => {
    const first = await page(`accountId=${ids.checking}&limit=3`);
    expect(descriptions(first.transactions)).toEqual(["Future", "Floating check", "Today settled"]);
    expect(first.totalCount).toBe(10);
    expect(normalized(first)).toMatchSnapshot();

    const second = await page(`accountId=${ids.checking}&limit=3&offset=3`);
    expect(descriptions(second.transactions)).toEqual(["Pay February", "Transfer", "Tie high"]);
    // Everything below "Tie high": Tie low, Market B, Market A, Pay January.
    expect(second.startingBalance).toBe(100_000 - 1_500 - 2_500 - 100);
    expect(normalized(second)).toMatchSnapshot();
  });

  it("anchors the starting balance below a floating row that ends the page", async () => {
    const result = await page(`accountId=${ids.checking}&limit=2`);
    expect(descriptions(result.transactions)).toEqual(["Future", "Floating check"]);
    // "Today settled" has a higher ID but sorts below the floating row.
    expect(result.startingBalance).toBe(200_000 - 300 - 5_000 - 200 - 100 - 2_500 - 1_500);
  });

  it("filters by several accounts, a payee, a rule, and a date range", async () => {
    const both = await page(`accountIds=${ids.checking},${ids.savings},${ids.savings}&limit=0`);
    expect(both.transactions.filter((row) => row.description === "Transfer")).toHaveLength(1);
    expect(both.totalCount).toBe(10);

    const payee = await page(`accountId=${ids.checking}&payeeId=${ids.market}&limit=1`);
    expect(descriptions(payee.transactions)).toEqual(["Market B"]);
    expect(payee.startingBalance).toBe(-1_500);

    const rule = await ok(`/api/b/1/transactions?recurringRuleId=${ids.rule}`);
    expect(descriptions(transactionListSchema.parse(rule))).toEqual(["Pay February", "Pay January"]);

    const range = await page(`accountId=${ids.checking}&startDate=2025-02-01&endDate=2025-02-12`);
    expect(descriptions(range.transactions)).toEqual(["Transfer", "Tie high", "Tie low", "Market B"]);
    // The date filters do not change the starting balance.
    expect(range.startingBalance).toBe(100_000 - 1_500);

    const balance = await page(`accountIds=${ids.checking},${ids.savings}&balanceAccountId=${ids.savings}&limit=1&offset=6`);
    expect(descriptions(balance.transactions)).toEqual(["Tie low"]);
    expect(balance.startingBalance).toBe(0);
  });

  it("widens the page to reach ensureId, and keeps the limit sentinels", async () => {
    const all = transactionListSchema.parse(await ok("/api/b/1/transactions?limit=0"));
    const oldest = all[all.length - 1];
    const widened = await page(`accountId=${ids.checking}&limit=2&ensureId=${oldest.id}`);
    expect(widened.transactions.at(-1)?.id).toBe(oldest.id);
    expect(widened.transactions).toHaveLength(10);
    // An offset or the "0" sentinel turns the widening off.
    expect((await page(`accountId=${ids.checking}&limit=2&offset=1&ensureId=${oldest.id}`)).transactions).toHaveLength(2);
    // Only the spelling "0" means every row. "00" is a limit of zero.
    expect(await ok("/api/b/1/transactions?limit=00")).toEqual([]);
    expect(await ok("/api/b/1/transactions?limit=00&ensureId=" + oldest.id)).toHaveLength(all.length);
    expect(all.map((row) => row.description)).toContain("Future");
    const bare = await ok("/api/b/1/transactions?limit=2");
    expect(Array.isArray(bare)).toBe(true);
    expect(normalized(bare)).toMatchSnapshot();
  });

  it("returns investment splits with their security and account", async () => {
    const brokerage = await createAccount({ name: "Brokerage", type: "asset", subtype: "investment" });
    const vti = await createSecurity({ name: "Total Market", symbol: "VTI", securityType: "etf", fixedPriceMicros: 5_000_000 });
    const buy = await createTransactionWithSplits({
      date: "2025-03-01", description: "Buy",
      splits: [{ accountId: brokerage.id, amount: 10_000 }, { accountId: ids.checking, amount: -10_000 }],
    });
    await createInvestmentSplit({ transactionId: buy.id, accountId: brokerage.id, securityId: vti.id, action: "buy", sharesMicros: 2_000_000, priceMicros: 50_000_000, feesCents: 3 });
    const split = await createTransactionWithSplits({
      date: "2025-03-02", description: "Split",
      splits: [{ accountId: brokerage.id, amount: 0 }, { accountId: brokerage.id, amount: 0 }],
    });
    await createInvestmentSplit({ transactionId: split.id, accountId: null, securityId: vti.id, action: "split", sharesMicros: 0, priceMicros: 0, splitNumerator: 2, splitDenominator: 1 });
    const body = transactionListSchema.parse(await ok(`/api/b/1/transactions?accountId=${brokerage.id}`));
    expect(body.map((row) => row.investmentSplits[0].action)).toEqual(["split", "buy"]);
    expect(normalized(body)).toMatchSnapshot();
  });

  it("refuses invalid filters and IDs from another book with the Node bodies", async () => {
    const all = transactionListSchema.parse(await ok("/api/b/1/transactions?limit=0"));
    const cases: Array<[string, number, string]> = [
      ["accountId=", 400, "Invalid accountId"],
      ["accountId=1.5", 400, "Invalid accountId"],
      ["accountIds=a,", 400, "Invalid accountIds"],
      ["balanceAccountId=0", 400, "Invalid balanceAccountId"],
      ["payeeId=x", 400, "Invalid payeeId"],
      ["recurringRuleId=", 400, "Invalid recurringRuleId"],
      ["startDate=2025-02-30", 400, "Invalid ISO date"],
      ["endDate=x&accountId=x", 400, "Invalid accountId"],
      ["limit=-1", 400, "Invalid limit"],
      ["offset=1e400", 400, "Invalid offset"],
      ["ensureId=0", 400, "Invalid ensureId"],
      [`balanceAccountId=${ids.otherAccount}`, 400, "Invalid balanceAccountId"],
      [`payeeId=${ids.otherPayee}`, 400, "Invalid payeeId"],
      [`recurringRuleId=${ids.otherRule}`, 400, "Invalid recurringRuleId"],
      [`accountIds=${ids.checking},${ids.otherAccount}`, 400, "One or more accounts do not belong to this book"],
      [`accountIds=-3`, 400, "One or more accounts do not belong to this book"],
      // The payee check runs before the account check.
      [`accountId=${ids.otherAccount}&payeeId=${ids.otherPayee}&ensureId=${all[0].id}`, 400, "Invalid payeeId"],
      // Outside the int4 range, each ID fails at its first query.
      ["balanceAccountId=99999999999", 500, "Failed to fetch transactions"],
      ["payeeId=99999999999", 500, "Failed to fetch transactions"],
      ["recurringRuleId=0x100000000", 500, "Failed to fetch transactions"],
      ["accountIds=1,99999999999", 500, "Failed to fetch transactions"],
      ["ensureId=99999999999", 500, "Failed to fetch transactions"],
      // The ensureId count binds every filter before the ownership checks run.
      [`payeeId=${ids.otherPayee}&accountId=99999999999&ensureId=${all[0].id}`, 500, "Failed to fetch transactions"],
      [`payeeId=${ids.otherPayee}&accountId=99999999999`, 400, "Invalid payeeId"],
    ];
    for (const [query, status, message] of cases) {
      const response = await client.request(`/api/b/1/transactions?${query}`);
      expect(response.status, query).toBe(status);
      expect(await response.json(), query).toEqual({ error: message });
    }
    const anonymous = await client.anonymous("/api/b/1/transactions");
    expect(anonymous.status).toBe(401);
  });
});
