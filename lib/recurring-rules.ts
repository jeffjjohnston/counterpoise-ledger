import { and, desc, eq, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";
import type { AppDb } from "@/db";
import {
  accounts,
  books,
  payees,
  recurringRules,
  recurringTemplateSplits,
  transactions,
} from "@/db/schema";
import {
  advanceNextDateToFuture,
  effectiveDateSql,
  getInitialNextDate,
  getNextDate,
  validateSplits,
} from "@/lib/accounting";
import { toDateString } from "@/lib/formatters";
import { normalizePayeeName } from "@/lib/payees";
import { addDaysToDateString, getOccurrenceDate } from "@/lib/recurring";
import { buildConfig } from "@/lib/recurring-processing";
import type {
  CreateRuleInput,
  TemplateSplitInput,
  UpdateRuleInput,
} from "@/lib/schemas/recurring";
import type { TransactionWithSplits } from "@/types";

// ---------------------------------------------------------------------------
// Error classes (Task 4 throws them; declared here so the module has one home)
// ---------------------------------------------------------------------------

/** Bad input to a recurring-rule write. */
export class RecurringRuleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecurringRuleValidationError";
  }
}

/**
 * A rule id that does not exist in this book. The default message is the exact
 * text both recurring routes already return, so rewiring them changes no HTTP
 * response body.
 */
