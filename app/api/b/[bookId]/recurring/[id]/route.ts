import { NextResponse } from "next/server";
import { authenticateBookRequest, isError } from "@/lib/api-auth";
import { accounts, payees, recurringRules, recurringTemplateSplits, transactions } from "@/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { advanceNextDateToFuture, getInitialNextDate, validateSplits } from "@/lib/accounting";
import { normalizePayeeName } from "@/lib/payees";
import { addDaysToDateString } from "@/lib/recurring";
import { type AppDb } from "@/db";
import { updateRuleSchema, type TemplateSplitInput } from "@/lib/schemas/recurring";

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
  let fallbackPayeeId =
    typeof payeeId === "number" && Number.isFinite(payeeId) ? payeeId : null;

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

export async function GET(
  request: Request,
  { params }: { params: Promise<{ bookId: string; id: string }> }
) {
  try {
    const { bookId, id } = await params;
    const auth = await authenticateBookRequest(bookId);
    if (isError(auth)) return auth.error;
    const { db, bookId: numericBookId } = auth;

    const ruleId = parseInt(id);

    const rule = await db.query.recurringRules.findFirst({
      where: and(eq(recurringRules.id, ruleId), eq(recurringRules.bookId, numericBookId)),
      with: {
        payee: true,
        templateSplits: {
          with: {
            account: true,
          },
        },
      },
    });

    if (!rule) {
      return NextResponse.json(
        { error: "Recurring rule not found" },
        { status: 404 }
      );
    }

    return NextResponse.json(rule);
  } catch (error) {
    console.error("Error fetching recurring rule:", error);
    return NextResponse.json(
      { error: "Failed to fetch recurring rule" },
      { status: 500 }
    );
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ bookId: string; id: string }> }
) {
  try {
    const { bookId, id } = await params;
    const auth = await authenticateBookRequest(bookId);
    if (isError(auth)) return auth.error;
    const { db, bookId: numericBookId } = auth;

    const ruleId = parseInt(id);
    const parsed = updateRuleSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
    }
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
      payeeId,
      payeeName,
    } = parsed.data;

    if (templateSplits && !validateSplits(templateSplits)) {
      return NextResponse.json(
        { error: "Template splits must sum to zero (debits = credits)" },
        { status: 400 }
      );
    }

    // Fetch existing rule for endDate validation and nextDate recomputation
    const scheduleChanged =
      frequency !== undefined || interval !== undefined || daysOfWeek !== undefined ||
      weekOfMonth !== undefined || daysOfMonth !== undefined || startDate !== undefined;
    const needsExisting = (endDate !== undefined && endDate !== null) || (scheduleChanged && nextDate === undefined);
    const existing = needsExisting
      ? await db.query.recurringRules.findFirst({
          where: and(eq(recurringRules.id, ruleId), eq(recurringRules.bookId, numericBookId)),
        })
      : undefined;

    // Validate endDate against effective startDate
    if (endDate !== undefined && endDate !== null) {
      const effStartDate = startDate ?? existing?.startDate;
      if (effStartDate && endDate < effStartDate) {
        return NextResponse.json(
          { error: "endDate cannot be earlier than startDate" },
          { status: 400 }
        );
      }
    }

    const resolvedPayeeId =
      payeeId !== undefined || payeeName !== undefined
        ? await resolvePayeeId({
            db,
            payeeName,
            payeeId,
            bookId: numericBookId,
          })
        : undefined;

    if (templateSplits) {
      const hasValidTemplateAccounts = await validateTemplateSplitAccounts(
        db,
        numericBookId,
        templateSplits
      );
      if (!hasValidTemplateAccounts) {
        return NextResponse.json(
          { error: "One or more template split accounts do not belong to this book" },
          { status: 400 }
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

      const recurrenceConfig = {
        frequency: effFrequency,
        interval: effInterval,
        daysOfWeek: effDaysOfWeek,
        weekOfMonth: effWeekOfMonth,
        daysOfMonth: effDaysOfMonth,
      };
      computedNextDate = advanceNextDateToFuture(
        getInitialNextDate(effStartDate, recurrenceConfig),
        recurrenceConfig
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
            eq(transactions.bookId, numericBookId)
          )
        );
      const lastCreatedDate = lastCreated?.maxDate ?? null;
      if (lastCreatedDate) {
        computedNextDate = advanceNextDateToFuture(
          computedNextDate,
          recurrenceConfig,
          addDaysToDateString(lastCreatedDate, 1)
        );
      }
    }

    await db.transaction(async (tx) => {
      await tx
        .update(recurringRules)
        .set({
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
          // this field was untyped `any`. The cast preserves that exact
          // pre-existing behavior (a literal `{ nextDate: null }` body still
          // reaches Postgres and fails there, same as before this change)
          // rather than papering over it with new validation this task
          // wasn't scoped to add.
          ...(nextDate !== undefined && { nextDate: nextDate as string }),
          ...(computedNextDate !== undefined && { nextDate: computedNextDate }),
          ...(templateDescription !== undefined && { templateDescription }),
          ...(resolvedPayeeId !== undefined && { payeeId: resolvedPayeeId }),
          ...(isActive !== undefined && { isActive }),
          ...(autoCreateDaysBefore !== undefined && {
            autoCreateDaysBefore,
          }),
        })
        .where(and(eq(recurringRules.id, ruleId), eq(recurringRules.bookId, numericBookId)));

      if (templateSplits && templateSplits.length >= 2) {
        await tx
          .delete(recurringTemplateSplits)
          .where(and(eq(recurringTemplateSplits.recurringRuleId, ruleId), eq(recurringTemplateSplits.bookId, numericBookId)));

        const splitValues = templateSplits.map(
          (split: TemplateSplitInput) => ({
            recurringRuleId: ruleId,
            accountId: split.accountId,
            amount: split.amount,
            bookId: numericBookId,
          })
        );

        await tx.insert(recurringTemplateSplits).values(splitValues);
      }
    });

    const result = await db.query.recurringRules.findFirst({
      where: and(eq(recurringRules.id, ruleId), eq(recurringRules.bookId, numericBookId)),
      with: {
        payee: true,
        templateSplits: {
          with: {
            account: true,
          },
        },
      },
    });

    if (!result) {
      return NextResponse.json(
        { error: "Recurring rule not found" },
        { status: 404 }
      );
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error("Error updating recurring rule:", error);
    return NextResponse.json(
      { error: "Failed to update recurring rule" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ bookId: string; id: string }> }
) {
  try {
    const { bookId, id } = await params;
    const auth = await authenticateBookRequest(bookId);
    if (isError(auth)) return auth.error;
    const { db, bookId: numericBookId } = auth;

    const ruleId = parseInt(id);

    const deleted = await db
      .delete(recurringRules)
      .where(and(eq(recurringRules.id, ruleId), eq(recurringRules.bookId, numericBookId)))
      .returning();

    if (deleted.length === 0) {
      return NextResponse.json(
        { error: "Recurring rule not found" },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error deleting recurring rule:", error);
    return NextResponse.json(
      { error: "Failed to delete recurring rule" },
      { status: 500 }
    );
  }
}
