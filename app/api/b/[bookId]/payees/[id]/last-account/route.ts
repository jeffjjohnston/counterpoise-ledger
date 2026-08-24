import { NextResponse } from "next/server";
import { authenticateBookRequest, isError } from "@/lib/api-auth";
import { getPayeeLastAccountId } from "@/lib/payees";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ bookId: string; id: string }> }
) {
  try {
    const { bookId, id } = await params;
    const auth = await authenticateBookRequest(bookId);
    if (isError(auth)) return auth.error;
    const { db, bookId: numericBookId } = auth;

    const payeeId = parseInt(id, 10);

    if (!Number.isFinite(payeeId)) {
      return NextResponse.json({ error: "Invalid payee id" }, { status: 400 });
    }

    // The debit split (positive amount) with the largest amount on this
    // payee's most recent transaction — the "To Account".
    return NextResponse.json({
      accountId: await getPayeeLastAccountId(db, numericBookId, payeeId),
    });
  } catch (error) {
    console.error("Error fetching last account for payee:", error);
    return NextResponse.json(
      { error: "Failed to fetch last account" },
      { status: 500 }
    );
  }
}
