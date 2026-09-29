# Counterpoise - Personal Finance Accounting

A web-based double-entry accounting application for personal finance management, built with modern technologies and accounting best practices. Supports multiple books per user, investment tracking, and bank sync via Plaid.

## Screenshots

Every screenshot below is the sample data you get from **Add demo book** — no setup, and nothing real in it.

| | |
| :-- | :-- |
| **Transactions** | **Recurring** |
| [![A credit card register with running balances and category icons](images/screenshot-transactions.png)](images/screenshot-transactions.png) | [![Recurring rules with a four-week upcoming calendar](images/screenshot-recurring.png)](images/screenshot-recurring.png) |
| Per-account register with a running balance, category icons, and inline entry. | An upcoming calendar over the rules behind it, including a multi-split paycheck. |
| **Securities** | **Bank sync** |
| [![Securities positions with cost basis and market value](images/screenshot-securities.png)](images/screenshot-securities.png) | [![Plaid reconciliation queue showing a strong match](images/screenshot-sync.png)](images/screenshot-sync.png) |
| Holdings with FIFO cost basis, income, and market value. | Plaid items matched against the ledger, with strong-match detection. |

## Features

### Core Accounting
- **True Double-Entry Bookkeeping** - Every transaction has balanced debits and credits
- **Chart of Accounts** - Five account types: Assets, Liabilities, Equity, Income, Expenses
- **Account Subtypes** - Bank, Credit Card, Loan, Investment, Cash accounts
- **Split Transactions** - Support for complex transactions involving multiple accounts (e.g., paychecks)
- **Running Balance** - Real-time balance calculation per account
- **Account Hierarchy** - Organize accounts with parent-child relationships

### Multi-Book Support
- **Multiple Books** - Maintain separate sets of books (e.g., personal, business)
- **Demo Book** - One click fills a brand-new book with the full sample dataset: three years of transactions, investment lots with cost basis, recurring rules, and a bank-sync queue waiting to be reconciled
- **User Authentication** - Session-based auth with scrypt password hashing
- **Registration Control** - Signup open, closed, or self-closing after the first account, via `REGISTRATION_ENABLED`
- **Book Isolation** - Data isolated by bookId within a single database

### Transaction Management
- **Simple Mode** - Quick entry for two-account transfers
- **Journal Entry Mode** - Full debit/credit ledger for advanced transactions
- **Transaction History** - View all transactions with filtering by account
- **Future Transaction Highlighting** - Scheduled transactions shown with visual indicator
- **Edit & Delete** - Full transaction modification capabilities
- **Floating Transactions** - Entries whose effective date auto-advances to today until reconciled

### Investment Tracking
- **Securities Management** - Track stocks, ETFs, and mutual funds
- **Buy/Sell/Dividend** - Full investment transaction support
- **FIFO Lot Tracking** - Automatic cost basis calculation
- **Position Summaries** - View holdings with market values
- **Price History** - Historical price data with Tiingo integration
- **Automatic Price Sync** - End-of-day prices fetched from Tiingo after each market day via cron
- **Quick Price Entry** - Banner prompts for marks on manually-priced securities (e.g., options)

### Recurring Transactions
- **Automated Rules** - Set up recurring income and expenses
- **Multiple Frequencies** - Daily, weekly, monthly, yearly, with custom intervals (e.g., every 2 weeks)
- **Next Date Tracking** - Automatically calculates next occurrence
- **Early Auto-Create Window** - Auto-create X days before the scheduled date (per rule)
- **Cron Processing** - Hourly automatic processing via Docker scheduler

### Bank Sync (Plaid)
- **Bank Connection** - Connect bank accounts via Plaid
- **Transaction Import** - Import transactions from connected accounts
- **Reconciliation** - Match imported transactions with existing records
- **Auto-Matching** - Learned payee-based matching runs automatically after each sync

### Financial Reporting
- **Dashboard** - Net worth, assets, liabilities, income, expenses
- **Balance Sheet** - Real-time snapshot of financial position
- **Income Statement** - Track income vs. expenses
- **Account Balances** - Automatic calculation with proper accounting signs
- **CSV Export** - Download report and security data as CSV

### AI Integration (MCP)
- **MCP Server** - Read/write access to accounting data for AI assistants, over stdio or HTTP (see [guides/mcp-server.md](guides/mcp-server.md))
- **API Keys** - Per-user `cpk_` keys managed on the Account page, scrypt-hashed at rest
- **Usage Analytics** - Optional PostHog integration for usage events. Custom events carry no financial values, but `$pageview` sends the full URL including its query string, and the search page puts the typed query in `?q=` — see [guides/posthog-analytics.md](guides/posthog-analytics.md)

### User Experience
- **Clean Modern UI** - Built with Tailwind CSS for a polished interface
- **Responsive Design** - Works on desktop and mobile devices
- **Sidebar Navigation** - Quick access to account filters
- **Autocomplete Search** - Type-ahead account and payee selection
- **Active/Inactive Accounts** - Hide accounts you're not using
- **Keyboard Shortcuts** - Global shortcuts with a `?` help overlay
- **In-App Issue Reporting** - Report bugs and improvement ideas from any page

