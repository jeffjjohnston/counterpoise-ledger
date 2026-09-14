# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**This file is the index.** It holds the commands, the rules that apply
everywhere, and the warnings you must read before you act. Everything else is in
`guides/`, one file per subject. Read the guide for the subject you are about to
touch. The guides carry the reasons, and a rule without its reason is the rule
that gets undone.

This checkout is for development only. Production runs from a separate checkout
on `main` — `~/prod/counterpoise` unless `COUNTERPOISE_BUILD_DIR` says otherwise —
with its own `.env.production.local` and `backups/`. Use `docker-compose.dev.yml`
here; `docker-compose.yml` is production-only.

## Project Overview

Counterpoise is a multi-book personal finance accounting application built with Next.js 16, implementing true double-entry bookkeeping with investment tracking. The app uses a PostgreSQL database for all data storage, supports user authentication, and includes a Moneydance import tool.

## Guides

| Guide | Read it before you |
| --- | --- |
| [guides/architecture.md](guides/architecture.md) | Add a route, a page, or a database query. Holds the tech stack, the layered flow, and the three kinds of `db` |
| [guides/api-route-patterns.md](guides/api-route-patterns.md) | Write or change an API route |
| [guides/schema.md](guides/schema.md) | Work with any table. One entry per table, with the fields that are easy to get wrong |
| [guides/library-reference.md](guides/library-reference.md) | Write a helper. It is probably already there — this lists every `lib/` function and every critical file |
| [guides/investments.md](guides/investments.md) | Touch investment splits, positions, or FIFO lots |
| [guides/securities-and-prices.md](guides/securities-and-prices.md) | Change price fetching, fixed-price securities, or the price entry pill |
| [guides/recurring-transactions.md](guides/recurring-transactions.md) | Change recurring rules, their processing, or business-day shifts |
| [guides/plaid-sync.md](guides/plaid-sync.md) | Change bank sync, auto-match, or reconciliation |
| [guides/mcp-server.md](guides/mcp-server.md) | Add or change an MCP tool. Lists all 59 tools |
| [guides/components-and-ui.md](guides/components-and-ui.md) | Build or change UI |
| [guides/testing.md](guides/testing.md) | Write a test, or claim that work is done |
| [guides/database-management.md](guides/database-management.md) | Change the schema, add a migration, or touch the production database |
| [guides/patterns-and-gotchas.md](guides/patterns-and-gotchas.md) | Add an import to a route or an MCP tool, or write a payee, date, or split helper |
| [guides/moneydance-import.md](guides/moneydance-import.md) | Change the importer |
| [guides/posthog-analytics.md](guides/posthog-analytics.md) | Add or query an analytics event |
| [guides/release-and-deploy.md](guides/release-and-deploy.md) | Release, deploy, or change CI |
| [guides/worktrees.md](guides/worktrees.md) | Work in a git worktree |
| [guides/debugging.md](guides/debugging.md) | Debug a query, an unbalanced transaction, or a wrong position |

## Skills

Repository workflows are skills under `.claude/skills/`. Prefer the skill over
driving its scripts by hand — each one carries the order of operations and the
checks that the scripts alone do not enforce.

| Skill | Use it to |
| --- | --- |
| `verify` | Drive a UI change end-to-end against the local dev server, when tests alone do not prove it works |

## Development Commands

### Essential Commands
```bash
docker compose -f docker-compose.dev.yml up -d --wait  # Dedicated dev/test PostgreSQL on localhost:5432
npm run dev               # Start development server (http://localhost:3000)
npm run build             # Build for production
npm run lint              # Run ESLint
npx tsc --noEmit          # Type-check without emitting files

# Testing
npm run db:create-test-dbs # Create counterpoise_dev + counterpoise_e2e (one-time setup)
npm test                  # Run Vitest once (node, DOM, and database projects)
npx vitest run            # Run Vitest directly
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

# Release & Deploy — read guides/release-and-deploy.md first
./scripts/release.sh [patch|minor|major] [--skip-checks] [--no-pr]  # In a RELEASE CHECKOUT: bump, name and push release/vX.Y.Z, open PR to main
./scripts/deploy.sh --ref <commit> [--yes]                          # Publish tag vX.Y.Z once at that commit, rebuild Docker
```

