# Debugging Tips

One of the guides [CLAUDE.md](../CLAUDE.md) points to. Read that file first;
it carries the rules that apply everywhere and says when to come here.

## View SQL Queries
Drizzle doesn't log by default. `.toSQL()` renders the statement and its
parameters without running anything:
```typescript
const query = db.select().from(transactions).where(eq(transactions.bookId, 1));
console.log(query.toSQL()); // { sql: "select ...", params: [1] }

// For the rows, await it — an un-awaited builder logs the builder, not results.
console.log("Query result:", await query);
```

## Check Split Balance
If transaction creation fails, log the split total:
```typescript
const total = splits.reduce((sum, s) => sum + s.amount, 0);
console.log("Split total (must be 0):", total);
```

## Investment Position Issues
Check these common causes:
1. Incorrect sign in `sharesMicros` (should be positive)
2. Missing or incorrect `action` field
3. Price or shares not converted to micros
4. Lot tracking out of sync — rebuild with `npm run db:rebuild-lots`, which
   regenerates lots from the existing splits. Do NOT re-run the import: an
   ordinary rerun inserts the transactions a second time, and `--overwrite`
   removes the target book's existing data first
