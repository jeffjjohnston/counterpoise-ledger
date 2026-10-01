import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { advanceNextDateToFuture, getInitialNextDate, type RecurrenceConfig } from "../../lib/accounting";
import { toDateString } from "../../lib/formatters";
import { addDaysToDateString, getOccurrenceDate } from "../../lib/recurring";
import {
  addBookMember, createAccount, createBook, createPayee, createRecurringRule,
  createTransactionWithSplits, createUser, resetTestDatabase, setupTestDatabase,
} from "../helpers/db-utils";
import { exec, row, rows } from "../helpers/sql";
import type { Payee, RecurringRule, Transaction, TransactionSplit } from "../../types/db";
import { sessionHttpClient, startHttpTestServer } from "../helpers/http-parity";

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

const today = () => toDateString(new Date());
const inDays = (days: number) => addDaysToDateString(today(), days);

/** Timestamps and today's date differ between runs, so snapshots replace them. */
function normalized(body: unknown): unknown {
  return JSON.parse(
    JSON.stringify(body)
      .replaceAll(today(), "<today>")
      .replace(/"(createdAt|updatedAt)":"[^"]+"/g, '"$1":"<timestamp>"')
  );
}

/** The nextDate that createRecurringRule and updateRecurringRule compute. */
function expectedNextDate(
  startDate: string, config: RecurrenceConfig, businessDaysOnly = false, after?: string
): string {
  const observe = (date: string) => getOccurrenceDate(date, businessDaysOnly);
  const next = advanceNextDateToFuture(getInitialNextDate(startDate, config), config, undefined, observe);
  return after ? advanceNextDateToFuture(next, config, addDaysToDateString(after, 1), observe) : next;
}

