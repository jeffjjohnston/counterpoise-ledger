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
  `formatPriceMicrosInput()`, `evaluateExpression()`,
  `formatCurrencyCompact()` and `compactDecimals()` (in `lib/formatters.ts`
  only: the short label for a chart axis, such as "$1.2k", and the decimals
  that keep two ticks one step apart different)

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
- `/lib/report-chart.ts` - `toChartData()`: turns the grouped report rows
  into the series for `ReportChart`, or `null` when the report has nothing
  to draw. It keeps the `TOP_ACCOUNTS` or `TOP_ITEMS` largest items and
  puts the rest in one `OTHER_KEY` series. The payee page chart
  (`PayeeSpendingChart`) calls it with `["month"]`, after `groupSplits()`,
  through `toPayeeSpendingChart()`
- `/lib/payee-spending-chart.ts` - `toPayeeSpendingChart()`: the payee page
  chart. It calls `toChartData()` with `["month"]` and fills each empty month
  from the first to the last month of the range with zero bars
- `/lib/income-statement-chart.ts` - `toMonthlyChart()`: income, expense
  and net bars for each month (gap months get zeros), or for each year when
  the range has more than `MAX_MONTHS` (24) months; `unit` says which. It
  gives `null` for fewer than 2 months. `toCategoryChart()`: the expense rows rolled up to the
  top-level account with `buildTopParentMap()`, the 10 largest and "Other"
- `/lib/realized-gains-chart.ts` - `toRealizedGainsChart()`: turns the rows
  of the realized gains page into stacked short-term and long-term bars. It
  has one group for each month of the range, or for each year above 24
  months. A row with an unknown term or basis is left out. Gives `null` when
  no row has a known gain
- `/lib/allocation-chart.ts` - `toAllocationChart()`: turns the securities
  into one horizontal bar for each security, by market value, largest first.
  The 10 largest get a bar and the rest go into "Other". A security with no
  price or no positive value has no bar. Gives `null` for fewer than two bars
- `/lib/chart-range.ts` - `ChartRange` (`"1Y"`, `"5Y"`, `"All"`),
  `CHART_RANGES`, `RANGE_NAMES` (the words for a range in a chart label),
  and `rangeStart()`: the first date of a range, or `null` for all history
- `/lib/price-history-chart.ts` - `toPriceHistoryChart()`: turns the price
  rows (newest first) into one `LineSeries`, oldest first, with values in
  cents, or `null` for fewer than two prices
- `/lib/account-balance-chart.ts` - `toAccountBalanceChart()`: turns the
  points of the `balance-history` route into one `LineSeries` with the
  display sign of the account type (`getDisplayBalance()`), or `null` for
  fewer than two points
- `/lib/net-worth-chart.ts` - `toNetWorthGroupChart()`: turns the
  `net-worth-history?groupBy=account` response into the stacked areas of the
  dashboard "By group" view: the 7 groups with the largest absolute value at
  the last point, then "Other" (`OTHER_KEY`, `--chart-8`), and net worth as
  the total line. Gives `null` for fewer than two points
- `/lib/net-worth.ts` - `effectiveBalance()`: the balance that the dashboard
  shows for an account (an investment account uses its market value plus
  the balance of its cash child). `computeNetWorth()`: the dashboard total.
  The net worth history route in Rust checks its result against this
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
- `/lib/accounting.ts` - the TypeScript accounting helpers
- `/lib/lots.ts` - `replayLots()`, the pure FIFO replay engine (no database)
- `/lib/investments.ts` - `aggregatePositions()`,
  `aggregateMarketValuesByAccount()`, and the position types that the pages
  import as types
- `/lib/payees.ts` - `normalizePayeeName()`, for the TypeSafe questions
- `/lib/typesafe/client.ts`, `/lib/typesafe/questions.ts`,
  `/lib/typesafe/report.ts`, `/lib/typesafe/settings.ts` - the TypeSafe
  client and the report of `npm run typesafe:report`, which reads the
  database file with `node:sqlite`. The server's copies are
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
  `aggregate_market_values_by_account()`, `replay_order()` (the order of a
  position replay) and `PositionReplay` (the replay that the positions and the
  net worth series share)
