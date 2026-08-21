import { NextResponse } from "next/server";
import { authenticateBookRequest, isError } from "@/lib/api-auth";
import { recurringRules } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { getNextDate } from "@/lib/accounting";
import { toDateString } from "@/lib/formatters";
import { getOccurrenceDate } from "@/lib/recurring";
import type { TransactionWithSplits } from "@/types";
import { projectedQuery } from "@/lib/schemas/recurring";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ bookId: string }> }
) {
  try {
    const { bookId } = await params;
    const auth = await authenticateBookRequest(bookId);
    if (isError(auth)) return auth.error;
    const { db, bookId: numericBookId, book } = auth;

    const { searchParams } = new URL(request.url);
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const upcomingDays = book.upcomingDays ?? 30;

    const defaultEnd = new Date(today);
    defaultEnd.setDate(defaultEnd.getDate() + upcomingDays);

    // All three params were read behind truthiness checks (`... || default`,
    // `param ? parseInt(...) : null`), so absent/empty values map to
    // `undefined` with `||`, not `??` — see lib/schemas/recurring.ts's
    // projectedQuery comment.
    const parsedQuery = projectedQuery.safeParse({
      startDate: searchParams.get("startDate") || undefined,
      endDate: searchParams.get("endDate") || undefined,
      accountId: searchParams.get("accountId") || undefined,
    });
    if (!parsedQuery.success) {
      return NextResponse.json({ error: parsedQuery.error.issues[0].message }, { status: 400 });
    }

    const startDate = parsedQuery.data.startDate ?? toDateString(tomorrow);
    const endDate = parsedQuery.data.endDate ?? toDateString(defaultEnd);
    const filterAccountId = parsedQuery.data.accountId ?? null;

    const rules = await db.query.recurringRules.findMany({
      where: and(eq(recurringRules.bookId, numericBookId), eq(recurringRules.isActive, true)),
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

      // Parse rule's recurrence config
      const config = {
        frequency: rule.frequency,
        interval: rule.interval,
        daysOfWeek: rule.daysOfWeek
          ? JSON.parse(rule.daysOfWeek)
          : undefined,
        weekOfMonth: rule.weekOfMonth ?? undefined,
        daysOfMonth: rule.daysOfMonth
          ? JSON.parse(rule.daysOfMonth)
          : undefined,
      };

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
            bookId: numericBookId,
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
              bookId: numericBookId,
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

    return NextResponse.json(projected);
  } catch (error) {
    console.error("Error fetching projected recurring transactions:", error);
    return NextResponse.json(
      { error: "Failed to fetch projected recurring transactions" },
      { status: 500 }
    );
  }
}

