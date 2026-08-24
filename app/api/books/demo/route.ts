import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { getSession } from "@/lib/session";
import { createDemoBook } from "@/lib/books";

/**
 * Creates a book and fills it with the sample dataset from db/seed.ts.
 *
 * This handler takes NO Request parameter, which is load-bearing rather than
 * tidy. `createDemoBook()` (lib/books.ts) creates the book and passes its own
 * fresh id to `seedBook`, whose real contract is "reset this book", not "add
 * to this book" — aimed at a book holding real data, it would erase that
 * data. With no Request in scope there is no body to read, so no caller can
 * name a book: the only id that can reach `seedBook` is the one
 * `createDemoBook` just created.
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
    const book = await createDemoBook(db, session.userId);

    return NextResponse.json(book);
  } catch {
    // No console.error here: createDemoBook's own catch (lib/books.ts) wraps
    // its whole body — the name lookup, the insert, and the seed — and logs
    // any failure among them with more context before rethrowing. Logging
    // again here would record the same failure twice.
    return NextResponse.json({ error: "Failed to create demo book" }, { status: 500 });
  }
}
