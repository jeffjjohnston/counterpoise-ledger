# Debugging Tips

One of the guides [CLAUDE.md](../CLAUDE.md) points to. Read that file first;
it carries the rules that apply everywhere and says when to come here.

## View SQL Queries
The Rust server logs through `tracing`, and `RUST_LOG` sets the filter (the
default is `info`). SQLx logs each statement at the `debug` level, so start
the server with `RUST_LOG=info,sqlx=debug` to see the SQL of each request.

To run a query by hand, open the development file with the SQLite shell:

```bash
sqlite3 data/counterpoise.db "SELECT id, name FROM books"
```

The shell does not have the app's SQL functions (`cp_today()`,
`cp_merchant_key()`, and the Unicode `lower()` and case-sensitive `LIKE`).
A query that uses them can give a different answer in the shell. See
[database-management.md](database-management.md#functions-registered-on-each-connection).

In a test, `tests/helpers/sql.ts` runs SQL on the worker's file with
`node:sqlite`: `rows()`, `scalar()` and `script()`.

## Check Split Balance
A transaction write whose splits do not sum to zero gets 400 `Transaction
splits must sum to zero (debits = credits)` from
`rust-api/server/src/routes/transactions.rs`. To find the difference, add up
the `amount` of each split in the request body: the total must be 0.

## Investment Position Issues
Check these common causes:
1. Incorrect sign in `sharesMicros` (should be positive)
2. Missing or incorrect `action` field
3. Price or shares not converted to micros
4. Lot tracking out of sync — rebuild with `npm run db:rebuild-lots`, which
   regenerates lots from the existing splits. Do NOT re-run the import: an
   ordinary rerun inserts the transactions a second time, and `--overwrite`
   removes the target book's existing data first
