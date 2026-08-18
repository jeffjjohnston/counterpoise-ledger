import { NextResponse } from "next/server";
import { authenticateBookRequest, isError } from "@/lib/api-auth";
import { getMarketValuesByAccount } from "@/lib/investments";
import { accountValuesQuery } from "@/lib/schemas/investments";

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
    const parsedQuery = accountValuesQuery.safeParse({
      asOfDate: searchParams.get("asOfDate") || undefined,
    });
    if (!parsedQuery.success) {
      return NextResponse.json(
        { error: parsedQuery.error.issues[0].message },
        { status: 400 }
      );
    }

    const values = await getMarketValuesByAccount(db, numericBookId, parsedQuery.data.asOfDate);
    return NextResponse.json(values);
  } catch (error) {
    console.error("Error fetching account market values:", error);
    return NextResponse.json(
      { error: "Failed to fetch account market values" },
      { status: 500 }
    );
  }
}
