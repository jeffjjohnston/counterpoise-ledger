import { NextResponse } from "next/server";
import { authenticateBookRequest, isError } from "@/lib/api-auth";
import { listPricesDue } from "@/lib/security-prices";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ bookId: string }> }
) {
  try {
    const { bookId } = await params;
    const auth = await authenticateBookRequest(bookId);
    if (isError(auth)) return auth.error;
    const { db, bookId: numericBookId } = auth;

    return NextResponse.json(await listPricesDue(db, numericBookId));
  } catch (error) {
    console.error("Error fetching prices due:", error);
    return NextResponse.json(
      { error: "Failed to fetch securities needing prices" },
      { status: 500 }
    );
  }
}
