# Architecture Overview

One of the guides [CLAUDE.md](../CLAUDE.md) points to. Read that file first;
it carries the rules that apply everywhere and says when to come here.

## Tech Stack
- **Framework**: Next.js 16 with App Router
- **Language**: TypeScript (strict mode)
- **Database**: PostgreSQL with postgres.js driver
- **ORM**: Drizzle ORM (type-safe queries)
- **Testing**: Vitest (unit), Playwright (E2E)
- **Styling**: Tailwind CSS

## Path Aliases
All imports use `@/` prefix mapping to project root:
```typescript
import { getDb } from "@/db";
import { validateSplits } from "@/lib/accounting";
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

- **Schema**: All tables defined in `/db/schema.ts`
- **Connection**: `getDb()` from `/db/index.ts` returns a cached Drizzle instance (does NOT auto-migrate; use `runMigrations()` explicitly in scripts)
- **Pages** live under `/app/b/[bookId]/...` (e.g., `/app/b/[bookId]/transactions/page.tsx`)
- **API routes** live under `/app/api/b/[bookId]/...` (e.g., `/app/api/b/[bookId]/transactions/route.ts`)
- **Auth routes** at `/app/api/auth/...` (login, register, logout, me, password, api-keys)
- **Book management** at `/app/api/books/...`

## Layered Architecture
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

## Database Connection
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