### Running Individual Tests
```bash
npx vitest run tests/lib/accounting.test.ts           # Run specific test file
npx vitest tests/lib/accounting.test.ts -t "validateSplits"  # Run specific test
```

### Import Scripts
```bash
# Import from Moneydance export file into a specific book
npx tsx scripts/import-moneydance/index.ts path/to/export.json --book-id <existing-book-id> --verbose

# Dry run (no database writes)
npx tsx scripts/import-moneydance/index.ts path/to/export.json --book-id <existing-book-id> --dry-run
```

Create the target book first, then use `npm run db:list-books` to discover its ID. `npm run db:seed` (without args) creates a sample `admin` user, sample book, and seed data.

## Rules That Apply Everywhere

### After Making Code Changes

After you change TypeScript files, always run `npx tsc --noEmit` and fix every
error before you call the task complete. Run that exact command — `release.sh`
and CI run it, and it is the command that gates a release. If it reports errors
that contradict `tsconfig.json`, the incremental cache is stale: see
[guides/testing.md](guides/testing.md).

### Reading an exit code through a pipe

A pipeline reports the exit status of its **last** command. `some-check | tail -5`
therefore reports `tail`'s status, and `tail` almost always succeeds. The check
can fail and the shell still says 0. Redirect to a file and read the file, or
`set -o pipefail` for that one command. Two agents lost a cycle to this on the
same day: see [guides/testing.md](guides/testing.md).

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

### Read the guide before you touch these

Each line is a rule that has already cost this project a defect. The guide holds
the incident that produced it.

- **Merge release PRs with a merge commit, never a squash.** This preserves
  release ancestry when reconciling `dev` with `main` →
  [guides/release-and-deploy.md](guides/release-and-deploy.md)
- **Never alter the production database with direct DDL.** Drizzle tracks
  applied migrations by hash, and a manual change desyncs the schema from the
  migration history → [guides/database-management.md](guides/database-management.md)
- **A module an API route or an MCP tool imports must contain declarations
  only.** No CLI guard, no top-level `await`, no I/O. A bundled main-module
  guard once nearly ran `DROP SCHEMA public CASCADE` against production →
  [guides/patterns-and-gotchas.md](guides/patterns-and-gotchas.md)
- **`withAdvisoryLock` hands its callback a different `db`.** It is bound to a
  reserved connection that has no `transaction()`. Go through
  `getDbForConnection`, never `drizzle(connection)` →
  [guides/architecture.md](guides/architecture.md)
- **Lots and allocations are derived state.** `rebuildLots()` is the only
  runtime inserter. The transaction CRUD paths call it inside the same
  transaction as the write; the importer and the seed are the exceptions, and
  rebuild per pair afterwards → [guides/investments.md](guides/investments.md)
- **Never spread a raw request body into `values()`.** The zod schema is what
  stops a client setting `bookId` or `id`. An id that references another row
  must also be proved to belong to this book →
  [guides/api-route-patterns.md](guides/api-route-patterns.md)
- **`isError(auth)` puts the response on `auth.error`, not `auth.response`** →
  [guides/library-reference.md](guides/library-reference.md)
- **`normalizePayeeName()` does not lowercase.** "IKEA" and "Ikea" are
  deliberately distinct payees → [guides/patterns-and-gotchas.md](guides/patterns-and-gotchas.md)
- **The mobile/desktop breakpoint is declared in two places** — Tailwind `lg:`
  classes and `MOBILE_BREAKPOINT`. They must move together →
  [guides/components-and-ui.md](guides/components-and-ui.md)
- **A tool's `inputSchema` must go through `toolShape()`.** Spreading `.shape`
  drops `.refine()` and `.superRefine()`, so the tool accepts input the HTTP
  route rejects → [guides/mcp-server.md](guides/mcp-server.md)
