# Architecture Overview

One of the guides [CLAUDE.md](../CLAUDE.md) points to. Read that file first;
it carries the rules that apply everywhere and says when to come here.

## Tech Stack
- **Web client**: React with React Router, TypeScript (strict mode),
  Tailwind CSS. Vite builds it into static files in `build/`. No page renders
  on the server.
- **API server**: Rust, with Axum and rusqlite, in `rust-api/`. It serves every
  `/api` route and the MCP server. On the Docker target it also serves the
  client build.
- **Shared logic**: the Rust core crate, which the browser loads as WASM.
- **Database**: SQLite, one file (`DATABASE_PATH`). The schema is the
  numbered SQL files in `rust-api/db/migrations/`, which the server applies
  with `ledger_db::migrate` when it starts.
- **Testing**: Vitest (unit, database, HTTP and MCP suites), `cargo test`, and
  Playwright (E2E).

## Deployment targets

One `server` crate builds for two production targets. The code that differs
is behind `server/src/platform.rs`, the `native` feature and the `hosted`
module, so a route or a job is written one time.
`COUNTERPOISE_DEPLOY_TARGET` (`docker` or `worker`) tells `deploy.sh` which
target a release goes to (see
[release-and-deploy.md](release-and-deploy.md)).

| | Docker | Worker |
| --- | --- | --- |
| Process | `counterpoise-rust-api` in one container | A Worker in front of one Durable Object (`LedgerObject`). The object runs the same axum router |
| Database | A file, `/data/counterpoise.db`, on the volume `counterpoise_data` | The object's own SQLite storage. There is no file |
| Client build | The server serves it (`COUNTERPOISE_STATIC_DIR`) | The Worker serves it as static assets |
| Migrations | At start, before the server listens. A failure stops the process | At the object's start. A failure answers each request with 503 |
| Scheduled jobs | The scheduler loop, each minute (`COUNTERPOISE_SCHEDULER=on`) | The object's alarm, unless `COUNTERPOISE_SCHEDULER=off` |
| Backups | Hourly `VACUUM INTO` snapshots and a daily dump in `backups/` | A daily dump in an R2 bucket at 03:45, a copy of it in an S3 bucket when that is set, and 30 days of point-in-time recovery |
| Live updates | A poller, every 100 ms | After each event of the object, with hibernation |
| MCP | HTTP and stdio | HTTP only |
| Deploy | `deploy.sh` builds the image and starts the container | The release merge into `main` runs `.github/workflows/worker-release.yml`, which publishes the tag and calls `worker-deploy.yml` |
| Access to the data | `ledger-cli` in the container | None. Load the daily dump into a local file |

An install on its own machine uses Docker. The Worker needs a Cloudflare account,
and its domain, Access policy and DNS are managed outside this repository.
CI runs the HTTP and MCP suites on both targets (see
[testing.md](testing.md)). Where the targets answer differently, the test
says so with `onWorker`.

## Rust API

`rust-api/` is a Cargo workspace:

- `core` holds the pure domain code: the shared accounting, recurrence,
  expression, formatting, position and FIFO lot helpers. The browser loads it
  as WASM through `lib/wasm-client.ts`. `rust-api/core/fixtures/core.json` is
  the corpus that its tests check.
- `db` (`ledger_db`) holds the database code that both binaries run: opening
  the file, the migrations, the SQLite limits, the locks, the portable SQL
  helpers, the backups, the lot rebuild and the sample seed.
- `server` holds the API server (`counterpoise-rust-api`). Route areas are
  under `server/src/routes/`. The shared database handle, configuration, tracing,
  authentication and the JSON error response are separate modules.
  `server/src/platform.rs` is the one door to the runtime: the clock, the
  monotonic clock, randomness, background and blocking work, sleeps and the
  socket peer. The server also builds for Workers (wasm32), where each
  of these works differently, so server code does not call tokio, the system
  clock or `getrandom` directly.
