# Library & File Reference

One of the guides [CLAUDE.md](../CLAUDE.md) points to. Read that file first;
it carries the rules that apply everywhere and says when to come here.

Read this before you write a helper. The helper is probably already there.
The Rust server serves every API route, so server logic is in `rust-api/`.
`lib/` holds the browser code and the few modules that the remaining Node
scripts run.

## Where a helper goes

- Domain logic that the server and the browser share goes in
  `rust-api/core`. The server links the crate. The browser loads it as WASM
  through `lib/wasm-client.ts`. Do not write a second copy in TypeScript.
- Logic that only a route needs goes in its route module under
  `rust-api/server/src/routes/`, or in a module of `rust-api/server/src/`
  when more than one route uses it.
- Database logic that the server and `ledger-cli` both run goes in
  `rust-api/db`.
- Browser-only helpers (API calls, events, presentation) go in `lib/`.

## Browser helpers (`lib/`)

### `/lib/wasm-client.ts`
The synchronous browser adapter for `ledger-core`. Components import the
shared helpers from here, not from `lib/accounting.ts`. It exports:
- Accounting: `validateSplits()`, `getInvestmentGrossAmountCents()`,
  `buildBuySplits()`, `buildSellSplits()`, `buildDividendSplits()`,
  `buildCapGainSplits()`, `getDisplayBalance()`, `getEffectiveDate()`,
  `getNextBusinessDay()`
- Account trees: `buildAccountTree()`, `flattenAccounts()`,
  `flattenAccountTreeWithDepth()`, `isDescendantOf()`,
  `buildAccountHierarchyName()`, `descendantAccountIds()`,
  `accountHierarchyNames()`, `resolveAccountIconSource()`,
  `buildCategoryLabelMap()`, and the label and order constants
  (`ACCOUNT_TYPE_LABELS`, `ACCOUNT_SUBTYPE_LABELS`, `ACCOUNT_TYPE_ORDER`,
  `BALANCE_SHEET_TYPES`)
  - `resolveAccountIconSource()` walks `parentId` upward. An account's own
    icon wins, and the result also names the ancestor that the icon came
    from (for "Inherits 🚗 from Automobile")
  - `buildCategoryLabelMap()` holds entries only for `income`/`expense`
    accounts. A lookup miss is the deliberate fallback to the full-path
    display, which keeps every renderer free of an `account.type` check
- Recurrence: `getNextDate()`, `describeRecurrence()`,
  `buildRuleRecurrenceConfig()`, `getOccurrenceDate()`,
  `isRecurringRuleDue()`, `maxIntervalFor()`, `scheduleKey()`,
  `previewOccurrences()`, `MAX_AUTO_CREATE_DAYS_BEFORE`
- Formatting: `formatCurrency()`, `formatDate()`, `formatDateShort()`,
  `toDateString()`, `isValidDateString()`, `parseStrictCurrency()`,
  `resolveAmountOnBlur()`, `getAccountShortName()`, `formatRelativeAge()`,
  `formatPriceMicrosInput()`, `evaluateExpression()`

The TypeScript modules `accounting`, `recurring`, `formatters` and
`expression` give its types.
`lib/investment-arithmetic.ts` and `lib/formatters.ts` give the fallbacks for
input that JSON cannot carry to the WASM module, such as a fractional value
while the user types.

### `/lib/api-client.ts`
Every browser request to the API goes through this module:
- `apiFetch()`, `apiGet()`, `apiPost()`, `apiPut()`, `apiDelete()`
- `ApiError` - carries the status and the server's `error` message
- `toMessage(error)` - the text to show for any thrown value

### `/lib/navigation.tsx`
Every router use in the client goes through this module: `Link`,
`useRouter()` (`push` and `replace`, with the `scroll` option),
`usePathname()`, `useParams()` and `useSearchParams()` (read only). It wraps
React Router. ESLint refuses a `react-router` import in any other file,
except `client/**` (the entry and the route table) and the two layout routes
(`app/layout.tsx` and `app/b/[bookId]/layout.tsx`).
`tests/lib/navigation.test.tsx` tests it against a memory router.

