# Architecture Overview

One of the guides [CLAUDE.md](../CLAUDE.md) points to. Read that file first;
it carries the rules that apply everywhere and says when to come here.

## Tech Stack
- **Web client**: React with React Router, TypeScript (strict mode),
  Tailwind CSS. Vite builds it into static files in `build/`. No page renders
  on the server.
- **API server**: Rust, with Axum and SQLx, in `rust-api/`. It serves every
  `/api` route, the MCP server and, in production, the client build.
- **Shared logic**: the Rust core crate, which the browser loads as WASM.
- **Database**: SQLite, one file (`DATABASE_PATH`). The schema is the
  numbered SQL files in `rust-api/db/migrations/`, which the server applies
  with `sqlx::migrate!` when it starts.
- **Testing**: Vitest (unit, database, HTTP and MCP suites), `cargo test`, and
  Playwright (E2E).

## Rust API

`rust-api/` is a Cargo workspace:

- `core` holds the pure domain code: the shared accounting, recurrence,
  expression, formatting, position and FIFO lot helpers. The browser loads it
  as WASM through `lib/wasm-client.ts`. `rust-api/core/fixtures/core.json` is
  the corpus that its tests check.
- `db` (`ledger_db`) holds the database code that both binaries run: opening
  the file, the migrations, the SQL functions, the locks, the portable SQL
  helpers, the backups, the lot rebuild and the sample seed.
- `server` holds the API server (`counterpoise-rust-api`). Route areas are
  under `server/src/routes/`. The database pool, configuration, tracing,
  authentication and the JSON error response are separate modules.
- `cli` holds `ledger-cli`: `migrate`, `seed`, `list-books`,
  `rebuild-lots`, `import-moneydance`, `backup` and `import-postgres` (the
  one-time converter; see [upgrade-to-sqlite.md](upgrade-to-sqlite.md)).

`rust-api/routes.json` lists the method and path pattern of each route that
the Axum router registers from its handler table. A few routes are registered
by name instead: `/health`, `/api/health`, `/api/mcp` and WebMCP. The Rust
code uses only runtime queries (`sqlx::query()` and its forms), so a build
needs no database and no query metadata.

Rust serves every API route. In production, the Rust server also serves the
pages, so the browser has one origin and no other process is in front of the
API. The Rust server answers a key with its own API-key lockout. `cp_today()`, the
SQL function for today's date, follows the server's `TZ`, so date-based
balance queries use the app's local day.

### Security layers

`rust-api/server/src/security.rs` holds the session gate, the cross-origin
write check and the security headers. It is the only copy: no other layer does
these checks. `serve()` in `main.rs` puts them around the router with
`security::protect()`. From the outside in:

1. **Security headers** on every response: `SECURITY_HEADERS` (CSP,
   `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`,
   `Permissions-Policy`), and `Strict-Transport-Security` when
   `ENABLE_HSTS=true`. The server reads `ENABLE_HSTS` when it starts.
2. **Cross-origin write check** on `/api/*`, before every route, with a 403
   when it refuses. The host that the `Origin` must name is `X-Forwarded-Host`
   when a reverse proxy sets it, and `Host` when not. `client_ip::record`
   removes `X-Forwarded-Host` and `X-Forwarded-Proto` when the server does not
   trust a proxy (`TRUST_PROXY`), as it ignores `X-Forwarded-For` then.
3. **The API gate**, before the router: the session and bearer test.
   An `/api/` request with no session cookie and no bearer header
   gets 401 `{"error":"Unauthorized"}`, whether a route has its path and
   method or not. Thus a wrong method does not give a 405 that shows the
   route. The public API paths (`/api/health`, `/api/version`,
   `/api/auth/`, `/api/cron/`) go through, and so does `/api/mcp`, because its
   own 401 has the `WWW-Authenticate: Bearer` challenge.
4. **The router.** Each route authenticates its own requests. The API gate
   only stops the requests that have no credentials at all.
