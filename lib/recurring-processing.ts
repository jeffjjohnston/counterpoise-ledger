import { and, eq, inArray } from "drizzle-orm";
import { type AppDb } from "@/db";
import { accounts, recurringRules, transactionSplits, transactions } from "@/db/schema";
import {
  getNextDate,
  isValidDateString,
  type RecurrenceConfig,
  validateSplits,
} from "@/lib/accounting";
import { toDateString } from "@/lib/formatters";
import { addDaysToDateString, getOccurrenceDate } from "@/lib/recurring";

// AppDb (from "@/db") is already the shared base both the top-level db and a
// `tx` handle satisfy — see the comment on its definition — so this used to
// redefine an equivalent union locally before that base existed. Kept as an
// alias since callers below read more clearly as "a plain db or a transaction".
type DbClient = AppDb;

type RuleWithTemplateSplits = {
  id: number;
  frequency: string;
  interval: number;
  daysOfWeek: string | null;
  weekOfMonth: string | null;
  daysOfMonth: string | null;
  nextDate: string;
  endDate: string | null;
  businessDaysOnly: boolean;
  templateDescription: string | null;
  payeeId: number | null;
  autoCreateDaysBefore: number;
  templateSplits: Array<{
    accountId: number;
    amount: number;
  }>;
};

export type RecurringProcessingResult = {
  transactionsCreated: number;
  transactionIds: number[];
  skipped: Array<{ ruleId: number; reason: string }>;
};

export function buildConfig(rule: {
  frequency: string;
  interval: number;
  daysOfWeek: string | null;
  weekOfMonth: string | null;
  daysOfMonth: string | null;
}): RecurrenceConfig {
  return {
    frequency: rule.frequency as RecurrenceConfig["frequency"],
    interval: rule.interval,
    daysOfWeek: rule.daysOfWeek ? JSON.parse(rule.daysOfWeek) : undefined,
    weekOfMonth: rule.weekOfMonth || undefined,
    daysOfMonth: rule.daysOfMonth ? JSON.parse(rule.daysOfMonth) : undefined,
  };
}

function toRuleInput(rule: RuleWithTemplateSplits) {
  return {
    id: rule.id,
    templateDescription: rule.templateDescription,
    payeeId: rule.payeeId,
    templateSplits: rule.templateSplits.map((split) => ({
      accountId: split.accountId,
      amount: split.amount,
    })),
  };
}

async function createTransactionFromRule(
  db: DbClient,
  bookId: number,
  rule: {
    id: number;
    templateDescription: string | null;
    payeeId: number | null;
    templateSplits: Array<{
      accountId: number;
      amount: number;
    }>;
  },
  date: string
): Promise<number | null> {
  if (rule.templateSplits.length < 2) {
    return null;
  }

  if (!isValidDateString(date)) {
    throw new Error("Recurring transaction date must be in YYYY-MM-DD format");
  }

  if (!validateSplits(rule.templateSplits)) {
    throw new Error("Recurring rule template splits must sum to zero");
  }

  const accountIds = [...new Set(rule.templateSplits.map((split) => split.accountId))];
  const accountRows =
    accountIds.length > 0
      ? await db
          .select({ id: accounts.id })
          .from(accounts)
          .where(and(eq(accounts.bookId, bookId), inArray(accounts.id, accountIds)))
      : [];

  if (accountRows.length !== accountIds.length) {
    throw new Error("Recurring rule template contains accounts outside this book");
  }

  const [newTransaction] = await db
    .insert(transactions)
    .values({
      bookId,
      date,
      description: rule.templateDescription,
      payeeId: rule.payeeId,
      recurringRuleId: rule.id,
    })
    .returning();

  const splitValues = rule.templateSplits.map((split) => ({
    bookId,
    transactionId: newTransaction.id,
    accountId: split.accountId,
    amount: split.amount,
  }));

  await db.insert(transactionSplits).values(splitValues);

  return newTransaction.id;
}

