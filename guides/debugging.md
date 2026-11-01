# Debugging Tips

One of the guides [CLAUDE.md](../CLAUDE.md) points to. Read that file first;
it carries the rules that apply everywhere and says when to come here.

## View SQL Queries
The Rust server logs through `tracing`, and `RUST_LOG` sets the filter (the
default is `info`). The routes and the MCP tools run on the synchronous API
(`ledger_db::store`), which logs no statement: to see the SQL of a request,
read it in the route, or run its `EXPLAIN QUERY PLAN` in the shell below.
The scheduled jobs and `ledger-cli` use the same API.

To run a query by hand, open the development file with the SQLite shell:

```bash
sqlite3 data/counterpoise.db "SELECT id, name FROM books"
```

The app registers no SQL function, so the shell runs the same SQL as the
server ([database-management.md](database-management.md#no-sql-functions)).
SQLite's own `lower()` folds ASCII only: to match without case as the app
does, compare a `*_fold` column with the lowercased value. After changing a name or a description in the shell, run
`ledger-cli repair-folds` (or restart the server), or the row's fold stays
stale.

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

## Production on the Worker
The Worker has no shell and no database file. Use these instead:

- **The data**: load the newest daily export into a local file, and query
  that file. See
  [database-management.md](database-management.md#production-data-on-the-worker).
- **The log**: `../../scripts/wrangler.sh tail` in `rust-api/worker/`
  streams the production Worker's log, and `--env staging` streams the
  staging Worker's log. Workers Logs keeps the log for a time only where
  `wrangler.toml` turns it on (see
  [release-and-deploy.md](release-and-deploy.md#the-cloudflare-worker-deploy)).
- **The jobs**: `/api/system/status`, or the MCP tool `get_system_status`,
  gives the last run of each job and the error of a failed run.
- **A failed start**: the object answers each request with a 503 that gives
  the cause, for example a migration that failed. The next request tries the
  start again.
