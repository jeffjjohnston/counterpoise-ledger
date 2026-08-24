import { NextResponse } from "next/server";
import { authenticateBookRequest, isError } from "@/lib/api-auth";
import { getProjectedTransactions } from "@/lib/recurring-rules";
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

    const projected = await getProjectedTransactions(db, numericBookId, {
      startDate: parsedQuery.data.startDate,
      endDate: parsedQuery.data.endDate,
      accountId: parsedQuery.data.accountId,
      upcomingDays: book.upcomingDays ?? 30,
    });

    return NextResponse.json(projected);
  } catch (error) {
    console.error("Error fetching projected recurring transactions:", error);
    return NextResponse.json(
      { error: "Failed to fetch projected recurring transactions" },
      { status: 500 }
    );
  }
}

