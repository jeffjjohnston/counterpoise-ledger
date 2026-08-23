# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Counterpoise is a multi-book personal finance accounting application built with Next.js 16, implementing true double-entry bookkeeping with investment tracking. The app uses a PostgreSQL database for all data storage, supports user authentication, and includes a Moneydance import tool.

## Development Commands

### Essential Commands
```bash
docker volume create counterpoise_pgdata  # Create persistent data volume (first time only)
docker compose up -d      # Start PostgreSQL (required before dev/test)
npm run dev               # Start development server (http://localhost:3000)
npm run build             # Build for production
npm run lint              # Run ESLint
npx tsc --noEmit          # Type-check without emitting files

# Testing
npm run db:create-test-dbs # Create counterpoise_dev + per-worker test databases (one-time setup)
npm test                  # Run all unit tests with Vitest
npm run test:ui          # Run tests with interactive UI
npm run test:coverage    # Generate test coverage report
npm run test:e2e         # Run Playwright E2E tests

# Database
npm run db:generate      # Generate migrations from /db/schema.ts
npm run db:migrate       # Apply pending migrations to the database
npm run db:seed          # Seed database with sample data (destructive: resets entire DB)
npm run db:seed -- --book-id 2  # Seed into existing book (replaces book data only)
npm run db:rebuild-lots  # Regenerate investment lots from splits (guarded; --force to override)
npx drizzle-kit studio   # Open Drizzle Studio (database GUI, requires DATABASE_URL)

# MCP
npm run mcp:dev          # Start MCP server for AI access to accounting data

# MCP (Docker — production)
docker exec -i counterpoise-app-1 node /app/mcp-server.mjs  # Run MCP server via Docker

# Release & Deploy
./scripts/release.sh [patch|minor|major]  # Bump version, tag, push, create PR to main
./scripts/deploy.sh                       # Pull main, rebuild Docker, restart app
```

### Release & Deploy Workflow

Uses semantic versioning with a squash-merge PR flow. GitHub is configured for squash merges on PRs to main.

```
dev branch (daily work)
    │
    ▼
./scripts/release.sh patch     ← runs checks, bumps version, tags, creates PR
    │
    ▼
GitHub PR: dev → main          ← CI runs lint/typecheck/tests; review & fix
    │
    ▼
Squash-merge PR on GitHub      ← all commits become one commit on main
    │
    ▼
./scripts/deploy.sh            ← builds, moves tag, rebases dev; resumable if it fails
```

