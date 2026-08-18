import { NextResponse } from "next/server";
import { authenticateBookRequest, isError } from "@/lib/api-auth";
import { plaidTokens } from "@/db/schema";
import { and, asc, eq } from "drizzle-orm";
import { createTokenSchema } from "@/lib/schemas/sync";

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

export async function GET(
  request: Request,
  { params }: { params: Promise<{ bookId: string }> }
) {
  try {
    const { bookId } = await params;
    const auth = await authenticateBookRequest(bookId);
    if (isError(auth)) return auth.error;
    const { db, bookId: numericBookId } = auth;

    const tokens = await db
      .select()
      .from(plaidTokens)
      .where(eq(plaidTokens.bookId, numericBookId))
      .orderBy(asc(plaidTokens.financialInstitution), asc(plaidTokens.itemId));

    return NextResponse.json(tokens.map(toTokenListItem));
  } catch (error) {
    console.error("Error fetching sync tokens:", error);
    return NextResponse.json(
      { error: "Failed to fetch sync tokens" },
      { status: 500 }
    );
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ bookId: string }> }
) {
  try {
    const { bookId } = await params;
    const auth = await authenticateBookRequest(bookId);
    if (isError(auth)) return auth.error;
    const { db, bookId: numericBookId } = auth;

    const parsed = createTokenSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
    }
    const { financialInstitution, itemId, accessToken } = parsed.data;

    const existing = await db
      .select({ id: plaidTokens.id })
      .from(plaidTokens)
      .where(and(eq(plaidTokens.bookId, numericBookId), eq(plaidTokens.itemId, itemId)))
      .limit(1);

    if (existing.length > 0) {
      return NextResponse.json(
        { error: "A token with this itemId already exists" },
        { status: 409 }
      );
    }

    const [inserted] = await db
      .insert(plaidTokens)
      .values({
        financialInstitution,
        itemId,
        accessToken,
        bookId: numericBookId,
      })
      .returning();

    return NextResponse.json(toTokenListItem(inserted));
  } catch (error) {
    console.error("Error creating sync token:", error);
    return NextResponse.json(
      { error: "Failed to create sync token" },
      { status: 500 }
    );
  }
}
