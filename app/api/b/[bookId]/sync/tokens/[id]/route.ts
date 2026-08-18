import { NextResponse } from "next/server";
import { authenticateBookRequest, isError } from "@/lib/api-auth";
import { plaidTokens } from "@/db/schema";
import { and, eq, ne } from "drizzle-orm";
import { updateTokenSchema } from "@/lib/schemas/sync";

const maskAccessToken = (accessToken: string): string => {
  if (accessToken.length <= 8) {
    return "*".repeat(accessToken.length);
  }

  const prefix = accessToken.slice(0, 4);
  const suffix = accessToken.slice(-4);
  const middle = "*".repeat(Math.max(8, accessToken.length - 8));
  return `${prefix}${middle}${suffix}`;
};

const toTokenListItem = (token: typeof plaidTokens.$inferSelect) => ({
  id: token.id,
  financialInstitution: token.financialInstitution,
  itemId: token.itemId,
  accessTokenMasked: maskAccessToken(token.accessToken),
  createdAt: token.createdAt,
  updatedAt: token.updatedAt,
});

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ bookId: string; id: string }> }
) {
  try {
    const { bookId, id } = await params;
    const auth = await authenticateBookRequest(bookId);
    if (isError(auth)) return auth.error;
    const { db, bookId: numericBookId } = auth;

    const tokenId = Number.parseInt(id, 10);

    if (!Number.isFinite(tokenId)) {
      return NextResponse.json({ error: "Invalid token id" }, { status: 400 });
    }

    const existingTokenRows = await db
      .select()
      .from(plaidTokens)
      .where(and(eq(plaidTokens.id, tokenId), eq(plaidTokens.bookId, numericBookId)))
      .limit(1);

    if (existingTokenRows.length === 0) {
      return NextResponse.json({ error: "Token not found" }, { status: 404 });
    }

    const parsed = updateTokenSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
    }
    const { financialInstitution, itemId, accessToken } = parsed.data;

    const duplicateItemRows = await db
      .select({ id: plaidTokens.id })
      .from(plaidTokens)
      .where(and(eq(plaidTokens.bookId, numericBookId), eq(plaidTokens.itemId, itemId), ne(plaidTokens.id, tokenId)))
      .limit(1);

    if (duplicateItemRows.length > 0) {
      return NextResponse.json(
        { error: "A token with this itemId already exists" },
        { status: 409 }
      );
    }

    const [updatedToken] = await db
      .update(plaidTokens)
      .set({
        financialInstitution,
        itemId,
        ...(accessToken ? { accessToken } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(plaidTokens.id, tokenId), eq(plaidTokens.bookId, numericBookId)))
      .returning();

    return NextResponse.json(toTokenListItem(updatedToken));
  } catch (error) {
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

    const tokenId = Number.parseInt(id, 10);

    if (!Number.isFinite(tokenId)) {
      return NextResponse.json({ error: "Invalid token id" }, { status: 400 });
    }

    const deleted = await db.delete(plaidTokens).where(and(eq(plaidTokens.id, tokenId), eq(plaidTokens.bookId, numericBookId))).returning();

    if (deleted.length === 0) {
      return NextResponse.json({ error: "Token not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error deleting sync token:", error);
    return NextResponse.json(
      { error: "Failed to delete sync token" },
      { status: 500 }
    );
  }
}