**Key details:**
- **Version semantics**: `patch` (bug fixes), `minor` (new features), `major` (breaking changes)
- **Tag accuracy**: `release.sh` creates the tag on dev; `deploy.sh` moves it to the squash commit on main (so the tag always points to exactly what's deployed, even if PR review commits landed after the version bump)
- **Branch sync**: `deploy.sh` records dev's HEAD as the fork point in `.git/DEPLOY_FORK_POINT` before mutating anything. Since deploy runs after the squash merge, everything on dev at that moment was in the squash. The rebase (`git rebase --onto main <fork-point> dev`) drops those commits and replays only work added afterwards, then force-pushes dev. The file is removed only once that push succeeds, so **its presence means a sync is still pending** and a re-run will finish it — including from `main`, which is where a failed deploy leaves you. If no fork point can be determined, the script deploys and then exits non-zero rather than skipping the sync silently.
- **Resuming a failed deploy**: just re-run `./scripts/deploy.sh`. It restores the branch it started on, names the stage that failed, and lists what did not happen. `--yes` skips the "already up to date" prompt for scripted runs; `--fork-point=<sha>` supplies the fork point by hand if the resume file was lost.
- **CI**: GitHub Actions (`.github/workflows/ci.yml`) runs on every PR to main — lint, type-check, tests against a PostgreSQL service container, and a `production-build` job that builds with **no database service**, since a page querying the database at build time passes E2E (which has one) and fails `docker build` (which does not)
- **After release.sh, before merging**: Additional commits can be pushed to dev to address PR feedback. These get included in the squash merge. The version tag is corrected at deploy time.
- **The session-hash migration is not reversible by redeploying the previous image.** Once the `sessions.token` column is renamed to `token_hash`, the old code queries a column that no longer exists and 500s on every authenticated request. Rolling back requires a forward migration (or a new fix-forward deploy), not an image rollback.

### After Making Code Changes
After modifying TypeScript files, always run `npx tsc --noEmit` to check for type errors and fix any that arise before considering the task complete.

Run that exact command — `release.sh` and CI do, and it is the one that gates a
release. In particular do **not** verify with `--incremental false`: it bypasses
`tsconfig.tsbuildinfo` and so cannot reproduce what the release gate sees.

If `tsc` reports errors that contradict `tsconfig.json` — classically
`TS2737: BigInt literals are not available when targeting lower than ES2020`
while `target` already says ES2020 — the incremental cache is replaying
diagnostics recorded under the previous options. Changing `target` does not
reliably invalidate them. Delete `tsconfig.tsbuildinfo` and re-run; the
regenerated cache is correct from then on. This is local only: the file is
gitignored, so CI never sees it.

### Running Individual Tests
```bash
npx vitest tests/lib/accounting.test.ts           # Run specific test file
npx vitest tests/lib/accounting.test.ts -t "validateSplits"  # Run specific test
```

### Working in Git Worktrees
Worktrees live under `.claude/worktrees/<name>/`. A fresh worktree has **no `node_modules`** of its own, which matters differently per tool:

| Tool | Needs `node_modules` in the worktree? | Why |
| ---- | ------------------------------------- | --- |
| Vitest, `tsc`, ESLint | No | Node resolves `node_modules` upward to the main checkout |
| `next dev`, `next build` | **Yes** — run `npm ci` first (~4s warm) | Turbopack computes its own project root and refuses to look above it |

Symlinking `node_modules` into a worktree does **not** work — Turbopack rejects it outright:

```
Error: Symlink [project]/node_modules is invalid, it points out of the filesystem root
```

So run the dev server or E2E suite from a worktree only after `npm ci` in that worktree.

**Gotchas after installing into a worktree:**
- `vitest.config.ts` includes a broad `**/*.test.{ts,tsx}` pattern that would otherwise glob into `.claude/worktrees/` and run a *second* copy of every test. With a worktree-local `node_modules` those load a second React and fail with `Invalid hook call`. The `exclude: [...configDefaults.exclude, "**/.claude/worktrees/**"]` entry prevents this — don't drop it, and keep the `configDefaults` spread (a bare `exclude` *replaces* the defaults rather than extending them, re-enabling `node_modules` scanning).
- `next dev` rewrites `AGENTS.md`, appending a `nextjs-agent-rules` block. It shows up as an unexpected uncommitted change — leave it out of unrelated commits (`git checkout -- AGENTS.md`).
- The E2E standalone build (`next build --webpack`) leaves a stray `.claude/worktrees/node_modules/` holding traced `next`/`styled-jsx` copies. Delete it.

### Import Scripts
```bash
# Import from Moneydance export file into a specific book
npx tsx scripts/import-moneydance/index.ts path/to/export.json --book-id <existing-book-id> --verbose

# Dry run (no database writes)
npx tsx scripts/import-moneydance/index.ts path/to/export.json --book-id <existing-book-id> --dry-run
```

Create the target book first, then use `npm run db:list-books` to discover its ID. `npm run db:seed` (without args) creates a sample `admin` user, sample book, and seed data.

## Architecture Overview

### Tech Stack
- **Framework**: Next.js 16 with App Router
- **Language**: TypeScript (strict mode)
- **Database**: PostgreSQL with postgres.js driver
- **ORM**: Drizzle ORM (type-safe queries)
- **Testing**: Vitest (unit), Playwright (E2E)
- **Styling**: Tailwind CSS

### Path Aliases
All imports use `@/` prefix mapping to project root:
```typescript
import { getDb } from "@/db";
import { validateSplits } from "@/lib/accounting";
```

### PostgreSQL Database
All data lives in a PostgreSQL database. Local development defaults to `postgresql://counterpoise:counterpoise@localhost:5432/counterpoise_dev` when `DATABASE_URL` is unset. Docker deployment uses a separate `counterpoise` database via `.env.production.local`. Meta tables (users, sessions, books) and book-scoped tables coexist in one schema, with a `bookId` foreign key on every book-scoped table for data isolation.

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

- **Schema**: All tables defined in `/db/schema.ts`
- **Connection**: `getDb()` from `/db/index.ts` returns a cached Drizzle instance (does NOT auto-migrate; use `runMigrations()` explicitly in scripts)
- **Pages** live under `/app/b/[bookId]/...` (e.g., `/app/b/[bookId]/transactions/page.tsx`)
- **API routes** live under `/app/api/b/[bookId]/...` (e.g., `/app/api/b/[bookId]/transactions/route.ts`)
- **Auth routes** at `/app/api/auth/...` (login, register, logout, me, password, api-keys)
- **Book management** at `/app/api/books/...`

### Layered Architecture
```
Client Components (React)
    ↓
API Routes (/app/api/b/[bookId]/*/route.ts)
    ↓
Auth + Book ID (/lib/api-auth.ts → getDb + bookId)
    ↓
Business Logic (/lib/*.ts)
    ↓
Data Access (Drizzle ORM, filtered by bookId)
    ↓
PostgreSQL Database
```

### Database Connection
```typescript
// In API routes — always use authenticateBookRequest to get the book's DB:
import { authenticateBookRequest } from "@/lib/api-auth";

export async function GET(request: Request, { params }: { params: Promise<{ bookId: string }> }) {
  const { bookId } = await params;
  const auth = await authenticateBookRequest(bookId);
  if (isError(auth)) return auth.error;
  const { db } = auth;
  // Use db (Drizzle ORM instance for this book)
}

// In scripts (seed, import) — use getDb directly, and run migrations first:
import { getDb, runMigrations } from "@/db";
await runMigrations();
const db = getDb();
```

A third kind of `db` exists and does **not** behave like the other two.
`withAdvisoryLock` (`/lib/advisory-lock.ts`) hands its callback a Drizzle
instance bound to a *reserved* postgres.js connection. Reserved connections
expose only `types`, `typed`, `unsafe`, `notify`, `array`, `json`, `file` and
`release`; `options`, `begin` and `savepoint` belong to the pool, and Drizzle
needs all three — it writes type parsers to `client.options`, implements
`db.transaction()` as `client.begin(...)`, and a nested transaction as
`client.savepoint(...)`. `getDbForConnection` in `/db/index.ts` grafts them on,
so always go through it rather than `drizzle(connection)`.

The missing transaction grafts silently disabled Plaid auto-matching for four
releases: `autoMatchPendingTransactions` claims each row in a transaction, so
every sync with something to match died on `this.client.begin is not a
function` — and did so *after* committing its cursor and clearing `lastError`,
which is why the failure surfaced as an error banner that a manual re-sync
appeared to fix. Any new `db.transaction(...)` reachable from inside the lock
depends on those grafts.

## Database Schema & Accounting Model

### Core Tables
- **accounts**: Chart of accounts with hierarchical structure (parent-child)
  - Types: `asset`, `liability`, `equity`, `income`, `expense`
  - Subtypes: `bank`, `credit_card`, `loan`, `investment`, `cash`, `other`
  - Special field: `isInvestmentCash` for auto-created investment cash accounts
  - `icon` (nullable): one emoji grapheme. **`null` means "inherit from the parent account" — never "no icon".** Resolved at render time by `resolveAccountIcon()`/`resolveAccountIconSource()`; only `income`/`expense` accounts show a picker or resolve an icon for display

- **transactions**: Main transaction records with date, description, payee
  - Links to `payees` (optional) and `recurringRules` (optional)

- **transactionSplits**: Double-entry splits (debits/credits)
  - Positive amounts = debits, negative = credits
  - Must sum to zero per transaction

- **securities**: Investment securities (stocks, ETFs, mutual funds)
  - Fields: name, symbol, securityType (etf/mutual_fund/stock), fetchPrices, fixedPriceMicros
  - `fixedPriceMicros` (nullable): a price that never moves — a money market fund at a $1.00 NAV. Non-null means fixed-price (see Fixed-Price Securities below); null means the price comes from `securityPrices`

- **securityPrices**: Historical price data per security per date
  - Composite key: securityId + priceDate

- **investmentSplits**: Investment-specific transaction data
  - Actions: `buy`, `sell`, `dividend`, `capGain`, `fee`, `split`
  - Links to `securities`, `investmentLots`, and accounts
  - Stores shares and prices in micros (1,000,000 = 1 share/dollar)

- **investmentLots**: FIFO lot tracking, scoped to (book, account, security)
  - Quantities live on the row: `originalSharesMicros`/`originalBasisCents` and `remainingSharesMicros`/`remainingBasisCents`
  - `acquiredDate` drives the short vs long-term holding period
- **investmentLotAllocations**: which lots a sell consumed, and how much of each
  - One row per (sell split, lot): `sharesMicros`, `basisCents`, `proceedsCents`
  - Realized gain is always `proceedsCents - basisCents`; never stored

- **recurringRules** / **recurringTemplateSplits**: Recurring transaction templates

- **apiKeys**: User API keys for MCP server authentication
  - Fields: `userId`, `name`, `keyHash` (scrypt), `keyPrefix` (first 8 chars for lookup), `lastUsedAt`

- **issueReports**: In-app issue reports (meta table — scoped to `userId`, not `bookId`)
  - Fields: `userId`, `description`, `type` (`bug`/`improvement`/`other`), `page`, `status` (`new`/`resolved`/`wontfix`)
  - Written by `ReportIssueModal`; consumed by the `fix-reported-issue` skill

- **plaidTokens** / **plaidAccounts** / **plaidTransactionReconciliation**: Plaid bank sync integration
  - `plaidTokens`: Stores Plaid access tokens and `syncCursor` for incremental transaction sync
  - `plaidAccounts`: Links Plaid accounts to Counterpoise accounts (`counterpoiseAccountId`)
  - `plaidTransactionReconciliation`: Staged Plaid transactions awaiting reconciliation
    - `resolutionStatus`: `pending`, `matched`, `created`, `ignored`
    - `reviewReason`: `plaid_modified` or `plaid_removed` (flags items needing human review)
    - `matchedTransactionId`: FK to local transaction when matched (manually or auto-matched)

### Critical Accounting Rules

1. **Balance Validation**: All transaction splits MUST sum to zero
   - Use `validateSplits()` from `lib/accounting.ts` before creating transactions

2. **Normal Balances** (sign conventions):
   - Assets & Expenses: Positive (debit normal)
   - Liabilities, Equity & Income: Negative (credit normal)

3. **Investment Precision**:
   - Shares stored in micros (multiply by 1,000,000)
   - Prices stored in micros
   - Cash amounts in cents
   - **IMPORTANT**: `sharesMicros` in `investmentSplits` table should ALWAYS be stored as positive values. The `action` field (`buy` vs `sell`) determines the direction. Use `Math.abs(samtMicros)` when importing.

4. **Investment Position Calculation**:
   - Use `aggregatePositions()` from `lib/investments.ts`
   - Splits are processed chronologically; same-date ties retain insertion order
   - For `action === "split"`: apply the split ratio to existing shares (corporate action, not a sign-applied delta)
   - Otherwise: `sharesDelta = sign * sharesMicros` where `sign = action === "sell" ? -1 : 1`

5. **Floating Transactions**:
   - `isFloating` boolean on transactions — effective date auto-advances to today
   - Use `effectiveDateSql` from `lib/accounting.ts` in all SQL queries that filter/sort/aggregate by date
   - Use `getEffectiveDate()` from `lib/accounting.ts` in client-side code for display and sorting
   - When reconciling a floating transaction: set `isFloating=false`, update `date` to cleared date, set `isReconciled=true`
   - Stored `date` field retains the original entry date while floating; it's overwritten with the cleared date on reconciliation

## Key Business Logic Files

### `/lib/accounting.ts`
Core accounting functions:
- `validateSplits(splits)` - Ensures debits = credits
- `getNormalBalanceSign(type)` - Returns 1 or -1 based on account type
- `getDisplayBalance(balance, type)` - Converts to display format
- `buildAccountTree()` - Creates hierarchical account structure
- `buildAccountHierarchyName()` - Creates display names (e.g., "Parent -> Child")
- `getNextDate()`, `getInitialNextDate()`, `describeRecurrence()` - Recurring transaction helpers
- `buildBuySplits()`, `buildSellSplits()`, `buildDividendSplits()`, `buildCapGainSplits()` - Investment split builders
- `mapInvestmentActionToSplits()`, `validateInvestmentAction()` - Investment action helpers
- `groupAccountsByType()` - Group accounts by type for display
- `resolveAccountIcon()` - Walks `parentId` upward and returns the first icon found; an account's own icon wins, `null` means no ancestor has one either
- `resolveAccountIconSource()` - Same walk, also returns the short name of the ancestor the icon came from (for "Inherits 🚗 from Automobile")
- `buildCategoryLabelMap()` - Precomputes icon/text/title per category account, memoized once per account list; holds entries only for `income`/`expense` accounts — a lookup miss is the deliberate fallback to today's full-path display, which is what keeps every renderer free of an `account.type` check

### `/lib/investments.ts`
Investment calculations:
- `aggregatePositions(splits, securities, prices)` - Calculates current positions (shares and market value only)
- `getPositions(db, bookId, accountId?)` - Full position query with market values; cost basis is summed from `investmentLots.remainingBasisCents`, not recomputed from splits (see Lot Tracking below)
- `getMarketValuesByAccount(db, bookId, asOfDate?)` - Aggregate market value by account

### `/lib/formatters.ts`
Display formatting:
- `formatCurrency(cents)` - Converts cents to USD string
- `formatDate(dateString)` - Formats YYYY-MM-DD for display
- `formatDateShort(dateString)` - Short date format
- `toDateString(date)` - Convert Date to YYYY-MM-DD
- `parseCurrency(string)` - Parses user input to cents
- `getAccountShortName(name)` - Extract short name from full path

### `/lib/api-auth.ts`
Authentication and book access:
- `authenticateRequest()` - Basic auth for non-book routes
- `authenticateBookRequest(bookId)` - Book-scoped auth, returns `{ db, bookId, userId, book }`
- `isError()` - Type guard for auth error checking. On failure the result carries the
  response as `auth.error` (the type is `{ error: NextResponse }`) — **not** `auth.response`

### `/lib/api-keys.ts`
API key management:
- `generateApiKey()` - Creates `cpk_` + 48 hex char key
- `getKeyPrefix(key)` - Extracts first 8 chars for DB lookup
- `hashApiKey(key)` - Scrypt hash for storage
- `verifyApiKey(key, hash)` - Timing-safe scrypt verification

### `/lib/auth.ts` & `/lib/session.ts`
User authentication:
- `hashPassword()`, `verifyPassword()` - Scrypt-based password handling
- `createSession()`, `getSession()`, `destroySession()` - 30-day session management with HTTP-only cookies

### `/lib/transactions.ts`
Shared transaction logic (used by both API routes and MCP tools):
- `createTransaction(db, bookId, input)` - Creates a transaction with splits and optional investment splits
- `updateTransaction(db, bookId, transactionId, input)` - Updates fields and/or replaces splits
- `TransactionValidationError` - Invalid input (splits don't balance, etc.)
- `TransactionNotFoundError` - Transaction ID doesn't exist in the book

### Other lib files
- `/lib/payees.ts` - `normalizePayeeName()` for deduplication
- `/lib/pricing.ts` - Security price data handling
- `/lib/securities.ts` - Security validation (`SecurityValidationError`, `SecurityDuplicateError`) shared by API and MCP
- `/lib/expression.ts` - `evaluateExpression()` parser for amount inputs (supports `+`, `-`, `*`, `/`, parens — e.g., user can type `12.50 + 3` in an amount field)
- `/lib/csv.ts` - CSV export helpers (`csvEscape()`, `triggerDownload()`) used by the securities and income statement pages
- `/lib/merge-transactions.ts` - `mergeTransactionsForDisplay()` interleaves projected (recurring) and actual transactions in date order for the transaction list
- `/lib/plaid.ts` - Plaid API client (link tokens, access tokens, transaction sync fetch)
- `/lib/plaid-sync.ts` - `syncToken()` — fetches Plaid transactions, stages in reconciliation table, runs auto-match
- `/lib/plaid-auto-match.ts` - `autoMatchPendingTransactions()` — learned payee-based auto-matching
- `/lib/recurring.ts`, `/lib/recurring-processing.ts` - Recurring transaction logic
- `/lib/reports.ts` - Financial report logic (`groupSplits()`, `computeGrandTotal()`, `buildTopParentMap()`)
- `/lib/utils.ts` - `cn()` utility for Tailwind class merging

## API Route Patterns

### Book-Scoped CRUD Pattern
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

### Transaction Creation Pattern
See `/app/api/b/[bookId]/transactions/route.ts` for full example:
1. Authenticate and get book DB
2. Parse and validate input
3. Validate splits balance to zero
4. Check if investment splits required
5. Create/lookup payee (normalized name matching)
6. Insert transaction, splits, and investment splits atomically
7. Return fully populated transaction with relations

## Investment Transaction Handling

### Creating Investment Transactions
Use builder functions from `lib/accounting.ts`:
```typescript
// Buy 100 shares at $50.00 with $10 fee
const splits = buildBuySplits({
  securityAccountId: 5,
  cashAccountId: 6,
  feeAccountId: 7,
  sharesMicros: 100_000_000,  // 100 shares
  priceMicros: 50_000_000,    // $50.00
  feesCents: 1000,            // $10.00
});
```

### Investment Split Validation
Before creating investment transactions, validate:
1. Investment account exists and is active
2. Security exists
3. Shares and prices are positive and finite
4. For sells: lot matching will be applied (FIFO)

### Lot Tracking

Lots and allocations are **derived state**, not something any write path is
meant to populate directly. `rebuildLots()` in `/lib/lots-db.ts` is the only
code that **inserts** rows into `investment_lots` or `investment_lot_allocations`
at runtime — but it is not the only thing that ever writes those tables, and
an earlier version of this section overstated that it was. Two other paths
touch them:
- The Moneydance importer's own superseded Pass 1/2 (below) insert
  `investment_lots` directly while building the initial import — never
  `investment_lot_allocations` — and a `rebuildLots` pass run later in the
  same import (after stock splits are imported — see Moneydance Import
  System below) regenerates `investment_lots` from the splits Pass 1/2 just
  wrote, so their direct writes never survive the import.
- Rows disappear via FK cascade (`onDelete: "cascade"` in `/db/schema.ts`)
  wherever a transaction, investment split, or lot is deleted, without going
  through `rebuildLots` at all: deleting a transaction cascades to its
  investment splits and their lot allocations (the transaction DELETE route,
  `tests/helpers/db-utils.ts` test teardown); deleting a lot cascades to its
  allocations (`scripts/import-moneydance/overwrite.ts`, which deletes
  `investment_lots` directly and never touches `investment_lot_allocations`
  itself). Grepping TypeScript for `insert`/`update`/`delete` cannot see a
  cascade declared in the DDL, which is exactly how this claim ended up wrong
  more than once — check the schema, not just the call sites.

Aside from those two paths, `rebuildLots` is the sole writer. It deletes and
regenerates one (account, security) pair by replaying that pair's investment
splits through the pure `replayLots()` engine in `/lib/lots.ts`.

Every write path that can change a pair's split history calls `rebuildLots`
inside the same DB transaction as the write itself: `createTransaction`,
`updateTransaction` (for both the prior and current pairs, since an edit can
move a split to a different security or account), and the transaction DELETE
route. Recompute-over-increment is deliberate: transactions are freely
backdated, so an incremental engine has no cheap way to answer which existing
allocations a newly inserted earlier buy invalidates — recomputing the whole
pair from its splits sidesteps that question entirely.

`rebuildLots` takes `pg_advisory_xact_lock(accountId, securityId)` as its
*first* statement, before it even runs the SELECT that reads the pair's
splits. The lock has to come first because the rows it inserts are computed
from that read — locking only at the later DELETE would leave the read itself
unprotected, letting two concurrent rebuilds of the same pair each read a
stale view and then both write from it. This locking only works when
`rebuildLots` runs inside an explicit `db.transaction(...)`: the advisory lock
is released at commit or rollback, so a caller that passes the top-level `db`
instead of a `tx` acquires and releases it within its own implicit
single-statement transaction and gets no protection across calls. Every
production call site passes a real `tx`.

The deploy-time backfill (`/scripts/rebuild-lots.ts`, run by
`docker-entrypoint.sh` after migrations, guarded — see Critical Files
Reference) does every book and pair inside **one transaction**, not one per
pair. That's what makes its "allocations already exist" guard trustworthy:
with per-pair commits, a crash partway through plus Docker's
`restart: unless-stopped` on the `app` service would let the guard see partial
progress as "already populated" on the next boot and silently skip the
remaining pairs — serving zero cost basis for them while reporting success. A
failure aborts container startup on purpose, because the alternative is
serving that zero cost basis with no visible error. Note that this only
catches a rebuild that *fails*. A rebuild that succeeds and is wrong — say
from a bug in `replayLots` — starts up cleanly and serves incorrect cost
basis and realized gains with no error anywhere, which no automated signal
here can distinguish from a correct one.

Short positions (sell-to-open) are **not** modeled — the `action` enum has no
open/close discriminator, `lib/investments.ts` skips positions with
`sharesMicros <= 0` in two places, and short-lot economics invert the normal
basis/proceeds relationship. See the design doc's Out of Scope section before
attempting to add them.

**Floating transactions drift, latently.** `rebuildLots` materializes
`effectiveDateSql` into `investment_lots.acquiredDate` at rebuild time — a
snapshot, not a live value. A **floating** transaction's effective date
advances to today every day until it's reconciled, but a floating buy's
persisted `acquiredDate` freezes at whatever "today" was on the last rebuild
and does not follow it. Left open, the lot looks older than it actually is
(biasing term classification toward long-term) and its FIFO ordering can drift
relative to fixed-date trades. This is checked as of this writing: production
has zero floating transactions of any kind, so the drift is latent, not
observed. The pair self-heals on any write that triggers `rebuildLots` for
it — nothing to fix, nothing to migrate.

The Moneydance importer's own Pass 1 (create buys and lots) and Pass 2 (FIFO
sell matching) — see Moneydance Import System below — are now superseded by a
`rebuildLots` call in its own phase near the end of the import, after stock
splits are imported, and are slated for deletion in a later release alongside
`investmentSplits.lotId`. The rebuild has to run after stock splits, not
inside the investment transactions phase that writes Pass 1/2's rows: a sell
that follows an imported stock split needs the split's "split" action row
present before replay, or the engine matches it against pre-split share
counts and corrupts cost basis, realized gains, and holding term.
That column has no remaining **reader** in production code — Pass 2 above is
still its only writer, setting it to a value nothing ever reads back — and
the missing reader is exactly the precondition for dropping the column. The
drop itself is deliberately deferred to a separate release. Adding the lots
tables and columns was backward compatible,
so this release can be rolled back from; dropping `lotId` in the same release
would not be, because the previous image still queries that column on every
transaction read and would 500 on rollback (the same trap CLAUDE.md records
above for the session-hash migration).

## Moneydance Import System

### Import Architecture
Located in `/scripts/import-moneydance/`, the importer runs this flow:
1. **Accounts** - Creates chart of accounts + auto-generates investment cash accounts
2. **Opening Balances** - Sets initial balances for accounts (loans, etc.)
3. **Payees** - Imports and deduplicates payees
4. **Standard Transactions** - Non-investment transactions
5. **Investment Transactions** - Two-pass: buys first, then FIFO sell matching
6. **Security Prices** - Historical price data
7. **Stock Splits** - Corporate actions
8. **Lot Rebuild** - Runs `rebuildLots` over every affected `(account, security)` pair, in `index.ts` (not inside the Investment Transactions phase). Must come after Stock Splits: a sell that follows an imported split needs the split's "split" action row on the books first, or the FIFO replay matches it against pre-split share counts and corrupts cost basis, realized gains, and holding term for that pair.
9. **Recurring Reminders** - Converts eligible reminders into recurring rules

### CLI Usage
```bash
npx tsx scripts/import-moneydance/index.ts <path-to-json> --book-id <id> [options]

Options:
  --book-id <id>    Book ID to import into (required)
  --dry-run         Parse and validate without writing to database
  --no-inactive     Skip inactive accounts
  --no-hidden       Skip hidden accounts
  --verbose         Show detailed progress
```

### Key Import Classes
- `IdMapper` (in `types.ts`) - Maps Moneydance UUIDs to Counterpoise integer IDs
- Phase parsers in `/parsers/` directory: `accounts.ts`, `opening-balances.ts`, `payees.ts`, `transactions.ts`, `investment-transactions.ts`, `security-prices.ts`, `stock-splits.ts`, `reminders.ts`

### Important Import Details
- Investment transactions use two-pass processing:
  - Pass 1: Create all buys and lots
  - Pass 2: Match sells to lots using FIFO
  - Both passes' hand-written lot writes (Pass 1's inserts, Pass 2's `closedTransactionId` update and `investmentSplits.lotId` stamping — the importer never touches `investment_lot_allocations`) are superseded by a `rebuildLots` call over every affected pair in the Lot Rebuild phase, which runs after Stock Splits, not inside this phase (see Lot Tracking above and Import Architecture's stage list) — Pass 1/2's own lot bookkeeping is dead weight kept only until `investmentSplits.lotId` is dropped in a later release
