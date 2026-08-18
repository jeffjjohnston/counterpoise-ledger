import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { recurringRules, recurringTemplateSplits } from "@/db/schema";

const db = getDb();
import {
  parseReminderFrequency,
  extractTemplateSplits,
  importReminders,
  normalizeReminderNextDate,
} from "@/scripts/import-moneydance/parsers/reminders";
import { IdMapper, type MoneydanceReminder, type ImportOptions } from "@/scripts/import-moneydance/types";
import { createAccount, resetTestDatabase, setupTestDatabase } from "@/tests/helpers/db";

function makeReminder(overrides: Partial<MoneydanceReminder>): MoneydanceReminder {
  return {
    obj_type: "reminder",
    id: "test-id",
    desc: "Test Reminder",
    sdt: "20240101",
    ackdt: "20250101",
    daily: "0",
    weekly: "0",
    weeklymod: "0",
    weeklydays: "0",
    monthly: "0",
    monthlymod: "0",
    monthlydays: "0",
    yearly: "0",
    ...overrides,
  };
}

const options: ImportOptions = {
  dryRun: false,
  importInactive: false,
  importHidden: false,
  verbose: false,
};

describe("parseReminderFrequency", () => {
  it("parses yearly reminder", () => {
    const result = parseReminderFrequency(makeReminder({ yearly: "1" }));
    expect(result).toEqual({ frequency: "yearly", interval: 1 });
  });

  it("parses monthly reminder with day of month", () => {
    const result = parseReminderFrequency(makeReminder({ monthlydays: "15" }));
    expect(result).toEqual({ frequency: "monthly", interval: 1, daysOfMonth: [15] });
  });

  it("parses quarterly reminder (monthlymod = 4)", () => {
    const result = parseReminderFrequency(makeReminder({ monthlydays: "1", monthlymod: "4" }));
    expect(result).toEqual({ frequency: "monthly", interval: 4, daysOfMonth: [1] });
  });

  it("parses biweekly reminder (daily = 14) as weekly interval 2", () => {
    const result = parseReminderFrequency(makeReminder({ daily: "14" }));
    expect(result).toEqual({ frequency: "weekly", interval: 2 });
  });

  it("parses every-4-weeks reminder (daily = 28, weeklymod > 0) as weekly interval 4", () => {
    const result = parseReminderFrequency(
      makeReminder({ daily: "28", weeklymod: "4", monthlymod: "3" })
    );
    expect(result).toEqual({ frequency: "weekly", interval: 4 });
  });

  it("parses pure daily interval (daily = 730)", () => {
    const result = parseReminderFrequency(makeReminder({ daily: "730" }));
    expect(result).toEqual({ frequency: "daily", interval: 730 });
  });

  it("returns null for unrecognized frequency pattern", () => {
    const result = parseReminderFrequency(makeReminder({}));
    expect(result).toBeNull();
  });
});

describe("extractTemplateSplits", () => {
  it("extracts parent + child splits from txn.* fields", () => {
    const reminder = makeReminder({
      "txn.acctid": "acct-checking",
      "txn.desc": "Amazon.com",
      "txn.0.acctid": "acct-expense",
      "txn.0.samt": "12760",
      "txn.0.pamt": "-12760",
      "txn.0.desc": "Amazon.com",
    }) as MoneydanceReminder;

    const splits = extractTemplateSplits(reminder);
    expect(splits).toEqual({
      parentAccountId: "acct-checking",
      templateDescription: "Amazon.com",
      splits: [
        { acctid: "acct-checking", amount: -12760 },
        { acctid: "acct-expense", amount: 12760 },
      ],
    });
  });

  it("extracts multi-split template (paycheck with 3 child splits)", () => {
    const reminder = makeReminder({
      "txn.acctid": "acct-gross",
      "txn.desc": "Paycheck",
      "txn.0.acctid": "acct-net",
      "txn.0.samt": "-470656",
      "txn.0.pamt": "470656",
      "txn.1.acctid": "acct-tax1",
      "txn.1.samt": "24058",
      "txn.1.pamt": "-24058",
      "txn.2.acctid": "acct-tax2",
      "txn.2.samt": "990",
      "txn.2.pamt": "-990",
    }) as MoneydanceReminder;

    const splits = extractTemplateSplits(reminder);
    expect(splits!.splits).toHaveLength(4); // parent + 3 children
    // Parent: sum of pamts = 470656 + (-24058) + (-990) = 445608
    expect(splits!.splits[0]).toEqual({ acctid: "acct-gross", amount: 445608 });
    expect(splits!.splits[1]).toEqual({ acctid: "acct-net", amount: -470656 });
    expect(splits!.splits[2]).toEqual({ acctid: "acct-tax1", amount: 24058 });
    expect(splits!.splits[3]).toEqual({ acctid: "acct-tax2", amount: 990 });
  });

  it("returns null when txn.acctid is missing", () => {
    const reminder = makeReminder({}) as MoneydanceReminder;
    const splits = extractTemplateSplits(reminder);
    expect(splits).toBeNull();
  });
});

