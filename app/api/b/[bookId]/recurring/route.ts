import { NextResponse } from "next/server";
import { authenticateBookRequest, isError } from "@/lib/api-auth";
import { accounts, payees, recurringRules, recurringTemplateSplits } from "@/db/schema";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { advanceNextDateToFuture, getInitialNextDate, validateSplits } from "@/lib/accounting";
import { normalizePayeeName } from "@/lib/payees";
import { getOccurrenceDate } from "@/lib/recurring";
import { captureEvent } from "@/lib/posthog-server";
import { type AppDb } from "@/db";
import { createRuleSchema, type TemplateSplitInput } from "@/lib/schemas/recurring";

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

export async function GET(
  request: Request,
  { params }: { params: Promise<{ bookId: string }> }
) {
  try {
    const { bookId } = await params;
    const auth = await authenticateBookRequest(bookId);
    if (isError(auth)) return auth.error;
    const { db, bookId: numericBookId } = auth;

    const rules = await db.query.recurringRules.findMany({
      where: eq(recurringRules.bookId, numericBookId),
      with: {
        payee: true,
        templateSplits: {
          with: {
            account: true,
          },
        },
      },
      orderBy: [desc(recurringRules.isActive), recurringRules.nextDate],
    });

    return NextResponse.json(rules);
  } catch (error) {
    console.error("Error fetching recurring rules:", error);
    return NextResponse.json(
      { error: "Failed to fetch recurring rules" },
      { status: 500 }
    );
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ bookId: string }> }
) {
  try {
    const { bookId } = await params;
    const auth = await authenticateBookRequest(bookId);
    if (isError(auth)) return auth.error;
    const { db, bookId: numericBookId } = auth;

    const parsed = createRuleSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
    }
    const {
      name, frequency, interval, daysOfWeek, weekOfMonth, daysOfMonth,
      startDate, endDate, templateDescription, templateSplits, autoCreateDaysBefore,
      businessDaysOnly,
      payeeId,
      payeeName,
    } = parsed.data;

    if (endDate && endDate < startDate) {
      return NextResponse.json(
        { error: "endDate cannot be earlier than startDate" },
        { status: 400 }
      );
    }

    if (!validateSplits(templateSplits)) {
      return NextResponse.json(
        { error: "Template splits must sum to zero (debits = credits)" },
        { status: 400 }
      );
    }

    const parsedAutoCreateDaysBefore = autoCreateDaysBefore ?? 0;

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

    const resolvedPayeeId = await resolvePayeeId({
      db,
      payeeName,
      payeeId,
      bookId: numericBookId,
    });

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
          bookId: numericBookId,
        })
        .returning();

      const splitValues = templateSplits.map(
        (split: TemplateSplitInput) => ({
          recurringRuleId: rule.id,
          accountId: split.accountId,
          amount: split.amount,
          bookId: numericBookId,
        })
      );

      await tx.insert(recurringTemplateSplits).values(splitValues);

      return rule;
    });

    const result = await db.query.recurringRules.findFirst({
      where: (rules, { eq }) => eq(rules.id, newRule.id),
      with: {
        payee: true,
        templateSplits: {
          with: {
            account: true,
          },
        },
      },
    });

    captureEvent(auth.userId, "recurring_rule_created", { bookId: numericBookId });

    return NextResponse.json(result);
  } catch (error) {
    console.error("Error creating recurring rule:", error);
    return NextResponse.json(
      { error: "Failed to create recurring rule" },
      { status: 500 }
    );
  }
}