- Share conversion: Moneydance uses variable precision (typically 10^5), Counterpoise uses micros (10^6)
- **Bug fix applied**: Sell transactions must store `sharesMicros` as positive values

## Testing Guidelines

### Test Organization
```
/tests
  ├─ lib/           # Unit tests for business logic
  ├─ api/           # Integration tests for API routes
  ├─ app/           # App/page tests
  ├─ components/    # Component tests
  ├─ db/            # Database tests
  ├─ hooks/         # Hook tests
  ├─ import/        # Import functionality tests
  ├─ mcp/           # MCP tools tests
  ├─ e2e/           # Playwright E2E tests
  └─ helpers/       # Test utilities (db setup, mocks)
```

### Writing Tests
- Use Vitest for unit and integration tests
- Run `npm run db:create-test-dbs` once to create per-worker PostgreSQL test databases
- Each test worker gets its own isolated PostgreSQL database
- Use test helpers from `/tests/helpers/db.ts` for setup
- Follow existing patterns in `/tests/lib/accounting.test.ts`
- Calling a lib function with the pooled `getDb()` does **not** cover the
  reserved-connection path. Anything reachable from `withAdvisoryLock` needs a
  test that goes through the lock — passing the pooled db is exactly how the
  auto-match transaction bug reached production despite ~20 auto-match tests

