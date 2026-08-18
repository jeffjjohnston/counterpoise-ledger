import { NextResponse } from "next/server";
import { authenticateBookRequest, isError } from "@/lib/api-auth";
import { captureEvent } from "@/lib/posthog-server";
import { getRealizedGains } from "@/lib/realized-gains";
import { realizedGainsQuery } from "@/lib/schemas/reports";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ bookId: string }> }
) {
  try {
    const { bookId } = await params;
    const auth = await authenticateBookRequest(bookId);
    if (isError(auth)) return auth.error;
    const { db, bookId: numericBookId, userId } = auth;

    const { searchParams } = new URL(request.url);
    const parsedQuery = realizedGainsQuery.safeParse({
      startDate: searchParams.get("startDate") || undefined,
      endDate: searchParams.get("endDate") || undefined,
      accountId: searchParams.get("accountId") || undefined,
    });
    if (!parsedQuery.success) {
      return NextResponse.json(
        { error: parsedQuery.error.issues[0].message },
        { status: 400 }
      );
    }
    const { startDate, endDate, accountId: accountIdParam } = parsedQuery.data;
    const accountId = accountIdParam !== undefined ? Number(accountIdParam) : undefined;

    const result = await getRealizedGains(db, numericBookId, { startDate, endDate, accountId });

    captureEvent(userId, "report_generated", {
      bookId: numericBookId,
      reportType: "realized_gains",
    });

    return NextResponse.json(result);
  } catch (error) {
    console.error("Error generating realized gains report:", error);
    return NextResponse.json(
      { error: "Failed to generate realized gains report" },
      { status: 500 }
    );
  }
}