5. **The gate for an unmatched request** (the router fallback). An `/api/`
   path gets 404. Any other path is a page: without a session cookie it gets
   a 307 to `/login`.
   `/login`, `/register`, `/assets/` (the hashed chunks of the client build),
   `/favicon*` and the asset shapes of `STATIC_ASSET` stay public. A page with
   a session goes to the page service: `static_pages.rs`, or
   `security::no_pages()` (404) when `COUNTERPOISE_STATIC_DIR` is not set.

The MCP tools call `routes()` directly, without these layers. The unit tests
in `security.rs` and `tests/http/security-layers.test.ts` test the layers.

### Response compression

`serve()` puts `compression::compress()` (`rust-api/server/src/compression.rs`)
around the security layers, so it applies to each response: the API, the MCP
endpoint and the client build. It sends gzip or br, as the `Accept-Encoding`
of the request selects, at level 5. It does not compress an event stream
(`text/event-stream`), because each book change hint must go out at once. It
also does not compress images, WOFF fonts, a body of 32 bytes or less, or a
response that has a `Content-Encoding`. A compressed response gets
`Vary: Accept-Encoding` and has no `Content-Length`. The module documentation
gives the measured sizes and the reason that the build has no precompressed
copies. The unit tests in `compression.rs` and `tests/http/compression.test.ts`
test the layer.

`/health` is the healthcheck of the `rust-api` container, and `/api/health` is
the deploy check, which reads `"ok":true`. Both are public. Each runs a
`select 1` and answers 503 when it fails. The image has no `wget`: its
healthcheck runs `counterpoise-rust-api health`, which calls `/health`. `/health` sends only the status;
`/api/health` sends `{ "ok": true, "db": true }`. So the container is healthy
only when the server and the database both answer.

In development, run the Rust server beside the Vite development server.
`npm run dev` runs Vite on port 3000. Vite sends each `/api` request to the
Rust server at `RUST_API_URL`, or at `http://127.0.0.1:4000` when that is
unset. The proxy keeps the browser's `Host` header, so the cross-origin check
compares the correct host. In development only, Vite also sends a page request
without a `counterpoise_session` cookie to `/login`, as the page gate does in
production. Without the Rust server, every API request fails:

```bash
cargo run --manifest-path rust-api/Cargo.toml -p counterpoise-rust-api  # listens on 127.0.0.1:4000
npm run dev
```

The first start creates `data/counterpoise.db` and applies the migrations.
`npm run db:seed` fills it with the sample book; stop the server first,
because `ledger-cli seed --reset` refuses while a server holds the file.

The login and register pages are static. They ask for the registration state
in the browser, with `useRegistrationOpen()` from `hooks/useRegistrationOpen.ts`.
The hook calls Rust's public `/api/auth/registration-open` route, which reads
`REGISTRATION_ENABLED`, or in bootstrap mode is open until the first user
exists. Until the answer arrives, the login page shows no register link and the
register page shows no form. When the request fails, or does not answer in
five seconds, the pages show registration as closed. A closed register page goes to `/login` in the browser.
No page renders on the server.

## Web client

The client is a static single-page application:

- `index.html` (at the repository root) holds the document head: the title,
  the icons, the manifest, the viewport and the theme script.
- `client/main.tsx` is the entry. `client/routes.tsx` is the route table.
  `client/NotFound.tsx` is the 404 page.
- `client/RouteError.tsx` is the error page of the root route. A tab that is
  open across a deploy asks for old chunk names, which the server no longer
  has. When a chunk does not load, the error page reloads the page one time,
  and the new `index.html` gives the new chunk names. A marker in
  `sessionStorage` (`client/stale-chunk.ts`) stops a second automatic reload
  in the next 30 seconds, so a reload that does not fix the error cannot
  loop. Other errors, and a chunk error after that reload, show a message
  with a Reload button and a link to the books page. The reload starts from
  the error page and not from a `vite:preloadError` listener: that event
  occurs before the router goes to the new URL, so a reload at that time
  loads the old page.
- The pages stay in `app/` at their old paths, for example
  `app/b/[bookId]/transactions/page.tsx`. The route table lazy-loads each page
  and the book layout, so the login page does not load the WASM core.