### Test Coverage
Focus coverage on:
- Business logic functions (`/lib/*.ts`)
- API route validation
- Investment calculations (critical for accuracy)

## Component Development

### UI Component Library
Located in `/components/ui/`:
- `Button.tsx`, `Input.tsx`, `Select.tsx`, `Tabs.tsx` - Form controls
- `Modal.tsx` - Dialog container
- `Card.tsx` - Card layout
- `Toast.tsx` - Notification toasts
- `DateRangeFilter.tsx` - Date range filtering
- `DateInput.tsx` - Date input field
- `Skeleton.tsx` - Loading skeleton placeholders
- `EmptyState.tsx` - Empty state displays
- `ThemeToggle.tsx` - Dark/light theme toggle
- `Textarea.tsx` - Multi-line text input
- `AccountAutocomplete.tsx` - Account selection with type-ahead search
- `PayeeAutocomplete.tsx` - Payee selection with search
- `SecurityAutocomplete.tsx` - Security selection with search
- `CategoryIcon.tsx` - Renders a resolved category icon in a fixed-width box; the only component that knows an icon is an emoji

### Feature Components
Organized by domain:
- `/components/accounts/` - Account management (AccountList, AccountForm, AccountCard, PositionsTable, IconPicker)
- `/components/transactions/` - Transaction forms and lists (TransactionForm, TransactionList, SplitEditor, InvestmentPositionsSection, NoteIndicator)
- `/components/securities/` - Security management (SecurityForm, PriceHistoryEditForm, StockSplitEditForm, UpdatePricesModal)
- `/components/reports/` - Financial reports (ReportConfigPanel, ReportTable)
- `/components/sync/` - Plaid sync (ReconciliationModal)
- `/components/layout/` - Navigation (Navbar, BookNavbar, PriceEntryPill)
- `/components/ThemeProvider.tsx` - Root theme provider
- `/components/KeyboardShortcutProvider.tsx` + `/components/ui/KeyboardShortcutOverlay.tsx` - Global keyboard shortcut system. Register shortcuts in client components via `useRegisterShortcuts()` from `/hooks/useRegisterShortcuts.ts`; press `?` to view the overlay.
- `/components/ReportIssueModal.tsx` - In-app issue reporting (writes to `issue_reports` table; consumed by the `fix-reported-issue` skill)
- `/components/transactions/PlaidBanner.tsx` - Banner shown on transactions linked to a Plaid reconciliation row

