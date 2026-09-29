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
- **Database**: PostgreSQL. Drizzle ORM holds the schema and is the only
  migrator (`db/schema.ts`, `db/migrations/`).
- **Testing**: Vitest (unit, database, HTTP and MCP suites), `cargo test`, and
  Playwright (E2E).

## Rust API

`rust-api/` is a Cargo workspace:

- `core` holds the pure domain code: the shared accounting, recurrence,
  expression, formatting, position and FIFO lot helpers. The browser loads it
  as WASM through `lib/wasm-client.ts`. `rust-api/core/fixtures/core.json` is
  the corpus that its tests check.
- `db` holds the database code that both binaries run: the lot rebuild and
  the sample seed.
- `server` holds the API server (`counterpoise-rust-api`). Route areas are
  under `server/src/routes/`. The database pool, configuration, tracing,
  authentication and the JSON error response are separate modules.
- `cli` holds `ledger-cli`: `rebuild-lots`, `seed` and `import-moneydance`.

`rust-api/routes.json` lists the method and path pattern of each route that
the Axum router registers from its handler table. A few routes are registered
by name instead: `/health`, `/api/health`, `/api/mcp` and WebMCP. The Rust
server's SQLx query metadata lives in `rust-api/.sqlx/`, so production images
compile without database access.

Rust serves every API route. In production, the Rust server also serves the
pages, so the browser has one origin and no other process is in front of the
API. The Rust server answers a key with its own API-key lockout. The server
and the database use the same `TZ` setting so date-based balance queries have
the same local day.

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
   when a reverse proxy sets it, and `Host` when not.
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
`select 1` and answers 503 when it fails. `/health` sends only the status;
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
DATABASE_URL=postgresql://counterpoise:counterpoise@localhost:5432/counterpoise_dev \
  cargo run --manifest-path rust-api/Cargo.toml -p counterpoise-rust-api  # listens on 127.0.0.1:4000
npm run dev
```

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

## PostgreSQL Database
All data lives in a PostgreSQL database. Local development defaults to `postgresql://counterpoise:counterpoise@localhost:5432/counterpoise_dev` when `DATABASE_URL` is unset. Docker deployment uses a separate `counterpoise` database via `.env.production.local`. Meta tables (users, sessions, books) and book-scoped tables coexist in one schema, with a `bookId` foreign key on every book-scoped table for data isolation.

Each Vitest run generates its own database name: `vitest.config.ts` mints a run
id and every worker creates `counterpoise_test_${runId}_${pool}` as its suite
starts, so two runs never share a schema and nothing is assigned. The scheduler
reclaims them — see [testing.md](testing.md). `npm run db:create-test-dbs`
creates only `counterpoise_dev` and `counterpoise_e2e`.

```
counterpoise (PostgreSQL database)
├── users, sessions, apiKeys, books, issueReports (meta tables)
├── accounts                        (+ bookId FK)
├── transactions, transactionSplits (+ bookId FK)
├── securities, securityPrices      (+ bookId FK)
├── investmentSplits, investmentLots, investmentLotAllocations (+ bookId FK)
├── recurringRules, recurringTemplateSplits (+ bookId FK)
├── payees                          (+ bookId FK)
└── plaidTokens, plaidAccounts, plaidTransactionReconciliation (+ bookId FK)
```

- **Schema**: all tables are defined in `/db/schema.ts`. Drizzle generates the
  migrations from it. The Rust server never applies DDL.
- **Pages** live under `/app/b/[bookId]/...` (e.g., `/app/b/[bookId]/transactions/page.tsx`)
- **API routes** live under `rust-api/server/src/routes/`. See
  [api-route-patterns.md](api-route-patterns.md).
- **TypeScript scripts** (`db/migrate.ts`, `scripts/rebuild-lots.ts`, the test
  helpers) use `getDb()` from `/db/index.ts`. It returns a cached Drizzle
  instance and does not migrate; call `runMigrations()` first where a script
  needs the schema.

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
PostgreSQL Database
```

## Advisory locks in Rust

`with_advisory_lock` in `rust-api/server/src/db_scope.rs` takes a
session-level advisory lock on one connection that it acquires from the pool.
It gives the callback that connection. Run the callback's queries on that
connection, and open a transaction on it with `with_transaction`. Never take a
second connection from the pool inside the callback: it does not hold the
lock. The connection closes when the callback ends, so a lock with an
uncertain state never goes back to the pool. The Plaid sync
(`routes/plaid_sync.rs`) uses it. A lock that lasts for one transaction only
uses `pg_advisory_xact_lock` in that transaction instead, as the lot rebuild in
`rust-api/db/src/lots.rs` does.

## Live book updates

Row triggers installed by the book-change migration notify `counterpoise_changes`
after commit. The payload contains only `bookId` and a table name. Writers in
cron, MCP, import and seed processes need no application event calls. Identical
payloads collapse inside one transaction; an import spanning transactions still
produces multiple notifications. The books trigger maps its id to bookId, so
projection settings changes also invalidate the register. Row triggers do not
cover TRUNCATE or DDL.

Rust serves `/api/b/[bookId]/events` from
`rust-api/server/src/routes/events.rs`. `rust-api/server/src/book_changes.rs`
opens one LISTEN connection per process at the first subscription. That
connection comes from its own one-connection pool, so it never takes a slot
from the request pool. The hub validates hints and coalesces them per book in
250 ms windows. The route streams SSE with 25-second heartbeats. It bounds
client queues and closes streams after five minutes to revalidate
authorization on reconnect. A graceful shutdown closes the open streams.
Revoked sessions can receive invalidation hints until that reconnect; data
fetches authenticate each request. No ledger values or credentials are
streamed. `lib/book-change-hub.ts` holds the `BookChange` type that the client
reads.

Notifications have no replay log. Listener reconnection sends `reset`; a new SSE
subscription sends `ready` only after LISTEN is established. Both require clients
to refetch current state. The book layout's `BookChangesProvider` shares one
EventSource per tab between subscribers and also invalidates on focus/visibility
restoration. The consumers are the transactions page and navbar sync badge;
the badge retains its 60-second fallback poll. Other pages keep their existing
refresh mechanisms. See the nginx streaming location in README.md.

When you change the book-change triggers or the events route, verify in
production that the migration role owns the affected tables and that events
stream through the deployed proxy. Development tests do not establish either
production property.
