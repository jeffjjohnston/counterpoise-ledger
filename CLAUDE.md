# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**This file is the index.** It holds the commands, the rules that apply
everywhere, and the warnings you must read before you act. Everything else is in
`guides/`, one file per subject. Read the guide for the subject you are about to
touch. The guides carry the reasons, and a rule without its reason is the rule
that gets undone.

This checkout is for development only. Production runs from a separate checkout
on `main`. The default path is `~/counterpoise-production`. The variable
`COUNTERPOISE_BUILD_DIR` can name another directory. The gitignored
`.env.deploy.local` can also set it. The production checkout is the directory
that `COUNTERPOISE_BUILD_DIR` names. On the owner's machine, `.env.deploy.local`
in the dev checkout sets it. The production checkout has its own
`.env.production.local` and `backups/`. Development needs no
Docker: the Rust server keeps its SQLite file in `data/`. `docker-compose.yml`
is production-only.

## Project Overview

Counterpoise is a multi-book personal finance accounting application with true double-entry bookkeeping and investment tracking. The UI is a React and React Router client that Vite builds into static files (`client/`, pages in `app/`). A Rust server (axum and sqlx, in `rust-api/`) serves every `/api` route, the MCP server and, in production, the client build; the browser runs its shared domain code as WASM. One SQLite file holds all data (`DATABASE_PATH`). The server applies the numbered SQL migrations in `rust-api/db/migrations/` at startup, and runs the scheduled jobs and the backups itself. Production is one image, one container and one process. The app supports user authentication, shared books, and a Moneydance import tool (`ledger-cli import-moneydance`).

## Guides

| Guide | Read it before you |
| --- | --- |
| [guides/architecture.md](guides/architecture.md) | Add a route, a page, or a database query. Holds the tech stack and the layered flow |
| [guides/api-route-patterns.md](guides/api-route-patterns.md) | Write or change an API route |
| [guides/api-contract.md](guides/api-contract.md) | Change a route a native client uses, or touch `openapi/` or `rust-api/server/src/openapi/` |
| [guides/schema.md](guides/schema.md) | Work with any table. One entry per table, with the fields that are easy to get wrong |
| [guides/library-reference.md](guides/library-reference.md) | Write a helper. It is probably already there — this lists the `lib/` client helpers and the critical Rust files |
| [guides/investments.md](guides/investments.md) | Touch investment splits, positions, or FIFO lots |
| [guides/securities-and-prices.md](guides/securities-and-prices.md) | Change price fetching, fixed-price securities, or the price entry pill |
| [guides/recurring-transactions.md](guides/recurring-transactions.md) | Change recurring rules, their processing, or business-day shifts |
| [guides/plaid-sync.md](guides/plaid-sync.md) | Change bank sync, auto-match, or reconciliation |
| [guides/mcp-server.md](guides/mcp-server.md) | Add or change an MCP tool, or connect an MCP client. Lists all 63 tools |
| [guides/components-and-ui.md](guides/components-and-ui.md) | Build or change UI |
| [guides/testing.md](guides/testing.md) | Write a test, or claim that work is done |
| [guides/database-management.md](guides/database-management.md) | Change the schema, add a migration, or touch the production database |
| [guides/patterns-and-gotchas.md](guides/patterns-and-gotchas.md) | Write a payee, date, or split helper |
| [guides/moneydance-import.md](guides/moneydance-import.md) | Change the importer |
| [guides/posthog-analytics.md](guides/posthog-analytics.md) | Add or query an analytics event |
| [guides/release-and-deploy.md](guides/release-and-deploy.md) | Release, deploy, or change CI |
| [guides/worktrees.md](guides/worktrees.md) | Work in a git worktree |
| [guides/upgrade-to-sqlite.md](guides/upgrade-to-sqlite.md) | Upgrade an install from PostgreSQL, or restore a snapshot |
| [guides/debugging.md](guides/debugging.md) | Debug a query, an unbalanced transaction, or a wrong position |
| [guides/typesafe-experiment.md](guides/typesafe-experiment.md) | Change TypeSafe suggestions, their settings, the data sent, or retention |

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
cargo run --manifest-path rust-api/Cargo.toml -p counterpoise-rust-api  # The API server (127.0.0.1:4000). Every /api route runs here. It creates and migrates data/counterpoise.db on first start
npm run dev               # Start the Vite dev server (http://localhost:3000); it sends /api to the Rust server
npm run build             # Build the client into build/ (the Rust server serves it with COUNTERPOISE_STATIC_DIR)
npm run lint              # Run ESLint
npx tsc --noEmit          # Type-check without emitting files

