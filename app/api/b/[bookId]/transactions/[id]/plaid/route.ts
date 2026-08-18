import { eq, and } from "drizzle-orm";
import { authenticateBookRequest, isError } from "@/lib/api-auth";
import { plaidTransactionReconciliation } from "@/db/schema";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ bookId: string; id: string }> }
) {
  try {
    const { bookId, id } = await params;
    const auth = await authenticateBookRequest(bookId);
    if (isError(auth)) return auth.error;
    const { db } = auth;

    const transactionId = parseInt(id, 10);
    if (isNaN(transactionId)) {
      return Response.json(null);
    }

    const [row] = await db
      .select({
        id: plaidTransactionReconciliation.id,
        plaidTransactionId: plaidTransactionReconciliation.plaidTransactionId,
        date: plaidTransactionReconciliation.date,
        authorizedDate: plaidTransactionReconciliation.authorizedDate,
        amountCents: plaidTransactionReconciliation.amountCents,
        name: plaidTransactionReconciliation.name,
        merchantName: plaidTransactionReconciliation.merchantName,
        originalDescription: plaidTransactionReconciliation.originalDescription,
        pending: plaidTransactionReconciliation.pending,
        isoCurrencyCode: plaidTransactionReconciliation.isoCurrencyCode,
        categoryPrimary: plaidTransactionReconciliation.categoryPrimary,
        categoryDetailed: plaidTransactionReconciliation.categoryDetailed,
        rawJson: plaidTransactionReconciliation.rawJson,
      })
      .from(plaidTransactionReconciliation)
      .where(
        and(
          eq(plaidTransactionReconciliation.matchedTransactionId, transactionId),
          eq(plaidTransactionReconciliation.bookId, parseInt(bookId, 10))
        )
      )
      .limit(1);

    return Response.json(row ?? null);
  } catch (error) {
    console.error("Error fetching Plaid link:", error);
    return Response.json({ error: "Failed to fetch Plaid link" }, { status: 500 });
  }
}
