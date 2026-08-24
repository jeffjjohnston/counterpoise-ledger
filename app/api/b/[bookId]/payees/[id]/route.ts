import { NextResponse } from "next/server";
import { authenticateBookRequest, isError } from "@/lib/api-auth";
import { deletePayee, getPayee, PayeeNotFoundError, PayeeValidationError } from "@/lib/payees";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ bookId: string; id: string }> }
) {
  try {
    const { bookId, id } = await params;
    const auth = await authenticateBookRequest(bookId);
    if (isError(auth)) return auth.error;
    const { db, bookId: numericBookId } = auth;

    if (!/^\d+$/.test(id)) {
      return NextResponse.json({ error: "Invalid payee id" }, { status: 400 });
    }
    const payeeId = parseInt(id, 10);

    const payee = await getPayee(db, numericBookId, payeeId);

    if (!payee) {
      return NextResponse.json({ error: "Payee not found" }, { status: 404 });
    }

    return NextResponse.json(payee);
  } catch (error) {
    console.error("Error fetching payee:", error);
    return NextResponse.json({ error: "Failed to fetch payee" }, { status: 500 });
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ bookId: string; id: string }> }
) {
  try {
    const { bookId, id } = await params;
    const auth = await authenticateBookRequest(bookId);
    if (isError(auth)) return auth.error;
    const { db, bookId: numericBookId } = auth;

    if (!/^\d+$/.test(id)) {
      return NextResponse.json({ error: "Invalid payee id" }, { status: 400 });
    }
    const payeeId = parseInt(id, 10);

    await deletePayee(db, numericBookId, payeeId);

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof PayeeNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof PayeeValidationError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error("Error deleting payee:", error);
    return NextResponse.json({ error: "Failed to delete payee" }, { status: 500 });
  }
}
