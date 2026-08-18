import { authenticateBookRequest, isError } from "@/lib/api-auth";
import { captureEvent } from "@/lib/posthog-server";
import { accounts } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getReportSplits } from "@/lib/reports-queries";
import { reportDataQuery } from "@/lib/schemas/reports";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ bookId: string }> },
) {
  try {
    const { bookId } = await params;
    const auth = await authenticateBookRequest(bookId);
    if (isError(auth)) return auth.error;
    const { db, bookId: numericBookId } = auth;

    const { searchParams } = new URL(request.url);
    const parsedQuery = reportDataQuery.safeParse({
      startDate: searchParams.get("startDate") || undefined,
      endDate: searchParams.get("endDate") || undefined,
      accountIds: searchParams.get("accountIds") || undefined,
      accountTypes: searchParams.get("accountTypes") || undefined,
    });
    if (!parsedQuery.success) {
      return Response.json(
        { error: parsedQuery.error.issues[0].message },
        { status: 400 },
      );
    }
    const { startDate, endDate, accountIds, accountTypes } = parsedQuery.data;

    const { splits: allSplits } = await getReportSplits(db, numericBookId, {
      startDate,
      endDate,
      accountIds,
      accountTypes,
    });

    // This endpoint has never returned `description`; keep its shape.
    const splits = allSplits.map((s) => ({
      splitId: s.splitId,
      transactionId: s.transactionId,
      date: s.date,
      amount: s.amount,
      accountId: s.accountId,
      accountName: s.accountName,
      accountType: s.accountType,
      accountParentId: s.accountParentId,
      payeeId: s.payeeId,
      payeeName: s.payeeName,
    }));

    const allAccounts = await db
      .select({
        id: accounts.id,
        name: accounts.name,
        type: accounts.type,
        parentId: accounts.parentId,
      })
      .from(accounts)
      .where(eq(accounts.bookId, numericBookId));

    captureEvent(auth.userId, "report_generated", {
      bookId: numericBookId,
      reportType: "balance-sheet",
    });

    return Response.json({ splits, accounts: allAccounts });
  } catch (error) {
    console.error("Error fetching report data:", error);
    return Response.json(
      { error: "Failed to fetch report data" },
      { status: 500 },
    );
  }
}