describe("normalizeReminderNextDate", () => {
  it("advances past yearly ack date to the next upcoming year", () => {
    const result = normalizeReminderNextDate(
      "2012-03-11",
      "2025-03-11",
      { frequency: "yearly", interval: 1 },
      "2026-02-27"
    );

    expect(result).toBe("2026-03-11");
  });
});

describe("importReminders (integration)", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-02-27T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("imports a yearly reminder with single split", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset", subtype: "bank" });
    const expense = await createAccount({ name: "Subscriptions", type: "expense" });

    const idMapper = new IdMapper();
    idMapper.setAccount("md-checking", checking.id);
    idMapper.setAccount("md-expense", expense.id);
    idMapper.setPayee("amazon.com", 1);

    const reminders: MoneydanceReminder[] = [
      makeReminder({
        id: "rem-1",
        desc: "Amazon.com Prime",
        yearly: "1",
        sdt: "20121019",
        ackdt: "20251019",
        acdays: "14",
        "txn.acctid": "md-checking",
        "txn.desc": "Amazon.com",
        "txn.0.acctid": "md-expense",
        "txn.0.samt": "12760",
        "txn.0.pamt": "-12760",
      }) as MoneydanceReminder,
    ];

    const stats = await importReminders(reminders, idMapper, options, db, 1);

    expect(stats.imported).toBe(1);
    expect(stats.errors).toHaveLength(0);


    const rules = await db.select().from(recurringRules);
    expect(rules).toHaveLength(1);
    expect(rules[0].name).toBe("Amazon.com Prime");
    expect(rules[0].frequency).toBe("yearly");
    expect(rules[0].interval).toBe(1);
    expect(rules[0].startDate).toBe("2012-10-19");
    expect(rules[0].nextDate).toBe("2026-10-19");
    expect(rules[0].autoCreateDaysBefore).toBe(14);
    expect(rules[0].templateDescription).toBe("Amazon.com");
    expect(rules[0].isActive).toBe(true);

    const splits = await db.select().from(recurringTemplateSplits);
    expect(splits).toHaveLength(2);
    expect(splits.find(s => s.accountId === checking.id)?.amount).toBe(-12760);
    expect(splits.find(s => s.accountId === expense.id)?.amount).toBe(12760);
  });

  it("skips reminders with unrecognizable frequency", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset", subtype: "bank" });
    const idMapper = new IdMapper();
    idMapper.setAccount("md-checking", checking.id);

    const reminders: MoneydanceReminder[] = [
      makeReminder({
        id: "rem-bad",
        desc: "Bad Reminder",
        "txn.acctid": "md-checking",
        "txn.0.acctid": "md-checking",
        "txn.0.samt": "100",
        "txn.0.pamt": "-100",
      }) as MoneydanceReminder,
    ];

    const stats = await importReminders(reminders, idMapper, options, db, 1);
    expect(stats.skipped).toBe(1);
    expect(stats.imported).toBe(0);
  });

  it("skips reminders with unmapped accounts", async () => {
    const idMapper = new IdMapper();

    const reminders: MoneydanceReminder[] = [
      makeReminder({
        id: "rem-unmapped",
        desc: "Missing Accounts",
        yearly: "1",
        "txn.acctid": "md-nonexistent",
        "txn.0.acctid": "md-also-nonexistent",
        "txn.0.samt": "100",
        "txn.0.pamt": "-100",
      }) as MoneydanceReminder,
    ];

    const stats = await importReminders(reminders, idMapper, options, db, 1);
    expect(stats.skipped).toBe(1);
    expect(stats.imported).toBe(0);
  });

  it("clamps negative acdays to 0 and caps at 30", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset", subtype: "bank" });
    const expense = await createAccount({ name: "Bills", type: "expense" });

    const idMapper = new IdMapper();
    idMapper.setAccount("md-checking", checking.id);
    idMapper.setAccount("md-expense", expense.id);

    const reminders: MoneydanceReminder[] = [
      makeReminder({
        id: "rem-neg",
        desc: "Negative Acdays",
        monthly: "1",
        monthlydays: "1",
        acdays: "-1",
        "txn.acctid": "md-checking",
        "txn.desc": "Bill",
        "txn.0.acctid": "md-expense",
        "txn.0.samt": "5000",
        "txn.0.pamt": "-5000",
      }) as MoneydanceReminder,
      makeReminder({
        id: "rem-high",
        desc: "High Acdays",
        monthly: "1",
        monthlydays: "15",
        acdays: "90",
        "txn.acctid": "md-checking",
        "txn.desc": "Bill 2",
        "txn.0.acctid": "md-expense",
        "txn.0.samt": "3000",
        "txn.0.pamt": "-3000",
      }) as MoneydanceReminder,
    ];

    const stats = await importReminders(reminders, idMapper, options, db, 1);
    expect(stats.imported).toBe(2);


    const rules = await db.select().from(recurringRules);
    expect(rules.find(r => r.name === "Negative Acdays")?.autoCreateDaysBefore).toBe(0);
    expect(rules.find(r => r.name === "High Acdays")?.autoCreateDaysBefore).toBe(30);
  });

  it("handles investment cash account reminders (xfrtp_bank)", async () => {
    const investmentCash = await createAccount({
      name: "401k Cash",
      type: "asset",
      subtype: "cash",
      isInvestmentCash: true,
    });
    const income = await createAccount({ name: "Salary", type: "income" });

    const idMapper = new IdMapper();
    idMapper.setAccount("md-401k_CASH", investmentCash.id);
    idMapper.setAccount("md-income", income.id);

    const reminders: MoneydanceReminder[] = [
      makeReminder({
        id: "rem-invest",
        desc: "401k Contribution",
        daily: "14",
        sdt: "20240101",
        ackdt: "20260301",
        "txn.acctid": "md-401k",
        "txn.xfer_type": "xfrtp_bank",
        "txn.desc": "Employer",
        "txn.0.acctid": "md-income",
        "txn.0.samt": "-50000",
        "txn.0.pamt": "50000",
      }) as MoneydanceReminder,
    ];

    const stats = await importReminders(reminders, idMapper, options, db, 1);
    expect(stats.imported).toBe(1);


    const rules = await db.select().from(recurringRules);
    expect(rules[0].frequency).toBe("weekly");
    expect(rules[0].interval).toBe(2);
    expect(rules[0].nextDate).toBe("2026-03-01");

    const splits = await db.select().from(recurringTemplateSplits);
    expect(splits.find(s => s.accountId === investmentCash.id)).toBeTruthy();
  });

  it("writes no rule when its template splits are rejected", async () => {
    // Both split amounts would sum to zero if they were valid, but at
    // 3,000,000,000 they exceed Postgres's int4 range for
    // recurring_template_splits.amount. The insert fails only after the
    // recurring rule row has already been created, which is the same shape
    // as any mid-sequence failure: the rule lands with zero template
    // splits — exactly the malformed-rule shape processRecurringRuleById's
    // guard exists to handle — unless the two writes are atomic.
    const checking = await createAccount({ name: "Checking", type: "asset", subtype: "bank" });
    const expense = await createAccount({ name: "Bills", type: "expense" });

    const idMapper = new IdMapper();
    idMapper.setAccount("md-checking", checking.id);
    idMapper.setAccount("md-expense", expense.id);

    const reminders: MoneydanceReminder[] = [
      makeReminder({
        id: "rem-overflow",
        desc: "Overflow Reminder",
        yearly: "1",
        "txn.acctid": "md-checking",
        "txn.desc": "Overflow",
        "txn.0.acctid": "md-expense",
        "txn.0.samt": "3000000000",
        "txn.0.pamt": "-3000000000",
      }) as MoneydanceReminder,
    ];

    const stats = await importReminders(reminders, idMapper, options, db, 1);
    expect(stats.imported).toBe(0);
    expect(stats.errors.length).toBeGreaterThan(0);

    const rules = await db.select().from(recurringRules);
    expect(rules).toHaveLength(0);

    const splits = await db.select().from(recurringTemplateSplits);
    expect(splits).toHaveLength(0);
  });

  it("uses dry run mode without writing", async () => {
    const dryRunOptions: ImportOptions = { ...options, dryRun: true };

    const reminders: MoneydanceReminder[] = [
      makeReminder({
        id: "rem-dry",
        desc: "Dry Run Test",
        yearly: "1",
        "txn.acctid": "md-checking",
        "txn.0.acctid": "md-expense",
        "txn.0.samt": "100",
        "txn.0.pamt": "-100",
      }) as MoneydanceReminder,
    ];

    const stats = await importReminders(reminders, new IdMapper(), dryRunOptions, db, 1);
    expect(stats.imported).toBe(1);


    const rules = await db.select().from(recurringRules);
    expect(rules).toHaveLength(0);
  });
});
