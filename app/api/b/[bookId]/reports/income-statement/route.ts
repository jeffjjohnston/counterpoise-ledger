import { NextResponse } from "next/server";
import { authenticateBookRequest, isError } from "@/lib/api-auth";
import { captureEvent } from "@/lib/posthog-server";
import { getIncomeStatement } from "@/lib/reports-queries";
import { incomeStatementQuery } from "@/lib/schemas/reports";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ bookId: string }> }
) {
  try {
    const { bookId } = await params;
    const auth = await authenticateBookRequest(bookId);
    if (isError(auth)) return auth.error;
    const { db, bookId: numericBookId } = auth;

    const { searchParams } = new URL(request.url);
    const parsedQuery = incomeStatementQuery.safeParse({
      startDate: searchParams.get("startDate") || undefined,
      endDate: searchParams.get("endDate") || undefined,
      includeInactive: searchParams.get("includeInactive") ?? undefined,
    });
    if (!parsedQuery.success) {
      return NextResponse.json(
        { error: parsedQuery.error.issues[0].message },
        { status: 400 }
      );
    }
    const { startDate, endDate } = parsedQuery.data;
    const includeInactive = parsedQuery.data.includeInactive === "true";

    const rows = (
      await getIncomeStatement(db, numericBookId, {
        startDate,
        endDate,
        includeInactive,
      })
    ).map((row) => ({
      accountId: row.accountId,
      name: row.name,
      type: row.type,
      balance: row.balanceCents,
    }));

    const totals = rows.reduce(
      (acc, row) => {
        if (row.type === "income") {
          acc.income += row.balance;
        } else {
          acc.expense += row.balance;
        }
        return acc;
      },
      { income: 0, expense: 0 }
    );

    captureEvent(auth.userId, "report_generated", {
      bookId: numericBookId,
      reportType: "income-statement",
    });

    return NextResponse.json({ accounts: rows, totals });
  } catch (error) {
    console.error("Error fetching income statement:", error);
    return NextResponse.json(
      { error: "Failed to fetch income statement" },
      { status: 500 }
    );
  }
}
