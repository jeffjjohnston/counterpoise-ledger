import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { toDateString } from "../../lib/formatters";
import {
  createAccount, createBook, createTransactionWithSplits, createUser, resetTestDatabase, setupTestDatabase,
} from "../helpers/db-utils";
import { sessionHttpClient, startHttpTestServer } from "../helpers/http-parity";

type Point = { date: string; balanceCents: number };

// A TZ far from UTC. The server inherits it, so "today" is the same local date
// in the server and in the test, and it is not the UTC date for most of the day.
const originalTz = process.env.TZ;
process.env.TZ = "Pacific/Kiritimati";

describe("account balance history", () => {
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
  afterAll(async () => {
    await stop?.();
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  async function points(accountId: number, query = "") {
    const response = await client.request(`/api/b/1/accounts/${accountId}/balance-history${query}`);
    expect(response.status).toBe(200);
    return (await response.json()).points as Point[];
  }

  it("gives the ledger balance at each month end and at the end date", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset", subtype: "bank" });
    const card = await createAccount({ name: "Card", type: "liability", subtype: "credit_card" });
    const salary = await createAccount({ name: "Salary", type: "income" });
    const food = await createAccount({ name: "Food", type: "expense" });
    await createTransactionWithSplits({ date: "2026-01-05", splits: [
      { accountId: checking.id, amount: 50_000 }, { accountId: salary.id, amount: -50_000 }] });
    await createTransactionWithSplits({ date: "2026-01-20", splits: [
      { accountId: checking.id, amount: -12_000 }, { accountId: card.id, amount: 12_000 }] });
    await createTransactionWithSplits({ date: "2026-02-03", splits: [
      { accountId: food.id, amount: 2_500 }, { accountId: card.id, amount: -2_500 }] });
    await createTransactionWithSplits({ date: "2026-03-10", splits: [
      { accountId: checking.id, amount: 3_000 }, { accountId: salary.id, amount: -3_000 }] });
    // A row after the end date must not change the last point.
    await createTransactionWithSplits({ date: "2026-03-25", splits: [
      { accountId: checking.id, amount: 7_000 }, { accountId: salary.id, amount: -7_000 }] });

    // 50,000 - 12,000 = 38,000 at the January and February month ends; + 3,000 = 41,000 on March 20.
    const checkingPoints = [
      { date: "2026-01-31", balanceCents: 38_000 },
      { date: "2026-02-28", balanceCents: 38_000 },
      { date: "2026-03-20", balanceCents: 41_000 },
    ];
    expect(await points(checking.id, "?startDate=2026-01-01&endDate=2026-03-20")).toEqual(checkingPoints);
    // Without a start date, the first point is the month end of the first split.
    expect(await points(checking.id, "?endDate=2026-03-20")).toEqual(checkingPoints);
    // A start date after the first split keeps the balance before it.
    expect(await points(checking.id, "?startDate=2026-02-15&endDate=2026-03-20")).toEqual(checkingPoints.slice(1));
    // A liability keeps its ledger sign: 12,000 paid in, then 2,500 charged.
    expect(await points(card.id, "?startDate=2026-01-01&endDate=2026-02-28")).toEqual([
      { date: "2026-01-31", balanceCents: 12_000 },
      { date: "2026-02-28", balanceCents: 9_500 },
    ]);
  });

  it("ends at the register balance of a parent account and does not add its child", async () => {
    const bank = await createAccount({ name: "Bank", type: "asset", subtype: "bank" });
    const savings = await createAccount({ name: "Savings", type: "asset", subtype: "bank", parentId: bank.id });
    const salary = await createAccount({ name: "Salary", type: "income" });
    const now = new Date();
    const earlier = toDateString(new Date(now.getFullYear(), now.getMonth() - 1, 10));
    await createTransactionWithSplits({ date: earlier, splits: [
      { accountId: bank.id, amount: 1_000 }, { accountId: salary.id, amount: -1_000 }] });
    await createTransactionWithSplits({ date: earlier, splits: [
      { accountId: savings.id, amount: 5_000 }, { accountId: salary.id, amount: -5_000 }] });
    await createTransactionWithSplits({ date: earlier, splits: [
      { accountId: bank.id, amount: -400 }, { accountId: savings.id, amount: 400 }] });

    const register = await (await client.request(
      `/api/b/1/transactions?accountId=${bank.id}&includeMeta=true&limit=0`)).json() as {
      startingBalance: number;
      transactions: { splits: { accountId: number; amount: number }[] }[];
    };
    const registerBalance = register.transactions.reduce((sum, transaction) => sum + transaction.splits
      .filter((split) => split.accountId === bank.id)
      .reduce((own, split) => own + split.amount, 0), register.startingBalance);
    // 1,000 - 400. The register shows the own splits of the account only.
    expect(registerBalance).toBe(600);
    expect((await points(bank.id)).at(-1)).toEqual({ date: toDateString(now), balanceCents: registerBalance });
  });

  it("counts a floating transaction at today only", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const salary = await createAccount({ name: "Salary", type: "income" });
    const now = new Date();
    const earlier = toDateString(new Date(now.getFullYear(), now.getMonth() - 2, 10));
    await createTransactionWithSplits({ date: earlier, splits: [
      { accountId: checking.id, amount: 500 }, { accountId: salary.id, amount: -500 }] });
    await createTransactionWithSplits({ date: "2020-01-01", isFloating: true, splits: [
      { accountId: checking.id, amount: 1_000 }, { accountId: salary.id, amount: -1_000 }] });

    const series = await points(checking.id);
    expect(series.at(-1)).toEqual({ date: toDateString(now), balanceCents: 1_500 });
    expect(series.slice(0, -1).map((point) => point.balanceCents)).toEqual([500, 500]);
  });

  it("gives no points for an account without splits or one that starts after the end date", async () => {
    const empty = await createAccount({ name: "Empty", type: "asset" });
    expect(await points(empty.id)).toEqual([]);
    expect(await points(empty.id, "?startDate=2025-01-01")).toEqual([]);
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const salary = await createAccount({ name: "Salary", type: "income" });
    await createTransactionWithSplits({ date: "2026-03-01", splits: [
      { accountId: checking.id, amount: 100 }, { accountId: salary.id, amount: -100 }] });
    expect(await points(checking.id, "?endDate=2026-02-01")).toEqual([]);
  });

  it("answers 404 for an account of another book and for a book that is not yours", async () => {
    const other = await createUser({ username: "other" });
    const book = await createBook({ name: "Other Book", userId: other.id });
    const foreign = await createAccount({ name: "Foreign", type: "asset", bookId: book.id });
    const salary = await createAccount({ name: "Salary", type: "income", bookId: book.id });
    await createTransactionWithSplits({ date: "2026-01-05", bookId: book.id, splits: [
      { accountId: foreign.id, amount: 100 }, { accountId: salary.id, amount: -100 }] });

    const wrongBook = await client.request(`/api/b/1/accounts/${foreign.id}/balance-history`);
    expect(wrongBook.status).toBe(404);
    expect(await wrongBook.json()).toEqual({ error: "Account not found" });
    const missing = await client.request("/api/b/1/accounts/999999/balance-history");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Account not found" });
    const notMember = await client.request(`/api/b/${book.id}/accounts/${foreign.id}/balance-history`);
    expect(notMember.status).toBe(404);
    expect(await notMember.json()).toEqual({ error: "Book not found" });
  });

  it("rejects a bad account id, a bad date and a start after the end", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    for (const [path, message] of [
      ["/api/b/1/accounts/abc/balance-history", "Invalid account id"],
      [`/api/b/1/accounts/${checking.id}/balance-history?startDate=2026-02-30`, "Invalid ISO date"],
      [`/api/b/1/accounts/${checking.id}/balance-history?endDate=2026-13-01`, "Invalid ISO date"],
      [`/api/b/1/accounts/${checking.id}/balance-history?startDate=2026-03-01&endDate=2026-02-01`,
        "startDate must not be after endDate"],
    ] as const) {
      const response = await client.request(path);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: message });
    }
  });
});
