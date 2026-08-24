import { and, eq } from "drizzle-orm";
import type { AppDb } from "@/db";
import { books, type Book } from "@/db/schema";
// Import `seedBook` and nothing else from this module. Its neighbour `seed()`
// runs DROP SCHEMA on public and drizzle — every user and every book in the
// database — and must stay unreachable from `createDemoBook`.
import { seedBook } from "@/db/seed";
import type { CreateBookInput, UpdateBookInput } from "@/lib/schemas/books";

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

export class BookValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BookValidationError";
  }
}

export class BookNotFoundError extends Error {
  constructor(message: string = "Book not found") {
    super(message);
    this.name = "BookNotFoundError";
  }
}

// ---------------------------------------------------------------------------
// createBook — moved from app/api/books/route.ts (POST)
// ---------------------------------------------------------------------------

export async function createBook(db: AppDb, userId: number, input: CreateBookInput): Promise<Book> {
  const { name } = input;

  const [book] = await db.insert(books).values({ userId, name }).returning();
  return book;
}

// ---------------------------------------------------------------------------
// updateBook — moved from app/api/books/[bookId]/route.ts (PUT)
// ---------------------------------------------------------------------------

export async function updateBook(
  db: AppDb,
  userId: number,
  bookId: number,
  input: UpdateBookInput
): Promise<Book> {
  const { name, upcomingDays } = input;

  const updates: { name: string; updatedAt: Date; upcomingDays?: number } = {
    name,
    updatedAt: new Date(),
  };
  if (upcomingDays !== undefined) {
    updates.upcomingDays = upcomingDays;
  }

  const [updated] = await db
    .update(books)
    .set(updates)
    .where(and(eq(books.id, bookId), eq(books.userId, userId)))
    .returning();

  if (!updated) throw new BookNotFoundError(`Book ${bookId} not found`);

  return updated;
}

// ---------------------------------------------------------------------------
// deleteBook — new. See design doc decision 3's guarded exception.
// ---------------------------------------------------------------------------

/**
 * Delete a book and, by FK cascade, everything in it.
 *
 * `confirmBookName` must exactly match the book's stored name. This guard
 * exists because deleting a book is the only operation in the app whose blast
 * radius is an entire ledger: all 14 book-scoped tables carry ON DELETE
 * cascade on book_id. The web UI gates it twice — a two-step reveal and a
 * window.confirm naming the book — but that protection lives only in the UI,
 * and the route has none, so MCP would otherwise bypass it entirely.
 * Annotations cannot substitute: they are advisory, never an authorization
 * check. See the design doc's decision 3 exception.
 *
 * The comparison is exact. Do not relax it to case-insensitive or trimmed:
 * requiring the caller to reproduce the name precisely is what makes this a
 * deliberate act rather than a plausible accident.
 */
export async function deleteBook(
  db: AppDb,
  userId: number,
  bookId: number,
  confirmBookName: string
): Promise<void> {
  // Existence and ownership are checked BEFORE the name comparison, so a
  // caller probing another user's book can never learn its name from the
  // error message — they get "not found", the same answer as a nonexistent
  // book id.
  const [book] = await db
    .select()
    .from(books)
    .where(and(eq(books.id, bookId), eq(books.userId, userId)));

  if (!book) throw new BookNotFoundError(`Book ${bookId} not found`);

  if (confirmBookName !== book.name) {
    throw new BookValidationError(
      `confirmBookName does not match. To delete this book, pass its exact name: "${book.name}"`
    );
  }

  await db.delete(books).where(and(eq(books.id, bookId), eq(books.userId, userId)));
}

// ---------------------------------------------------------------------------
// createDemoBook — moved from app/api/books/demo/route.ts (POST)
// ---------------------------------------------------------------------------

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
 * `seedBook` opens by deleting every row that belongs to the book id it
 * receives, so its real contract is "reset this book", not "add to this
 * book". This function is the only caller that can reach it, and it always
 * passes the id of the book it just created immediately above — never a
 * caller-supplied id — so an existing book full of real data can never be
 * the target.
 *
 * The seed writes thousands of rows one at a time and takes seconds.
 *
 * One try/catch wraps the whole function body, not just the seed step. The
 * lookup for a free demo-book name and the book insert can also fail — for
 * example a DB connectivity error, or a userId that fails an FK check.
 * Neither caller of this function (the web route, the create_demo_book MCP
 * tool) logs anything of its own, so this is the only place in the call
 * chain able to log a failure with useful context. An earlier version
 * logged only the seed step, so a lookup or insert failure produced no log
 * anywhere — the same silent-failure shape as the auto-match transaction
 * bug this file's CLAUDE.md entry describes.
 */
export async function createDemoBook(db: AppDb, userId: number): Promise<Book> {
  let book: Book | undefined;

  try {
    const existing = await db
      .select({ name: books.name })
      .from(books)
      .where(eq(books.userId, userId));

    const created = await db
      .insert(books)
      .values({
        userId,
        name: nextDemoBookName(existing.map((candidate) => candidate.name)),
      })
      .returning();
    book = created[0];

    await seedBook(db, book.id);

    return book;
  } catch (error) {
    // Log first: if the cleanup below itself fails, the cause of the
    // original failure is still on the record.
    console.error("Failed to create demo book:", error);

    // A book holding half a dataset is worse than no book, because it looks
    // usable. Every book-scoped table declares onDelete: "cascade" on its
    // bookId, so removing the book removes whatever the seed managed to
    // write. `book` is set only once the insert has returned a row, so this
    // runs after a seed failure and is skipped after a lookup or insert
    // failure, when there is no book to remove.
    if (book) {
      await db.delete(books).where(eq(books.id, book.id));
    }

    // Rethrow so the caller (route or MCP tool) reports the failure instead
    // of silently returning a book that was never actually seeded.
    throw error;
  }
}
