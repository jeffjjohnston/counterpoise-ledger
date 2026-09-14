# API Route Patterns

One of the guides [CLAUDE.md](../CLAUDE.md) points to. Read that file first;
it carries the rules that apply everywhere and says when to come here.

## Book-Scoped CRUD Pattern
All data routes are under `/app/api/b/[bookId]/`. Every query is `await`ed
(PostgreSQL via postgres.js is async — there is no `.all()`), every body is
parsed by a zod schema from `/lib/schemas/`, and every handler wraps its work in
try/catch so failures keep the `{ error }` envelope:

```typescript
// GET /api/b/[bookId]/resource/route.ts
export async function GET(request: Request, { params }: { params: Promise<{ bookId: string }> }) {
  try {
    const { bookId } = await params;
    const auth = await authenticateBookRequest(bookId);
    if (isError(auth)) return auth.error;
    const { db, bookId: numericBookId } = auth;

    const results = await db.select().from(table).where(eq(table.bookId, numericBookId));
    return NextResponse.json(results);
  } catch (error) {
    console.error("Error fetching resources:", error);
    return NextResponse.json({ error: "Failed to fetch resources" }, { status: 500 });
  }
}

// POST /api/b/[bookId]/resource/route.ts
export async function POST(request: Request, { params }: { params: Promise<{ bookId: string }> }) {
  try {
    const { bookId } = await params;
    const auth = await authenticateBookRequest(bookId);
    if (isError(auth)) return auth.error;
    const { db, bookId: numericBookId } = auth;

    // Never spread the raw body into values(): the schema is what stops a
    // client setting bookId, id, or any other column it does not own.
    const parsed = createResourceSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
    }

    const [created] = await db
      .insert(table)
      .values({ ...parsed.data, bookId: numericBookId })
      .returning();
    return NextResponse.json(created);
  } catch (error) {
    console.error("Error creating resource:", error);
    return NextResponse.json({ error: "Failed to create resource" }, { status: 500 });
  }
}
```

Any id referencing another row (`parentId`, `payeeId`, `balanceAccountId`, …)
must be confirmed to belong to this book before use — a zod schema proves it is
an integer, not that it is *yours*. See `accounts/route.ts` for the pattern.

## Transaction Creation Pattern
See `/app/api/b/[bookId]/transactions/route.ts` for full example:
1. Authenticate and get book DB
2. Parse and validate input
3. Validate splits balance to zero
4. Check if investment splits required
5. Create/lookup payee (normalized name matching)
6. Insert transaction, splits, and investment splits atomically
7. Return fully populated transaction with relations