- `net_worth.rs` - `net_worth_series()` (the net worth at each date),
  `net_worth_by_group()` (the same values, split by top-level account; the
  group values of a point add up to its net worth) and `point_dates()`
  (month ends, then the end date). Both series use one per-account
  calculation, so they cannot disagree. The account balance
  history route uses `point_dates()` too
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
- `seed/` (a directory) - `seed_book()`, the sample datasets (`household`, `single`) of
  `npm run db:seed` and of `POST /api/books/demo`. The dates are relative to
  `today`. Snapshot and invariant tests: `rust-api/db/src/seed/tests.rs`
- `database.rs` - `open()` (the pragmas and the SQL functions on each pooled
  connection), `migrate()` (the embedded migrations of
  `rust-api/db/migrations/`), and `lock_server()` (the `<database>.lock` file
  lock)
- `functions.rs` - the SQL functions that each connection registers:
  Unicode `lower()`, case-sensitive `LIKE`, `cp_today()` and
  `cp_merchant_key()`
- `sql.rs` - the SQL helpers: `today!()`, `EFFECTIVE_DATE`, `in_integers()`,
  `in_texts()`, `json()`, `json_array()` and `MERCHANT_KEY`
- `locks.rs` - `begin()` and `begin_pool()` (`BEGIN IMMEDIATE`), and
  `with_session_lock()`, a file lock under `<database>.locks/` that spans
  several transactions
- `backup.rs` - `snapshot()`: a `VACUUM INTO` copy, checked with
  `PRAGMA integrity_check`
- `testing.rs` - `TempDatabase`, a migrated database file for a Rust test

### `rust-api/server/src`
Shared server modules:
- `auth.rs` - `principal()` resolves the session cookie or a bearer key to a
  user, with the API-key lockout. `principal_with()` also takes whether an
  OAuth access token counts: only `/api/mcp` and its tools' route requests
  accept one. `session_user()` gives the route's 401. `bearer_token()`,
  `cookie_token()`
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
- `db_scope.rs` - `with_transaction()` opens `BEGIN IMMEDIATE` on the
  caller's connection. Inside `ledger_db::locks::with_session_lock()`, run
  the callback's transaction and queries on the connection that it hands
  over, never on the pool
- `rate_limit.rs` - the login, registration, password, API-key and
  member-add limits. `client_ip()` reads the forwarded address
- `book_changes.rs` - `BookChangeHub`, which polls `change_marks` for the
  event stream
- `scheduler.rs` - the scheduled jobs and their status files
- `health_probe.rs` - `counterpoise-rust-api health`, the image's
  healthcheck
- `analytics.rs` - `capture_event()`. A route that runs for an MCP tool
  records nothing
- `plaid.rs`, `tiingo.rs` - the Plaid and Tiingo clients
- `typesafe.rs`, `typesafe_client.rs`, `typesafe_questions.rs` - the
  TypeSafe experiment
