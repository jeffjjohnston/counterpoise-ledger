import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { books } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { getSession } from "@/lib/session";
import { updateBookSchema } from "@/lib/schemas/books";

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ bookId: string }> }
) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json(
        { error: "Not authenticated" },
        { status: 401 }
      );
    }

    const { bookId: bookIdStr } = await params;
    const bookId = parseInt(bookIdStr, 10);
    if (isNaN(bookId)) {
      return NextResponse.json(
        { error: "Invalid book ID" },
        { status: 400 }
      );
    }

    const parsed = updateBookSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
    }
    const { name, upcomingDays } = parsed.data;

    const updates: { name: string; updatedAt: Date; upcomingDays?: number } = {
      name,
      updatedAt: new Date(),
    };
    if (upcomingDays !== undefined) {
      updates.upcomingDays = upcomingDays;
    }

    const metaDb = getDb();
    const [updated] = await metaDb
      .update(books)
      .set(updates)
      .where(and(eq(books.id, bookId), eq(books.userId, session.userId)))
      .returning();

    if (!updated) {
      return NextResponse.json(
        { error: "Book not found" },
        { status: 404 }
      );
    }

    return NextResponse.json(updated);
  } catch (error) {
    console.error("Error updating book:", error);
    return NextResponse.json(
      { error: "Failed to update book" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ bookId: string }> }
) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json(
        { error: "Not authenticated" },
        { status: 401 }
      );
    }

    const { bookId: bookIdStr } = await params;
    const bookId = parseInt(bookIdStr, 10);
    if (isNaN(bookId)) {
      return NextResponse.json(
        { error: "Invalid book ID" },
        { status: 400 }
      );
    }

    const metaDb = getDb();
    const [deleted] = await metaDb
      .delete(books)
      .where(and(eq(books.id, bookId), eq(books.userId, session.userId)))
      .returning();

    if (!deleted) {
      return NextResponse.json(
        { error: "Book not found" },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error deleting book:", error);
    return NextResponse.json(
      { error: "Failed to delete book" },
      { status: 500 }
    );
  }
}