### `/lib/book-roles.ts`
Roles and access levels for shared books. It has no server imports. The
browser uses it only to show or hide controls. The Rust server enforces every
level in `rust-api/server/src/book_auth.rs`:
- `BOOK_ROLES` - `["owner", "editor", "viewer"]`; `BookRole` is its element type
- `AccessLevel` - `"read" | "write" | "owner"`
- `roleSatisfies(role, level)` - `read` accepts every role; `write` accepts
  owner and editor; `owner` accepts owner only
- `accessDeniedMessage(level)` - "Only an owner can do this" for `owner`,
  otherwise "You have read-only access to this book"

### `/lib/transaction-requests.ts`
Browser helpers for the edit-conflict check. Each call sends the
`updatedAt` that the client loaded, so the server can refuse a stale edit
with 409:
- `putTransaction(bookId, transaction, body)` - PUT with `expectedUpdatedAt`
  added to the body
- `deleteTransactionRequest(bookId, transaction)` - DELETE with
  `expectedUpdatedAt` added to the query string
- `isTransactionConflict(error)` - true for a 409 `ApiError`
- `TRANSACTION_CONFLICT_MESSAGE` - "Another user changed this transaction.
  Showing the latest version." The Rust route sends the same text
  (`CONFLICT` in `rust-api/server/src/routes/transactions.rs`)

### `components/BookRoleProvider.tsx`
Client provider, mounted in `app/b/[bookId]/layout.tsx` above `BookNavbar`.
Loads `/api/books` and `/api/books/[bookId]/members` once and refreshes on a
`books`/`book_members` change from `useBookChanges`. `useBookRole()` returns
`{ books, currentBook, currentUserId, role, canWrite, isOwner, members,
refresh }`. Outside the provider (isolated component tests, non-book pages)
it answers owner access with no members — a display default only; the server
enforces every level regardless of what the client shows

### Other browser files
- `/lib/book-change-hub.ts` - `createBookChangeHub()`: one event stream per
  book, shared by every `useBookChanges` subscriber (`BookChange` is the
  message type). `components/BookChangesProvider.tsx` mounts it
- `/lib/events.ts` - window event names: `PRICES_SAVED_EVENT`,
  `SYNC_QUEUE_CHANGED_EVENT`, `BOOK_SESSION_ENDED_EVENT`
- `/lib/formatters.ts` - the TypeScript formatters. Components use the WASM
  copies in `lib/wasm-client.ts`; this module gives the types and the
  fallback for input that JSON cannot carry
- `/lib/expression.ts` - `evaluateExpression()`, the parser for amount inputs
  (`+`, `-`, `*`, `/`, parentheses; a user can type `12.50 + 3`)
- `/lib/recurring.ts` - the recurrence limits and helpers
  (`MAX_*_INTERVAL_*`, `isValidAutoCreateDaysBefore()`,
  `parseAutoCreateDaysBefore()`, `addDaysToDateString()`) and the types for
  the WASM recurrence functions
- `/lib/reports.ts` - report grouping for the report page: `groupSplits()`,
  `computeGrandTotal()`, `buildTopParentMap()`
- `/lib/csv.ts` - CSV export: `csvEscape()`, `datedCsvFilename()`,
  `triggerDownload()`
- `/lib/merge-transactions.ts` - `mergeTransactionsForDisplay()` interleaves
  projected (recurring) and actual transactions in date order
- `/lib/payee-match.ts` - `rankPayeeMatch()` and `comparePayeeMatches()`: the
  three match tiers that the payee autocomplete ranks by (the name starts
  with the term, a word starts with it, any other substring). The Rust
  payee list applies the same tiers in SQL before its LIMIT, because the
  forms ask for 8 rows and an alphabetical cut dropped "United" for "uni"
- `/lib/pricing.ts` - `formatPriceMicros()`, `parsePriceMicros()` for the
  price entry pill
- `/lib/job-health.ts` - the job names, their schedules (`JOB_SCHEDULES`),
  and `evaluateJobHealth()`. The status page uses it for its empty state; the
  server evaluates in `rust-api/server/src/routes/system.rs`
- `/lib/posthog-client.ts` - `identifyUser()`, `resetUser()`
- `/lib/posthog-url.ts` - `redactedCaptureUrl()`
- `/lib/typesafe/events.ts`, `/lib/typesafe/types.ts` - the TypeSafe
  settings event and the suggestion types that the sync page shows
