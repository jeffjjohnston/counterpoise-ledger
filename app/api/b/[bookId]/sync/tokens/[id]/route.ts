import { NextResponse } from "next/server";
import { authenticateBookRequest, isError } from "@/lib/api-auth";
import { updateTokenSchema } from "@/lib/schemas/sync";
import {
  deletePlaidToken,
  parseTokenId,
  PlaidTokenNotFoundError,
  PlaidTokenValidationError,
  updatePlaidToken,
} from "@/lib/plaid-tokens";

export async function PUT(
  request: Request,
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

    const parsed = updateTokenSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
    }

    const updatedToken = await updatePlaidToken(db, numericBookId, tokenId, parsed.data);
    return NextResponse.json(updatedToken);
  } catch (error) {
    if (error instanceof PlaidTokenNotFoundError) {
      return NextResponse.json({ error: "Token not found" }, { status: 404 });
    }
    if (error instanceof PlaidTokenValidationError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error("Error updating sync token:", error);
    return NextResponse.json(
      { error: "Failed to update sync token" },
      { status: 500 }
    );
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

    const tokenId = parseTokenId(id);

    if (tokenId === null) {
      return NextResponse.json({ error: "Invalid token id" }, { status: 400 });
    }

    await deletePlaidToken(db, numericBookId, tokenId);
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof PlaidTokenNotFoundError) {
      return NextResponse.json({ error: "Token not found" }, { status: 404 });
    }
    console.error("Error deleting sync token:", error);
    return NextResponse.json(
      { error: "Failed to delete sync token" },
      { status: 500 }
    );
  }
}