## Tech Stack

- **Web client**: React with React Router, built by Vite into static files
- **API server**: Rust (Axum and SQLx). It serves the API, the MCP server and the client build
- **Language**: TypeScript in the browser, Rust on the server. The browser runs the shared Rust domain code as WASM
- **Styling**: Tailwind CSS
- **Database**: PostgreSQL
- **Schema and migrations**: Drizzle ORM
- **Testing**: Vitest (unit), `cargo test`, Playwright (E2E)

## Prerequisites

- Node.js 26+
- npm
- Docker (for PostgreSQL)
- Rust with `cargo` and the `wasm32-unknown-unknown` target. `npm run dev`
  builds the core crate to WASM, and `npm run db:seed` runs the Rust CLI

## Installation

1. Clone the repository:
```bash
git clone https://github.com/jeffjjohnston/counterpoise-ledger.git
cd counterpoise-ledger
```

2. Install dependencies:
```bash
npm install
```

3. Start the dedicated development database (Compose creates its volume):
```bash
docker compose -f docker-compose.dev.yml up -d --wait
```

This uses project `counterpoise-dev`, volume `counterpoise_dev_pgdata`, and
`127.0.0.1:5432`. It needs no production environment file and shares no data with
production. Stop it with `docker compose -f docker-compose.dev.yml down`;
the data volume survives. Keep port 5432 available for this database.

The development checkout is separate from production. For a full Docker
deployment, use the production clone (`~/prod/counterpoise` by default, branch `main`).
In that clone, create the production volume, copy the example environment file,
and point `DATABASE_URL` at the `postgres` service — inside a container,
`localhost` is the container itself:

```bash
docker volume create counterpoise_pgdata
cp .env.example .env.production.local

# Then edit .env.production.local. Set the bootstrap superuser password —
# production Compose has no fallback, and the published development value must
# not be reused here:
#   POSTGRES_PASSWORD=$(openssl rand -hex 32)
#
# Set an application-role password too, and put that same password into
# DATABASE_URL — nothing derives one from the other:
#   APP_DB_PASSWORD=$(openssl rand -hex 32)
#   DATABASE_URL=postgresql://counterpoise_app:<that password>@postgres:5432/counterpoise

docker compose --env-file .env.production.local up -d --build
```

`--env-file` is required, not optional: Compose reads `${VAR}` substitutions in
`docker-compose.yml` from the shell, a `.env` file, or `--env-file` — a
service-level `env_file:` populates the container but does **not** feed those
substitutions. Without it, `TZ` keeps its default and `POSTGRES_PASSWORD`
arrives empty, which the postgres image refuses to initialize a volume with.

Run tests only against the separate dev database. Its test databases can be
reclaimed manually with `scripts/scheduler/sweep-test-databases.sh`; see
[testing.md](guides/testing.md). Production does not schedule dev cleanup.

4. In the development checkout, create the local dev database (and the E2E database):
```bash
npm run db:create-test-dbs
```

Docker only creates the `counterpoise` database; local development uses `counterpoise_dev`, which this script creates along with `counterpoise_e2e`. The Vitest suite needs neither: each run creates its own databases as it starts, and the dev cleanup script can reclaim them.

5. Seed with sample data (optional):
```bash
npm run db:seed
```

This resets the local database, creates a sample `admin` user with password `password`, creates a sample book, and seeds it with data. If you want to seed an existing book instead, first create the book, then run `npm run db:list-books` to find its ID and `npm run db:seed -- --book-id <id>`. The seed runs `ledger-cli seed` through `cargo run`, so the first run also builds the Rust CLI.

If you skip seeding, run `npm run db:migrate` instead to apply the schema — migrations are not applied automatically in local dev.

6. Start the API server and the Vite development server, in two terminals.
   Vite serves the client on port 3000. It sends every `/api` request to the
   API server on `127.0.0.1:4000` (set `RUST_API_URL` to use a different address):
```bash
DATABASE_URL=postgresql://counterpoise:counterpoise@localhost:5432/counterpoise_dev \
  cargo run --manifest-path rust-api/Cargo.toml -p counterpoise-rust-api
npm run dev
```