- `/lib/api-contract.ts` - `API_CONTRACT`, the number a native client
  compares. The Rust server reads it at build time
- `/lib/utils.ts` - `cn()` for Tailwind class merging, and
  `selectInputContents()`

## Modules the Node scripts run (`lib/`)

These run outside the web server. Do not import them from a component.
- `/lib/accounting.ts` - the TypeScript accounting helpers, and
  `effectiveDateSql`, the effective-date SQL expression that the lot rebuild
  and the payee queries below use
- `/lib/lots.ts` - `replayLots()`, the pure FIFO replay engine (no database)
- `/lib/lots-db.ts` - `rebuildLots()`, `rebuildLotsForPairs()`,
  `findAllLotPairs()`, `collectAffectedPairs()`. `scripts/rebuild-lots.ts`
  runs them for `npm run db:migrate`. The Rust copy in
  `rust-api/db/src/lots.rs` must write the same lots:
  `tests/http/rebuild-lots.test.ts` compares the two
- `/lib/investments.ts` - `aggregatePositions()`, `getPositions()`,
  `getMarketValuesByAccount()`, `fixedPriceRow()`, and the position types
  that the pages import as types
- `/lib/payees.ts` - payee queries and `normalizePayeeName()`, for the
  TypeSafe report
- `/lib/typesafe/client.ts`, `/lib/typesafe/questions.ts`,
  `/lib/typesafe/report.ts`, `/lib/typesafe/settings.ts` - the TypeSafe
  client and the report of `npm run typesafe:report`. The server's copies are
  `rust-api/server/src/typesafe_client.rs`, `typesafe_questions.rs` and
  `typesafe.rs`
- `/lib/plaid.ts` - the Plaid client of `npm run plaid:link`. The server's
  copy is `rust-api/server/src/plaid.rs`. `PLAID_API_URL` replaces the Plaid
  origin for a test mock
- `/lib/posthog-query.ts` - HogQL queries for `scripts/posthog-export.ts`.
  The server's copy is `rust-api/server/src/posthog_query.rs`

## Server code (`rust-api/`)

### `rust-api/core` (`ledger-core`)
Pure domain code. The server links it, and the browser loads it as WASM
(`core/src/wasm.rs`). Its tests check the corpus in
`rust-api/core/fixtures/core.json`:
- `accounting.rs` - `validate_splits()`, `gross_amount_cents()`, the
  investment split builders, `map_investment_action_to_splits()`,
  `validate_investment_action()`, `normal_balance_sign()`,
  `display_balance()`
- `accounts.rs` - the account tree, hierarchy names, and icon resolution
- `recurring.rs` - recurrence: `next_date()`, `initial_next_date()`,
  `is_recurring_rule_due()`, `schedule_key()`, `preview_occurrences()`,
  business-day shifts, and `effective_date()`
- `investments.rs` - `aggregate_positions()`, `fixed_price_row()`,
  `aggregate_market_values_by_account()`
- `lots.rs` - `replay_lots()`, the FIFO replay engine
- `formatters.rs`, `expression.rs` - formatting, currency parsing, and the
  amount expression parser

### `rust-api/db` (`ledger-db`)
Database code that the server and `ledger-cli` both run:
- `lots.rs` - `rebuild_lots()`, `rebuild_lots_for_pairs()`,
  `collect_affected_pairs()`, `find_all_lot_pairs()`, `backfill_lots()`.
  Lots and allocations are derived state. The transaction routes call
  `collect_affected_pairs()` and `rebuild_lots_for_pairs()` inside the same
  transaction as the write
- `seed.rs` - `seed_book()`, the sample dataset of `npm run db:seed` and of
  `POST /api/books/demo`

### `rust-api/server/src`
Shared server modules:
- `auth.rs` - `principal()` resolves the session cookie or a bearer key to a
  user, with the API-key lockout. `session_user()` gives the route's 401.
  `bearer_token()`, `cookie_token()`
- `routes/auth.rs` - `cookie_session()`, the cookie-only session. The
  password change and the API-key routes use only this, so a device that
  holds one key cannot mint another. A repository test holds that rule