### Client vs Server Components
- Pages are Server Components by default
- Use `"use client"` for interactive components
- API data fetching happens in Server Components or via client fetch
- Use `useBookId()` from `/hooks/useBookId.ts` for current book ID; `useIsMobile()` from `/hooks/useIsMobile.ts` for responsive logic; `useRegisterShortcuts()` from `/hooks/useRegisterShortcuts.ts` for keyboard shortcut registration

### The Mobile/Desktop Breakpoint Is In Two Places

The layout switch is **`lg` (1024px)**, and it is declared twice: as Tailwind
`lg:` classes in `BookNavbar.tsx`, `transactions/page.tsx` and
`accounts/page.tsx`, and as `MOBILE_BREAKPOINT` in `/hooks/useIsMobile.ts`.
**The two must move together.** The CSS controls the navbar, sidebar, drawer and
FAB; the hook is what `TransactionList.tsx` reads to render the card list
instead of the register table. Change one alone and you get a half-switched
layout — the sidebar hides while the crushed table stays.

It is `lg`, not `md`, because the desktop navbar needs ~1019px. At `md` (768px)
every portrait iPad rendered a navbar it could not fit, which pushed More,
Search, Report an issue and the user menu off-screen entirely, and scrolled the
whole document sideways. The book-name button is capped (`sm:max-w-[10rem]`) so
that width stays bounded no matter how long a book is named.

Two register tables are `table-fixed` with a `<colgroup>` mixing `rem` and `%`
widths. Fixed widths are satisfied first, so when they exceed the container the
percentage column collapses to **0px** and its text paints over its neighbour —
this is how the Activity column disappeared. Keep the fixed columns under 36rem;
`TransactionList.test.tsx` asserts that budget.

## Common Patterns & Gotchas

### Transaction Balance Validation
Before inserting transactions, always validate:
```typescript
import { validateSplits } from "@/lib/accounting";
if (!validateSplits(splits)) {
  throw new Error("Transaction splits must sum to zero");
}
```

### Investment Shares Sign
Investment split `sharesMicros` should ALWAYS be positive. The `action` field determines direction:
- Buy: positive shares added to position
- Sell: positive shares subtracted from position (sign applied in calculation)

### Date Formatting
- Database stores dates as `YYYY-MM-DD` strings
- Use `toDateString()` from `lib/formatters.ts` to convert Date objects
- Use `formatDate()` for display formatting

### Payee Normalization
Payees are deduplicated using normalized names:
```typescript
import { normalizePayeeName } from "@/lib/payees";
const normalized = normalizePayeeName(input); // Trims, collapses whitespace runs, normalizes curly quotes to '
```

**It does not lowercase** — "IKEA" and "Ikea" are deliberately distinct
payees. The importer has its own copy, `normalizeName()` in
`scripts/import-moneydance/utils/format.ts`, which must stay behaviorally
identical or an import creates duplicates of payees the app already has.

## Database Management

### Schema Location
- All tables (meta + book-scoped): `/db/schema.ts`

### Making Schema Changes
1. Edit `/db/schema.ts`
2. Run `npm run db:generate` to create a migration in `/db/migrations/`
3. Run `npm run db:migrate` to apply the migration
4. Commit **all** generated files: the SQL migration (`db/migrations/NNNN_*.sql`), the snapshot (`db/migrations/meta/NNNN_snapshot.json`), and the updated journal (`db/migrations/meta/_journal.json`). Drizzle needs the snapshot to compute future diffs correctly.
5. Update TypeScript types (Drizzle auto-generates)

Migrations are NOT auto-applied by `getDb()`. Use `npm run db:migrate` (or `runMigrations()` in scripts). Test helpers handle migrations for tests.

### ⚠️ Never Manually Alter the Production Database
Do not use `ALTER TABLE`, `CREATE INDEX`, or other DDL statements directly against the production database. Drizzle tracks applied migrations by hash in its `__drizzle_migrations` table — manual changes desync the schema from the migration history, causing future migrations to fail (e.g., `column already exists`). Always make schema changes through `db/schema.ts` → `npm run db:generate` → deploy.

### Database Location
- Local PostgreSQL default: `postgresql://counterpoise:counterpoise@localhost:5432/counterpoise_dev`
- The `counterpoise_dev` database is created by `npm run db:create-test-dbs` — Docker Compose only creates the `counterpoise` database
- Docker deployment database: `counterpoise`, reached as the **`counterpoise_app`** role, not the bootstrap one
- Override with `DATABASE_URL` environment variable
- Run `docker compose up -d` to start the local PostgreSQL instance
- Inspect with `npx drizzle-kit studio` (see Essential Commands)

### Two Roles, One Instance

`counterpoise` (bootstrap superuser) and `counterpoise_app` (owner of the
production database, **not** a superuser) share one PostgreSQL instance.

The split exists because the bootstrap credential is *published* —
`.env.example`, the README, and four hardcoded fallbacks (`db/index.ts:10`,
`scripts/create-test-dbs.ts`, `scripts/docker-migrate.mjs`,
`playwright.config.ts`) all carry `counterpoise:counterpoise`. That is
deliberate: those open `counterpoise_dev`, `counterpoise_e2e` and
`counterpoise_test_0..8`, which are disposable, and `tests/setup.ts` builds a
*different* connection string per worker — so exporting one `DATABASE_URL` to
re-point them would collapse all eight workers onto one database and destroy
test isolation. The dev credential cannot move. Production moved instead.

- `scripts/postgres-init/01-app-role.sh` creates the role from `APP_DB_PASSWORD`
  on **first initialization only**. The postgres image skips
  `/docker-entrypoint-initdb.d` once the volume holds a database, so setting
  that variable later does nothing. Same trap as `POSTGRES_PASSWORD`, which
  `initdb` reads and nothing else — editing it on a populated volume is
  silently ignored, and the role's password changes only via `ALTER ROLE`.
- `scripts/check-db-credential.sh` runs from `docker-entrypoint.sh` before
  migrations and aborts startup when `DATABASE_URL` carries the published
  default. It is **not** a `${APP_DB_PASSWORD:?}` guard in `docker-compose.yml`:
  Compose interpolates the whole file before selecting services, so a required
  variable there also blocks `docker compose up -d postgres`, `ps`, `logs` and
  `down` (measured). Checking the connection string also catches the operator
  who sets `APP_DB_PASSWORD` and forgets to update `DATABASE_URL`.
- Migrating a pre-existing instance was a one-off, already done for the only
  such deployment. The README no longer carries the procedure; recover it from
  git history if it is ever needed again (`git log -S "REASSIGN OWNED BY" --
  README.md`). The trap it documents still holds: **never** `REASSIGN OWNED BY`
  — databases are shared objects, so it retitles every database the role owns
  instance-wide, dev and test included. A per-database ownership loop is what
  that migration needs.

## Recurring Transactions

### How Recurring Rules Work
- Stored in `recurring_rules` table with frequency and date settings
- Template splits stored in `recurring_template_splits`
- `nextDate` field tracks next due date
- `autoCreateDaysBefore` (default 0) lets a rule's transaction be auto-created up to N days before it's due
- `businessDaysOnly` (default false) shifts an occurrence that lands on a weekend to the following Monday — see Business-Day Occurrences below
- Process via POST to `/api/b/[bookId]/recurring/process`
- Cron endpoint at `/api/cron/recurring` runs hourly (via Docker `scheduler` sidecar; same sidecar runs Plaid sync — see below)