7. Open [http://localhost:3000](http://localhost:3000).

If you ran `npm run db:seed`, sign in with `admin` / `password`. Otherwise, register an account and create a book.

To explore with realistic data instead of an empty book, click **Add demo book**
on the books page. It creates a book named "Demo Book" and fills it with the
same sample dataset the seed uses. Unlike `npm run db:seed`, which resets the
entire database, this only ever writes to the book it just created — so it is
safe to run on an instance that already holds real data, and you can add several.
It writes thousands of rows in one transaction, so give it a few seconds. If it
fails, no demo book remains.

## Database Architecture

Counterpoise uses a PostgreSQL database containing all meta tables (users, sessions, books) and book-scoped tables. Book-scoped tables have a `bookId` foreign key for data isolation. Local development defaults to `postgresql://counterpoise:counterpoise@localhost:5432/counterpoise_dev` when `DATABASE_URL` is unset; Docker deployment uses `counterpoise` via `.env.production.local`.

### Core Tables

- **accounts** - Chart of accounts with hierarchy (types: asset, liability, equity, income, expense)
- **transactions** / **transactionSplits** - Double-entry transactions
- **securities** / **securityPrices** - Investment securities and price history
- **investmentSplits** / **investmentLots** - Investment transactions and FIFO lot tracking
- **payees** - Deduplicated payees (normalized-name matching)
- **recurringRules** / **recurringTemplateSplits** - Recurring transaction templates
- **plaidTokens** / **plaidAccounts** / **plaidTransactionReconciliation** - Bank sync via Plaid
- **apiKeys** - User API keys for MCP access
- **issueReports** - In-app issue reports (meta table, scoped to user)

## Docker Deployment

The full stack runs as three Docker Compose services:

| Service     | Description                                                              |
|-------------|--------------------------------------------------------------------------|
| `postgres`  | PostgreSQL 16 database with persistent volume                            |
| `rust-api`  | The app: the UI (the Vite client build), the API and MCP, on host port 3000. Before the server starts, it checks the database credential, applies the Drizzle migrations and rebuilds the investment lots |
| `scheduler` | PostgreSQL Alpine sidecar — recurring transactions, Plaid sync, backups, pruning, reindex |

### Configuration

The `rust-api` and `scheduler` services read secrets from `.env.production.local` via `env_file`. Configure these variables:

```bash
# .env.production.local
CRON_SECRET=your-cron-secret-here

# Optional — signup control. Leave unset and registration is open only until the
# first account exists, then closes itself.
REGISTRATION_ENABLED=true|false

# Optional — the client address for the rate limits. Leave unset: the server
# then uses X-Forwarded-For only when APP_BIND is loopback. See "Client
# addresses and rate limits" below.
TRUST_PROXY=true|false

# Optional — Plaid bank sync (see "Connecting a Bank (Plaid)" below)
PLAID_CLIENT_ID=...
PLAID_SECRET=...
PLAID_ENV=sandbox|production

# Optional — Tiingo security prices
TIINGO_API_KEY=...

# Optional — PostHog analytics
# NEXT_PUBLIC_* values are Docker build args. The client build puts them into
# the JS bundle when the image is built, so a change needs a rebuild.
NEXT_PUBLIC_POSTHOG_KEY=...
NEXT_PUBLIC_POSTHOG_HOST=...
POSTHOG_PERSONAL_API_KEY=...  # runtime; used for querying the PostHog API
```

Set `DATABASE_URL` in `.env.production.local`, pointing at the internal
`postgres` hostname and at the application role — for example
`postgresql://counterpoise_app:<app password>@postgres:5432/counterpoise`. That
role is created from `APP_DB_PASSWORD` by
`scripts/postgres-init/01-app-role.sh`, which runs on **first initialization
only**: the postgres image skips `/docker-entrypoint-initdb.d` once the volume
holds a database. Set `APP_DB_PASSWORD` before the first `docker compose up` —
setting it later does nothing. The app refuses to start while
`DATABASE_URL` still carries the published `counterpoise:counterpoise` default,
which is in this repository and known to every reader of it.

### Starting

> **Run production `docker compose` commands from the production checkout root**
> (`~/prod/counterpoise` by default, branch `main`). Dev uses `-f docker-compose.dev.yml`. The project
> name is pinned in `docker-compose.yml`, so Compose addresses the same
> containers from any directory, while `--env-file` is resolved against the
> directory the command runs in. A command run one directory away therefore
> recreates production's containers reading `TZ`, `POSTGRES_PASSWORD` and
> `COUNTERPOISE_BACKUPS_DIR` from the wrong file. An env file that is missing
> outright is refused — Compose exits 1 — so the hazard is one that exists and
> disagrees. `./scripts/check-compose-cwd.sh` answers "am I in
> the right directory?" and `scripts/deploy.sh` runs it first.

```bash
# Create the persistent data volume (first time only)
docker volume create counterpoise_pgdata

# Build and start all services
docker compose --env-file .env.production.local up -d --build

# Or start only the production database
docker compose --env-file .env.production.local up -d postgres
```

The app will be available at http://localhost:3000. The `rust-api` entrypoint
(`docker-entrypoint.sh`) applies the migrations before the server starts. If a
migration fails, the server does not start.

### Rebuilding

Rebuild the image after code changes. The new migrations run before the new
server starts:

```bash
docker compose --env-file .env.production.local up -d --build rust-api
```

### Upgrading to SQLite

v1.48.0 is the last release that uses PostgreSQL. The next release moves the
data to SQLite, and an existing install must convert its data one time. Read
[guides/upgrade-to-sqlite.md](guides/upgrade-to-sqlite.md) before you upgrade
past v1.48.0.

### Updating Environment Variables

Docker Compose reads `env_file` only when **creating** a container. After editing `.env.production.local`, force-recreate to pick up changes:

```bash
docker compose --env-file .env.production.local up -d --force-recreate rust-api scheduler
```

> **Note:** `docker compose restart` will **not** re-read the env file — it only stops and starts the existing container with the old environment.

### Viewing Logs

```bash
# All services
docker compose logs -f

# Specific service
docker compose logs -f rust-api
```

### Stopping

```bash
# Stop all services (data persists in the pgdata volume)
docker compose down

# Stop and delete the database volume (external volume must be removed separately)
docker compose down
docker volume rm counterpoise_pgdata
```

### Build Architecture

The root `Dockerfile` builds one image in stages:

1. **wasm-builder** — compiles the core crate to WASM for the browser
2. **client** — runs `npm ci` and `npm run build` (Vite) to make the client in `build/`
3. **builder** — compiles the Rust server and `ledger-cli`
4. **runtime** — a small Node image with the two binaries, the client in
   `/srv/client` (`COUNTERPOISE_STATIC_DIR`), the migrations and `migrate.js`

Its entrypoint (`docker-entrypoint.sh`) checks the database credential,
applies the Drizzle migrations, rebuilds the lots with `ledger-cli
rebuild-lots`, and then starts the server. Node runs only for `migrate.js`. A
new server never runs against the old schema.

## Getting HTTPS

In a Docker deployment this is not just hardening advice — it is what makes
login work at all.

The image runs with `NODE_ENV=production`, which marks the session cookie
`Secure`. Browsers refuse to store a `Secure` cookie that arrives over plain
`http://`, with one exception: `localhost`, which they treat as a trustworthy
origin. So the same build behaves differently depending on how you reach it:

| Reached at | Login |
| --- | --- |
| `http://localhost:3000` | Works — browsers exempt localhost |
| `http://192.168.1.50:3000` | **Fails silently.** Correct password, `200` response, and straight back to the login page |
| `https://books.example.com` | Works |

The middle row has no error message, so it looks like a rejected password. It is
what you get by setting `APP_BIND=0.0.0.0` and pointing a phone at the LAN
address. Counterpoise logs a warning when it happens — check `docker compose
logs rust-api` if login is bouncing.

Any of these fixes it:

| Option | What it needs | Notes |
| --- | --- | --- |
| **Localhost only** | Nothing | No TLS needed. Fine if you use Counterpoise on the machine it runs on. |
| **Tailscale Serve** | A tailnet | `tailscale serve --bg 3000` publishes it at `https://<machine>.<tailnet>.ts.net`. No open ports, no domain, no certificate management, and it preserves `Host`. Easiest option for reaching your own instance from other devices. |
| **Caddy** | A domain, ports 80/443 | Automatic Let's Encrypt certificates from a two-line Caddyfile. Sets `Host` and `X-Forwarded-Proto` correctly by default. |
| **Cloudflare Tunnel** | A domain on Cloudflare | `cloudflared` dials out, so nothing needs to be opened inbound. |
| **nginx + certbot** | A domain, ports 80/443 | Works, but needs three proxy headers set by hand — see below. |

Leave `APP_BIND` at its `127.0.0.1` default when the proxy runs on the same
host; the proxy reaches the app over loopback and nothing else can.

A Caddyfile is the whole configuration:

```
books.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

nginx needs three headers set explicitly. Its defaults break Counterpoise in three
separate ways — `Host` becomes the upstream address, which fails the
cross-origin check for any WRITE to `/api/` that the browser did not label with
`Sec-Fetch-Site` (safe methods and page requests never reach the comparison,
that header is checked first wherever it is present, and a request carrying no
`Origin` is allowed through), and without `X-Forwarded-Proto` the app cannot
tell that the original request was HTTPS, and without
`X-Forwarded-For` the rate limits see one address for all clients and pass on a
value that the client wrote:

```nginx
# Deliver live book updates immediately instead of buffering the stream.
location ~ ^/api/b/[0-9]+/events$ {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_buffering off;
    proxy_read_timeout 60s;
}

location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

Once TLS is working, set `ENABLE_HSTS=true` to add a `Strict-Transport-Security`
header.

### Client addresses and rate limits

The auth rate limits count failures per client address. The server finds that
address in one of two ways:

- **`X-Forwarded-For`**, the rightmost entry. A reverse proxy adds its own
  client's address at the end, so that entry is correct when every request
  comes through the proxy.
- **The TCP peer address**, which the client cannot change. The server ignores
  `X-Forwarded-For`, because a client that connects directly can write any
  value in it and get a new rate-limit bucket for each attempt.

`TRUST_PROXY` selects the method:

| `TRUST_PROXY` | Client address |
| --- | --- |
| unset (the default) | `X-Forwarded-For` when `APP_BIND` is loopback, else the peer |
| `true` | `X-Forwarded-For`. The peer when the header is missing |
| `false` | The peer. `X-Forwarded-For` has no effect |

With the default `APP_BIND=127.0.0.1`, only a process on the same host can
connect, and that is your proxy. Tailscale Serve, Caddy and Cloudflare Tunnel
set `X-Forwarded-For` by default; nginx needs the line in the example above.
Thus the default needs no configuration. The server logs its choice when it
starts (`docker compose logs rust-api`).

Set `TRUST_PROXY=true` when a proxy on a different host is the only way in and
`APP_BIND` is therefore not loopback. Do not set it when clients can also reach
port 3000 directly.

With `APP_BIND=0.0.0.0` and no proxy, the server uses the peer address. On
Linux with the default Docker network, that is the real client address. Docker
Desktop (macOS and Windows) and rootless Docker can show the same internal
address for all clients. Then all clients share one bucket of twenty failures,
and one client's failures can lock out the others for a time. The per-username
limit is not changed. Put a proxy in front if this is a problem.

## Security notes for self-hosting

Counterpoise was built for a single trusted household on a home LAN. Before
exposing it to anything wider, understand these defaults:

- **Put it behind HTTPS.** In a Docker deployment this is not optional: the
  session cookie is marked `Secure` under `NODE_ENV=production`, so login fails
  silently over plain HTTP anywhere but `localhost`. See "Getting HTTPS" above
  for the ways to do it. A baseline set of security headers (CSP,
  `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`) is always sent;
  HSTS is added only when you set `ENABLE_HSTS=true`.
- **Registration closes after the first account.** `REGISTRATION_ENABLED` has
  three states: unset means open only while no account exists, `true` means
  always open, `false` means always closed. The unset default is what lets a
  fresh install bootstrap its first account and then shut by itself, with no
  configuration step and no window where a forgotten default leaves signup open.
  To add someone later, set it to `true`, register them, and unset it again.
- **Auth endpoints are rate limited.** Five failed attempts per username and
  twenty per client IP in fifteen minutes, with lockouts escalating from one
  minute to fifteen. State is in-process and resets when the container restarts.
  The server takes the client IP from `X-Forwarded-For` only when the port is
  on loopback or `TRUST_PROXY=true`. See "Client addresses and rate limits".
- **The app binds to `127.0.0.1` by default**, so a reverse proxy is the only
  way in. `APP_BIND=0.0.0.0` publishes it on your LAN instead — which bypasses
  whatever authentication that proxy provides, and, if you reach it over plain
  HTTP, silently breaks login. See "Getting HTTPS" above.
- **`npm run db:seed` creates an `admin` / `password` account.** Delete or change
  it before the instance is reachable by anyone else.
- **The bootstrap superuser password comes from `POSTGRES_PASSWORD`**, and
  production Compose has no fallback for it: a fresh deployment must supply
  one, and must not reuse the published development value. Nothing enforces
  that yet — the postgres image reads the password before any script of ours
  runs.
- **The application connects as its own non-superuser role.** A fresh install
  creates `counterpoise_app` from `APP_DB_PASSWORD`, and the app refuses to
  start if `DATABASE_URL` still carries the published default.
- **Cron endpoints fail closed.** `/api/cron/*` returns 401 unless `CRON_SECRET`
  is set and presented as a bearer token.
- **A reverse proxy in front of Counterpoise must preserve the original `Host`
  header.** The cross-origin write check compares the request's `Origin`
  against its `Host` header (or `X-Forwarded-Host` when the proxy sets it).
  The Rust server does this check in `rust-api/server/src/security.rs`.
  Tailscale Serve preserves `Host` by
  default, so this works out of the box behind it. nginx does **not** — its
  default `proxy_set_header Host $proxy_host` replaces `Host` with the
  upstream address — and a proxy on that default will 403 every write with an
  opaque "Cross-origin request rejected". Configure `proxy_set_header Host
  $http_host;` (or equivalent) if you front Counterpoise with nginx or a
  similar proxy.
- **A reverse proxy also needs a read timeout long enough for "Add demo book".**
  That request runs the whole sample seed inline and holds the connection for
  seconds — it is the longest the app makes, and the only one a short read
  timeout will cut. The seed keeps running server-side when it does, so the
  symptom is a failed request plus a complete demo book the page never showed.

### Separating the application database role

`scripts/postgres-init/01-app-role.sh` creates `counterpoise_app` on the FIRST
initialization of the postgres volume. An instance that already holds a database
skips that directory entirely, so an existing deployment has to be migrated by
hand.

```sql
-- As the bootstrap superuser, against the application database.
CREATE ROLE counterpoise_app LOGIN PASSWORD 'the value of APP_DB_PASSWORD';
ALTER DATABASE counterpoise OWNER TO counterpoise_app;

-- Then, connected to that database, hand over what it contains:
REASSIGN OWNED BY counterpoise TO counterpoise_app;
```

**`REASSIGN OWNED BY` reaches past the database you run it in.** It moves every
object inside the current database *and* every shared object the old role owns
— databases and tablespaces — whichever database the connection is using.
Connecting to the right database confines the first half only, so running it
once per database does not stop the second. On an instance where the bootstrap
role also owns development or test databases, those databases change owner too.
Run it only where the old role owns nothing you mean to leave alone — a
production instance holding one database — and otherwise move ownership by
hand, with `ALTER DATABASE` and an `ALTER ... OWNER TO` per object inside.

Afterwards point `DATABASE_URL` at the new role and restart. The app refuses to
start while `DATABASE_URL` still carries the published bootstrap
credential, so a missed step fails loudly rather than running as a superuser.

#### The bootstrap password

`POSTGRES_PASSWORD` is the superuser's, and it has no default: set your own in
`.env.production.local` before the first start. `scripts/postgres-entrypoint-guard.sh`
runs as the postgres entrypoint and refuses the password this repository
publishes, ahead of `initdb` — the only moment refusing costs nothing, because
no cluster exists yet. Change the variable and start again.

On a deployment ALREADY initialized with that password the guard warns on every
start and lets postgres run, because refusing there would take a working
deployment down without fixing anything. Changing the variable does not help
either: the password lives in the cluster once it is created. Rotate it in
place instead.

```sql
-- As the bootstrap superuser.
ALTER ROLE counterpoise WITH PASSWORD 'a value of your own';
```

Then set that same value as `POSTGRES_PASSWORD` in `.env.production.local`, so
a future re-initialization matches. Backups authenticate as `counterpoise_app`
and are unaffected.

## Backups

The `scheduler` container dumps the database hourly to `./backups`, prunes dumps
older than 30 days, and reindexes monthly.

```bash
# Take a backup now
docker exec counterpoise-scheduler-1 sh -c \
  'pg_dump -Fc "$DATABASE_URL" > /backups/manual-$(date +%Y%m%d-%H%M%S).dump'

# List a dump's contents without restoring
pg_restore --list backups/<file>.dump

# Full restore (drops and recreates all objects) — stop the app first
docker compose stop rust-api
pg_restore --clean --if-exists -d "$DATABASE_URL" backups/<file>.dump
docker compose start rust-api
```

### Get the dumps off the machine

Everything above runs on one disk. Hourly dumps beside the database they came
from protect you from a bad migration or a mistaken delete — not from disk
failure, theft, or ransomware, all of which take the database and every dump
together. Nothing in this repo can fix that for you; it needs a second place.

Two ways, either is fine:

- **A whole-disk backup service** already covering the host — Backblaze, Time
  Machine to a separate drive, or equivalent. Nothing to configure here, as
  long as `./backups` is not in an exclusion list. Check that it is actually
  being picked up rather than assuming it.
- **A scheduled copy of the newest dump** to cloud storage or another machine.
  Run this from the **host's** crontab, not the scheduler container: that
  container is `postgres:16-alpine` and has no `rclone`. Use an absolute path
  to your checkout — `/backups` is the path *inside* the container, and cron
  has no working directory to speak of:

  ```bash
  0 5 * * * rclone copy "$(ls -t /srv/counterpoise/backups/counterpoise-*.dump | head -1)" remote:counterpoise/
  ```

  `restic`, `rsync` over SSH, or `aws s3 cp` all work the same way. Putting the
  copy in the scheduler's crontab instead means building your own image with
  the tool installed — the stock one cannot do it.

Whichever you pick, **keep version history**. A backup that mirrors the current
state one-for-one will faithfully replicate a corruption or an encryption event
to your only other copy. Thirty days of retention turns that from a disaster
into an inconvenience.

The scheduler checks every dump, but check what that check is: `pg_restore
--list` reads the archive's header and table of contents and stops there. It
catches a file whose header or contents list is unreadable, and a `pg_dump`
that failed outright is caught separately by its own exit status. It never
reaches the data blocks, so a dump truncated or corrupted past the contents
list lists cleanly. Nothing here restores a dump or reads a row, so nothing
here can tell you the data inside is complete — only a restore into a scratch
database does that, and none is performed. See Monitoring below.

### Monitoring

Counterpoise reads each dump's table of contents with `pg_restore --list` and
records the outcome of every scheduled job to `backups/status/`. The app surfaces stale or
unverified jobs in the navbar — silently, until something needs attention.

That design assumes **you use the app**. It detects a broken backup job while
everything else works, but it cannot tell you the host is switched off, because
it is running on that host. On a machine you open regularly that gap is covered
by you noticing.

**If you deploy this somewhere you don't look at daily, add an external dead-man
switch** — healthchecks.io or similar — by appending a ping to each cron line in
`docker-compose.yml`. That is the only layer that still reports when the whole
host is down.

## Scheduler

The `scheduler` container runs all cron jobs on a `postgres:16-alpine` image (giving it access to `pg_dump`, `reindexdb`, and `wget`):

| Job | Schedule | Description |
|-----|----------|-------------|
| Recurring transactions | Hourly | Calls `/api/cron/recurring` authenticated with `CRON_SECRET` |
| Plaid sync | Every 6 hours | Calls `/api/cron/plaid-sync` for all linked asset/liability accounts |
| Security price sync | Tue–Sat 6am ET | Calls `/api/cron/price-sync` to fetch Tiingo end-of-day prices |
| Database backup | Hourly, 6am–9pm | `pg_dump` to `backups/counterpoise-<timestamp>.dump` |
| Backup pruning | Daily at 4am | Deletes `.dump` files older than 30 days |
| REINDEX | 1st of month at 3am | `reindexdb "$DATABASE_URL"` |

Manual trigger:

```bash
curl -H "authorization: Bearer ${CRON_SECRET}" http://localhost:3000/api/cron/recurring
```

## Connecting a Bank (Plaid)

Bank sync is optional, and off until `PLAID_CLIENT_ID` and `PLAID_SECRET` are
set — `isPlaidConfigured()` is false without them, so sync fails closed rather
than reaching a live institution.

### 1. Get API credentials

Sign up at [dashboard.plaid.com](https://dashboard.plaid.com). Your `client_id`
and per-environment secrets are under **Developers → Keys**.

Plaid has two environments: **Sandbox**, which serves fake institutions and
fake transactions, and **Production**, which connects real banks. There is no
longer a Development environment — Plaid retired it, so `PLAID_ENV` takes only
`sandbox` or `production`.

Production is not gated behind a sales call for a personal deployment. Developers
signing up in the US or Canada get the **Trial plan**: free, real production
data, auto-approved for most applicants, capped at 10 connected Items. That is
usually enough for one household's banks. (The older Limited Production tier
closed to new signups on 15 April 2026.)

Use the **Sandbox** secret in `.env.local` and the **Production** secret in
`.env.production.local`. `.env.example` explains why that separation is not
optional: a production secret in `.env.local` means `npm run dev` reaches real
banks and bills real API requests, and the separate `counterpoise_dev`
database does nothing to prevent it — it bounds writes, not outbound calls.

### 2. Mint an access token

Counterpoise syncs against a stored access token per institution, but it does
not run Plaid Link itself. `scripts/plaid-link.ts` produces the token:

```bash
npm run plaid:link      # sandbox, via .env.local

# Or, to connect a real bank with the deployment's credentials:
npx tsx --env-file=.env.production.local scripts/plaid-link.ts
```

It prints a Plaid-hosted URL. Open it in any browser, log in to the bank, and
the script prints an **Item ID** and an **Access Token** when the session
completes. In Sandbox, log in to any institution with `user_good` /
`pass_good`.

It stops waiting after ten minutes and prints the command to resume. Use that
rather than re-running plain: a fresh link token stops watching the session you
opened, so an Item you had already created at the bank would sit on your Plaid
plan with no token to exchange for it.

The script uses [Hosted Link](https://plaid.com/docs/link/hosted-link/), where
Plaid serves the Link UI on its own domain, so there is nothing to run locally
and no redirect URI to register. That matters for OAuth institutions — Chase,
Wells Fargo, US Bank — which require a redirect URI that is HTTPS and
registered in the Plaid dashboard, and so cannot be completed against a
`http://localhost` page at all.

### 3. Add the token to a book

Go to **Sync → Manage Sync Tokens**, then **Add Token**. Enter the institution
name, and paste the Item ID and Access Token. Counterpoise fetches the
institution's accounts, and **Assign Accounts** maps each one to a Counterpoise
account.

From then on the `scheduler` sidecar syncs every six hours, staging
transactions for reconciliation rather than writing them to the ledger
directly. Review them on the **Sync** page.

An access token does not expire. Treat it as a credential: it reads the
connected account's transactions until revoked from the Plaid dashboard.

## Moneydance Import

Import data from Moneydance JSON exports:

```bash
# Dry run (recommended first)
npm run import:moneydance -- path/to/export.json --book-id <existing-book-id> --dry-run

# Full import
npm run import:moneydance -- path/to/export.json --book-id <existing-book-id> --verbose
```

Create the destination book first in the UI, or use `npm run db:seed` for a sample seeded book. Use `npm run db:list-books` to find the book ID before importing.

Imports accounts, payees, transactions, investment transactions, security prices, stock splits, and recurring reminders. The script runs `ledger-cli import-moneydance` through `cargo run`, so the first run also builds the Rust CLI. One database transaction holds the import, so a failed import leaves the book as it was. See `guides/moneydance-import.md` for details.

## Usage Examples

### Recording an Expense
**Simple Mode:**
1. Go to Transactions page
2. Select "From Account" (e.g., Checking)
3. Select "To Account" (e.g., Groceries expense)
4. Enter amount: $125.43
5. Click "Add Transaction"

**Result:**
- Checking account decreases by $125.43
- Groceries expense increases by $125.43

### Recording a Paycheck
**Journal Entry Mode:**
1. Switch to "Journal Entry" mode
2. Add split: Main Checking (Debit) $3,500
3. Add split: 401k (Debit) $500
4. Add split: Salary Income (Credit) $4,000
5. Verify splits balance to zero
6. Click "Add Transaction"

### Setting Up Recurring Rent
1. Go to Recurring page
2. Click "New Rule"
3. Name: "Monthly Rent"
4. Frequency: Monthly
5. Start Date: First of month
6. Add splits:
   - Rent Expense (Debit) $1,500
   - Checking (Credit) $1,500
7. Click "Create Rule"

The system will automatically show when it's due and allow one-click processing.

## Double-Entry Accounting Primer

### Account Types & Normal Balances

| Account Type | Normal Balance | Increase | Decrease |
|--------------|----------------|----------|----------|
| Asset        | Debit (+)      | Debit    | Credit   |
| Liability    | Credit (-)     | Credit   | Debit    |
| Equity       | Credit (-)     | Credit   | Debit    |
| Income       | Credit (-)     | Credit   | Debit    |
| Expense      | Debit (+)      | Debit    | Credit   |

### Transaction Examples

**Buying groceries with credit card:**
- Debit: Groceries (expense) +$50
- Credit: Credit Card (liability) -$50

**Paying off credit card:**
- Debit: Credit Card (liability) +$50
- Credit: Checking (asset) -$50

**Receiving salary:**
- Debit: Checking (asset) +$3,000
- Credit: Salary (income) -$3,000

## Development

### Available Scripts

```bash
npm run dev          # Start the web server (the API server runs with cargo; see step 6 above)
npm run build        # Build for production
npm run start        # Start production server
npm run lint         # Run ESLint
npm test             # Run unit tests (Vitest)
npm run test:ui      # Open Vitest UI
npm run test:coverage # Generate coverage report
npm run test:e2e     # Run Playwright E2E tests
npm run db:generate  # Generate a migration from /db/schema.ts into /db/migrations
npm run db:migrate   # Apply pending migrations
npm run db:create-test-dbs  # Create dev + E2E databases (one-time setup)
npm run db:list-books  # List books and their IDs
npm run db:seed -- --book-id 2  # Full reset + seed sample data for a specific book
npm run mcp:dev      # Start the MCP server over stdio (Rust; needs DATABASE_URL and COUNTERPOISE_API_KEY)
npm run plaid:link   # Mint a Plaid access token for one bank (sandbox)
npx drizzle-kit studio  # Open Drizzle Studio (database GUI)
```

For book schema changes, use this workflow:
1. Edit `/db/schema.ts`
2. Run `npm run db:generate`
3. Run `npm run db:migrate`
4. Commit the SQL migration plus the updated snapshot and journal in `/db/migrations/meta/`

Migrations are NOT auto-applied by `getDb()`. Use `runMigrations()` explicitly in scripts; seed and test helpers handle migrations automatically.

### Project Structure

```
/app
  /page.tsx                       # Home / book list
  /login, /register, /account     # Auth pages
  /b/[bookId]/                    # Book-scoped pages
    /page.tsx                     # Dashboard
    /accounts, /transactions      # Core accounting
    /securities, /recurring       # Investment & recurring
    /payees, /sync                # Payees & bank sync
    /reports, /search             # Financial reports & search
  /api/
    /auth/                        # Authentication
    /books/                       # Book management
    /b/[bookId]/                  # Book-scoped API routes
    /cron/                        # Cron endpoints (recurring, plaid-sync, price-sync)
/components
  /ui                             # Reusable UI components
  /accounts, /transactions        # Feature components
  /securities, /sync, /layout     # Domain components
  /reports                        # Financial report components
/db
  /schema.ts                      # Unified database schema (meta + book-scoped tables)
  /index.ts                       # Database connection (getDb)
  /seed.ts                        # Sample data
/lib
  /accounting.ts                  # Accounting helpers
  /investments.ts                 # Investment calculations
  /formatters.ts                  # Display formatters
  /api-auth.ts                    # API authentication
  /reports.ts                     # Financial report logic
/hooks
  /useBookId.ts                   # Client hooks (also useIsMobile, useRegisterShortcuts)
/rust-api
  /server/src/mcp                 # MCP server (AI access to accounting data)
```

## License

MIT — see [LICENSE](LICENSE).

## Contributing

Counterpoise is developed as a personal project and is **not accepting pull
requests, feature requests, or bug reports**. That is not unfriendliness — it is
the point of publishing it.

Fork it and make it yours. The repository is built for exactly that: `CLAUDE.md`
and the `guides/` directory it indexes are a complete machine-readable contract
for the codebase, so your own AI agents can pick it up and build on it without a
human explaining the architecture first. The `.claude/skills/` directory ships the maintainer's own workflows as
worked examples.

If you want to track upstream changes, add this repository as a second remote
and cherry-pick what you want. Releases are tagged `vX.Y.Z`.