- `app/layout.tsx` and `app/b/[bookId]/layout.tsx` are layout routes. Each
  renders its child route with `<Outlet />`. The root layout holds
  `<ScrollRestoration />`: a navigation goes to the top of the page, and Back
  and Forward restore the position.
- `lib/navigation.tsx` is the only module that uses the router. See
  [library-reference.md](library-reference.md).
- `vite.config.ts` puts `NEXT_PUBLIC_POSTHOG_KEY`, `NEXT_PUBLIC_POSTHOG_HOST`
  and the app version into the bundle at build time. It reads them from the
  same `.env` files, with the same names, that the Next build used. A change
  to one needs a new build.

`vite build` (`npm run build`) writes the client to `build/`. The Rust server
serves that folder when `COUNTERPOISE_STATIC_DIR` names it. The page service is
`rust-api/server/src/static_pages.rs`:

- A page path that is not a file gets `index.html`. The client routes in the
  browser.
- A missing file under `/assets/` gets 404, not `index.html`. A browser that
  asks for a script must not get a page.
- A file under `/assets/` gets `Cache-Control: public, max-age=31536000,
  immutable`, because each build gives a changed chunk a new name. A 304 for
  that file gets the same value. All other responses get `no-cache`.
- Each response gets `Vary: Accept-Encoding`, a 304 included, because the
  compression layer can compress the 200 that it replaces.
- The server refuses to start when the folder has no `index.html`. Without
  `COUNTERPOISE_STATIC_DIR`, the server runs in API mode: a page request that
  passes the page gate gets 404.

## Path Aliases
All TypeScript imports use the `@/` prefix, which maps to the project root:
```typescript
import { apiGet } from "@/lib/api-client";
import { formatCurrency } from "@/lib/formatters";
```

## SQLite Database
All data lives in one SQLite file. `DATABASE_PATH` names it: the production
image uses `/data/counterpoise.db`, and development uses
`data/counterpoise.db` when it is unset. Meta tables (users, sessions, books)
and book-scoped tables are in one schema, with a `book_id` foreign key on
every book-scoped table for data isolation. See
[database-management.md](database-management.md) for the files, the locks and
the backups.

Each Vitest worker gets its own database file; see [testing.md](testing.md).

```
counterpoise.db (SQLite)
├── users, sessions, api_keys, books, book_members, issue_reports (meta tables)
├── accounts                        (+ book_id FK)
├── transactions, transaction_splits (+ book_id FK)
├── securities, security_prices     (+ book_id FK)
├── investment_splits, investment_lots, investment_lot_allocations (+ book_id FK)
├── recurring_rules, recurring_template_splits (+ book_id FK)
├── payees                          (+ book_id FK)
├── plaid_tokens, plaid_accounts, plaid_transaction_reconciliation (+ book_id FK)
├── typesafe_evaluations, typesafe_decisions, typesafe_quotas, typesafe_aggregates (+ book_id FK)
└── change_marks                    (live-update counts)
```

- **Schema**: the numbered SQL files in `rust-api/db/migrations/`. The server
  applies the pending ones when it starts; `ledger-cli migrate` applies them
  without a server.
- **Pages** live under `/app/b/[bookId]/...` (e.g., `/app/b/[bookId]/transactions/page.tsx`)
- **API routes** live under `rust-api/server/src/routes/`. See
  [api-route-patterns.md](api-route-patterns.md).
- **TypeScript** has no database code. The test helpers run raw SQL with
  `node:sqlite` (`tests/helpers/sql.ts`).

## Scheduled jobs

The server runs the scheduled jobs itself (`rust-api/server/src/scheduler.rs`)
when `COUNTERPOISE_SCHEDULER=on`. The production image sets it. The default
is off, so a development or test server never runs a job on its own. The
times are in `TZ`:

