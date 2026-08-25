import { NextResponse } from "next/server";
import { authenticateBookRequest, isError } from "@/lib/api-auth";
import { pendingTransactionsQuery } from "@/lib/schemas/sync";
import { listPendingPlaidTransactions } from "@/lib/plaid-transactions";

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
    const parsedQuery = pendingTransactionsQuery.safeParse({
      accountId: searchParams.get("accountId") || undefined,
    });
    if (!parsedQuery.success) {
      return NextResponse.json({ error: parsedQuery.error.issues[0].message }, { status: 400 });
    }

    const pending = await listPendingPlaidTransactions(db, numericBookId, parsedQuery.data);

    return NextResponse.json(pending);
  } catch (error) {
    console.error("Error fetching pending Plaid transactions:", error);
    return NextResponse.json(
      { error: "Failed to fetch pending Plaid transactions" },
      { status: 500 }
    );
  }
}