### Processing Due Rules
1. Check if the *observed* date (`getOccurrenceDate(nextDate, businessDaysOnly)`) is `<= today` (plus `autoCreateDaysBefore`)
2. Create new transaction from template, dated the observed date
3. Calculate next date using `getNextDate()` function — from the **scheduled** `nextDate`, never the observed one
4. Update rule's `nextDate`
5. If past `endDate`, deactivate rule

### Business-Day Occurrences
`getOccurrenceDate(scheduledDate, businessDaysOnly)` in `/lib/recurring.ts` is
the single place the shift is applied, and it is applied at *read* time — when a
scheduled date becomes a transaction date — never written back into the rule.
Storing the shifted date in `nextDate` would make `getNextDate()` compute the
following occurrence from the Monday, so a rule due on the 15th would creep to
the 17th and stay there.

Everything that turns a rule into dates goes through it: `processRecurringRuleById`
and `processAllRecurringRules` (`/lib/recurring-processing.ts`), the projection
route (`/app/api/b/[bookId]/recurring/projected/route.ts`), the recurring page's
due badge, "Next:" line and calendar, and the global search page's "Next Date"
column (`lib/search.ts` carries `businessDaysOnly` through so the two pages
cannot disagree). `isRecurringRuleDue()` takes `businessDaysOnly` as an optional
4th argument and compares the observed date, so a rule whose occurrence falls on
a Saturday is not due — and is not created — until the Monday it will be dated.

`advanceNextDateToFuture()` (`/lib/accounting.ts`) needs the observed date too,
for the opposite reason: it decides which scheduled occurrence to *store* when a
rule is created or its schedule is edited. Comparing raw dates against today
threw away a Saturday occurrence for a rule created on that Sunday or Monday,
even though the rule would still have created the transaction on the Monday. It
takes an optional `observe` transform rather than a `businessDaysOnly` flag:
`lib/recurring.ts` already imports `lib/accounting.ts`, so a flag would need
either a circular import or a second copy of the shift inside `accounting.ts`.
Callers pass `(date) => getOccurrenceDate(date, businessDaysOnly)`; the default
leaves dates alone.

Two consequences worth knowing:
- **Weekends are the whole definition of "non-business day."** Bank holidays are
  not modeled, the same limitation `getNextBusinessDay()` in `/lib/accounting.ts`
  documents. `advanceToBusinessDay()` next to it is the "when is this observed?"
  variant — it leaves a weekday alone, where `getNextBusinessDay()` always moves.
- **Two occurrences can collapse onto one observed date.** A daily rule's Saturday
  and Sunday both land on Monday, and both transactions are created. That is two
  occurrences observed the same day, not a duplicate.

`endDate` still bounds the **scheduled** date, not the observed one: an occurrence
scheduled on or before `endDate` counts even when its shift lands past it.

## Plaid Bank Sync

### How Plaid Sync Works
1. User connects a bank via Plaid Link (stores access token in `plaidTokens`)
2. User maps Plaid accounts to Counterpoise accounts (stored in `plaidAccounts`)
3. Sync fetches new/modified/removed transactions from Plaid's transaction sync API
4. Transactions are staged in `plaidTransactionReconciliation` as `pending`
5. Auto-match runs on pending rows, then remaining items await manual reconciliation in the UI

### Sync Trigger Points
- **Manual**: POST `/api/b/[bookId]/sync/tokens/[id]/sync` — syncs a single token on demand (per-account variant: POST `/api/b/[bookId]/sync/accounts/[id]/sync`)
- **Cron**: GET `/api/cron/plaid-sync` — syncs all tokens with linked accounts every 6 hours (via Docker `scheduler` sidecar at 12am, 6am, 12pm, 6pm). Requires `CRON_SECRET` bearer token. **Tokens with `isDemo = true` are excluded**, and `syncToken` refuses them outright. The seed gives a demo book a Plaid connection with a synthetic access token so the Sync page has something to show; it is linked to a liability account exactly like a real connection, so nothing but that column tells them apart. Without the exclusion, every demo book makes a guaranteed-failing call to Plaid every six hours and writes the rejection to `lastError`, which the Sync page renders as "Last sync failed". `syncToken`'s guard sits *above* its try block for that reason — the catch inside writes `lastError`, and a demo connection must not be recorded as a broken one.

### Auto-Match Algorithm (`/lib/plaid-auto-match.ts`)
Auto-match runs automatically after every sync (both manual and cron). It uses a learned payee map built from previously human-matched reconciliation rows:
1. **Build payee map**: Query all `matched` reconciliation rows to create a map of normalized Plaid merchant names → Counterpoise payee IDs
2. **For each pending row** (without `reviewReason`):
   - Look up the Plaid merchant name in the payee map
   - Find candidate transactions with: exact amount match, matching payee ID, on the mapped Counterpoise account
   - Filter candidates to ±1 day of **either** the Plaid authorization date **or** the posted date (the union keeps delayed settlements in range — a transaction the user entered on the posted date matches even when the authorization date is 7+ days earlier — without matching anything in the gap between the two dates)
   - If exactly one or more candidates remain, pick the first (ordered by date, then ID)
   - Atomically set `resolutionStatus = 'matched'`, mark the local transaction as reconciled (and `isFloating = false`), and stamp its `date` (see date rule below)
3. **Per-link uniqueness**: A transaction can only be auto-matched once per Plaid account link (but the same transaction can match on different linked accounts for transfers)

**Auto-match date rule**: When stamping the matched transaction's `date`, prefer the Plaid **authorization** date (closest to when the user entered the transaction) over the **posted** date. Fall back to the posted date only when it lands 7+ days after authorization (a gap that large means the posted/settlement date is the meaningful one), or when Plaid provides no `authorizedDate`. Note this differs from the manual `match` action in the reconcile route, which leaves the local transaction's date untouched.

### Sync Handling of Modified/Removed Transactions
- **Modified**: If a previously matched/created row is modified by Plaid, it gets `reviewReason: 'plaid_modified'` with before/after metadata for human review
- **Removed**: If a previously resolved row is removed by Plaid, it gets `reviewReason: 'plaid_removed'`
- **Pending rows**: Modified pending rows are simply updated in place

### Transaction Unlink
- DELETE `/api/b/[bookId]/transactions/[id]/plaid/unlink` — Removes the Plaid link from a matched transaction (sets reconciliation back to `pending`, clears `isReconciled`)

### Environment Variables
| Variable | Purpose |
| -------- | ------- |
| `PLAID_CLIENT_ID` | Plaid API client ID |
| `PLAID_SECRET` | Plaid API secret |
| `PLAID_ENV` | Plaid environment (`sandbox`, `development`, `production`) |
| `CRON_SECRET` | Shared secret for cron endpoint auth (also used by recurring cron) |

### Key Classes and Functions
- `syncToken(db, bookId, tokenId)` — Main sync entry point, returns `SyncTokenResult` with counts of added/modified/removed/auto-matched. Serialised per token by `withAdvisoryLock`, so the cron and a manual click cannot fetch the same Plaid pages twice; the loser gets `SyncTokenError` 409 rather than waiting. The whole sync therefore runs on a reserved connection — see Database Connection above
- `SyncTokenError` — Error class with HTTP status (404 token not found, 400 invalid config)
- `autoMatchPendingTransactions(db, bookId, linkIds)` — Returns count of successful auto-matches
- `buildPayeeMap(db, bookId)` — Builds the learned payee map from historical matches
- `isPlaidConfigured()` — Checks if all three Plaid env vars are set

## Security Price Sync

Security prices come from Tiingo's end-of-day API. Shared fetch logic lives in `/lib/tiingo.ts` (`fetchLatestTiingoPrices()`, `isTiingoConfigured()`); requires `TIINGO_API_KEY`.