- `openapi/` - the OpenAPI document. See [guides/api-contract.md](api-contract.md)
- `mcp/` - the MCP server. See [guides/mcp-server.md](mcp-server.md)
- `oauth/` - OAuth 2.1 for `/api/mcp`: discovery, client registration and
  metadata documents, consent, tokens and grants. See
  [guides/mcp-server.md](mcp-server.md#oauth-for-custom-connectors)

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
| `/rust-api/db/migrations/` | The schema: `0001_baseline.sql` and each later numbered file. Never edit one that has run |
| `/rust-api/db/src/database.rs` | Opening the file: pragmas, SQL functions, the server lock, the embedded migrations |
| `/types/db.ts` | The TypeScript row types that the client and the test helpers use |
| `/rust-api/routes.json` | The routes that `routes/mod.rs` registers from its handler table |
| `/rust-api/server/src/routes/mod.rs` | The Axum router, and the routes that it registers by name (`/health`, `/api/health`, `/api/mcp`, WebMCP) |
| `/rust-api/server/src/book_auth.rs` | Book access at a level |
| `/rust-api/db/src/lots.rs` | The lot rebuild. Lots and allocations are derived state |
| `/rust-api/cli/src/main.rs` | `ledger-cli`: `migrate`, `seed [--book-id N \| --reset]`, `list-books`, `rebuild-lots [--force]`, `import-moneydance`, `backup [--dir D]`, `import-postgres --from <url> --to <path> [--allow-unbalanced]`. Each uses `DATABASE_PATH` (default `data/counterpoise.db`) |
| `/rust-api/cli/src/import_postgres.rs` | The one-time PostgreSQL-to-SQLite converter and its checks. See [upgrade-to-sqlite.md](upgrade-to-sqlite.md) |
| `/rust-api/server/src/scheduler.rs` | The scheduled jobs (recurring, Plaid, prices, TypeSafe cleanup, backup, prune, `VACUUM`), on when `COUNTERPOISE_SCHEDULER=on` |
| `/rust-api/cli/src/import_moneydance/mod.rs` | Moneydance import orchestration, run by `ledger-cli import-moneydance` and `npm run import:moneydance` |
| `/rust-api/server/src/mcp/` | The MCP server: the tool registry, the stdio and HTTP transports, WebMCP, and one handler module per tool group. See [mcp-server.md](mcp-server.md) |
| `/rust-api/server/src/oauth/` | OAuth 2.1 for `/api/mcp`, on when `COUNTERPOISE_PUBLIC_URL` is set. See [mcp-server.md](mcp-server.md#oauth-for-custom-connectors) |
| `/rust-api/server/mcp-tools.json` | The source of each MCP tool's name, title, description, annotations and input schema |
| `/rust-api/server/src/openapi/` | The source of `openapi/openapi.json` |
| `/rust-api/server/src/security.rs` | The only copy of the session gate, the cross-origin write check and the security headers: `protect()` adds the headers (HSTS when `ENABLE_HSTS=true`), the cross-origin write check, the API gate (401 for an `/api/` request without credentials, before the router), and the gate for unmatched paths (404 for `/api/`, a redirect to `/login` for a page without a session) |
| `/rust-api/server/src/compression.rs` | The gzip and br layer that `serve()` puts around every response. It never compresses an event stream, an image, a WOFF font or a tiny body |
| `/rust-api/server/src/static_pages.rs` | The page service behind the page gate. It serves the client build that `COUNTERPOISE_STATIC_DIR` names: `index.html` for each page path, 404 for a missing file under `/assets/`, a one-year immutable cache for `/assets/` and `no-cache` for the rest. The server refuses to start when the folder has no `index.html` |
| `/vite.config.ts` | The client build (to `build/`) and the development server on port 3000. It proxies `/api` to `RUST_API_URL` and puts the `NEXT_PUBLIC_*` values into the bundle at build time |
| `/client/routes.tsx` | The route table of the client. Each page and the book layout load on demand |
| `/lib/wasm-client.ts` | The browser adapter for `ledger-core` |
| `/lib/api-client.ts` | Every browser API request |
| `/scripts/upgrade-to-sqlite.sh` | Converts an install's PostgreSQL data to SQLite, once. Uses `docker-compose.upgrade.yml`. See [upgrade-to-sqlite.md](upgrade-to-sqlite.md) |
| `/scripts/verify-postgres-conversion.sh` | `--ref <commit>`: seeds PostgreSQL with the binaries of that commit, converts, and compares every GET response of every book |
| `/scripts/release.sh` | Version bump, release branch, push, and PR creation. Creates no tag |
| `/scripts/deploy.sh` | Publishes the version tag at one named commit, then builds and restarts. Rebases nothing |
| `/scripts/posthog-export.ts` | CLI tool for exporting PostHog events |
| `/hooks/useBookId.ts` | Client hook for the current book ID |
| `/hooks/useRegistrationOpen.ts` | Client hook for the registration gate of the login and register pages. `null` until the Rust server answers, `false` when the request fails or does not answer in five seconds |
| `/tests/helpers/navigation.tsx` | `mockNavigation(overrides)`: a full mock of `@/lib/navigation` for component tests. It supplies each export, so a test gives only the hooks that it cares about |
| `/tests/helpers/contract.ts` | `contract(name)`: a strict validator of a response body against a component of `openapi/openapi.json` |
| `/tests/helpers/api-keys.ts`, `/tests/helpers/password.ts` | Test helpers that mint API keys and hash passwords in the formats that the Rust server checks |
