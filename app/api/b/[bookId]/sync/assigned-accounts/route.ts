import { NextResponse } from "next/server";
import { authenticateBookRequest, isError } from "@/lib/api-auth";
import { getAssignedAccounts } from "@/lib/plaid-tokens";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ bookId: string }> }
) {
  try {
    const { bookId } = await params;
    const auth = await authenticateBookRequest(bookId);
    if (isError(auth)) return auth.error;
    const { db, bookId: numericBookId } = auth;

    return NextResponse.json(await getAssignedAccounts(db, numericBookId));
  } catch (error) {
    console.error("Error fetching assigned sync accounts:", error);
    return NextResponse.json(
      { error: "Failed to fetch assigned sync accounts" },
      { status: 500 }
    );
  }
}
