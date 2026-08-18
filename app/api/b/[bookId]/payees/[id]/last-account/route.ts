import { NextResponse } from "next/server";
import { authenticateBookRequest, isError } from "@/lib/api-auth";
import { transactions, transactionSplits } from "@/db/schema";
import { eq, desc, gt, and } from "drizzle-orm";
import { effectiveDateSql } from "@/lib/accounting";

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

    // Find the most recent transaction for this payee
    const [lastTxn] = await db
      .select({ id: transactions.id })
      .from(transactions)
      .where(and(eq(transactions.payeeId, payeeId), eq(transactions.bookId, numericBookId)))
      .orderBy(desc(effectiveDateSql), desc(transactions.id))
      .limit(1);

    if (!lastTxn) {
      return NextResponse.json({ accountId: null });
    }

    // Get the debit split (positive amount) with the largest amount — that's the "To Account"
    const [debitSplit] = await db
      .select({ accountId: transactionSplits.accountId })
      .from(transactionSplits)
      .where(
        and(
          eq(transactionSplits.transactionId, lastTxn.id),
          gt(transactionSplits.amount, 0)
        )
      )
      .orderBy(desc(transactionSplits.amount))
      .limit(1);

    return NextResponse.json({ accountId: debitSplit?.accountId ?? null });
  } catch (error) {
    console.error("Error fetching last account for payee:", error);
    return NextResponse.json(
      { error: "Failed to fetch last account" },
      { status: 500 }
    );
  }
}