// The recurring rule routes: rule CRUD, the projection, the rule-linked
// transaction list, and processing. Full bodies are snapshots that the Node
// run writes and the Rust run must match. A result that depends on today is
// compared with the value the TypeScript recurrence helpers compute.
describe("recurring HTTP parity", () => {
  let baseUrl: string;
  let stop: () => Promise<void>;
  let client: Awaited<ReturnType<typeof sessionHttpClient>>;
  let a: Record<string, number>;

  beforeAll(async () => {
    await setupTestDatabase();
    ({ baseUrl, stop } = await startHttpTestServer());
  }, 120_000);
  beforeEach(async () => {
    await resetTestDatabase();
    client = await sessionHttpClient(baseUrl);
    const checking = await createAccount({ name: "Checking", type: "asset", subtype: "bank" });
    const rent = await createAccount({ name: "Rent", type: "expense" });
    const utilities = await createAccount({ name: "Utilities", type: "expense" });
    const electric = await createAccount({ name: "Electric", type: "expense", parentId: utilities.id });
    const salary = await createAccount({ name: "Salary", type: "income" });
    const landlord = await createPayee({ name: "Landlord" });
    const other = await createBook({ name: "Other" });
    const otherAccount = await createAccount({ name: "Other", type: "asset", bookId: other.id });
    const otherPayee = await createPayee({ name: "Elsewhere", bookId: other.id });
    const otherRule = await createRecurringRule({
      name: "Foreign", frequency: "monthly", startDate: "2030-01-01", nextDate: "2030-01-01", bookId: other.id,
      templateSplits: [{ accountId: otherAccount.id, amount: 5 }, { accountId: otherAccount.id, amount: -5 }],
    });
    a = {
      checking: checking.id, rent: rent.id, utilities: utilities.id, electric: electric.id, salary: salary.id,
      landlord: landlord.id, other: other.id, otherAccount: otherAccount.id, otherPayee: otherPayee.id,
      otherRule: otherRule.id,
    };
  });
  afterAll(async () => { await stop?.(); });

  const pay = (amount: number, to = () => a.rent) => [
    { accountId: to(), amount }, { accountId: a.checking, amount: -amount },
  ];

  async function ok(path: string, init?: RequestInit) {
    const response = await client.request(path, init);
    expect(response.status, `${init?.method ?? "GET"} ${path} ${String(init?.body)}`).toBe(200);
    return response.json();
  }

  async function expectError(path: string, init: RequestInit, status: number, message: string) {
    const response = await client.request(path, init);
    expect(response.status, `${init.method ?? "GET"} ${path} ${String(init.body)}`).toBe(status);
    expect(await response.json(), String(init.body)).toEqual({ error: message });
  }

  const create = (body: Record<string, unknown>) => ok("/api/b/1/recurring", json("POST", body));
  const update = (id: number | string, body: unknown) => ok(`/api/b/1/recurring/${id}`, json("PUT", body));
  const processRules = (body: unknown) => ok("/api/b/1/recurring/process", json("POST", body));

  async function storedRule(id: number) {
    const [rule] = await rows<RecurringRule>("SELECT * FROM recurring_rules WHERE id = $1", [id]);
    return rule;
  }

  async function bookTransactions() {
    const stored = await rows<Transaction>("SELECT * FROM transactions WHERE book_id = $1 ORDER BY id", [1]);
    const splits = await rows<TransactionSplit>("SELECT * FROM transaction_splits ORDER BY id");
    return stored.map((row) => ({ ...row, splits: splits.filter((split) => split.transactionId === row.id) }));
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  it("lists rules with their payee and template split accounts, active first", async () => {
    await createRecurringRule({
      name: "Zebra", frequency: "monthly", daysOfMonth: [1, -1], startDate: "2030-01-01", nextDate: "2030-02-01",
      templateDescription: "Rent", payeeId: a.landlord, autoCreateDaysBefore: 3, businessDaysOnly: true,
      templateSplits: pay(150_000),
    });
    await createRecurringRule({
      name: "Alpha", frequency: "weekly", daysOfWeek: [1, 3], weekOfMonth: "last", startDate: "2030-01-01",
      nextDate: "2030-02-01", endDate: "2031-01-01", templateSplits: pay(900, () => a.electric),
    });
    await createRecurringRule({
      name: "Paused", frequency: "daily", interval: 3, startDate: "2029-01-01", nextDate: "2029-06-01",
      isActive: false, templateSplits: pay(100),
    });
    await createRecurringRule({
      name: "Early", frequency: "yearly", startDate: "2030-01-01", nextDate: "2030-01-15", templateSplits: pay(100),
    });
    const list = await ok("/api/b/1/recurring");
    expect(list.map((rule: { name: string }) => rule.name)).toEqual(["Early", "Alpha", "Zebra", "Paused"]);
    expect(normalized(list)).toMatchSnapshot();
  });

  it("reads one rule by a parseInt ID and refuses a missing or foreign one", async () => {
    const rule = await createRecurringRule({
      name: "Rent", frequency: "monthly", startDate: "2030-01-01", nextDate: "2030-01-01", payeeId: a.landlord,
      templateSplits: pay(150_000),
    });
    const read = await ok(`/api/b/1/recurring/${rule.id}`);
    expect(normalized(read)).toMatchSnapshot();
    expect(await ok(`/api/b/1/recurring/0x${rule.id.toString(16)}`)).toEqual(read);
    expect(await ok(`/api/b/1/recurring/${rule.id}abc`)).toEqual(read);
    for (const [id, status, message] of [
      ["999", 404, "Recurring rule not found"],
      [String(a.otherRule), 404, "Recurring rule not found"],
      ["abc", 500, "Failed to fetch recurring rule"],
      ["3000000000", 500, "Failed to fetch recurring rule"],
    ] as const) {
      await expectError(`/api/b/1/recurring/${id}`, {}, status, message);
    }
  });

  it("projects occurrences in an explicit window", async () => {
    const monthly = await createRecurringRule({
      name: "Rent", frequency: "monthly", startDate: "2030-01-31", nextDate: "2030-01-31",
      templateDescription: "Rent", payeeId: a.landlord, templateSplits: pay(150_000),
    });
    // 2030-03-02 is a Saturday and 2030-03-03 a Sunday: both land on Monday.
    await createRecurringRule({
      name: "Weekend", frequency: "daily", startDate: "2030-03-01", nextDate: "2030-03-01", endDate: "2030-03-04",
      businessDaysOnly: true, templateSplits: pay(700, () => a.electric),
    });
    await createRecurringRule({
      name: "Nth", frequency: "weekly", daysOfWeek: [2], weekOfMonth: "2", startDate: "2030-01-01",
      nextDate: "2030-01-08", templateSplits: pay(50),
    });
    await createRecurringRule({
      name: "Paused", frequency: "daily", startDate: "2030-01-01", nextDate: "2030-01-01", isActive: false,
      templateSplits: pay(1),
    });
    const projected = await ok("/api/b/1/recurring/projected?startDate=2030-02-01&endDate=2030-03-31");
    expect(projected.every((row: { isProjected: boolean }) => row.isProjected)).toBe(true);
    // The snapshot hides timestamps; a projected row carries new Date(0).
    expect(projected[0]).toMatchObject({ createdAt: "1970-01-01T00:00:00.000Z", updatedAt: "1970-01-01T00:00:00.000Z" });
    expect(projected.map((row: { date: string }) => row.date)).toEqual([...projected.map((row: { date: string }) => row.date)].sort());
    expect(projected.find((row: { recurringRuleId: number }) => row.recurringRuleId === monthly.id).id)
      .toBe(-(monthly.id * 10_000));
    expect(normalized(projected)).toMatchSnapshot();

    // An account filter keeps rules with a split on the account or its child.
    const utilities = await ok(`/api/b/1/recurring/projected?startDate=2030-02-01&endDate=2030-03-31&accountId=${a.utilities}`);
    expect(new Set(utilities.map((row: { description: string | null; recurringRuleId: number }) => row.recurringRuleId)).size).toBe(1);
    expect(utilities.map((row: { date: string }) => row.date)).toEqual(["2030-03-01", "2030-03-04", "2030-03-04", "2030-03-04"]);
    expect(await ok(`/api/b/1/recurring/projected?startDate=2030-02-01&endDate=2030-03-31&accountId=${a.salary}`)).toEqual([]);
    expect(await ok("/api/b/1/recurring/projected?startDate=2030-02-01&endDate=2030-03-31&accountId=3000000000")).toEqual([]);
    // Number() reads the ID: whitespace and hexadecimal are accepted.
    expect(await ok(`/api/b/1/recurring/projected?startDate=2030-02-01&endDate=2030-03-31&accountId=%20${a.utilities}%20`))
      .toEqual(utilities);
    expect(await ok(`/api/b/1/recurring/projected?startDate=2030-02-01&endDate=2030-03-31&accountId=0x${a.utilities.toString(16)}`))
      .toEqual(utilities);
  });

  it("projects from tomorrow through the book's upcoming days by default", async () => {
    await exec("UPDATE books SET upcoming_days = $1 WHERE id = $2", [5, 1]);
    const rule = await createRecurringRule({
      name: "Daily", frequency: "daily", startDate: inDays(-1), nextDate: inDays(-1), templateSplits: pay(10),
    });
    const projected = await ok("/api/b/1/recurring/projected?startDate=&endDate=");
    expect(projected.map((row: { id: number; date: string }) => [row.id, row.date])).toEqual(
      [1, 2, 3, 4, 5].map((day, index) => [-(rule.id * 10_000 + index), inDays(day)])
    );
    expect(await ok(`/api/b/1/recurring/projected?endDate=${inDays(2)}`)).toHaveLength(2);
    expect(await ok(`/api/b/1/recurring/projected?startDate=${inDays(-1)}&endDate=${inDays(0)}`)).toHaveLength(2);
  });

  it("refuses an invalid projection query after authentication", async () => {
    for (const [query, message] of [
      ["accountId=abc", "Invalid accountId"],
      ["accountId=0", "Invalid accountId"],
      ["accountId=-1", "Invalid accountId"],
      ["accountId=1.5", "Invalid accountId"],
      ["accountId=Infinity", "Invalid accountId"],
      ["accountId=9007199254740993", "Invalid accountId"],
      ["startDate=2030-02-30", "Invalid ISO date"],
      ["endDate=20300101", "Invalid ISO date"],
    ] as const) {
      await expectError(`/api/b/1/recurring/projected?${query}`, {}, 400, message);
    }
    await expectError("/api/b/999/recurring/projected?accountId=abc", {}, 404, "Book not found");
  });

  it("lists rule-linked transactions by effective date", async () => {
    const rule = await createRecurringRule({
      name: "Rent", frequency: "monthly", startDate: "2025-01-01", nextDate: "2025-04-01", templateSplits: pay(10),
    });
    const other = await createRecurringRule({
      name: "Gym", frequency: "monthly", startDate: "2025-01-01", nextDate: "2025-04-01", templateSplits: pay(10),
    });
    for (const [date, ruleId, isFloating] of [
      ["2025-01-01", rule.id, false], ["2025-02-01", rule.id, false], ["2025-03-01", other.id, false],
      ["2020-01-01", rule.id, true], ["2025-02-15", null, false],
    ] as const) {
      await createTransactionWithSplits({ date, recurringRuleId: ruleId, isFloating, splits: pay(10) });
    }
    await createTransactionWithSplits({
      date: "2025-02-01", bookId: a.other, recurringRuleId: a.otherRule,
      splits: [{ accountId: a.otherAccount, amount: 1 }, { accountId: a.otherAccount, amount: -1 }],
    });
    const byId = (rows: Array<{ transactionId: number }>) => [...rows].sort((x, y) => x.transactionId - y.transactionId);
    expect(byId(await ok("/api/b/1/recurring/transactions?startDate=2025-02-01&endDate=2025-03-01"))).toEqual([
      { transactionId: 2, date: "2025-02-01", recurringRuleId: rule.id, ruleName: "Rent" },
      { transactionId: 3, date: "2025-03-01", recurringRuleId: other.id, ruleName: "Gym" },
    ]);
    expect(await ok(`/api/b/1/recurring/transactions?startDate=${today()}&endDate=${today()}`)).toEqual([
      { transactionId: 4, date: today(), recurringRuleId: rule.id, ruleName: "Rent" },
    ]);
    // The dates are compared as text, not validated.
    expect(byId(await ok("/api/b/1/recurring/transactions?startDate=2025&endDate=2025-9"))).toHaveLength(3);
  });

  it("checks the rule-linked transaction query before authentication", async () => {
    for (const query of ["", "startDate=2025-01-01", "startDate=&endDate=2025-01-01", "endDate=2025-01-01"]) {
      await expectError(`/api/b/1/recurring/transactions?${query}`, {}, 400, "startDate and endDate are required");
      await expectError(`/api/b/999/recurring/transactions?${query}`, {}, 400, "startDate and endDate are required");
    }
    await expectError("/api/b/999/recurring/transactions?startDate=a&endDate=b", {}, 404, "Book not found");
  });

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  it("creates a rule with the Node field defaults and resolves the payee", async () => {
    const created = await create({
      name: "Rent", frequency: "monthly", startDate: "2030-01-31", endDate: "", templateDescription: "",
      payeeName: "  new   Landlord ", templateSplits: pay(150_000), bookId: 99, id: 5, isActive: false,
    });
    expect(created).toMatchObject({
      bookId: 1, interval: 1, nextDate: "2030-01-31", endDate: null, templateDescription: null, isActive: true,
      businessDaysOnly: false, autoCreateDaysBefore: 0, payee: { name: "new Landlord" },
    });
    expect(normalized(created)).toMatchSnapshot();

    const weekly = await create({
      name: "Gym", frequency: "weekly", interval: 2, daysOfWeek: [5, 1], weekOfMonth: "every", startDate: "2030-01-02",
      businessDaysOnly: true, autoCreateDaysBefore: 30, payeeName: "LANDLORD", payeeId: a.otherPayee,
      templateDescription: "Gym", templateSplits: pay(4_000),
    });
    expect(weekly.payeeId).toBe(a.landlord);
    const nth = await create({
      name: "Nth", frequency: "weekly", daysOfWeek: [2], weekOfMonth: 2, interval: 0, startDate: "2030-01-01",
      daysOfMonth: [], templateDescription: 5, payeeName: " ", payeeId: a.landlord, templateSplits: pay(1),
    });
    expect(nth).toMatchObject({ interval: 1, weekOfMonth: "2", templateDescription: "5", payeeId: a.landlord });
    const last = await create({
      name: "Last", frequency: "monthly", daysOfMonth: [-1, 15], startDate: "2030-02-16", interval: -1,
      payeeId: a.otherPayee, templateSplits: pay(1),
    });
    expect(last).toMatchObject({ interval: -1, payeeId: null, payee: null });
    expect(normalized({ weekly, nth, last })).toMatchSnapshot();
    expect((await rows<Payee>("SELECT * FROM payees WHERE book_id = $1", [1])).map((row) => row.name).sort())
      .toEqual(["Landlord", "new Landlord"]);
  });

  it("advances a past start date to the next occurrence still to come", async () => {
    const cases: Array<{ frequency: RecurrenceConfig["frequency"]; startDate: string; extra?: Record<string, unknown>; businessDaysOnly?: boolean }> = [
      { frequency: "daily", startDate: "2020-01-01" },
      { frequency: "daily", startDate: "2020-01-01", extra: { interval: 3 } },
      { frequency: "weekly", startDate: "2020-01-04", businessDaysOnly: true },
      { frequency: "weekly", startDate: "2020-01-01", extra: { daysOfWeek: [0, 6] }, businessDaysOnly: true },
      { frequency: "weekly", startDate: "2020-01-01", extra: { daysOfWeek: [3], interval: 2 } },
      { frequency: "weekly", startDate: "2020-01-01", extra: { daysOfWeek: [1, 4], weekOfMonth: "last" } },
      { frequency: "monthly", startDate: "2020-01-31", businessDaysOnly: true },
      { frequency: "monthly", startDate: "2020-01-01", extra: { daysOfMonth: [-1, 14], interval: 2 } },
      { frequency: "yearly", startDate: "2020-02-29" },
    ];
    for (const { frequency, startDate, extra = {}, businessDaysOnly = false } of cases) {
      const created = await create({ name: frequency, frequency, startDate, businessDaysOnly, templateSplits: pay(1), ...extra });
      const config = { frequency, interval: (extra.interval as number) || 1, ...extra } as RecurrenceConfig;
      expect(created.nextDate, JSON.stringify({ frequency, startDate, extra })).toBe(
        expectedNextDate(startDate, config, businessDaysOnly)
      );
    }
  });

  it("refuses invalid creates with the Node bodies and writes nothing", async () => {
    const valid = { name: "Rent", frequency: "monthly", startDate: "2030-01-01", templateSplits: pay(100) };
    const required = "Name, frequency, startDate, and templateSplits are required";
    const splitsMessage = "templateSplits must be an array of at least 2 valid splits";
    const days = "autoCreateDaysBefore must be an integer between 0 and 30";
    const cases: Array<[unknown, number, string]> = [
      [null, 400, required],
      [[], 400, required],
      ["rent", 400, required],
      [{}, 400, required],
      [{ ...valid, name: "" }, 400, required],
      [{ ...valid, name: 5 }, 400, required],
      [{ ...valid, frequency: "hourly" }, 400, "Invalid frequency"],
      [{ ...valid, frequency: undefined }, 400, "Invalid frequency"],
      [{ ...valid, startDate: "2030-02-30" }, 400, "startDate must be in YYYY-MM-DD format"],
      [{ ...valid, startDate: undefined }, 400, "startDate must be in YYYY-MM-DD format"],
      [{ ...valid, endDate: "2030-13-01" }, 400, "endDate must be in YYYY-MM-DD format"],
      [{ ...valid, endDate: 5 }, 400, "endDate must be in YYYY-MM-DD format"],
      [{ ...valid, templateSplits: undefined }, 400, splitsMessage],
      [{ ...valid, templateSplits: {} }, 400, splitsMessage],
      [{ ...valid, templateSplits: [pay(1)[0]] }, 400, splitsMessage],
      [{ ...valid, templateSplits: [{ accountId: "1", amount: 1 }, pay(1)[1]] }, 400, splitsMessage],
      [{ ...valid, templateSplits: [{ accountId: 1.5, amount: 1 }, pay(1)[1]] }, 400, splitsMessage],
      [{ ...valid, templateSplits: [{ accountId: a.rent }, pay(1)[1]] }, 400, splitsMessage],
      [{ ...valid, templateSplits: [5, 6] }, 400, "Invalid input: expected object, received number"],
      [{ ...valid, autoCreateDaysBefore: 31 }, 400, days],
      [{ ...valid, autoCreateDaysBefore: -1 }, 400, days],
      [{ ...valid, autoCreateDaysBefore: 1.5 }, 400, days],
      [{ ...valid, autoCreateDaysBefore: null }, 400, days],
      [{ ...valid, businessDaysOnly: "yes" }, 400, "businessDaysOnly must be a boolean"],
      [{ ...valid, businessDaysOnly: null }, 400, "businessDaysOnly must be a boolean"],
      [{ ...valid, endDate: "2029-12-31" }, 400, "endDate cannot be earlier than startDate"],
      [{ ...valid, endDate: "2029-12-31", templateSplits: [{ accountId: a.rent, amount: 1 }, { accountId: a.checking, amount: 2 }] }, 400, "endDate cannot be earlier than startDate"],
      [{ ...valid, templateSplits: [{ accountId: a.rent, amount: 1 }, { accountId: a.checking, amount: 2 }] }, 400, "Template splits must sum to zero (debits = credits)"],
      [{ ...valid, templateSplits: [{ accountId: a.rent, amount: 1.5 }, { accountId: a.checking, amount: -1.5 }] }, 400, "Template splits must sum to zero (debits = credits)"],
      [{ ...valid, templateSplits: pay(3_000_000_000) }, 400, "Template splits must sum to zero (debits = credits)"],
      [{ ...valid, templateSplits: pay(1, () => a.otherAccount) }, 400, "One or more template split accounts do not belong to this book"],
      [{ ...valid, templateSplits: pay(1, () => 99_999_999_999) }, 500, "Failed to create recurring rule"],
      // Valid until the insert, which PostgreSQL refuses; the payee rolls back.
      [{ ...valid, interval: 1.5, payeeName: "Rolled Back" }, 500, "Failed to create recurring rule"],
      [{ ...valid, interval: 3_000_000_000, payeeName: "Rolled Back" }, 500, "Failed to create recurring rule"],
      [{ ...valid, interval: true, payeeName: "Rolled Back" }, 500, "Failed to create recurring rule"],
      [{ ...valid, interval: [1, 2], payeeName: "Rolled Back" }, 500, "Failed to create recurring rule"],
      [{ ...valid, payeeId: 1.5, payeeName: "Rolled Back" }, 500, "Failed to create recurring rule"],
      [{ ...valid, payeeId: 3_000_000_000 }, 500, "Failed to create recurring rule"],
    ];
    for (const [body, status, message] of cases) {
      await expectError("/api/b/1/recurring", json("POST", body), status, message);
    }
    await expectError("/api/b/1/recurring", { method: "POST", body: "{" }, 500, "Failed to create recurring rule");
    expect(await rows("SELECT * FROM recurring_rules WHERE book_id = $1", [1])).toHaveLength(0);
    expect(await rows("SELECT * FROM payees WHERE name = $1", ["Rolled Back"])).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Update
  // -------------------------------------------------------------------------

  it("leaves nextDate alone when an update does not change the schedule", async () => {
    const rule = await createRecurringRule({
      name: "Rent", frequency: "weekly", daysOfWeek: [1], startDate: "2030-01-02", nextDate: "2030-01-14",
      templateSplits: pay(100),
    });
    // The edit form posts every schedule field on each save.
    const renamed = await update(rule.id, {
      name: "Renamed", frequency: "weekly", interval: 1, daysOfWeek: [1], weekOfMonth: "every", daysOfMonth: null,
      startDate: "2030-01-02", endDate: null, templateDescription: "", isActive: false, businessDaysOnly: true,
      autoCreateDaysBefore: 2,
    });
    expect(renamed).toMatchObject({
      name: "Renamed", nextDate: "2030-01-14", weekOfMonth: "every", daysOfMonth: null, templateDescription: "",
      isActive: false, businessDaysOnly: true, autoCreateDaysBefore: 2,
    });
    expect(normalized(renamed)).toMatchSnapshot();
    expect((await update(rule.id, {})).nextDate).toBe("2030-01-14");
    expect((await update(rule.id, { templateSplits: pay(250, () => a.electric) })).templateSplits).toMatchObject([
      { accountId: a.electric, amount: 250 }, { accountId: a.checking, amount: -250 },
    ]);
    expect(await rows("SELECT * FROM recurring_template_splits WHERE recurring_rule_id = $1", [rule.id]))
      .toHaveLength(2);
  });

  it("recomputes nextDate for a schedule change and resumes after created transactions", async () => {
    const rule = await createRecurringRule({
      name: "Rent", frequency: "monthly", startDate: "2030-01-01", nextDate: "2030-01-01", templateSplits: pay(100),
    });
    expect((await update(rule.id, { daysOfMonth: [15] })).nextDate).toBe("2030-01-15");
    expect((await update(rule.id, { startDate: "2030-02-20", daysOfMonth: null })).nextDate).toBe("2030-02-20");
    await createTransactionWithSplits({ date: "2030-05-20", recurringRuleId: rule.id, splits: pay(100) });
    expect((await update(rule.id, { frequency: "weekly", daysOfWeek: [3] })).nextDate).toBe("2030-05-22");
    expect((await update(rule.id, { interval: 2, nextDate: "2031-01-01" })).nextDate).toBe("2031-01-01");
    expect((await update(rule.id, { interval: 2 })).nextDate).toBe("2031-01-01");

    const past = await createRecurringRule({
      name: "Past", frequency: "daily", startDate: "2020-01-01", nextDate: "2020-01-01", templateSplits: pay(1),
    });
    await createTransactionWithSplits({ date: inDays(3), recurringRuleId: past.id, splits: pay(1) });
    const config: RecurrenceConfig = { frequency: "weekly", interval: 1, daysOfWeek: [6] };
    expect((await update(past.id, { frequency: "weekly", daysOfWeek: [6], businessDaysOnly: true })).nextDate)
      .toBe(expectedNextDate("2020-01-01", config, true, inDays(3)));
  });

  it("updates the payee and clears it with null", async () => {
    const rule = await createRecurringRule({
      name: "Rent", frequency: "monthly", startDate: "2030-01-01", nextDate: "2030-01-01", payeeId: a.landlord,
      templateSplits: pay(100),
    });
    expect((await update(rule.id, { payeeName: "New Owner" })).payee).toMatchObject({ name: "New Owner" });
    expect((await update(rule.id, { payeeId: a.landlord, payeeName: 5 })).payeeId).toBe(a.landlord);
    expect((await update(rule.id, { payeeId: a.otherPayee })).payeeId).toBeNull();
    expect((await update(rule.id, { payeeId: a.landlord })).payeeId).toBe(a.landlord);
    expect((await update(rule.id, { payeeId: null })).payee).toBeNull();
  });

  it("refuses invalid updates with the Node bodies and changes nothing", async () => {
    const rule = await createRecurringRule({
      name: "Rent", frequency: "monthly", startDate: "2030-01-10", nextDate: "2030-01-10", payeeId: a.landlord,
      templateSplits: pay(100),
    });
    const before = await storedRule(rule.id);
    const cases: Array<[number | string, unknown, number, string]> = [
      [rule.id, null, 400, "Invalid input: expected object, received null"],
      [rule.id, [], 400, "Invalid input: expected object, received array"],
      [rule.id, { startDate: null }, 400, "startDate must be in YYYY-MM-DD format"],
      [rule.id, { endDate: "" }, 400, "endDate must be in YYYY-MM-DD format"],
      [rule.id, { nextDate: "2030-02-30" }, 400, "nextDate must be in YYYY-MM-DD format"],
      [rule.id, { templateSplits: [pay(1)[0]] }, 400, "templateSplits must be an array of at least 2 valid splits"],
      [rule.id, { autoCreateDaysBefore: "1" }, 400, "autoCreateDaysBefore must be an integer between 0 and 30"],
      [rule.id, { businessDaysOnly: 1 }, 400, "businessDaysOnly must be a boolean"],
      [rule.id, { name: 5 }, 400, "Invalid input: expected string, received number"],
      [rule.id, { frequency: null }, 400, "Invalid frequency"],
      [rule.id, { isActive: "no" }, 400, "Invalid input: expected boolean, received string"],
      [rule.id, { templateSplits: [{ accountId: a.rent, amount: 1 }, { accountId: a.checking, amount: 2 }] }, 400, "Template splits must sum to zero (debits = credits)"],
      [rule.id, { endDate: "2030-01-09" }, 400, "endDate cannot be earlier than startDate"],
      [rule.id, { endDate: "2030-01-09", startDate: "2030-01-08" }, 200, ""],
      [rule.id, { templateSplits: pay(1, () => a.otherAccount) }, 400, "One or more template split accounts do not belong to this book"],
      [rule.id, { templateSplits: pay(1, () => 99_999_999_999) }, 500, "Failed to update recurring rule"],
      [rule.id, { nextDate: null }, 400, "nextDate cannot be null"],
      [rule.id, { interval: null }, 500, "Failed to update recurring rule"],
      [rule.id, { interval: 1.5, payeeName: "Rolled Back" }, 500, "Failed to update recurring rule"],
      [rule.id, { payeeId: 1.5 }, 500, "Failed to update recurring rule"],
      [999, { name: "X", payeeName: "Rolled Back" }, 404, "Recurring rule not found"],
      [a.otherRule, { endDate: "2000-01-01", templateSplits: pay(1) }, 404, "Recurring rule not found"],
      ["abc", { name: "X" }, 500, "Failed to update recurring rule"],
      ["abc", { name: 5 }, 400, "Invalid input: expected string, received number"],
      ["abc", { nextDate: null }, 400, "nextDate cannot be null"],
      ["abc", { startDate: "2030-01-01" }, 500, "Failed to update recurring rule"],
    ];
    for (const [id, body, status, message] of cases) {
      if (status === 200) {
        await update(id, body);
        await update(id, { startDate: before.startDate, endDate: null });
        continue;
      }
      await expectError(`/api/b/1/recurring/${id}`, json("PUT", body), status, message);
    }
    await expectError(`/api/b/1/recurring/${rule.id}`, { method: "PUT", body: "{" }, 500, "Failed to update recurring rule");
    expect(await storedRule(rule.id)).toEqual(before);
    expect(await rows("SELECT * FROM payees WHERE name = $1", ["Rolled Back"])).toHaveLength(0);
    const foreign = await row<RecurringRule>("SELECT * FROM recurring_rules WHERE id = $1", [a.otherRule]);
    expect(foreign.endDate).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Delete
  // -------------------------------------------------------------------------

  it("deletes a rule and its template splits and keeps its transactions", async () => {
    const rule = await createRecurringRule({
      name: "Rent", frequency: "monthly", startDate: "2030-01-01", nextDate: "2030-01-01", templateSplits: pay(100),
    });
    const made = await createTransactionWithSplits({ date: "2025-01-01", recurringRuleId: rule.id, splits: pay(100) });
    for (const [id, status, message] of [
      ["999", 404, "Recurring rule not found"],
      [String(a.otherRule), 404, "Recurring rule not found"],
      ["abc", 500, "Failed to delete recurring rule"],
      ["3000000000", 500, "Failed to delete recurring rule"],
    ] as const) {
      await expectError(`/api/b/1/recurring/${id}`, { method: "DELETE" }, status, message);
    }
    expect(await ok(`/api/b/1/recurring/${rule.id}`, { method: "DELETE" })).toEqual({ success: true });
    expect(await rows("SELECT * FROM recurring_template_splits WHERE book_id = $1", [1])).toHaveLength(0);
    const kept = await row<Transaction>("SELECT * FROM transactions WHERE id = $1", [made.id]);
    expect(kept.recurringRuleId).toBeNull();
    await expectError(`/api/b/1/recurring/${rule.id}`, { method: "DELETE" }, 404, "Recurring rule not found");
  });

  // -------------------------------------------------------------------------
  // Processing
  // -------------------------------------------------------------------------

  it("processes every due rule, catching up and deactivating past the end date", async () => {
    // 2025-01-04 is a Saturday: a business-day rule dates it Monday 2025-01-06.
    const daily = await createRecurringRule({
      name: "Daily", frequency: "daily", startDate: "2025-01-02", nextDate: "2025-01-02", endDate: "2025-01-04",
      businessDaysOnly: true, templateDescription: "Coffee", payeeId: a.landlord, templateSplits: pay(500),
    });
    const monthly = await createRecurringRule({
      name: "Monthly", frequency: "monthly", daysOfMonth: [31], startDate: "2025-01-31", nextDate: inDays(-40),
      templateSplits: pay(150_000),
    });
    const lead = await createRecurringRule({
      name: "Lead", frequency: "daily", startDate: inDays(2), nextDate: inDays(2), endDate: inDays(2),
      autoCreateDaysBefore: 3, templateSplits: pay(7),
    });
    const later = await createRecurringRule({
      name: "Later", frequency: "daily", startDate: inDays(2), nextDate: inDays(2), autoCreateDaysBefore: 1,
      templateSplits: pay(7),
    });
    const lonely = await createRecurringRule({
      name: "Lonely", frequency: "daily", startDate: "2025-01-01", nextDate: "2025-01-01",
      templateSplits: [{ accountId: a.rent, amount: 0 }],
    });
    const paused = await createRecurringRule({
      name: "Paused", frequency: "daily", startDate: "2025-01-01", nextDate: "2025-01-01", isActive: false,
      templateSplits: pay(1),
    });
    const result = await processRules({ processAll: true });
    expect(result).toMatchObject({ success: true, skipped: [{ ruleId: lonely.id, reason: "fewer than 2 template splits" }] });
    const created = await bookTransactions();
    expect(result.transactionIds).toEqual(created.map((row) => row.id));
    expect(result.transactionsCreated).toBe(created.length);

    const dated = (ruleId: number) => created.filter((row) => row.recurringRuleId === ruleId).map((row) => row.date);
    expect(dated(daily.id)).toEqual(["2025-01-02", "2025-01-03", "2025-01-06"]);
    expect(dated(lead.id)).toEqual([inDays(2)]);
    expect(dated(later.id)).toEqual([]);
    expect(dated(paused.id)).toEqual([]);
    expect(dated(monthly.id).length).toBeGreaterThan(0);
    expect(await storedRule(daily.id)).toMatchObject({ nextDate: "2025-01-05", isActive: false });
    expect(await storedRule(lead.id)).toMatchObject({ nextDate: inDays(3), isActive: false });
    expect((await storedRule(monthly.id)).nextDate > today()).toBe(true);
    expect(await storedRule(lonely.id)).toMatchObject({ nextDate: "2025-01-01", isActive: true });
    expect(normalized(created.filter((row) => row.recurringRuleId === daily.id))).toMatchSnapshot();

    // Nothing is due any more.
    expect(await processRules({ processAll: true })).toEqual({
      success: true, transactionsCreated: 0, transactionIds: [],
      skipped: [{ ruleId: lonely.id, reason: "fewer than 2 template splits" }],
    });
  });

  it("forces one rule's next occurrence by ID", async () => {
    const rule = await createRecurringRule({
      name: "Rent", frequency: "monthly", startDate: "2030-01-31", nextDate: "2030-02-02", businessDaysOnly: true,
      isActive: false, endDate: "2030-01-31", templateDescription: "Rent", templateSplits: pay(150_000),
    });
    const lonely = await createRecurringRule({
      name: "Lonely", frequency: "daily", startDate: "2030-01-01", nextDate: "2030-01-01",
      templateSplits: [{ accountId: a.rent, amount: 0 }],
    });
    const result = await processRules({ ruleId: rule.id, processAll: false });
    expect(result).toEqual({ success: true, transactionsCreated: 1, transactionIds: [1], skipped: [] });
    expect(normalized(await bookTransactions())).toMatchSnapshot();
    // 2030-02-02 is a Saturday: the transaction is dated Monday, the rule
    // advances from the Saturday.
    expect(await storedRule(rule.id)).toMatchObject({ nextDate: "2030-03-02", isActive: false });
    expect(await processRules({ ruleId: lonely.id })).toEqual({
      success: true, transactionsCreated: 0, transactionIds: [],
      skipped: [{ ruleId: lonely.id, reason: "fewer than 2 template splits" }],
    });
    // ruleId 0 is "not given": processAll runs instead. It checks that a
    // rule is due before it counts the template splits.
    expect(await processRules({ ruleId: 0 })).toEqual({ success: true, transactionsCreated: 0, transactionIds: [], skipped: [] });
    await exec("UPDATE recurring_rules SET next_date = $1 WHERE id = $2", ["2025-01-01", lonely.id]);
    expect((await processRules({ ruleId: 0, processAll: true })).skipped).toEqual([
      { ruleId: lonely.id, reason: "fewer than 2 template splits" },
    ]);
  });

  it("leaves a rule whose schedule does not advance unchanged on each run", async () => {
    const rule = await createRecurringRule({
      name: "Stuck", frequency: "daily", startDate: "2025-01-01", nextDate: "2025-01-01", templateSplits: pay(1),
    });
    // The update stores interval 0; its schedule key equals interval 1, so
    // nextDate is not recomputed.
    expect(await update(rule.id, { interval: 0 })).toMatchObject({ interval: 0, nextDate: "2025-01-01" });
    for (let run = 0; run < 2; run++) {
      expect(await processRules({ processAll: true })).toEqual({
        success: true, transactionsCreated: 0, transactionIds: [],
        skipped: [{ ruleId: rule.id, reason: "schedule does not advance" }],
      });
    }
    expect(await storedRule(rule.id)).toMatchObject({ nextDate: "2025-01-01", isActive: true });
    expect(await bookTransactions()).toEqual([]);
  });

  it("reads weekOfMonth with parseInt", async () => {
    const rule = await create({
      name: "Padded", frequency: "weekly", daysOfWeek: [2], weekOfMonth: " 2 ", startDate: "2030-01-01",
      templateSplits: pay(1),
    });
    expect(rule).toMatchObject({ weekOfMonth: " 2 ", nextDate: "2030-01-08" });
    const projected = await ok("/api/b/1/recurring/projected?startDate=2030-01-01&endDate=2030-03-31");
    expect(projected.map((row: { date: string }) => row.date)).toEqual(["2030-01-08", "2030-02-12", "2030-03-12"]);
  });

  it("refuses invalid processing requests with the Node bodies", async () => {
    const cases: Array<[unknown, number, string]> = [
      [null, 400, "Invalid input: expected object, received null"],
      [[], 400, "Invalid input: expected object, received array"],
      [{ ruleId: "1" }, 400, "Invalid input: expected number, received string"],
      [{ ruleId: 1.5 }, 400, "Invalid input: expected int, received number"],
      [{ ruleId: 9_007_199_254_740_992 }, 400, "Too big: expected int to be <=9007199254740991"],
      [{ processAll: "yes" }, 400, "Invalid input: expected boolean, received string"],
      [{ ruleId: 999 }, 404, "Recurring rule not found"],
      [{ ruleId: a.otherRule }, 404, "Recurring rule not found"],
      [{ ruleId: -5 }, 404, "Recurring rule not found"],
      [{ ruleId: 3_000_000_000 }, 500, "Failed to process recurring rules"],
    ];
    for (const [body, status, message] of cases) {
      await expectError("/api/b/1/recurring/process", json("POST", body), status, message);
    }
    await expectError("/api/b/1/recurring/process", { method: "POST", body: "" }, 500, "Failed to process recurring rules");
    expect(await processRules({})).toEqual({ success: true, transactionsCreated: 0, transactionIds: [], skipped: [] });
    const foreign = await row<RecurringRule>("SELECT * FROM recurring_rules WHERE id = $1", [a.otherRule]);
    expect(foreign.nextDate).toBe("2030-01-01");
  });

  it("creates each due date once under concurrent processing", async () => {
    const rule = await createRecurringRule({
      name: "Daily", frequency: "daily", startDate: "2025-01-01", nextDate: "2025-01-01", endDate: "2025-01-10",
      templateSplits: pay(1),
    });
    const results = await Promise.all([1, 2, 3, 4].map(() => processRules({ processAll: true })));
    expect(results.reduce((sum, result) => sum + result.transactionsCreated, 0)).toBe(10);
    const forced = await createRecurringRule({
      name: "Forced", frequency: "daily", startDate: "2030-01-01", nextDate: "2030-01-01", templateSplits: pay(1),
    });
    const byId = await Promise.all([1, 2, 3].map(() => processRules({ ruleId: forced.id })));
    const created = byId.reduce((sum, result) => sum + result.transactionsCreated, 0);
    expect((await storedRule(forced.id)).nextDate).toBe(addDaysToDateString("2030-01-01", created));
    const rows = await bookTransactions();
    expect(rows.filter((row) => row.recurringRuleId === rule.id)).toHaveLength(10);
    expect(new Set(rows.map((row) => `${row.recurringRuleId}:${row.date}`)).size).toBe(rows.length);
  });

  it("denies viewers write access and lets them read", async () => {
    const owner = await createUser({ username: "owner" });
    const shared = await createBook({ name: "Shared", userId: owner.id });
    await addBookMember({ bookId: shared.id, userId: 1, role: "viewer" });
    const account = await createAccount({ name: "Cash", type: "asset", bookId: shared.id });
    const rule = await createRecurringRule({
      name: "Shared", frequency: "monthly", startDate: "2030-01-01", nextDate: "2030-01-01", bookId: shared.id,
      templateSplits: [{ accountId: account.id, amount: 1 }, { accountId: account.id, amount: -1 }],
    });
    const base = `/api/b/${shared.id}/recurring`;
    expect(await ok(base)).toHaveLength(1);
    expect((await ok(`${base}/${rule.id}`)).name).toBe("Shared");
    expect(await ok(`${base}/projected?startDate=2030-01-01&endDate=2030-01-01`)).toHaveLength(1);
    expect(await ok(`${base}/transactions?startDate=2030-01-01&endDate=2030-01-01`)).toEqual([]);
    const readOnly = "You have read-only access to this book";
    await expectError(base, json("POST", {}), 403, readOnly);
    await expectError(`${base}/${rule.id}`, json("PUT", {}), 403, readOnly);
    await expectError(`${base}/${rule.id}`, { method: "DELETE" }, 403, readOnly);
    await expectError(`${base}/process`, json("POST", { processAll: true }), 403, readOnly);
    await expectError("/api/b/999/recurring", {}, 404, "Book not found");
  });
});
