import { NextResponse } from "next/server";
import { authenticateBookRequest, isError } from "@/lib/api-auth";
import { getPendingCount } from "@/lib/plaid-tokens";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ bookId: string }> }
) {
  try {
    const { bookId } = await params;
    const auth = await authenticateBookRequest(bookId);
    if (isError(auth)) return auth.error;
    const { db, bookId: numericBookId } = auth;

    return NextResponse.json({ count: await getPendingCount(db, numericBookId) });
  } catch (error) {
    console.error("Error fetching sync pending count:", error);
    return NextResponse.json({ error: "Failed to fetch pending count" }, { status: 500 });
  }
}