| Job | When |
| --- | --- |
| Recurring transactions | Hourly |
| Plaid sync | 00:00, 06:00, 12:00, 18:00 |
| Security prices | 06:00, Tuesday to Saturday |
| TypeSafe cleanup | Hourly at :15 |
| Backup (a `VACUUM INTO` snapshot, then `PRAGMA integrity_check`) | Hourly, 06:00 to 21:00 |
| Prune (snapshots and old `.dump` files older than 30 days), then `PRAGMA optimize` | Daily, 04:00 |
| `VACUUM` | The 1st of the month, 03:00 |

Each job calls its job function directly, not over HTTP. A job that still
runs when its next time comes is skipped, not started twice. Backup, prune
and `VACUUM` share one lock. Each job writes its status to
`<STATUS_DIR>/<job>.json` (default `/backups/status`), which
`/api/system/status` reads. The `/api/cron/*` routes still run a job by hand;
`CRON_SECRET` gates them.

## Layered Architecture
```
Pages and client components (React, app/ and components/, routed by client/routes.tsx)
    ↓  fetch /api/... (lib/api-client.ts); in development, Vite forwards it
Rust security layers (security.rs: headers, cross-origin check, API gate, unmatched-path gate)
    ↓
Rust route handler (rust-api/server/src/routes/*.rs)
    ↓  authenticate_book(..., AccessLevel::...) → book id and role
SQL through SQLx, filtered by book_id
    ↓
SQLite database file (DATABASE_PATH)
```

## Locks in Rust

`ledger_db::locks` (`rust-api/db/src/locks.rs`) holds every lock. Open each
write transaction with `locks::begin` or `locks::begin_pool`, which send
`BEGIN IMMEDIATE`; `clippy.toml` forbids plain `begin()`. The write lock of
the file then serializes every writer, in this process and in others.

`with_session_lock` holds a lock across several transactions. It is a file
lock under `<database>.locks/`, so it also holds against the MCP stdio
process. It gives the callback one connection from the pool. Run the
callback's queries on that connection, and open a transaction on it with
`with_transaction` in `rust-api/server/src/db_scope.rs`. A second caller does
not wait: it gets `None`. The Plaid sync (`routes/plaid_sync.rs`) uses it.

The server lock (`<database>.lock`) keeps a second server off the file, so the
scheduler and the change hints of one server see every write that another
server could have made.

## Live book updates

Insert, update and delete triggers on 14 tables count the row changes of each
(book, table) in the table `change_marks`. The tables are `CHANGE_TABLES` in
`rust-api/server/src/book_changes.rs`. Every writer runs the triggers: the
server, `ledger-cli`, MCP over stdio and the `sqlite3` shell. Thus the import,
the seed and the MCP tools need no event calls. A write that rolls back also
rolls back its count. The `books` triggers count under the book's own id, so a
change of the projection settings also invalidates the register.

Rust serves `/api/b/[bookId]/events` from
`rust-api/server/src/routes/events.rs`. At the first subscription,
`BookChangeHub` in `rust-api/server/src/book_changes.rs` starts one poller for
the process. Every 100 ms, it reads the counts of the books that have a
subscriber, and a count that moved is a hint for that table. The hub
coalesces hints per book in 250 ms windows. The route streams SSE with 25-second heartbeats. It bounds
client queues and closes streams after five minutes to revalidate
authorization on reconnect. A graceful shutdown closes the open streams.
Revoked sessions can receive invalidation hints until that reconnect; data
fetches authenticate each request. No ledger values or credentials are
streamed. `lib/book-change-hub.ts` holds the `BookChange` type that the client
reads.

Hints have no replay log. A new SSE subscription sends `ready`, and the client
then refetches the current state. The counts cannot be lost, so the server
never sends `reset`; the client still accepts one. The book layout's `BookChangesProvider` shares one
EventSource per tab between subscribers and also invalidates on focus/visibility
restoration. The consumers are the transactions page and navbar sync badge;
the badge retains its 60-second fallback poll. Other pages keep their existing
refresh mechanisms. See the nginx streaming location in README.md.

When you change the book-change triggers or the events route, verify in
production that events stream through the deployed proxy. Development tests
do not prove it.
