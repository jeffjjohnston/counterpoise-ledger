import { NextResponse } from "next/server";
import { authenticateBookRequest, isError } from "@/lib/api-auth";
import { getStaleUnmatched } from "@/lib/plaid-tokens";

/**
 * Finds manually entered transactions on Plaid-synced accounts that no bank
 * transaction has matched — the local entry is either a mistake or its
 * posting is unusually delayed, so the user should take a look.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ bookId: string }> }
) {
  try {
    const { bookId } = await params;
    const auth = await authenticateBookRequest(bookId);
    if (isError(auth)) return auth.error;
    const { db, bookId: numericBookId } = auth;

    return NextResponse.json(await getStaleUnmatched(db, numericBookId));
  } catch (error) {
    console.error("Error fetching stale unmatched transactions:", error);
    return NextResponse.json(
      { error: "Failed to fetch stale unmatched transactions" },
      { status: 500 }
    );
  }
}