export async function processRecurringRuleById(
  db: AppDb,
  bookId: number,
  ruleId: number
): Promise<RecurringProcessingResult | null> {
  const rule = await db.query.recurringRules.findFirst({
    where: and(eq(recurringRules.id, ruleId), eq(recurringRules.bookId, bookId)),
    with: {
      templateSplits: true,
    },
  });

  if (!rule) {
    return null;
  }

  // createTransactionFromRule returns null for these, but the nextDate claim
  // below would still succeed — advancing the rule past a date that produced
  // nothing, silently. Check before claiming, same as processAllRecurringRules.
  if (rule.templateSplits.length < 2) {
    return {
      transactionsCreated: 0,
      transactionIds: [],
      skipped: [{ ruleId: rule.id, reason: "fewer than 2 template splits" }],
    };
  }

  const dueDate = rule.nextDate;
  // The rule advances on its own cadence; only the transaction's date observes
  // the business-day shift. See getOccurrenceDate in lib/recurring.ts.
  const occurrenceDate = getOccurrenceDate(dueDate, rule.businessDaysOnly);
  const nextDate = getNextDate(dueDate, buildConfig(rule));

  const transactionIds: number[] = [];
  return db.transaction(async (tx) => {
    // Claim the due date before creating anything: advance nextDate only if it
    // still holds the value we read. A concurrent processor (cron, or a second
    // click) blocks on this row, then matches zero rows once we commit and
    // bails out — so the same date can never produce two transactions.
    const claimed = await tx
      .update(recurringRules)
      .set({ nextDate })
      .where(
        and(
          eq(recurringRules.id, ruleId),
          eq(recurringRules.bookId, bookId),
          eq(recurringRules.nextDate, dueDate)
        )
      )
      .returning({ id: recurringRules.id });

    if (claimed.length === 0) {
      return { transactionsCreated: 0, transactionIds: [], skipped: [] };
    }

    const transactionId = await createTransactionFromRule(
      tx,
      bookId,
      toRuleInput(rule),
      occurrenceDate
    );
    if (transactionId) {
      transactionIds.push(transactionId);
    }

    return {
      transactionsCreated: transactionIds.length,
      transactionIds,
      skipped: [],
    };
  });
}

export async function processAllRecurringRules(
  db: AppDb,
  bookId: number,
  today = toDateString(new Date())
): Promise<RecurringProcessingResult> {
  const createdTransactions: number[] = [];
  const skipped: Array<{ ruleId: number; reason: string }> = [];

  const activeRules = await db.query.recurringRules.findMany({
    where: and(eq(recurringRules.isActive, true), eq(recurringRules.bookId, bookId)),
    with: {
      templateSplits: true,
    },
  });

  for (const rule of activeRules) {
    const horizonDate = addDaysToDateString(today, rule.autoCreateDaysBefore ?? 0);
    // The horizon is compared against the *observed* date throughout: a
    // businessDaysOnly rule due on a Saturday is not created until the Monday
    // it will be dated, not on the Saturday itself.
    const observe = (date: string) => getOccurrenceDate(date, rule.businessDaysOnly);
    if (observe(rule.nextDate) > horizonDate) {
      continue;
    }

    // createTransactionFromRule returns null for these, but the nextDate claim
    // below would still succeed — advancing the rule past a date that produced
    // nothing, every run, silently.
    if (rule.templateSplits.length < 2) {
      skipped.push({ ruleId: rule.id, reason: "fewer than 2 template splits" });
      continue;
    }

    // Work out which dates are due up front so the guarded nextDate update can
    // be the first statement in the transaction — see processRecurringRuleById.
    const occurrenceDates: string[] = [];
    let currentDate = rule.nextDate;
    let deactivateRule = false;

    // endDate bounds the schedule, not the observed date — an occurrence
    // scheduled on or before endDate still counts even when its business-day
    // shift lands past it.
    while (observe(currentDate) <= horizonDate) {
      if (rule.endDate && currentDate > rule.endDate) {
        deactivateRule = true;
        break;
      }

      occurrenceDates.push(observe(currentDate));
      currentDate = getNextDate(currentDate, buildConfig(rule));
    }

    const result = await db.transaction(async (tx) => {
      const claimed = await tx
        .update(recurringRules)
        .set({
          nextDate: currentDate,
          ...(deactivateRule ? { isActive: false } : {}),
        })
        .where(
          and(
            eq(recurringRules.id, rule.id),
            eq(recurringRules.bookId, bookId),
            eq(recurringRules.nextDate, rule.nextDate)
          )
        )
        .returning({ id: recurringRules.id });

      if (claimed.length === 0) {
        return [];
      }

      const ruleTransactionIds: number[] = [];
      for (const occurrenceDate of occurrenceDates) {
        const transactionId = await createTransactionFromRule(
          tx,
          bookId,
          toRuleInput(rule),
          occurrenceDate
        );
        if (transactionId) {
          ruleTransactionIds.push(transactionId);
        }
      }

      return ruleTransactionIds;
    });

    createdTransactions.push(...result);
  }

  return {
    transactionsCreated: createdTransactions.length,
    transactionIds: createdTransactions,
    skipped,
  };
}
