import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { recurringRules, transactions } from "@/db/schema";
import { GET as GETRecurringCron } from "@/app/api/cron/recurring/route";
import { POST as POSTRecurringProcess } from "@/app/api/b/[bookId]/recurring/process/route";
import {
  createAccount,
  createPayee,
  createRecurringRule,
  resetTestDatabase,
  setupTestDatabase,
} from "@/tests/helpers/db";

vi.mock("@/lib/api-auth", async () => {
  const { mockApiAuth } = await import("@/tests/helpers/db");
  return mockApiAuth();
});

vi.mock("@/db", async () => {
  const { db } = await import("@/tests/helpers/db-utils");
  return {
    getDb: vi.fn().mockReturnValue(db),
  };
});

describe("Recurring processing", () => {
  const db = getDb();
  const originalCronSecret = process.env.CRON_SECRET;

  beforeAll(async () => {
    await setupTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
    process.env.CRON_SECRET = originalCronSecret;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("processes rules early when nextDate is inside the lead window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-02-10T12:00:00Z"));

    const checking = await createAccount({ name: "Checking", type: "asset" });
    const rent = await createAccount({ name: "Rent", type: "expense" });
    const rule = await createRecurringRule({
      name: "Rent",
      frequency: "daily",
      startDate: "2026-02-13",
      nextDate: "2026-02-13",
      autoCreateDaysBefore: 3,
      templateSplits: [
        { accountId: rent.id, amount: 150000 },
        { accountId: checking.id, amount: -150000 },
      ],
    });

    const response = await POSTRecurringProcess(
      new Request("http://localhost/api/recurring/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ processAll: true }),
      }),
      { params: Promise.resolve({ bookId: "1" }) }
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.transactionsCreated).toBe(1);

    const created = await db.query.transactions.findMany({
      where: eq(transactions.recurringRuleId, rule.id),
    });
    expect(created).toHaveLength(1);
    expect(created[0].date).toBe("2026-02-13");

    const updatedRule = await db.query.recurringRules.findFirst({
      where: eq(recurringRules.id, rule.id),
    });
    expect(updatedRule?.nextDate).toBe("2026-02-14");
  });

  it("does not process when outside the lead window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-02-10T12:00:00Z"));

    const checking = await createAccount({ name: "Checking", type: "asset" });
    const rent = await createAccount({ name: "Rent", type: "expense" });
    const rule = await createRecurringRule({
      name: "Rent",
      frequency: "daily",
      startDate: "2026-02-13",
      nextDate: "2026-02-13",
      autoCreateDaysBefore: 2,
      templateSplits: [
        { accountId: rent.id, amount: 150000 },
        { accountId: checking.id, amount: -150000 },
      ],
    });

    const response = await POSTRecurringProcess(
      new Request("http://localhost/api/recurring/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ processAll: true }),
      }),
      { params: Promise.resolve({ bookId: "1" }) }
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.transactionsCreated).toBe(0);

    const created = await db.query.transactions.findMany({
      where: eq(transactions.recurringRuleId, rule.id),
    });
    expect(created).toHaveLength(0);

    const updatedRule = await db.query.recurringRules.findFirst({
      where: eq(recurringRules.id, rule.id),
    });
    expect(updatedRule?.nextDate).toBe("2026-02-13");
  });

  it("catches up overdue rules and advances nextDate past horizon", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-02-10T12:00:00Z"));

    const checking = await createAccount({ name: "Checking", type: "asset" });
    const utilities = await createAccount({ name: "Utilities", type: "expense" });
    const rule = await createRecurringRule({
      name: "Utilities",
      frequency: "daily",
      startDate: "2026-02-08",
      nextDate: "2026-02-08",
      autoCreateDaysBefore: 1,
      templateSplits: [
        { accountId: utilities.id, amount: 9000 },
        { accountId: checking.id, amount: -9000 },
      ],
    });

    const response = await POSTRecurringProcess(
      new Request("http://localhost/api/recurring/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ processAll: true }),
      }),
      { params: Promise.resolve({ bookId: "1" }) }
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.transactionsCreated).toBe(4);

    const created = await db.query.transactions.findMany({
      where: eq(transactions.recurringRuleId, rule.id),
      orderBy: (t, { asc }) => [asc(t.date)],
    });
    expect(created.map((t) => t.date)).toEqual([
      "2026-02-08",
      "2026-02-09",
      "2026-02-10",
      "2026-02-11",
    ]);

    const updatedRule = await db.query.recurringRules.findFirst({
      where: eq(recurringRules.id, rule.id),
    });
    expect(updatedRule?.nextDate).toBe("2026-02-12");
  });

  it("deactivates rules once processing passes endDate", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-02-10T12:00:00Z"));

    const checking = await createAccount({ name: "Checking", type: "asset" });
    const subscription = await createAccount({
      name: "Subscription",
      type: "expense",
    });
    const rule = await createRecurringRule({
      name: "Trial Subscription",
      frequency: "daily",
      startDate: "2026-02-08",
      nextDate: "2026-02-08",
      endDate: "2026-02-09",
      autoCreateDaysBefore: 2,
      templateSplits: [
        { accountId: subscription.id, amount: 1200 },
        { accountId: checking.id, amount: -1200 },
      ],
    });

    const response = await POSTRecurringProcess(
      new Request("http://localhost/api/recurring/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ processAll: true }),
      }),
      { params: Promise.resolve({ bookId: "1" }) }
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.transactionsCreated).toBe(2);

    const updatedRule = await db.query.recurringRules.findFirst({
      where: eq(recurringRules.id, rule.id),
    });
    expect(updatedRule?.isActive).toBe(false);
    expect(updatedRule?.nextDate).toBe("2026-02-10");
  });

  it("sets payeeId on created transactions from rule", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-02-10T12:00:00Z"));

    const checking = await createAccount({ name: "Checking", type: "asset" });
    const rent = await createAccount({ name: "Rent", type: "expense" });
    const payee = await createPayee({ name: "Landlord" });
    const rule = await createRecurringRule({
      name: "Rent",
      frequency: "daily",
      startDate: "2026-02-10",
      nextDate: "2026-02-10",
      payeeId: payee.id,
      templateSplits: [
        { accountId: rent.id, amount: 150000 },
        { accountId: checking.id, amount: -150000 },
      ],
    });

    const response = await POSTRecurringProcess(
      new Request("http://localhost/api/recurring/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ruleId: rule.id }),
      }),
      { params: Promise.resolve({ bookId: "1" }) }
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.transactionsCreated).toBe(1);

    const created = await db.query.transactions.findMany({
      where: eq(transactions.recurringRuleId, rule.id),
    });
    expect(created).toHaveLength(1);
    expect(created[0].payeeId).toBe(payee.id);
  });

  it("returns 401 from cron route when authorization is missing", async () => {
    process.env.CRON_SECRET = "test-secret";

    const response = await GETRecurringCron(
      new Request("http://localhost/api/cron/recurring")
    );

    expect(response.status).toBe(401);
  });

  it("processes recurring rules from cron route with valid authorization", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-02-10T12:00:00Z"));
    process.env.CRON_SECRET = "test-secret";

    const checking = await createAccount({ name: "Checking", type: "asset" });
    const insurance = await createAccount({ name: "Insurance", type: "expense" });
    await createRecurringRule({
      name: "Insurance",
      frequency: "daily",
      startDate: "2026-02-11",
      nextDate: "2026-02-11",
      autoCreateDaysBefore: 1,
      templateSplits: [
        { accountId: insurance.id, amount: 5000 },
        { accountId: checking.id, amount: -5000 },
      ],
    });

    const response = await GETRecurringCron(
      new Request("http://localhost/api/cron/recurring", {
        headers: {
          authorization: "Bearer test-secret",
        },
      })
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.transactionsCreated).toBe(1);
  });
});
