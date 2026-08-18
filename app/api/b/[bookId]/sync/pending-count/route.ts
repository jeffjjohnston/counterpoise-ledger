import { NextResponse } from "next/server";
import { authenticateBookRequest, isError } from "@/lib/api-auth";
import { plaidAccounts, plaidTransactionReconciliation } from "@/db/schema";
import { and, eq, isNotNull, isNull, or, sql } from "drizzle-orm";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ bookId: string }> }
) {
  try {
    const { bookId } = await params;
    const auth = await authenticateBookRequest(bookId);
    if (isError(auth)) return auth.error;
    const { db, bookId: numericBookId } = auth;

    const rows = await db
      .select({
        count: sql<number>`cast(count(*) as integer)`.as("count"),
      })
      .from(plaidTransactionReconciliation)
      .innerJoin(
        plaidAccounts,
        eq(plaidTransactionReconciliation.plaidAccountLinkId, plaidAccounts.id)
      )
      .where(
        and(
          eq(plaidTransactionReconciliation.bookId, numericBookId),
          isNotNull(plaidAccounts.counterpoiseAccountId),
          or(
            and(
              eq(plaidTransactionReconciliation.resolutionStatus, "pending"),
              isNull(plaidTransactionReconciliation.reviewReason)
            ),
            isNotNull(plaidTransactionReconciliation.reviewReason)
          )
        )
      );

    return NextResponse.json({ count: rows[0]?.count ?? 0 });
  } catch (error) {
    console.error("Error fetching sync pending count:", error);
    return NextResponse.json({ error: "Failed to fetch pending count" }, { status: 500 });
  }
}
