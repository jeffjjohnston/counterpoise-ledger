import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { books } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { getDb, type AppDb } from "@/db";

type AuthSuccess = {
  db: AppDb;
  bookId: number;
  userId: number;
  book: typeof books.$inferSelect;
};

type AuthError = {
  error: NextResponse;
};

type AuthResult = AuthSuccess | AuthError;

function isError(result: AuthResult): result is AuthError {
  return "error" in result;
}

export { isError };

export async function authenticateRequest(): Promise<
  { userId: number } | { error: NextResponse }
> {
  const session = await getSession();
  if (!session) {
    return {
      error: NextResponse.json(
        { error: "Not authenticated" },
        { status: 401 }
      ),
    };
  }
  return { userId: session.userId };
}

export async function authenticateBookRequest(
  bookIdStr: string
): Promise<AuthResult> {
  const session = await getSession();
  if (!session) {
    return {
      error: NextResponse.json(
        { error: "Not authenticated" },
        { status: 401 }
      ),
    };
  }

  const bookId = parseInt(bookIdStr, 10);
  if (isNaN(bookId)) {
    return {
      error: NextResponse.json(
        { error: "Invalid book ID" },
        { status: 400 }
      ),
    };
  }

  const db = getDb();
  const [book] = await db
    .select()
    .from(books)
    .where(and(eq(books.id, bookId), eq(books.userId, session.userId)));

  if (!book) {
    return {
      error: NextResponse.json(
        { error: "Book not found" },
        { status: 404 }
      ),
    };
  }

  return { db, bookId, userId: session.userId, book };
}