export class RecurringRuleNotFoundError extends Error {
  constructor(message: string = "Recurring rule not found") {
    super(message);
    this.name = "RecurringRuleNotFoundError";
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * One rule with the relations every recurring surface renders.
 *
 * The `with` literal is repeated in listRecurringRules rather than hoisted
 * into a shared constant: Drizzle infers the relational result type from the
 * literal itself, and a hoisted object widens it away.
 */
async function hydrateRule(db: AppDb, bookId: number, ruleId: number) {
  return db.query.recurringRules.findFirst({
    where: and(eq(recurringRules.id, ruleId), eq(recurringRules.bookId, bookId)),
    with: { payee: true, templateSplits: { with: { account: true } } },
  });
}

export type RecurringRuleWithRelations = NonNullable<Awaited<ReturnType<typeof hydrateRule>>>;

/** GET /b/[bookId]/recurring/[id]. Undefined when the rule is not in this book. */
export async function getRecurringRule(
  db: AppDb,
  bookId: number,
  ruleId: number
): Promise<RecurringRuleWithRelations | undefined> {
  return hydrateRule(db, bookId, ruleId);
}

/** GET /b/[bookId]/recurring. Active rules first, then by next scheduled date. */
export async function listRecurringRules(
  db: AppDb,
  bookId: number
): Promise<RecurringRuleWithRelations[]> {
  return db.query.recurringRules.findMany({
    where: eq(recurringRules.bookId, bookId),
    with: { payee: true, templateSplits: { with: { account: true } } },
    orderBy: [desc(recurringRules.isActive), recurringRules.nextDate],
  });
}

export type ProjectedTransaction = TransactionWithSplits & { isProjected: boolean };

export interface ProjectionOptions {
  /** Inclusive start. Defaults to tomorrow. */
  startDate?: string;
  /** Inclusive end. Defaults to `today` + the book's upcomingDays. */
  endDate?: string;
  /** Keep only rules with a template split on this account or a direct child of it. */
  accountId?: number | null;
  /**
   * The book's projection window. Omit and it is read from `books`. The route
   * already holds the row from authentication and passes it, so the extra
   * query happens only on the MCP path.
   */
  upcomingDays?: number;
  /** Today, as YYYY-MM-DD. Injectable so tests do not depend on the clock. */
  today?: string;
}

export async function getProjectedTransactions(
  db: AppDb,
  bookId: number,
  opts: ProjectionOptions = {}
): Promise<ProjectedTransaction[]> {
  const today = opts.today ?? toDateString(new Date());
  const upcomingDays =
    opts.upcomingDays ??
    (await db
      .select({ upcomingDays: books.upcomingDays })
      .from(books)
      .where(eq(books.id, bookId))
      .limit(1))[0]?.upcomingDays ??
    30;

  const startDate = opts.startDate ?? addDaysToDateString(today, 1);
  const endDate = opts.endDate ?? addDaysToDateString(today, upcomingDays);
  const filterAccountId = opts.accountId ?? null;

  const rules = await db.query.recurringRules.findMany({
    where: and(eq(recurringRules.bookId, bookId), eq(recurringRules.isActive, true)),
    with: {
      payee: true,
      templateSplits: {
        with: {
          account: true,
        },
      },
    },
  });

  const projected: (TransactionWithSplits & { isProjected: boolean })[] = [];
  const epoch = new Date(0);

  for (const rule of rules) {
    // If filtering by account, check if this rule has a split touching that account
    if (filterAccountId !== null) {
      const hasMatchingAccount = rule.templateSplits.some(
        (s) =>
          s.accountId === filterAccountId ||
          s.account.parentId === filterAccountId
      );
      if (!hasMatchingAccount) continue;
    }

    // Parse rule's recurrence config. buildConfig also builds this shape for
    // lib/recurring-processing.ts. Sharing one function stops the two copies
    // from drifting apart, the way weekOfMonth's null handling once did.
    const config = buildConfig(rule);

    // Iterate through occurrences starting from nextDate. The loop walks the
    // *scheduled* dates — that is what getNextDate advances — while the range
    // filter and the projected transaction both use the observed date, which
    // is what will actually be created. Bounding the loop on the scheduled
    // date is still safe: the shift only ever moves a date forward, so once
    // the schedule passes endDate every later observed date has too.
    let currentDate = rule.nextDate;
    let occurrenceIndex = 0;

    while (currentDate <= endDate) {
      const occurrenceDate = getOccurrenceDate(currentDate, rule.businessDaysOnly);

      if (occurrenceDate >= startDate && occurrenceDate <= endDate) {
        const txId = -(rule.id * 10000 + occurrenceIndex);

        projected.push({
          id: txId,
          bookId,
          date: occurrenceDate,
          description: rule.templateDescription,
          checkNumber: null,
          notes: null,
          payeeId: rule.payeeId,
          isReconciled: false,
          isFloating: false,
          recurringRuleId: rule.id,
          createdAt: epoch,
          updatedAt: epoch,
          payee: rule.payee ?? null,
          splits: rule.templateSplits.map((ts, i) => ({
            id: -(txId * 100 + i),
            bookId,
            transactionId: txId,
            accountId: ts.accountId,
            amount: ts.amount,
            account: ts.account,
          })),
          investmentSplits: [],
          isProjected: true,
        });

        occurrenceIndex++;
      }

      // Advance to next occurrence
      const nextDateStr = getNextDate(currentDate, config);
      if (nextDateStr <= currentDate) break; // safety: prevent infinite loop
      currentDate = nextDateStr;

      // Also respect endDate on the rule
      if (rule.endDate && currentDate > rule.endDate) break;
    }
  }

  // Sort by date ascending
  projected.sort((a, b) => a.date.localeCompare(b.date));

  return projected;
}

export interface RecurringTransactionRow {
  transactionId: number;
  date: string;
  recurringRuleId: number | null;
  ruleName: string;
}

/** GET /b/[bookId]/recurring/transactions. Dates are effective dates. */
export async function listRecurringTransactions(
  db: AppDb,
  bookId: number,
  range: { startDate: string; endDate: string }
): Promise<RecurringTransactionRow[]> {
  return db
    .select({
      transactionId: transactions.id,
      date: effectiveDateSql.as("date"),
      recurringRuleId: transactions.recurringRuleId,
      ruleName: recurringRules.name,
    })
    .from(transactions)
    .innerJoin(recurringRules, eq(transactions.recurringRuleId, recurringRules.id))
    .where(
      and(
        eq(transactions.bookId, bookId),
        isNotNull(transactions.recurringRuleId),
        gte(effectiveDateSql, range.startDate),
        lte(effectiveDateSql, range.endDate)
      )
    );
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * True when every template split names an account in this book.
 *
 * Moved from the two recurring route files, which held byte-for-byte copies.
 */
async function validateTemplateSplitAccounts(
  db: AppDb,
  bookId: number,
  templateSplits: TemplateSplitInput[]
) {
  const accountIds = [...new Set(templateSplits.map((split) => split.accountId))];
  const accountRows =
    accountIds.length > 0
      ? await db
          .select({ id: accounts.id })
          .from(accounts)
          .where(
            and(eq(accounts.bookId, bookId), inArray(accounts.id, accountIds))
          )
      : [];

  return accountRows.length === accountIds.length;
}

/**
 * The payee a write applies, or null for no payee.
 *
 * `payeeName` and `payeeId` keep their `unknown` types. The looseness is the
 * contract both routes have always had: an out-of-book `payeeId` resolves to
 * null instead of an error, a non-string `payeeName` is ignored, and a name
 * that normalizes to empty falls back to the id. Narrowing the types would
 * change what the routes accept.
 */
const resolvePayeeId = async ({
  db,
  payeeName,
  payeeId,
  bookId,
}: {
  db: AppDb;
  payeeName: unknown;
  payeeId: unknown;
  bookId: number;
}) => {
  let fallbackPayeeId: number | null =
    typeof payeeId === "number" && Number.isFinite(payeeId) ? payeeId : null;

  // Verify fallback payee belongs to this book
  if (fallbackPayeeId !== null) {
    const [valid] = await db
      .select({ id: payees.id })
      .from(payees)
      .where(and(eq(payees.id, fallbackPayeeId), eq(payees.bookId, bookId)))
      .limit(1);
    if (!valid) {
      fallbackPayeeId = null;
    }
  }

  if (typeof payeeName !== "string") {
    return fallbackPayeeId;
  }

  const normalizedPayeeName = normalizePayeeName(payeeName);
  if (!normalizedPayeeName) {
    return fallbackPayeeId;
  }

  const existingPayee = await db
    .select({ id: payees.id })
    .from(payees)
    .where(and(eq(payees.bookId, bookId), sql`lower(${payees.name}) = ${normalizedPayeeName.toLowerCase()}`))
    .limit(1);

  if (existingPayee.length > 0) {
    return existingPayee[0].id;
  }

  const [newPayee] = await db
    .insert(payees)
    .values({ name: normalizedPayeeName, bookId })
    .returning({ id: payees.id });

  return newPayee?.id ?? null;
};

/**
 * POST /b/[bookId]/recurring.
 *
 * The three validations run in the order POST always ran them: a request with
 * more than one problem must keep getting the message it got before.
 */
export async function createRecurringRule(
  db: AppDb,
  bookId: number,
  input: CreateRuleInput
): Promise<RecurringRuleWithRelations> {
  const {
    name, frequency, interval, daysOfWeek, weekOfMonth, daysOfMonth,
    startDate, endDate, templateDescription, templateSplits, autoCreateDaysBefore,
    businessDaysOnly,
    payeeId,
    payeeName,
  } = input;

  if (endDate && endDate < startDate) {
    throw new RecurringRuleValidationError("endDate cannot be earlier than startDate");
  }

  if (!validateSplits(templateSplits)) {
    throw new RecurringRuleValidationError(
      "Template splits must sum to zero (debits = credits)"
    );
  }

  const parsedAutoCreateDaysBefore = autoCreateDaysBefore ?? 0;

  const hasValidTemplateAccounts = await validateTemplateSplitAccounts(
    db,
    bookId,
    templateSplits
  );
  if (!hasValidTemplateAccounts) {
    throw new RecurringRuleValidationError(
      "One or more template split accounts do not belong to this book"
    );
  }

  const recurrenceConfig = {
    frequency,
    interval: interval || 1,
    daysOfWeek,
    weekOfMonth,
    daysOfMonth,
  };
  const effBusinessDaysOnly = businessDaysOnly ?? false;
  // Compare the date each occurrence is observed on, not the scheduled one:
  // a business-day rule's Saturday occurrence is still to come when the rule
  // is created on that Sunday or Monday.
  const initialNextDate = advanceNextDateToFuture(
    getInitialNextDate(startDate, recurrenceConfig),
    recurrenceConfig,
    undefined,
    (date) => getOccurrenceDate(date, effBusinessDaysOnly)
  );

  const newRule = await db.transaction(async (tx) => {
    // Resolved on `tx`, not on the pooled db. An unseen payeeName makes a
    // payee, and outside the transaction that payee committed on its own — so
    // a write that then failed left it behind in the book with nothing
    // pointing at it and no way for the caller to know. `interval` is enough
    // to cause that: it is one of the loose z.any() fields, so an out-of-range
    // value reaches this INSERT unchecked. lib/transactions.ts resolves its
    // payee inside the transaction for the same reason.
    const resolvedPayeeId = await resolvePayeeId({
      db: tx,
      payeeName,
      payeeId,
      bookId,
    });

    const [rule] = await tx
      .insert(recurringRules)
      .values({
        name,
        frequency,
        interval: interval || 1,
        daysOfWeek: daysOfWeek ? JSON.stringify(daysOfWeek) : null,
        weekOfMonth: weekOfMonth || null,
        daysOfMonth: daysOfMonth ? JSON.stringify(daysOfMonth) : null,
        startDate,
        endDate: endDate || null,
        nextDate: initialNextDate,
        businessDaysOnly: effBusinessDaysOnly,
        autoCreateDaysBefore: parsedAutoCreateDaysBefore,
        templateDescription: templateDescription || null,
        payeeId: resolvedPayeeId,
        isActive: true,
        bookId,
      })
      .returning();

    const splitValues = templateSplits.map(
      (split: TemplateSplitInput) => ({
        recurringRuleId: rule.id,
        accountId: split.accountId,
        amount: split.amount,
        bookId,
      })
    );

    await tx.insert(recurringTemplateSplits).values(splitValues);

    return rule;
  });

  const result = await hydrateRule(db, bookId, newRule.id);

  return result!;
}

/**
 * PUT /b/[bookId]/recurring/[id].
 *
 * Applies only the fields it is given. The existing row is read only when the
 * write needs it — see `needsExisting` below.
 */
export async function updateRecurringRule(
  db: AppDb,
  bookId: number,
  ruleId: number,
  input: UpdateRuleInput
): Promise<RecurringRuleWithRelations> {
  const {
    name,
    frequency,
    interval,
    daysOfWeek,
    weekOfMonth,
    daysOfMonth,
    startDate,
    endDate,
    nextDate,
    templateDescription,
    templateSplits,
    isActive,
    autoCreateDaysBefore,
    businessDaysOnly,
    payeeId,
    payeeName,
  } = input;

  if (templateSplits && !validateSplits(templateSplits)) {
    throw new RecurringRuleValidationError(
      "Template splits must sum to zero (debits = credits)"
    );
  }

  // Fetch existing rule for endDate validation and nextDate recomputation
  const scheduleChanged =
    frequency !== undefined || interval !== undefined || daysOfWeek !== undefined ||
    weekOfMonth !== undefined || daysOfMonth !== undefined || startDate !== undefined;
  const needsExisting = (endDate !== undefined && endDate !== null) || (scheduleChanged && nextDate === undefined);
  const existing = needsExisting
    ? await db.query.recurringRules.findFirst({
        where: and(eq(recurringRules.id, ruleId), eq(recurringRules.bookId, bookId)),
      })
    : undefined;

  // Validate endDate against effective startDate
  if (endDate !== undefined && endDate !== null) {
    const effStartDate = startDate ?? existing?.startDate;
    if (effStartDate && endDate < effStartDate) {
      throw new RecurringRuleValidationError("endDate cannot be earlier than startDate");
    }
  }

  if (templateSplits) {
    const hasValidTemplateAccounts = await validateTemplateSplitAccounts(
      db,
      bookId,
      templateSplits
    );
    if (!hasValidTemplateAccounts) {
      throw new RecurringRuleValidationError(
        "One or more template split accounts do not belong to this book"
      );
    }
  }

  // Recompute nextDate when schedule fields change (and nextDate isn't explicitly provided)
  let computedNextDate: string | undefined;
  if (scheduleChanged && nextDate === undefined && existing) {
    const effFrequency = frequency ?? existing.frequency;
    const effInterval = interval ?? existing.interval;
    const effStartDate = startDate ?? existing.startDate;
    const effDaysOfWeek = daysOfWeek !== undefined ? daysOfWeek : (existing.daysOfWeek ? JSON.parse(existing.daysOfWeek) : undefined);
    const effWeekOfMonth = weekOfMonth !== undefined ? weekOfMonth : (existing.weekOfMonth ?? undefined);
    const effDaysOfMonth = daysOfMonth !== undefined ? daysOfMonth : (existing.daysOfMonth ? JSON.parse(existing.daysOfMonth) : undefined);

    const effBusinessDaysOnly = businessDaysOnly ?? existing.businessDaysOnly;

    const recurrenceConfig = {
      frequency: effFrequency,
      interval: effInterval,
      daysOfWeek: effDaysOfWeek,
      weekOfMonth: effWeekOfMonth,
      daysOfMonth: effDaysOfMonth,
    };
    // Compare the date each occurrence is observed on, not the scheduled one,
    // so a business-day rule keeps a weekend occurrence it has yet to reach.
    const observe = (date: string) =>
      getOccurrenceDate(date, effBusinessDaysOnly);
    computedNextDate = advanceNextDateToFuture(
      getInitialNextDate(effStartDate, recurrenceConfig),
      recurrenceConfig,
      undefined,
      observe
    );

    // Don't let the recompute regress before occurrences already auto-created
    // from this rule (e.g. when only an end date is being added). Resume
    // strictly after the latest transaction generated by this rule.
    const [lastCreated] = await db
      .select({ maxDate: sql<string | null>`max(${transactions.date})` })
      .from(transactions)
      .where(
        and(
          eq(transactions.recurringRuleId, ruleId),
          eq(transactions.bookId, bookId)
        )
      );
    const lastCreatedDate = lastCreated?.maxDate ?? null;
    if (lastCreatedDate) {
      // Transactions carry the observed date, so the "already created" cutoff
      // has to be compared against observed dates too.
      computedNextDate = advanceNextDateToFuture(
        computedNextDate,
        recurrenceConfig,
        addDaysToDateString(lastCreatedDate, 1),
        observe
      );
    }
  }

  // updateRuleSchema.nextDate accepts null. It ports a route guard that
  // tolerated null — see the schema's comment on that field. But
  // recurringRules.nextDate does not allow null, unlike endDate. A null
  // value can never write to that column. This check turns null into a
  // clear RecurringRuleValidationError before the write reaches Postgres. It
  // also makes the MCP tool's published schema honest: that schema tells a
  // model null is a valid value for this field.
  if (nextDate === null) {
    throw new RecurringRuleValidationError("nextDate cannot be null");
  }

  await db.transaction(async (tx) => {
    // Prove the rule is in this book before anything below names its id.
    //
    // Neither statement that follows can do it. The UPDATE is book-scoped but
    // matches zero rows for a foreign id, which Postgres does not treat as an
    // error and Drizzle does not check the count of; and when `ruleValues` is
    // empty it does not run at all. The split replace then does the damage:
    // its DELETE is scoped to this book and matches nothing, while its INSERT
    // writes rows naming the foreign rule id, which
    // recurring_template_splits.recurring_rule_id accepts — it is a plain FK
    // to recurring_rules.id, with no composite (bookId, recurringRuleId)
    // constraint behind it. The transaction commits, and the book-scoped
    // rehydrate at the end of this function then reports not-found over the
    // top, so the caller sees a clean 404 while another book's rule quietly
    // holds the splits. Measured, not theorized: removing this check makes
    // the two cross-book tests find 4 splits on the victim rule.
    //
    // Throwing here rolls the transaction back, and nothing is written before
    // this point.
    const [exists] = await tx
      .select({ id: recurringRules.id })
      .from(recurringRules)
      .where(and(eq(recurringRules.id, ruleId), eq(recurringRules.bookId, bookId)))
      .limit(1);
    if (!exists) throw new RecurringRuleNotFoundError();

    // Resolved here, after the existence check, so a payee named for the
    // first time is not committed by an update that then throws. Outside the
    // transaction it committed on its own, which left a stray payee in the
    // caller's own book every time an update named a new payee and then hit a
    // rule that is not theirs.
    //
    // `undefined` means "leave the payee alone"; `null` — which
    // resolvePayeeId can legitimately return — means "clear it". The two must
    // not collapse.
    const resolvedPayeeId =
      payeeId !== undefined || payeeName !== undefined
        ? await resolvePayeeId({
            db: tx,
            payeeName,
            payeeId,
            bookId,
          })
        : undefined;

    const ruleValues = {
      ...(name !== undefined && { name }),
      ...(frequency !== undefined && { frequency }),
      ...(interval !== undefined && { interval }),
      ...(daysOfWeek !== undefined && { daysOfWeek: daysOfWeek ? JSON.stringify(daysOfWeek) : null }),
      ...(weekOfMonth !== undefined && { weekOfMonth: weekOfMonth || null }),
      ...(daysOfMonth !== undefined && { daysOfMonth: daysOfMonth ? JSON.stringify(daysOfMonth) : null }),
      ...(startDate !== undefined && { startDate }),
      ...(endDate !== undefined && { endDate }),
      // recurringRules.nextDate is NOT NULL, unlike endDate — but the
      // guard this schema ports tolerates an explicit `null` here (see
      // updateRuleSchema.nextDate's comment), same as it always did when
      // this field was untyped `any`. The guard above (`if (nextDate ===
      // null)`) now rejects that literal `null` before this object is even
      // built. The cast here is what lets a valid date string through this
      // conditional spread — not a route to a database error.
      ...(nextDate !== undefined && { nextDate: nextDate as string }),
      ...(computedNextDate !== undefined && { nextDate: computedNextDate }),
      ...(templateDescription !== undefined && { templateDescription }),
      ...(resolvedPayeeId !== undefined && { payeeId: resolvedPayeeId }),
      ...(isActive !== undefined && { isActive }),
      ...(autoCreateDaysBefore !== undefined && {
        autoCreateDaysBefore,
      }),
      ...(businessDaysOnly !== undefined && { businessDaysOnly }),
    };


    // An update that changes no rule column — templateSplits on its own is
    // the usual one, and the headline behavior of the MCP update tool —
    // leaves nothing to SET, and Drizzle refuses an empty set with "No values
    // to set". PUT answered 500 for that request until this change, although
    // it was always semantically valid. Skipping the statement lets it
    // through.
    if (Object.keys(ruleValues).length > 0) {
      await tx
        .update(recurringRules)
        .set(ruleValues)
        .where(and(eq(recurringRules.id, ruleId), eq(recurringRules.bookId, bookId)));
    }

    if (templateSplits && templateSplits.length >= 2) {
      await tx
        .delete(recurringTemplateSplits)
        .where(and(eq(recurringTemplateSplits.recurringRuleId, ruleId), eq(recurringTemplateSplits.bookId, bookId)));

      const splitValues = templateSplits.map(
        (split: TemplateSplitInput) => ({
          recurringRuleId: ruleId,
          accountId: split.accountId,
          amount: split.amount,
          bookId,
        })
      );

      await tx.insert(recurringTemplateSplits).values(splitValues);
    }
  });

  const result = await hydrateRule(db, bookId, ruleId);

  if (!result) {
    throw new RecurringRuleNotFoundError();
  }

  return result;
}

/** DELETE /b/[bookId]/recurring/[id]. Template splits go by ON DELETE cascade. */
export async function deleteRecurringRule(
  db: AppDb,
  bookId: number,
  ruleId: number
): Promise<void> {
  const deleted = await db
    .delete(recurringRules)
    .where(and(eq(recurringRules.id, ruleId), eq(recurringRules.bookId, bookId)))
    .returning();

  if (deleted.length === 0) {
    throw new RecurringRuleNotFoundError();
  }
}