- **Manual**: The Update Prices modal on `/securities` fetches latest prices via POST `/api/b/[bookId]/security-prices/tiingo`, then saves user-reviewed values via `/security-prices/bulk`
- **Cron**: GET `/api/cron/price-sync` fetches latest prices for all securities with `fetchPrices = true` across all books (Docker `scheduler` sidecar, Tue–Sat 6am ET — early morning after each market day). Requires `CRON_SECRET` bearer token; skips when `TIINGO_API_KEY` is unset
- The cron never overwrites an existing price for the same (security, date) — manual entries always win, and re-runs after market holidays are no-ops (Tiingo returns the prior market day's close, whose date is already recorded)
- Securities with `fetchPrices = false` (e.g. options, which have no Tiingo feed) are excluded and rely on manual price entry

### Fixed-Price Securities
A security with a non-null `fixedPriceMicros` is valued at that price forever — a money market fund at a $1.00 NAV. It is set on the Add/Edit Security form and cleared by unticking the same checkbox.

- **One rule, applied at the read sites.** `fixedPriceRow()` in `/lib/investments.ts` builds the synthetic price row, dated today so it wins every "newest price" comparison. `getLatestPrices()` uses it (covering `getPositions`, `getMarketValuesByAccount`, the securities list, the pill, and MCP's `get_security_detail`, which builds its position from `getPositions`), and the security detail route uses it directly — that route replays positions itself instead of calling `getPositions`, which is why it is the one place that needs its own call
- The fixed price **supersedes** any `securityPrices` rows, including ones recorded before the security was marked fixed-price. Those rows stay on the books as history and still render in the Price History tab; they no longer value the position
- **Setting a fixed price forces `fetchPrices = false`** in both `createSecurity()` and the securities PUT route, so the two cannot contradict each other. Clearing the fixed price leaves fetching off — turning it back on is the user's call. The Tiingo cron and the Update Prices modal *also* filter on `fixedPriceMicros` rather than trusting that coupling
- The Update Prices modal renders a fixed-price security read-only ("Fixed at $1.00") with no Fetch checkbox, and the securities list marks its price cell `fixed`
- The investment entry form prefills Price from the fixed price when the user **picks** the security (`selectSecurity()` in `/components/transactions/useInvestmentEntry.ts`) and labels the field "Price (fixed)". The bare `setSelectedSecurityId()` setter deliberately does not prefill: `TransactionForm` uses it to restore a saved transaction, which must keep the price it was recorded at. The field stays editable
- Switching from a fixed-price security to an ordinary one clears the prefill, but **only if the field still holds exactly what was auto-filled** — a price the user typed survives a security change, as it does everywhere else in that form
- Ticking Fixed price with no usable amount blocks submission rather than sending `null`, which would read as "not fixed" while the box still shows ticked. Unticking the box is the only way to clear a fixed price
- Prices are written into form fields by `formatPriceMicrosInput()` in `/lib/formatters.ts` — at least cents, never rounded to them. That text is what the form sends back on the next save, so rounding a NAV like 1.0025 there would silently rewrite the security's value

### Quick Price Entry Pill
Manually-priced securities are prompted for via a navbar pill (`/components/layout/PriceEntryPill.tsx`), visible on every book page:
- GET `/api/b/[bookId]/securities/prices-due` returns securities with `fetchPrices = false`, no fixed price, an open position (via `getPositions()`), and no price for the due date
- The due date is the newest price date across `fetchPrices = true` securities (the cron keeps these current, so this tracks the last market day through holidays); falls back to the last calendar weekday when the book has no fetchable prices
- The pill (`● N prices due`) opens a popover form: one row per security (symbol, input prefilled with the last saved mark), first field focused with value selected, Enter saves all via `/security-prices/bulk`, Escape closes
- Pressing `P` opens the popover from any book page; there is no dismissal — the pill is quiet until prices are entered
- After a save the pill dispatches a `counterpoise:security-prices-saved` window event (exported as `PRICES_SAVED_EVENT`); the transactions page listens and refreshes so the positions table picks up new market values
- Lists derive from open positions, so rolled/expired options drop off without configuration

## PostHog Analytics

Counterpoise includes PostHog integration for usage analytics. No financial data is captured — events track actions (e.g., "transaction created") with metadata like `bookId` and `splitCount`.

### Environment Variables

| Variable | Context | Purpose |
| -------- | ------- | ------- |
| `NEXT_PUBLIC_POSTHOG_KEY` | Build-time | Public project API key (inlined into JS bundle) |
| `NEXT_PUBLIC_POSTHOG_HOST` | Build-time | PostHog instance URL |
| `POSTHOG_PERSONAL_API_KEY` | Runtime (server) | Personal API key for querying PostHog REST API |

In Docker, the `NEXT_PUBLIC_*` vars are passed as **build args** in `docker-compose.yml` → `Dockerfile` so Next.js can inline them. The personal API key is a runtime env var via `env_file`.

### Client-Side Tracking

- **`/app/posthog-provider.tsx`** — Wraps app with `PostHogProvider`, initializes SDK, auto-identifies returning users via `/api/auth/me`
- **`/app/posthog-pageview.tsx`** — Captures `$pageview` on SPA route changes (pathname + search params)
- **`/lib/posthog-client.ts`** — Helpers: `identifyUser(userId)` (called on login), `resetUser()` (called on logout)

### Server-Side Event Capture

- **`/lib/posthog-server.ts`** — Singleton `posthog-node` client with `captureEvent(userId, event, properties?)`. Returns null/no-op if PostHog is not configured.

Instrumented server events:
| Event | Route | Properties |
|-------|-------|-----------|
| `transaction_created` | POST `/api/b/[bookId]/transactions` | `bookId`, `hasInvestmentSplits`, `splitCount` |
| `transaction_updated` | PUT `/api/b/[bookId]/transactions/[id]` | `bookId`, `fieldsChanged`, `splitsAccountsChanged` |
| `transaction_deleted` | DELETE `/api/b/[bookId]/transactions/[id]` | `bookId` |
| `account_created` | POST `/api/b/[bookId]/accounts` | `bookId`, `type`, `subtype` |
| `recurring_rule_created` | POST `/api/b/[bookId]/recurring` | `bookId` |
| `report_generated` | GET `/api/b/[bookId]/reports/*` | `bookId`, `reportType` |
| `sync_transaction_matched` | POST `/api/b/[bookId]/sync/accounts/[id]/reconcile` | `bookId` |
| `sync_transaction_created` | POST `/api/b/[bookId]/sync/accounts/[id]/reconcile` | `bookId` |
| `sync_transaction_ignored` | POST `/api/b/[bookId]/sync/accounts/[id]/reconcile` | `bookId` |
| `sync_transaction_kept_local` | POST `/api/b/[bookId]/sync/accounts/[id]/reconcile` | `bookId` |
| `sync_transaction_unlinked` | DELETE `/api/b/[bookId]/transactions/[id]/plaid/unlink` | `bookId` |
| `sync_transaction_amount_updated` | POST `/api/b/[bookId]/sync/accounts/[id]/reconcile` | `bookId` |
| `sync_transaction_auto_matched` | `autoMatchPendingTransactions()` in `/lib/plaid-auto-match.ts` (one per match, attributed to the book owner) | `bookId` |

### PostHog Query API Client

- **`/lib/posthog-query.ts`** — `runHogQLQuery(query)` runs HogQL via `POST /api/projects/@current/query/` (the `@current` alias is required for project-scoped personal API keys). Also `escapeHogQLString()` and `parsePropertiesColumn()` (HogQL returns `properties` as a JSON string). The legacy `/api/event/` endpoint is deprecated and silently returns only ~1 day of events — never use it for historical analysis.

### CLI Event Export

```bash
npx tsx scripts/posthog-export.ts [--days N] [--output FILE]
```
- Batch exports events via the PostHog Query API (HogQL, paginated) for analysis
- `--days N` — Lookback period (default: 7)
- `--output FILE` — Write JSON to file (omit for stdout)
- Requires `POSTHOG_PERSONAL_API_KEY` and `NEXT_PUBLIC_POSTHOG_HOST`

### MCP Tool: `analyze_usage`

Defined in `/mcp/tools/usage.ts`. Queries PostHog for event summaries.
- **Input**: `days` (1–90, default 7), optional `eventType` filter
- **Output**: `totalEvents`, `eventCounts` (sorted by frequency), `recentEvents` (last 20)
- Requires `POSTHOG_PERSONAL_API_KEY` and `NEXT_PUBLIC_POSTHOG_HOST`

## MCP Server

Counterpoise includes a Model Context Protocol (MCP) server that gives AI assistants read and write access to accounting data. The server uses stdio transport and runs via `npm run mcp:dev`.

### Authentication

All MCP tools require a valid `COUNTERPOISE_API_KEY` environment variable. The key is verified at startup via `initMcpAuth()` in `/mcp/auth.ts`, cached in memory, and periodically revalidated so revoked keys stop working without a process restart.

**How it works:**
1. User creates an API key in the UI at `/account` (ApiKeyManager component)
2. Key is `cpk_` + 48 hex chars; only the scrypt hash is stored in the `apiKeys` table
3. User provides the key to their MCP client via environment variable
4. On startup, `initMcpAuth()` looks up candidates by `keyPrefix` (first 8 chars), then verifies with scrypt
5. Each tool call checks auth via `requireAuth()` or `requireBookAuth(bookId)`, and `requireAuth()` periodically re-checks that the key still exists

**Auth helpers** in `/mcp/auth.ts`:
- `requireAuth()` — returns `McpAuth` (userId, keyId) or an MCP error response
- `requireBookAuth(bookId)` — chains auth + book ownership check (book must belong to the user)
- Both return `{ isError: true, content: [...] }` on failure, checked via `"isError" in result`

### MCP Client Configuration

```json
{
  "mcpServers": {
    "counterpoise": {
      "command": "npm",
      "args": ["run", "mcp:dev"],
      "cwd": "/path/to/counterpoise",
      "env": {
        "COUNTERPOISE_API_KEY": "cpk_..."
      }
    }
  }
}
```

### Docker MCP Client Configuration

When running Counterpoise via Docker Compose, configure MCP clients to use `docker exec` with the API key passed via `-e`:

```json
{
  "mcpServers": {
    "counterpoise": {
      "command": "docker",
      "args": ["exec", "-i", "-e", "COUNTERPOISE_API_KEY=cpk_...", "counterpoise-app-1", "node", "/app/mcp-server.mjs"]
    }
  }
}
```

**Prerequisites:**
- Generate an API key at `/account` in the web UI
- The `app` container must be running (`docker compose up -d`)
- `/app/mcp-server.mjs` is bundled at image build time by `scripts/bundle-node-entrypoints.mjs` (Dockerfile builder stage)
- Each user provides their own API key in the MCP client config — no container rebuild needed

### Environment Variables

| Variable | Purpose |
| -------- | ------- |
| `COUNTERPOISE_API_KEY` | User API key for MCP authentication (required) |
| `DATABASE_URL` | PostgreSQL connection string (defaults to local dev DB) |

### Available Tools

**Discovery:**
- `list_books` — List books the authenticated user owns

**Accounts** (require `bookId`):
- `list_accounts` — List accounts with balances, filterable by type and as-of date
- `get_account_tree` — Hierarchical account tree grouped by type

**Transactions** (require `bookId`):
- `list_transactions` — List transactions with splits, payees, and investment data; filterable by account, date, with pagination
- `search` — Search accounts, payees, and transactions by text or amount
- `create_transaction` — Create a double-entry transaction with splits (must sum to zero)
- `update_transaction` — Update an existing transaction's fields or replace splits

**Reports** (require `bookId`):
- `get_income_statement` — Income/expense totals for a date range
- `get_report_data` — Raw split data for custom analysis
- `get_account_balance_history` — Running balance over time for an account
- `get_realized_gains` — Realized capital gains/losses per lot disposed of, with short/long-term totals

**Investments** (require `bookId`):
- `get_investment_positions` — Current positions with shares, cost basis, market value, gain/loss
- `get_security_detail` — Security info, price history, transactions, and position
- `create_security` — Create a new security (ETF, mutual fund, or stock); fails if the symbol already exists in the book

**Analytics:**
- `analyze_usage` — Query PostHog for event summaries (requires PostHog env vars)

### Shared Transaction Logic

`/lib/transactions.ts` contains `createTransaction()` and `updateTransaction()` shared by both API routes and MCP tools. Error classes:
- `TransactionValidationError` — invalid input (splits don't balance, missing fields)
- `TransactionNotFoundError` — transaction ID doesn't exist in the book

### API Key Management

- **Routes**: `/app/api/auth/api-keys/route.ts` (GET, POST), `/app/api/auth/api-keys/[id]/route.ts` (DELETE)
- **UI**: `/components/account/ApiKeyManager.tsx` on the `/account` page
- **Library**: `/lib/api-keys.ts` — `generateApiKey()`, `hashApiKey()`, `verifyApiKey()`, `getKeyPrefix()`

## Critical Files Reference

| File | Purpose |
|------|---------|
| `/db/schema.ts` | All table definitions and relations (meta + book-scoped) |
| `/db/index.ts` | Database connection (`getDb()`) with postgres.js driver, `runMigrations()` for explicit migration |
| `/db/create-book.ts` | Migration folder path constant |
| `/lib/accounting.ts` | Core accounting logic and validation |
| `/lib/investments.ts` | Position and market value calculation (cost basis now comes from lots, not this file); `fixedPriceRow()` for fixed-price securities |
| `/lib/lots.ts` | Pure FIFO replay engine (no DB) |
| `/lib/lots-db.ts` | `rebuildLots()` — the only inserter of lots and allocations at runtime (rows also disappear via FK cascade on deletes) |
| `/lib/realized-gains.ts` | Realized gain/loss query shared by the report route and MCP |
| `/scripts/rebuild-lots.ts` | Guarded backfill, run by the container entrypoint |
| `/scripts/check-db-credential.sh` | Aborts container startup when `DATABASE_URL` uses the published default credential |
| `/scripts/postgres-init/01-app-role.sh` | Creates the `counterpoise_app` role on first postgres initialization |
| `/lib/reports.ts` | Financial report logic |
| `/lib/api-auth.ts` | API authentication and book access |
| `/lib/api-keys.ts` | API key generation, hashing, and verification |
| `/lib/auth.ts` | Password hashing and verification |
| `/lib/session.ts` | Session management |
| `/lib/transactions.ts` | Shared create/update transaction logic (used by API routes and MCP) |
| `/lib/advisory-lock.ts` | `withAdvisoryLock()` — session-scoped lock on a reserved connection; its callback's `db` is not the pooled one |
| `/lib/plaid-sync.ts` | Plaid transaction sync — fetches, stages, and auto-matches |
| `/lib/plaid-auto-match.ts` | Learned payee-based auto-matching for Plaid transactions |
| `/app/api/cron/plaid-sync/route.ts` | Cron endpoint for periodic Plaid sync (every 6 hours) |
| `/lib/tiingo.ts` | Shared Tiingo price fetching (`fetchLatestTiingoPrices()`, `isTiingoConfigured()`) |
| `/app/api/cron/price-sync/route.ts` | Cron endpoint for automatic security price updates (Tue–Sat 6am ET) |
| `/lib/posthog-server.ts` | Server-side PostHog singleton and `captureEvent()` |
| `/lib/posthog-client.ts` | Client-side PostHog helpers (`identifyUser`, `resetUser`) |
| `/hooks/useBookId.ts` | Client hook for current book ID |
| `/app/api/b/[bookId]/transactions/route.ts` | Main transaction API |
| `/scripts/release.sh` | Version bump, tag, push, and PR creation |
| `/scripts/deploy.sh` | Build, move tag, rebase dev; resumable via `.git/DEPLOY_FORK_POINT` |
| `.github/workflows/ci.yml` | CI pipeline for PRs to main |
| `/scripts/import-moneydance/index.ts` | Import orchestration |
| `/scripts/posthog-export.ts` | CLI tool for exporting PostHog events |
| `/mcp/auth.ts` | MCP API key authentication and book access verification |
| `/mcp/server.ts` | MCP server entry point and tool registration |
| `/scripts/bundle-node-entrypoints.mjs` | Bundles the MCP server and lot rebuild script into `dist/` for the Docker image |
| `/mcp/tools/usage.ts` | MCP tool for querying PostHog analytics |

## Debugging Tips

### View SQL Queries
Drizzle doesn't log by default. Add logging in API routes:
```typescript
const result = db.select()...;
console.log("Query result:", result);
```

### Check Split Balance
If transaction creation fails, log the split total:
```typescript
const total = splits.reduce((sum, s) => sum + s.amount, 0);
console.log("Split total (must be 0):", total);
```

### Investment Position Issues
Check these common causes:
1. Incorrect sign in `sharesMicros` (should be positive)
2. Missing or incorrect `action` field
3. Price or shares not converted to micros
4. Lot tracking out of sync (re-run import if needed)
