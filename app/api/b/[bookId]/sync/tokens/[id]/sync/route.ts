import { NextResponse } from "next/server";
import { authenticateBookRequest, isError } from "@/lib/api-auth";
import { clearSyncData, PlaidTokenNotFoundError } from "@/lib/plaid-tokens";
import { syncToken, SyncTokenError, isPlaidConfigurationError } from "@/lib/plaid-sync";

function parseTokenId(value: string): number | null {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ bookId: string; id: string }> }
) {
  try {
    const { bookId, id } = await params;
    const auth = await authenticateBookRequest(bookId);
    if (isError(auth)) return auth.error;
    const { db, bookId: numericBookId } = auth;

    const tokenId = parseTokenId(id);
    if (tokenId === null) {
      return NextResponse.json({ error: "Invalid token id" }, { status: 400 });
    }

    await clearSyncData(db, numericBookId, tokenId);

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof PlaidTokenNotFoundError) {
      return NextResponse.json({ error: "Token not found" }, { status: 404 });
    }
    console.error("Error resetting sync for token:", error);
    return NextResponse.json(
      { error: "Failed to reset sync" },
      { status: 500 }
    );
  }
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ bookId: string; id: string }> }
) {
  try {
    const { bookId, id } = await params;
    const auth = await authenticateBookRequest(bookId);
    if (isError(auth)) return auth.error;
    const { db, bookId: numericBookId } = auth;

    const tokenId = parseTokenId(id);
    if (tokenId === null) {
      return NextResponse.json({ error: "Invalid token id" }, { status: 400 });
    }

    const result = await syncToken(db, numericBookId, tokenId);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof SyncTokenError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    const message = error instanceof Error ? error.message : "Failed to sync token";
    const status = isPlaidConfigurationError(message) ? 500 : 502;
    console.error("Error syncing Plaid token:", error);
    return NextResponse.json({ error: message }, { status });
  }
}
