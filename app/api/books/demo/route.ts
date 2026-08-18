import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { books } from "@/db/schema";
import { getSession } from "@/lib/session";
// Import `seedBook` and nothing else from this module. Its neighbour `seed()`
// runs DROP SCHEMA on public and drizzle — every user and every book in the
// database — and must stay unreachable from any HTTP handler.
import { seedBook } from "@/db/seed";

const DEMO_BOOK_NAME = "Demo Book";

/**
 * Picks a name no book of this user already holds: "Demo Book", then
 * "Demo Book 2", and so on.
 *
 * At most `names.size` candidates can be taken, so one of the first
 * `names.size + 1` is always free. That is what bounds the loop.
 */
function nextDemoBookName(taken: string[]): string {
  const names = new Set(taken);

  for (let n = 1; n <= names.size + 1; n += 1) {
    const candidate = n === 1 ? DEMO_BOOK_NAME : `${DEMO_BOOK_NAME} ${n}`;
    if (!names.has(candidate)) return candidate;
  }

  return `${DEMO_BOOK_NAME} ${names.size + 2}`;
}

/**
 * Creates a book and fills it with the sample dataset from db/seed.ts.
 *
 * This handler takes NO Request parameter, which is load-bearing rather than
 * tidy. `seedBook` opens by deleting every row that belongs to the book id it
 * receives, so its real contract is "reset this book", not "add to this book".
 * Aimed at a book holding real data, it would erase that data. With no Request
 * in scope there is no body to read, so no caller can name a book: the only id
 * that can reach `seedBook` is the one created immediately above the call.
 *
 * The seed writes thousands of rows one at a time and takes seconds. The
 * button that calls this shows a pending state for its whole duration.
 */
export async function POST() {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    const db = getDb();
    const existing = await db
      .select({ name: books.name })
      .from(books)
      .where(eq(books.userId, session.userId));

    const [book] = await db
      .insert(books)
      .values({
        userId: session.userId,
        name: nextDemoBookName(existing.map((candidate) => candidate.name)),
      })
      .returning();

    try {
      await seedBook(db, book.id);
    } catch (seedError) {
      // A book holding half a dataset is worse than no book, because it looks
      // usable. Every book-scoped table declares onDelete: "cascade" on its
      // bookId, so removing the book removes whatever the seed managed to
      // write. Log first: if the cleanup itself fails, the cause of the
      // failure is still on the record.
      console.error("Demo seed failed, removing the empty book:", seedError);
      await db.delete(books).where(eq(books.id, book.id));
      return NextResponse.json({ error: "Failed to create demo book" }, { status: 500 });
    }

    return NextResponse.json(book);
  } catch (error) {
    console.error("Error creating demo book:", error);
    return NextResponse.json({ error: "Failed to create demo book" }, { status: 500 });
  }
}
