import { eq, and } from "drizzle-orm";
import { authenticateBookRequest, isError } from "@/lib/api-auth";
import { plaidTransactionReconciliation } from "@/db/schema";
import { captureEvent } from "@/lib/posthog-server";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ bookId: string; id: string }> }
) {
  try {
    const { bookId, id } = await params;
    const auth = await authenticateBookRequest(bookId);
    if (isError(auth)) return auth.error;
    const { db } = auth;

    const numericBookId = parseInt(bookId, 10);
    const transactionId = parseInt(id, 10);
    if (isNaN(transactionId)) {
      return Response.json({ error: "Invalid transaction ID" }, { status: 400 });
    }

    const rows = await db
      .select({ id: plaidTransactionReconciliation.id })
      .from(plaidTransactionReconciliation)
      .where(
        and(
          eq(plaidTransactionReconciliation.matchedTransactionId, transactionId),
          eq(plaidTransactionReconciliation.bookId, numericBookId)
        )
      );

    if (rows.length === 0) {
      return Response.json({ error: "No Plaid link found" }, { status: 404 });
    }

    for (const row of rows) {
      await db
        .update(plaidTransactionReconciliation)
        .set({
          resolutionStatus: "pending",
          matchedTransactionId: null,
          reviewReason: null,
          reviewMetadataJson: null,
          resolvedAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(plaidTransactionReconciliation.id, row.id),
            eq(plaidTransactionReconciliation.bookId, numericBookId)
          )
        );
    }

    captureEvent(auth.userId, "sync_transaction_unlinked", {
      bookId: numericBookId,
    });

    return Response.json({ success: true });
  } catch (error) {
    console.error("Error unlinking from Plaid:", error);
    return Response.json({ error: "Failed to unlink from Plaid" }, { status: 500 });
  }
}