- The `native` feature of `server` and `db`, on by default, holds what only
  a process has: rusqlite and the database file, the listener and its
  graceful shutdown, the static file service, the WebSocket upgrade, stdio
  MCP, and the file work of the backup, prune and reindex jobs. Without it
  the server crate builds for `wasm32-unknown-unknown` (CI checks it with
  clippy), the database is a host connection (`ledger_db::engine::hosted`),
  and `main()` is empty: a Worker calls the router instead. The crate is a
  library (`src/lib.rs`, `counterpoise_rust_api`) and a binary
  (`src/main.rs`) that calls its `run()`.
- `worker` is the Cloudflare target: a Worker in front of one Durable Object,
  configured by `worker/wrangler.toml`. The Worker sends `/api`, `/health`
  and `/.well-known/` to the object and serves every other path from the
  client build, behind the same page gate as the native server
  (`security::page_gate`). Run it locally with `npm run build` at the root,
  then `npm run worker:dev` (it needs `worker-build`; no Cloudflare
  account). It listens on port 4000 in place of the native server, so
  `npm run dev` then sends `/api` to the Worker. Run every wrangler command
  through `scripts/wrangler.sh`: it pins the version, and approves the
  install scripts of esbuild and workerd, which `.npmrc` blocks otherwise. Its object keeps its file under `rust-api/worker/.wrangler/`
  and starts empty: to give it data, set `IMPORT_SECRET` in
  `rust-api/worker/.dev.vars` and post a `ledger-cli dump` to the admin
  import route (see
  [database-management.md](database-management.md#the-admin-import-route)). The object, `LedgerObject`, holds the database in its
  own SQLite storage and serves the same axum router: when it is built, it
  runs `hosted::start()` (the version check, the zone and the migrations).
  The object starts again after each hibernation, so the start leaves out
  the fold repair, which reads every row: before its first event the object
  repairs the folds once for each build (`BUILD_COMMIT`, kept in the
  object's storage), and on each start without `BUILD_COMMIT`. The object
  sends the HEAD of the restore marker before the start, so that the bucket
  can answer while the start runs, and each event waits for that answer
  outside `blockConcurrencyWhile`. Never wait inside the callback for a call
  that was sent before it: the callback holds back the answer, and the
  object then waits until the runtime resets it, at each start. An earlier
  version did that and stopped the object on Cloudflare. Only the answer "no marker" skips the callback; see
  [database-management.md](database-management.md#point-in-time-restore). A start that fails
  answers each request with a 503 that says why, and the next request tries
  again. The object's alarm runs the
  scheduled jobs (see [Scheduled jobs](#scheduled-jobs)). The object holds the
  book sockets with hibernation (see
  [api-route-patterns.md](api-route-patterns.md#rust-live-updates)). It has no event
  stream and does not compress (Cloudflare compresses at its edge); it
  reads the client IP from `CF-Connecting-IP` and never trusts
  `X-Forwarded-For` or `X-Forwarded-Host`.
- `cli` holds `ledger-cli`: `migrate`, `seed`, `list-books`,
  `rebuild-lots`, `import-moneydance`, `backup`, `dump` and `load`. The
  one-time PostgreSQL converter is only in v1.50.0 to v1.53.0; see
  [upgrade-to-sqlite.md](upgrade-to-sqlite.md).

`rust-api/routes.json` lists the method and path pattern of each route that
the Axum router registers from its handler table. A few routes are registered
by name instead: `/health`, `/api/health`, `/api/mcp` and WebMCP. The Rust
code runs its SQL through `ledger_db::store`, checked when it runs, so a
build needs no database and no query metadata.

Rust serves every API route. On the Docker target, the Rust server also
serves the pages, so the browser has one origin and no other process is in
front of the API. On the Worker, the Worker serves the pages and the object
serves the API, from the same origin. The Rust server answers a key with its own API-key lockout. Today's
date comes from `ledger_db::clock::today()`, in the app's zone (`APP_TZ`, else
`TZ`), and the SQL gets it as a value, so date-based balance queries use the
app's local day.

### Security layers

`rust-api/server/src/security.rs` holds the session gate, the cross-origin
write check and the security headers. It is the only copy: no other layer does
these checks. `serve()` in `lib.rs` puts them around the router with
`security::protect()`. From the outside in:

1. **Security headers** on every response: `SECURITY_HEADERS` (CSP,
   `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`,
   `Permissions-Policy`), and `Strict-Transport-Security` when
   `ENABLE_HSTS=true`. The server reads `ENABLE_HSTS` when it starts.
   The CSP has `script-src 'self'`, the hash of the inline theme script in
   `index.html`, and `'wasm-unsafe-eval'` for the shared domain code; and
   `connect-src 'self'`. So a page runs no inline script and calls no other
   host. If you change the theme script, a Rust test names the new hash. A
   new script or request to another host needs a change to
   `CONTENT_SECURITY_POLICY` in `security.rs`, and a reason.
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
(`text/event-stream`), because each event must go out at once. It also does
not compress images, WOFF fonts, a body of 32 bytes or less, or a
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
- `client/version-check.ts` asks `/api/version` for the server's build when
  the page becomes visible, on focus and every 10 minutes. On a new build,
  `client/UpdateBanner.tsx` shows a Reload button, and the next navigation to
  another path loads the page from the server. Commits between releases share
  a version, so the Worker deploy also names its commit: in the client build
  (`NEXT_PUBLIC_BUILD_COMMIT`) and in `/api/version` (`BUILD_COMMIT`). When
  both sides name one, a different commit is a new build. A local build names
  none and compares the version only.
- The pages stay in `app/` at their old paths, for example
  `app/b/[bookId]/transactions/page.tsx`. The route table lazy-loads each page
  and the book layout, so the login page does not load the WASM core.
- `app/layout.tsx` and `app/b/[bookId]/layout.tsx` are layout routes. Each
  renders its child route with `<Outlet />`. The root layout holds
  `<ScrollRestoration />`: a navigation goes to the top of the page, and Back
  and Forward restore the position.
- `lib/navigation.tsx` is the only module that uses the router. See
  [library-reference.md](library-reference.md).
- `vite.config.ts` puts `NEXT_PUBLIC_BUILD_COMMIT` and the app version into
  the bundle at build time. A change to one needs a new build.

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
import { formatCurrency } from "@/lib/wasm-client";
```

## SQLite Database
All data lives in one SQLite database. On a native server, `DATABASE_PATH`
names its file: the Docker image uses `/data/counterpoise.db`, and
development uses `data/counterpoise.db` when it is unset. On the Worker, the
Durable Object's own storage holds it. Meta tables (users, sessions, books)
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
├── change_marks                    (live-update counts)
└── transaction_changes             (delta-sync log of a native client)
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

The server runs the scheduled jobs itself (`rust-api/server/src/scheduler/mod.rs`)
when `COUNTERPOISE_SCHEDULER=on`. The Docker image sets it. The default
is off, so a development or test server never runs a job on its own. On
the Worker the default is on, because the object's alarm is its only
scheduler: only `COUNTERPOISE_SCHEDULER=off` stops the alarm
(`alarm_enabled()` in `rust-api/worker/src/lib.rs`). Do not set `off` on a
deployed Worker: no job runs, the daily export included, and a socket whose
credential expires stays open until the next event. The Worker tests set it.
The
times are in the app's zone (`APP_TZ`, else `TZ`). Workers has no `TZ` and
its system zone is UTC, so `wrangler.toml` sets `APP_TZ` for each Worker.
Without it, the jobs run on UTC and today's date changes in the evening:

| Job | When |
| --- | --- |
| Recurring transactions | Hourly |
| Plaid sync | 00:00, 06:00, 12:00, 18:00 |
| Security prices | 06:00, Tuesday to Saturday |
| TypeSafe cleanup | Hourly at :15 |
| Backup (a `VACUUM INTO` snapshot, then `PRAGMA integrity_check`; the day's first run also writes a JSON dump) | Hourly, 06:00 to 21:00 |
| Prune (snapshots, dumps and old `.dump` files older than 30 days), then `PRAGMA optimize` | Daily, 04:00 |
| `VACUUM` | The 1st of the month, 03:00 |

Each job calls its job function directly, not over HTTP. The scheduler is
a pure function, `plan()` in `rust-api/server/src/scheduler/plan.rs`: given
the time and what the job tables hold, it returns the jobs due now and the
next wake. The native loop calls it every minute. On Workers the Durable
Object's alarm calls it (`scheduler::alarm()`): each alarm runs one step of
one due job and sets the next alarm, at once when it ran a step, else at the
plan's next wake. Before that step runs, the other jobs due at the same
time claim their slots, so a step that outlasts its minute does not lose
them. The plan lists a run whose step started and did not end after the
other due jobs, the most starts last. So a job that never finishes does not
stay first in the alarm's line and block the jobs after it. `setAlarm`
replaces the alarm that is set, so the next
wake always comes from the tables alone. Each new instance of the object
also sets the alarm from the tables at its first request, unless one is set
sooner (`needs_alarm()` in `rust-api/worker/src/lib.rs`). An alarm that is
late by more than a minute counts as not set: the runtime drops an alarm
after its sixth failed retry, and the storage can still give its time; no
event comes from it, and no request would set a new one. `VACUUM` needs
the native server's file and is off the object's schedule. The object's backup is a daily dump into its R2 bucket at 03:45,
and a copy into an S3 bucket outside Cloudflare when its settings are set
(see [database-management.md](database-management.md#backups-on-the-worker)),
and its prune job prunes only the rate limits. It walks UTC minutes and reads
each in the app's zone, so a change to or from daylight saving time needs
no special case.

A run claims its slot (the scheduled minute it serves) in `job_slots`
before it starts and marks it finished at the end. A slot that is not
finished, with its lease free, is a run that stopped, and the next plan runs
it again; so every job must leave the data as it is when it runs a second
time. The slot counts the starts of its current step (`job_slots.attempts`,
`ledger_db::jobs::attempt()`). The scheduler adds one before the step runs,
because a step that stops with its alarm or its process cannot count
itself. A step that keeps its cursor sets the count back to zero. When a
step has started 3 times (`MAX_ATTEMPTS`) and the run is still unfinished,
the scheduler does not start it again: it finishes the slot and records a
failed run, which the status page shows. A late wake still runs a slot up to
an hour old; a job with no slot on record catches up nothing. The weekly review runs one book per step and the
Plaid sync three connections per step, keeping where the next step starts
in the slot's cursor, so that one step fits in an alarm's time (15 minutes).
A run asked for outside the schedule waits in `job_requests`. The lot
rebuild is such a job and is never on the schedule: a Durable Object that
starts on a file with trades and no lots asks for it, and it rebuilds 50
pairs per step (`ledger_db::lots::rebuild_lots_step()`). Having no next slot,
it keeps a failed step unfinished, and the next plan goes on from its
cursor. A step that fails 3 times ends the run as a failure. The rebuild
records its run, and the status page lists it when it has a record ("Lot
rebuild", "On demand", never stale). An object that starts after a failed
rebuild asks for the rebuild again (`scheduler::request_lot_rebuild()`), but
not while a run is unfinished: a request starts a new run with a new count
of starts. The native server rebuilds them before it serves instead.

A job that still runs when its next time comes is not started twice: each
run holds the job's lease (`job_leases`), and the new slot starts when the
run ends. Backup, prune and `VACUUM` share one lease. Each job records its
run in `job_runs` (`ledger_db::jobs`), which `/api/system/status` reads. The
status lists the jobs of its own target: a Durable Object shows its daily
export as the backup, its prune of the rate limits, and no reindex. The
`/api/cron/*` routes still run a job by hand, all of it in one call;
`CRON_SECRET` gates them. `/api/cron/backup` runs the backup: on a Durable
Object it exports a dump under a name of its own, and the day's dump stays
(see [database-management.md](database-management.md#a-dump-on-demand)). On Workers such a call runs inside its request,
which keeps the object up. Background work that a response has promised,
such as the review that `POST .../weekly-review/run` starts with a 202,
goes through `platform::spawn_to_finish()`, which hands it to the object's
`ctx.waitUntil`.

## Layered Architecture
```
Pages and client components (React, app/ and components/, routed by client/routes.tsx)
    ↓  fetch /api/... (lib/api-client.ts); in development, Vite forwards it
Rust security layers (security.rs: headers, cross-origin check, API gate, unmatched-path gate)
    ↓
Rust route handler (rust-api/server/src/routes/*.rs)
    ↓  authenticate_book(..., AccessLevel::...) → book id and role
SQL through ledger_db::store on state.database, filtered by book_id
    ↓
SQLite database file (DATABASE_PATH)
```

## Locks in Rust

`ledger_db::locks` (`rust-api/db/src/locks.rs`) holds every lock. A route
opens a write transaction with `Database::transaction` (through
`write_transaction` in `rust-api/server/src/db_scope.rs`), which sends
`BEGIN IMMEDIATE`; `clippy.toml` forbids rusqlite's own deferred
`Connection::transaction`. The write lock of
the file then serializes every writer, in this process and in others.

A lease (`rust-api/server/src/leases.rs`, rows of `job_leases`) keeps two
runs apart across several transactions and across processes, so it also holds
against the MCP stdio process. `try_take` does not wait: a second caller gets
`None`. The holder renews the lease while it runs, and a crashed holder's
lease lapses after 60 seconds. A run goes through `Held::guard`, which stops
it when a renewal finds that the lease lapsed and another run took it. The scheduled jobs and the Plaid sync
(`routes/plaid_sync.rs`) use one. The Plaid sync runs on `state.database`
like a route: each write is its own transaction between two network calls,
and only the lease spans the run.

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

A native client keeps a local copy of the transactions. It reads the
changes from `GET /api/b/[bookId]/transactions/changes`
(`rust-api/server/src/routes/transaction_changes.rs`). Triggers on
`transactions`, `transaction_splits` and `investment_splits` log the ID of
each changed transaction in `transaction_changes`, for every writer, as the
`change_marks` triggers do. The live-update hint tells the client when to read.

Rust serves the hints over a WebSocket, `/api/b/[bookId]/socket` from
`rust-api/server/src/routes/socket.rs`. The web and iOS clients use it. At
the first subscription,
`BookChangeHub` in `rust-api/server/src/book_changes.rs` starts one poller for
the process. Every 100 ms, it reads the counts of the books that have a
subscriber, and a count that moved is a hint for that table. The hub
coalesces hints per book in 250 ms windows, and bounds each client's queue.
A graceful shutdown closes the open sockets. The socket pings every 25
seconds and checks its credential again on a revocation, a membership change and every
five minutes (see [api-route-patterns.md](api-route-patterns.md#rust-live-updates)).
On the Worker the object holds the sockets with hibernation and runs no
poller: it reads the counts after each of its own events instead. No ledger values or credentials are
streamed. `lib/book-change-hub.ts` holds the `BookChange` type that the client
reads.

Hints have no replay log. A new subscription sends `ready`, and the client
then refetches the current state. The counts cannot be lost, so the server
never sends `reset`. The book layout's `BookChangesProvider` shares one
WebSocket per tab between subscribers and also invalidates on focus/visibility
restoration. It reconnects after a close with a growing delay (1 second
doubling to 30, with jitter), at once when the tab regains focus, and never
after a 44xx close. After a socket that closed before `ready` (a refused
handshake reaches the browser as 1006), it first sends the route a plain
`GET`, and stops on 401, 403 or 404. The consumers are the transactions page and navbar sync badge;
the badge retains its 60-second fallback poll. Other pages keep their existing
refresh mechanisms. See the nginx socket location in README.md. The Vite dev
proxy passes the upgrade (`ws: true`).

When you change the book-change triggers or the socket route, verify on each
deployed target that hints reach the page: through the reverse proxy of a
Docker install, and through the Worker, whose object sends them on its own
path (`rust-api/server/src/hosted/sockets.rs`). Development tests do not
prove it.
