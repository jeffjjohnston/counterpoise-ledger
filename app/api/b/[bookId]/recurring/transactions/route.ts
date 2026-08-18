import { NextResponse } from "next/server";
import { authenticateBookRequest, isError } from "@/lib/api-auth";
import { transactions, recurringRules } from "@/db/schema";
import { eq, and, gte, lte, isNotNull } from "drizzle-orm";
import { effectiveDateSql } from "@/lib/accounting";
import { recurringTransactionsQuery } from "@/lib/schemas/recurring";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ bookId: string }> }
) {
  try {
    const { searchParams } = new URL(request.url);
    const parsedQuery = recurringTransactionsQuery.safeParse({
      startDate: searchParams.get("startDate") || undefined,
      endDate: searchParams.get("endDate") || undefined,
    });
    if (!parsedQuery.success) {
      return NextResponse.json({ error: parsedQuery.error.issues[0].message }, { status: 400 });
    }
    const { startDate, endDate } = parsedQuery.data;

    const { bookId } = await params;
    const auth = await authenticateBookRequest(bookId);
    if (isError(auth)) return auth.error;
    const { db, bookId: numericBookId } = auth;

    const results = await db
      .select({
        transactionId: transactions.id,
        date: effectiveDateSql.as("date"),
        recurringRuleId: transactions.recurringRuleId,
        ruleName: recurringRules.name,
      })
      .from(transactions)
      .innerJoin(
        recurringRules,
        eq(transactions.recurringRuleId, recurringRules.id)
      )
      .where(
        and(
          eq(transactions.bookId, numericBookId),
          isNotNull(transactions.recurringRuleId),
          gte(effectiveDateSql, startDate),
          lte(effectiveDateSql, endDate)
        )
      );

    return NextResponse.json(results);
  } catch (error) {
    console.error("Error fetching recurring transactions:", error);
    return NextResponse.json(
      { error: "Failed to fetch recurring transactions" },
      { status: 500 }
    );
  }
}