- `book_auth.rs` - `authenticate_book(state, headers, raw_book_id, level,
  failure_message)` and `authenticate_book_membership()`. Not a member: 404
  "Book not found", never 403, so a stranger cannot learn that the book
  exists. A member below the level: 403 with the text of
  `accessDeniedMessage()`. Give the level explicitly: `AccessLevel::Read` for
  a read. The default of `AccessLevel` is `Write`. See Access Levels in
  [guides/api-route-patterns.md](api-route-patterns.md)
- `error.rs` - `ApiError`, `error()`, `error_owned()`, `internal_error()`.
  An error answers `{ "error": message }`
- `validation.rs` - the parsers that keep the input rules of the former
  TypeScript routes: `parse_json_body()`, `first_query_values()`,
  `query_date_param()`, `parse_int_prefix()`, `database_integer()`,
  `js_number_string()`, `js_stringify()`, and the account and payee
  validators
- `transaction_input.rs`, `recurring_input.rs` - the transaction and
  recurring-rule input rules, including `expected_updated_at()`
- `db_scope.rs` - `with_advisory_lock()` holds a session lock on one reserved
  connection and hands the callback that connection. Run the callback's
  transaction and queries on it (`with_transaction()`), never on the pool
- `rate_limit.rs` - the login, registration, password, API-key and
  member-add limits. `client_ip()` reads the forwarded address
- `book_changes.rs` - the change notifications behind the event stream
- `analytics.rs` - `capture_event()`. A route that runs for an MCP tool
  records nothing
- `plaid.rs`, `tiingo.rs` - the Plaid and Tiingo clients
- `typesafe.rs`, `typesafe_client.rs`, `typesafe_questions.rs` - the
  TypeSafe experiment
- `openapi/` - the OpenAPI document. See [guides/api-contract.md](api-contract.md)
- `mcp/` - the MCP server. See [guides/mcp-server.md](mcp-server.md)

### `rust-api/server/src/routes/`
One module per route area. `routes/mod.rs` registers each entry of
`rust-api/routes.json`. Functions that more than one caller uses:
- `accounts.rs` - `accounts_with_balances()`
- `transactions.rs` - the register, and the create, update and delete paths.
  A write that sends `expectedUpdatedAt` and finds a newer row answers 409
  and changes nothing. A floating row sorts above the settled rows of its
  effective date (`REGISTER_ORDER`)
- `payees.rs` - `normalize_name()`: trims, collapses whitespace runs and
  straightens quotes. It does **not** lowercase: "IKEA" and "Ikea" are two
  payees. `create_exact()` creates a payee with the exact name
