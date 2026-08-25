import { authenticateBookRequest, isError } from "@/lib/api-auth";
import { PlaidLinkNotFoundError, unlinkPlaidTransaction } from "@/lib/plaid-transactions";
import { captureEvent } from "@/lib/posthog-server";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ bookId: string; id: string }> }
) {
  try {
    const { bookId, id } = await params;
    const auth = await authenticateBookRequest(bookId);
    if (isError(auth)) return auth.error;
    const { db, bookId: numericBookId } = auth;

    const transactionId = parseInt(id, 10);
    if (isNaN(transactionId)) {
      return Response.json({ error: "Invalid transaction ID" }, { status: 400 });
    }

    await unlinkPlaidTransaction(db, numericBookId, transactionId);

    captureEvent(auth.userId, "sync_transaction_unlinked", {
      bookId: numericBookId,
    });

    return Response.json({ success: true });
  } catch (error) {
    if (error instanceof PlaidLinkNotFoundError) {
      return Response.json({ error: "No Plaid link found" }, { status: 404 });
    }
    console.error("Error unlinking from Plaid:", error);
    return Response.json({ error: "Failed to unlink from Plaid" }, { status: 500 });
  }
}
