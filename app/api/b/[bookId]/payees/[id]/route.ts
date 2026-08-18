import { NextResponse } from "next/server";
import { authenticateBookRequest, isError } from "@/lib/api-auth";
import { payees, transactions } from "@/db/schema";
import { and, eq, sql, count } from "drizzle-orm";

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

    const payeeRows = await db
      .select({
        id: payees.id,
        name: payees.name,
        createdAt: payees.createdAt,
        transactionCount: sql<number>`cast(count(${transactions.id}) as integer)`.as(
          "transactionCount"
        ),
      })
      .from(payees)
      .leftJoin(transactions, eq(transactions.payeeId, payees.id))
      .where(and(eq(payees.id, payeeId), eq(payees.bookId, numericBookId)))
      .groupBy(payees.id);

    if (payeeRows.length === 0) {
      return NextResponse.json({ error: "Payee not found" }, { status: 404 });
    }

    return NextResponse.json(payeeRows[0]);
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

    const payeeRows = await db
      .select({ id: payees.id })
      .from(payees)
      .where(and(eq(payees.id, payeeId), eq(payees.bookId, numericBookId)));

    if (payeeRows.length === 0) {
      return NextResponse.json({ error: "Payee not found" }, { status: 404 });
    }

    const [{ txCount }] = await db
      .select({ txCount: count(transactions.id) })
      .from(transactions)
      .where(eq(transactions.payeeId, payeeId));

    if (txCount > 0) {
      return NextResponse.json(
        { error: "Cannot delete a payee that has associated transactions" },
        { status: 409 }
      );
    }

    await db
      .delete(payees)
      .where(and(eq(payees.id, payeeId), eq(payees.bookId, numericBookId)));

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error deleting payee:", error);
    return NextResponse.json({ error: "Failed to delete payee" }, { status: 500 });
  }
}