# Testing (each Vitest worker makes its own SQLite file with ledger-cli)
cargo build --manifest-path rust-api/Cargo.toml -p ledger-cli  # Needed once before npm test
npm test                  # Run Vitest once (node, DOM, and database projects)
npx vitest run            # Run Vitest directly
npm run test:ui          # Run tests with interactive UI
npm run test:coverage    # Generate test coverage report
npm run test:e2e         # Run Playwright E2E tests

# Database
# (DATABASE_PATH selects the file; the default is data/counterpoise.db)
npm run db:migrate       # Apply pending migrations (ledger-cli migrate)
npm run db:seed          # Delete and recreate the dev database with sample data (ledger-cli seed --reset)
npm run db:seed -- --book-id 2  # Seed into existing book (replaces book data only)
# ledger-cli seed [--book-id N | --reset] [--dataset household|single] [--today YYYY-MM-DD]
# The seed dates end today (the app's TZ). --today pins them; --today 2025-12-31 gives the old 2023-2025 household rows
npm run db:rebuild-lots  # Regenerate investment lots from splits (guarded; --force to override)
npm run db:list-books    # List the books and their IDs
sqlite3 data/counterpoise.db  # Open the dev database. The shell lacks the app's SQL functions: see guides/database-management.md

# MCP (the Rust server; needs COUNTERPOISE_API_KEY)
npm run mcp:dev          # Start the MCP server over stdio (cargo run ... -- mcp)
npm run test:mcp:http    # Run the MCP tool suites over HTTP (needs the Rust server binary)
npm run test:mcp:stdio   # Run the MCP tool suites over stdio

# MCP (Docker — production)
docker exec -i -e COUNTERPOISE_API_KEY=cpk_... counterpoise-rust-api-1 counterpoise-rust-api mcp

# Release & Deploy — read guides/release-and-deploy.md first
./scripts/release.sh [patch|minor|major] [--skip-checks] [--no-pr]  # In a RELEASE CHECKOUT: bump, name and push release/vX.Y.Z, open PR to main
./scripts/deploy.sh --ref <commit> [--yes]                          # Publish tag vX.Y.Z once at that commit, rebuild Docker
scripts/upgrade-to-sqlite.sh                                        # Once per install: convert PostgreSQL data to SQLite (guides/upgrade-to-sqlite.md)
```

### Running Individual Tests
```bash
npx vitest run tests/lib/accounting.test.ts           # Run specific test file
npx vitest tests/lib/accounting.test.ts -t "validateSplits"  # Run specific test
```

### Import Scripts
```bash
# Import from Moneydance export file into a specific book (runs `ledger-cli import-moneydance`)
npm run import:moneydance -- path/to/export.json --book-id <existing-book-id> --verbose

