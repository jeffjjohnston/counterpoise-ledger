import { authenticateBookRequest, isError } from "@/lib/api-auth";
import { getTransactionPlaidLink } from "@/lib/plaid-transactions";

export async function GET(
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
      return Response.json(null);
    }

    return Response.json(await getTransactionPlaidLink(db, numericBookId, transactionId));
  } catch (error) {
    console.error("Error fetching Plaid link:", error);
    return Response.json({ error: "Failed to fetch Plaid link" }, { status: 500 });
  }
}