- `members.rs` - member changes. An unknown username and an existing member
  both fail with "Cannot add that user", so the answer does not disclose
  which usernames exist. Only an unknown username counts against the
  `book-member-add` limit. Each change locks every member row of the book
  (`lock_members()`), then checks the actor's role again, so a concurrent
  change cannot leave the book without an owner ("A book must keep at least
  one owner")
- `books.rs` - book CRUD and `create_demo_book()`, which writes the book and
  the seed in one transaction
- `securities.rs` - `delete_security()` refuses a security that still has
  investment splits: splits, lots and prices all cascade from `securities`
- `security_prices.rs` - `set_prices()`, the atomic batch upsert that reports
  the items it skipped. A price move onto an occupied date answers 409
- `reports.rs`, `realized_gains.rs`, `search.rs` - `report_splits()`,
  `income_rows()`, `report()` and `search_book()`
- `sync.rs`, `plaid_sync.rs`, `reconcile.rs` - Plaid connections (access
  tokens are masked before they leave the server), `sync_token()`, and the
  reconciliation queue and `resolve()`
- `recurring.rs` - recurring rules and `process_rules()`
- `system.rs` - version, health, and job status
- `cron.rs`, `typesafe.rs`, `typesafe_suggestion.rs`, `events.rs`,
  `issue_reports.rs`

## Critical Files Reference

| File | Purpose |
|------|---------|
| `/db/schema.ts` | All table definitions and relations (meta + book-scoped). Drizzle is the only migrator |
| `/db/index.ts` | Database connection (`getDb()`) with the postgres.js driver, and `runMigrations()` for explicit migration |
| `/db/create-book.ts` | The migration folder path constant |
| `/db/reset.ts` | `resetDatabase()`: drops the `public` and `drizzle` schemas and runs the migrations again. **Declarations only — no top-level side effects** |
| `/db/seed-cli.ts` | CLI entry for `npm run db:seed`. For a full reset it runs `resetDatabase()`, then runs `ledger-cli seed` through `cargo run`. Holds the main-module guard. Keep the guard out of any module that another file imports: inlined into a bundle, it matches the bundle's own path and drops the database schemas when the bundle starts |
| `/rust-api/routes.json` | The routes that `routes/mod.rs` registers from its handler table |
| `/rust-api/server/src/routes/mod.rs` | The Axum router, and the routes that it registers by name (`/health`, `/api/health`, `/api/mcp`, WebMCP) |
| `/rust-api/server/src/book_auth.rs` | Book access at a level |
| `/rust-api/db/src/lots.rs` | The lot rebuild. Lots and allocations are derived state |
| `/rust-api/cli/src/main.rs` | `ledger-cli`: `rebuild-lots [--force]`, `seed [--book-id N]`, `import-moneydance` |
| `/rust-api/cli/src/import_moneydance/mod.rs` | Moneydance import orchestration, run by `ledger-cli import-moneydance` and `npm run import:moneydance` |
| `/rust-api/server/src/mcp/` | The MCP server: the tool registry, the stdio and HTTP transports, WebMCP, and one handler module per tool group. See [mcp-server.md](mcp-server.md) |
| `/rust-api/server/mcp-tools.json` | The source of each MCP tool's name, title, description, annotations and input schema |
| `/rust-api/server/src/openapi/` | The source of `openapi/openapi.json` |
| `/rust-api/server/src/security.rs` | The only copy of the session gate, the cross-origin write check and the security headers: `protect()` adds the headers (HSTS when `ENABLE_HSTS=true`), the cross-origin write check, the API gate (401 for an `/api/` request without credentials, before the router), and the gate for unmatched paths (404 for `/api/`, a redirect to `/login` for a page without a session) |
| `/rust-api/server/src/compression.rs` | The gzip and br layer that `serve()` puts around every response. It never compresses an event stream, an image, a WOFF font or a tiny body |
| `/rust-api/server/src/static_pages.rs` | The page service behind the page gate. It serves the client build that `COUNTERPOISE_STATIC_DIR` names: `index.html` for each page path, 404 for a missing file under `/assets/`, a one-year immutable cache for `/assets/` and `no-cache` for the rest. The server refuses to start when the folder has no `index.html` |
| `/vite.config.ts` | The client build (to `build/`) and the development server on port 3000. It proxies `/api` to `RUST_API_URL` and puts the `NEXT_PUBLIC_*` values into the bundle at build time |
| `/client/routes.tsx` | The route table of the client. Each page and the book layout load on demand |
| `/lib/wasm-client.ts` | The browser adapter for `ledger-core` |
| `/lib/api-client.ts` | Every browser API request |
| `/scripts/rebuild-lots.ts` | Guarded lot backfill, run by `npm run db:migrate`. `ledger-cli rebuild-lots [--force]` is the Rust copy, with the same guard and messages; the Docker entrypoint runs it |
| `/scripts/check-db-credential.sh` | Stops the app container (before the migrations) and the scheduler when `DATABASE_URL` uses the published default credential |
| `/scripts/postgres-init/01-app-role.sh` | Creates the `counterpoise_app` role on first postgres initialization |
| `/scripts/release.sh` | Version bump, release branch, push, and PR creation. Creates no tag |
| `/scripts/deploy.sh` | Publishes the version tag at one named commit, then builds and restarts. Rebases nothing |
| `/scripts/posthog-export.ts` | CLI tool for exporting PostHog events |
| `/hooks/useBookId.ts` | Client hook for the current book ID |
| `/hooks/useRegistrationOpen.ts` | Client hook for the registration gate of the login and register pages. `null` until the Rust server answers, `false` when the request fails or does not answer in five seconds |
| `/tests/helpers/navigation.tsx` | `mockNavigation(overrides)`: a full mock of `@/lib/navigation` for component tests. It supplies each export, so a test gives only the hooks that it cares about |
| `/tests/helpers/contract.ts` | `contract(name)`: a strict validator of a response body against a component of `openapi/openapi.json` |
| `/tests/helpers/api-keys.ts`, `/tests/helpers/password.ts` | Test helpers that mint API keys and hash passwords in the formats that the Rust server checks |
