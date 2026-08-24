import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { books } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { getSession } from "@/lib/session";
import { updateBookSchema } from "@/lib/schemas/books";
import { updateBook, deleteBook, BookNotFoundError } from "@/lib/books";

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

    const metaDb = getDb();
    try {
      const updated = await updateBook(metaDb, session.userId, bookId, parsed.data);
      return NextResponse.json(updated);
    } catch (error) {
      if (error instanceof BookNotFoundError) {
        return NextResponse.json({ error: "Book not found" }, { status: 404 });
      }
      throw error;
    }
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

    // deleteBook() takes no route-level shortcut around its own confirmBookName
    // check — see lib/books.ts. This handler reads the book's own current
    // name and passes it straight back in, which the check trivially accepts.
    // That keeps the guard unconditional (every caller, HTTP or MCP, goes
    // through the same one function) while preserving this route's existing
    // contract: the UI already confirms deletion twice on its own, so the
    // DELETE request itself carries no body and asks for no confirmation name.
    const [book] = await metaDb
      .select()
      .from(books)
      .where(and(eq(books.id, bookId), eq(books.userId, session.userId)));

    if (!book) {
      return NextResponse.json(
        { error: "Book not found" },
        { status: 404 }
      );
    }

    await deleteBook(metaDb, session.userId, bookId, book.name);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error deleting book:", error);
    return NextResponse.json(
      { error: "Failed to delete book" },
      { status: 500 }
    );
  }
}