# Dry run (no database writes)
npm run import:moneydance -- path/to/export.json --book-id <existing-book-id> --dry-run
```

Create the target book first, then use `npm run db:list-books` to discover its ID. `npm run db:seed` (without args) creates a sample `admin` user (password `password`), sample book, and seed data. The seed dates end today; the transaction count depends on `today`. Pin the end date with `--today YYYY-MM-DD`.

## Rules That Apply Everywhere

### After Making Code Changes

After you change Rust files, run `cargo fmt --all`, `cargo clippy --workspace
--all-targets -- -D warnings` and `cargo test --workspace` from `rust-api/`, as
CI does. After you change TypeScript files, always run `npx tsc --noEmit` and
fix every error before you call the task complete. Run that exact command — `release.sh`
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
   - The Rust write paths check it with `validate_splits()` in `rust-api/core/src/accounting.rs`. The browser runs the same function through `lib/wasm-client.ts` before it sends a transaction

2. **Normal Balances** (sign conventions):
   - Assets & Expenses: Positive (debit normal)
   - Liabilities, Equity & Income: Negative (credit normal)

3. **Investment Precision**:
   - Shares stored in micros (multiply by 1,000,000)
   - Prices stored in micros
   - Cash amounts in cents
   - `sharesMicros` in the `investmentSplits` table is always positive. The `action` field (`buy` vs `sell`) gives the direction. Use `Math.abs(samtMicros)` when importing.

4. **Investment Position Calculation**:
   - Use `aggregate_positions()` in `rust-api/core/src/investments.rs`
   - Splits are processed chronologically; same-date ties retain insertion order
   - For `action === "split"`: apply the split ratio to existing shares (corporate action, not a sign-applied delta)
   - Otherwise: `sharesDelta = sign * sharesMicros` where `sign = action === "sell" ? -1 : 1`

5. **Floating Transactions**:
   - `isFloating` boolean on transactions — effective date auto-advances to today
   - In SQL that filters, sorts or aggregates by date, use the effective date: `CASE WHEN t.is_floating THEN cp_today() ELSE t.date END` (`EFFECTIVE_DATE` in `rust-api/db/src/sql.rs`; the route modules and `rust-api/db/src/lots.rs` use it). `cp_today()` is today in the app's `TZ`; do not use SQLite's `CURRENT_DATE`, which is the UTC date
   - Use `getEffectiveDate()` from `lib/wasm-client.ts` in client-side code for display and sorting
   - When reconciling a floating transaction: set `isFloating=false`, update `date` to cleared date, set `isReconciled=true`
   - Stored `date` field retains the original entry date while floating; it's overwritten with the cleared date on reconciliation
   - A floating row sorts **above** the settled rows sharing its effective date. The register's `ORDER BY` (effective date, then `is_floating`, then `id`, each descending) in `rust-api/server/src/routes/transactions.rs` is the definition; the starting-balance boundary in the same file and `TransactionList` (display order and its reversed running-balance order) repeat it and must move with it

### Read the guide before you touch these

Each line is a rule that has already cost this project a defect. The guide holds
the incident that produced it.

- **Merge release PRs with a merge commit, never a squash.** This preserves
  release ancestry when reconciling `dev` with `main` →
  [guides/release-and-deploy.md](guides/release-and-deploy.md)
- **Every schema change is a new numbered file in `rust-api/db/migrations/`.**
  Never edit a migration that has run, and never change a database with direct
  DDL. sqlx records each migration's checksum in `_sqlx_migrations`, and the
  server refuses to start when a file no longer matches →
  [guides/database-management.md](guides/database-management.md)
- **Lots and allocations are derived state.** `rebuild_lots()` in
  `rust-api/db/src/lots.rs` is the only runtime inserter. The transaction write
  paths call it inside the same transaction as the write; the importer and the
  seed are the exceptions, and rebuild per pair afterwards. At startup the
  server runs the lot backfill guard after the migrations; `ledger-cli
  rebuild-lots` (`npm run db:rebuild-lots`) runs the same code by hand →
  [guides/investments.md](guides/investments.md)
- **Never write a request field that the route's validator did not name.**
  The validator is what stops a client setting `bookId` or `id`. An id that
  references another row must also be proved to belong to this book →
  [guides/api-route-patterns.md](guides/api-route-patterns.md)
- **Payee `normalize_name()` does not lowercase.** "IKEA" and "Ikea" are
  deliberately distinct payees → [guides/patterns-and-gotchas.md](guides/patterns-and-gotchas.md)
- **The mobile/desktop breakpoint is declared in two places** — Tailwind `lg:`
  classes and `MOBILE_BREAKPOINT`. They must move together →
  [guides/components-and-ui.md](guides/components-and-ui.md)
- **`rust-api/server/mcp-tools.json` is the source of each MCP tool's
  schema.** A `.describe()` or a rule in `lib/schemas/` no longer reaches a
  tool; change the manifest and the Rust check together →
  [guides/mcp-server.md](guides/mcp-server.md)
- **A book route or MCP tool declares its access level.** A route passes
  `AccessLevel::Read` to `authenticate_book` for a GET, `Write` for a change,
  and `Owner` for an owner-only operation; an MCP handler gives `Level::Read`
  for a read-only tool. A static test fails on a mismatch →
  [guides/api-route-patterns.md](guides/api-route-patterns.md)
- **Timestamps are UTC text; calendar dates are local.** A timestamp column
  holds UTC wall-clock text that Rust binds; the app's SQL never makes one. `cp_today()`
  gives today in the app's `TZ`, and SQLite's own `CURRENT_DATE` and
  `datetime('now')` give UTC. Use the right one, and test under a non-UTC
  `TZ` → [guides/schema.md](guides/schema.md#timezones-and-timestamp-columns)
