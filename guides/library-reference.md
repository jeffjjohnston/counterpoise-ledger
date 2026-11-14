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
shared helpers from here. It exports:
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
- Notes: `noteHtml()`, the HTML of a Markdown transaction note. It is the
  first filter between a note and the page. The CSP `script-src` is the
  second: it refuses an inline script or event handler.
  Put its result into the page as it is, and do not render a note another way

`lib/accounting.ts`, `lib/recurring.ts` and `lib/formatters.ts` give its
types: the data types and the signatures (`AccountingCore`, `RecurringCore`,
`FormattersCore`). They hold no copy of the Rust functions. Do not add one:
the corpus in `rust-api/core/fixtures/core.json` is where a case goes.
`lib/investment-arithmetic.ts` and `formatCurrency()` in `lib/formatters.ts`
give the fallbacks for input that JSON cannot carry to the WASM module, such
as a fractional value while the user types.

### `/lib/api-client.ts`
Every browser request to the API goes through this module:
- `apiFetch()`, `apiGet()`, `apiPost()`, `apiPut()`, `apiDelete()`
- `ApiError` - carries the status and the server's `error` message
- `toMessage(error)` - the text to show for any thrown value

### `/lib/access-session.ts`
Cloudflare Access in front of a deployment. An expired Access token turns
each API request into a redirect to the Access login on another origin, so
`apiFetch()` and the book socket's handshake check fetch with
`redirect: "manual"`. `accessExpired(response)` spots the redirect, and
`renewAccessSession()` reloads the page (once a minute at most), which
renews the token or shows the login. No API route redirects a `fetch`.

### `/lib/tab-return.ts`
`onTabReturn(callback)` calls `callback` once when the user comes back to the
tab, and returns the function that removes its listeners. One return fires
both `focus` and `visibilitychange`, so the events within 100 ms make one call.

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
- `/lib/formatters.ts` - `formatCurrencyCompact()` and `compactDecimals()`
  for the chart axes, the `formatCurrency()` fallback for input that JSON
  cannot carry, `toDateString()` (the tests use it for today's date), and
  `FormattersCore`, the types of the WASM formatters. Components use the
  formatters in `lib/wasm-client.ts`. `evaluateExpression()` there is the
  parser for amount inputs (`+`, `-`, `*`, `/`, parentheses; a user can type
  `12.50 + 3`)
- `/lib/investments.ts` - the types `PositionSummary` and
  `AccountMarketValue` of the investment responses. The Rust core calculates
  them
- `/lib/save-chord.ts` - the optional chord when the transaction form saves:
  the per-device setting (localStorage) and `prepareSaveChord()`, which makes
  the AudioContext inside the submit gesture and returns the function that
  plays the chord once the save handler reports success. Only
  `TransactionForm` calls it; imports, sync, recurring processing and MCP
  writes stay silent
- `/lib/recurring.ts` - `RecurringCore`, the types of the WASM recurrence
  functions. The limits and helpers are in `rust-api/core/src/recurring.rs`
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
  server evaluates in `rust-api/server/src/routes/system.rs`, whose Worker
  table drops the reindex and runs one backup a day
- `/lib/typesafe/events.ts`, `/lib/typesafe/types.ts` - the TypeSafe
  settings event and the suggestion types that the sync page shows
- `/lib/api-contract.ts` - `API_CONTRACT`, the number a native client
  compares. The Rust server reads it at build time
- `/lib/utils.ts` - `cn()` for Tailwind class merging, and
  `selectInputContents()`

## Modules the Node scripts run (`lib/`)

These run outside the web server. Do not import them from a component.
- `/lib/payees.ts` - `normalizePayeeName()`, for the TypeSafe questions
- `/lib/typesafe/questions.ts`, `/lib/typesafe/report.ts`,
  `/lib/typesafe/settings.ts` - the question builders and the report of
  `npm run typesafe:report`, which reads the database file with
  `node:sqlite`. The server's copies are
  `rust-api/server/src/typesafe_questions.rs` and `typesafe.rs`. Only the
  server calls the model (`typesafe_client.rs`)
- `/lib/plaid.ts` - `getPlaidConfig()`, the Plaid settings of
  `npm run plaid:link`, the terminal fallback to the in-app Hosted Link flow.
  The server's Plaid client is `rust-api/server/src/plaid.rs`.
  `PLAID_API_URL` replaces the Plaid origin for a test mock

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
- `notes.rs` - `note_html()`, Markdown note to HTML with pulldown-cmark
  (tables, strikethrough, task lists, bare-URL autolinks). It drops raw HTML
  and keeps a link or image only for an `http`, `https` or `mailto` target

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
- `database.rs` - `open()` (the pragmas and the limits on each pooled
  connection), `migrate()` (the embedded migrations of
  `rust-api/db/migrations/`), and `lock_server()` (the `<database>.lock` file
  lock)
- `store.rs` - the synchronous API: `Database` (`open()`, `transaction()`,
  `read_transaction()`), the `Sql` trait (`query`, `query_row`,
  `query_optional`, `execute`, `exec_batch`), `Value`, `Row`, `FromRow`,
  `params!` and `Builder` (a statement with optional clauses). `#[derive(FromRow)]`
  comes from the `ledger-db-derive` crate (`rust-api/derive/`) and reads each
  field from the column of its name. See
  [database-management.md](database-management.md#the-synchronous-api)
- `engine/` - the one module that names the engine. `engine/native.rs` is
  the rusqlite backend of `store.rs` (`Database`, `Transaction` and its
  `savepoint()`), built with the `native` feature. `engine/hosted.rs` is the
  backend without it: a `Connection` trait that the host implements (a
  Durable Object's `SqlStorage`), with `Database::new()`. Its tests run it
  over rusqlite
- `limits.rs` - `LIMITS`: a Durable Object's SQLite limits, which
  `Database::open()` sets on every connection
- `folds.rs` - the `*_fold` columns and the Plaid `merchant_key`:
  `FOLD_COLUMNS`, `fold()` and `merchant_key()` (from `ledger_core::names`),
  `check()` and `repair()` (on the synchronous API), which the native
  server runs at start, the Worker's object once for each build, and
  `ledger-cli repair-folds` by hand
- `clock.rs` - the app's zone (`APP_TZ`, else `TZ`) and `today()` in it
- `env.rs` - `var()`, which every setting read goes through. A process reads
  its environment; a Worker has none, so the Durable Object passes its
  variables and secrets to `set()` before it starts
- `sql.rs` - the SQL helpers: `today_literal()`, `date_literal()`,
  `EFFECTIVE_DATE`, `in_integers()`, `in_texts()`, `json_rows()`, `json()`
  and `json_array()` (`store::Builder::push_in_integers()` is the builder's)
- `locks.rs` - `FOR_UPDATE` and `FOR_SHARE`, both empty: `BEGIN IMMEDIATE`
  already holds the write lock
- `jobs.rs` - the job leases (`acquire()`, `renew()`, `release()` and
  `held()` on `job_leases`), the job runs (`record_run()`, `runs()` and
  `last_run_failed()` on `job_runs`), and the scheduler's slots and requests
  (`slots()`, `claim()`, `advance()`, `attempt()`, `finish()` on `job_slots`;
  `request()` and `requests()` on `job_requests`)
- `backup.rs` - `snapshot()`: a `VACUUM INTO` copy, checked with
  `PRAGMA integrity_check`; `daily_dump()` and `write_dump()`
- `dump.rs` - `dump()` and `load()`: the portable JSON dump that moves the
  data between a file and a Durable Object. `dump_json()` writes the same
  dump as text a row at a time; use it to store a dump, because a tree of
  JSON values takes several times the memory of its text. `load()` reads a
  dump into a new file, and `dump::import()` reads one into a migrated database
  with no user, as the admin import route does
- `sync_floor.rs` - `SYNC_FLOOR_BOOK_ID` and the floor marker that a
  backup copy and a loaded dump add to `transaction_changes`
- `testing.rs` - `TempDatabase`, a migrated database file for a Rust test

`backup.rs`, `database.rs` (`open()` and the server lock), `limits.rs` and
`testing.rs` need a file and rusqlite, so they build only with the `native`
feature, which is the default.

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
- `db_scope.rs` - `write_transaction()` and `read_transaction()` run a
  route's closure in a transaction of `state.database` and answer a database
  error with the route's 500. `write_transaction_or()` takes the route's
  own answer to a database error, for a route whose failure is not a 500
  (the TypeSafe routes answer 503)
- `platform.rs` - what the server takes from the runtime: `now()`,
  `timestamp()`, `today()`, `instant()`, `random()`, `spawn()`,
  `spawn_to_finish()` (background work that must end, which a Durable
  Object keeps itself up for with `waitUntil`), `blocking()`, `sleep()`, `timeout()`, `process_name()`, the socket peer
  (`CF-Connecting-IP` on the Worker) and the HTTP client (`http_client()`;
  each request sets its own `.timeout()`). Server code calls these, not
  `Utc::now`, `Instant::now`, `tokio::spawn`, `spawn_blocking`,
  `tokio::time`, `getrandom` or `std::process::id`, so that the Workers
  build can replace each in one place: on wasm32 the standard library's
  clock and process id panic. A test in the module fails on a direct call
  outside it and the native-only files. `outbound()` wraps each outgoing
  request, since a request future on wasm32 is not `Send`.
  `post_without_redirects()` is the POST of a client that sends a key (the
  weekly review, TypeSafe): it hands back a 3xx instead of following it. On
  wasm32 it calls `fetch` itself with `redirect: "manual"`, since reqwest
  cannot refuse a redirect there
- `hosted.rs` - `start()`, the Worker's version of the native start: it
  checks the version, the zone and the migrations, asks
  for the stepped lot rebuild when trades exist and no lot does, and returns an `App`:
  the router with the security layers, `repair_folds()`, which the object
  runs once for each build, `next_wake()` and `alarm()`, which
  run the scheduler from the object's alarm, and the hibernating book
  sockets (`hosted/sockets.rs`: `admit_socket()`, `watch_books()`,
  `socket_updates()`). The router also has the admin import route
  (`hosted/import.rs`), which is off without `IMPORT_SECRET`. The Durable
  Object calls it. `hosted/restore.rs` checks the point-in-time restore
  route, which the object serves itself, and `App::after_restore()` adds the
  floor marker at the first start after a restore
- `revocations.rs` - `Revocations`, the watch channel that ends a book
  socket when a session or API key is revoked
- `leases.rs` - `try_take()` and `wait()`: a lease on a job or a Plaid
  connection, renewed while it is held and released when it drops
- `rate_limit.rs` - the login, registration, password, API-key, member-add
  and OAuth limits, in the table `rate_limits`. `client_ip::from_headers()`
  (`client_ip.rs`) reads the forwarded address
- `book_changes.rs` - `BookChangeHub`, which polls `change_marks` for the
  book socket
- `scheduler/mod.rs` - the scheduled jobs, their steps and their run
  records; `scheduler/plan.rs` - `plan()`, the jobs due now and the next
  wake from the time and the job tables
- `health_probe.rs` - `counterpoise-rust-api health`, the image's
  healthcheck
- `plaid.rs`, `tiingo.rs` - the Plaid and Tiingo clients
- `typesafe.rs`, `typesafe_client.rs`, `typesafe_questions.rs` - the
  TypeSafe experiment
- `weekly_review/` - the weekly review: `input.rs` (the data and the request
  document), `output.rs` (the schema and the checks), `anthropic.rs` (the
  Messages API client) and `mod.rs` (start, run, save, prune). The routes are
  `routes/weekly_review.rs`. See [guides/weekly-review.md](weekly-review.md)
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
  straightens quotes. It does **not** lowercase, but a payee name matches
  without case: "IKEA" and "Ikea" are one payee. `create_exact()` creates a
  payee, or returns the name of the existing payee that matches
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
- `cron.rs`, `typesafe.rs`, `typesafe_suggestion.rs`, `socket.rs`,
  `issue_reports.rs`

## Critical Files Reference

| File | Purpose |
|------|---------|
| `/rust-api/db/migrations/` | The schema: `0001_baseline.sql` and each later numbered file. Never edit one that has run |
| `/rust-api/db/src/database.rs` | Opening the file: pragmas, limits, the server lock, the embedded migrations |
| `/types/db.ts` | The TypeScript row types that the client and the test helpers use |
| `/rust-api/routes.json` | The routes that `routes/mod.rs` registers from its handler table |
| `/rust-api/server/src/routes/mod.rs` | The Axum router, and the routes that it registers by name (`/health`, `/api/health`, `/api/mcp`, WebMCP) |
| `/rust-api/server/src/book_auth.rs` | Book access at a level |
| `/rust-api/db/src/lots.rs` | The lot rebuild. Lots and allocations are derived state |
| `/rust-api/cli/src/main.rs` | `ledger-cli`: `migrate`, `seed [--book-id N \| --reset]`, `list-books`, `rebuild-lots [--force]`, `import-moneydance`, `backup [--dir D]`. Each uses `DATABASE_PATH` (default `data/counterpoise.db`) |
| `/rust-api/server/src/scheduler/mod.rs` | The scheduled jobs (recurring, Plaid, prices, TypeSafe cleanup, backup, prune, `VACUUM`), on when `COUNTERPOISE_SCHEDULER=on` |
| `/rust-api/cli/src/import_moneydance/mod.rs` | Moneydance import orchestration, run by `ledger-cli import-moneydance` and `npm run import:moneydance` |
| `/rust-api/server/src/mcp/` | The MCP server: the tool registry, the stdio and HTTP transports, WebMCP, and one handler module per tool group. See [mcp-server.md](mcp-server.md) |
| `/rust-api/server/src/oauth/` | OAuth 2.1 for `/api/mcp`, on when `COUNTERPOISE_PUBLIC_URL` is set. See [mcp-server.md](mcp-server.md#oauth-for-custom-connectors) |
| `/rust-api/server/mcp-tools.json` | The source of each MCP tool's name, title, description, annotations and input schema |
| `/rust-api/server/src/openapi/` | The source of `openapi/openapi.json` |
| `/rust-api/server/src/security.rs` | The only copy of the session gate, the cross-origin write check and the security headers: `protect()` adds the headers (HSTS when `ENABLE_HSTS=true`), the cross-origin write check, the API gate (401 for an `/api/` request without credentials, before the router), and the gate for unmatched paths (404 for `/api/`, a redirect to `/login` for a page without a session). `page_gate()` is that page decision alone, which the Worker also runs |
| `/rust-api/server/src/lib.rs` | The server crate's root: its modules, `serve()`, stdio MCP and `run()`, the command line that `main.rs` calls. The Worker crate links it as `counterpoise_rust_api` |
| `/rust-api/worker/` | The Worker and its Durable Object. `route()` decides which paths go to the object; `wrangler.toml` holds the bindings and lists the secrets. `src/object.rs` is `LedgerObject`: it starts the server with `hosted::start()`, serves the router, holds the book sockets with hibernation, runs the scheduled jobs from its alarm and sets the next one, gives the backup job the `EXPORTS` bucket, and passes promised background work to `waitUntil`; a panic aborts the object so that the next request builds it again. `src/storage.rs` is the database of the object: `SqlStorage` behind `ledger_db`'s `Connection`, with the bindings workers-rs lacks (`transactionSync`, the point-in-time bookmarks, `abort`, `waitUntil`). Reset the object only with its `reset()`, which calls `ctx.abort` from a timer: `abort` throws, and a throw through Wasm frames leaves the instance unable to finish any future until the next deploy |
| `/rust-api/server/src/compression.rs` | The gzip and br layer that `serve()` puts around every response. It never compresses an event stream, an image, a WOFF font or a tiny body |
| `/rust-api/server/src/static_pages.rs` | The page service behind the page gate. It serves the client build that `COUNTERPOISE_STATIC_DIR` names: `index.html` for each page path, 404 for a missing file under `/assets/`, a one-year immutable cache for `/assets/` and `no-cache` for the rest. The server refuses to start when the folder has no `index.html` |
| `/vite.config.ts` | The client build (to `build/`) and the development server on port 3000. It proxies `/api` to `RUST_API_URL` and puts the `NEXT_PUBLIC_*` values into the bundle at build time |
| `/client/routes.tsx` | The route table of the client. Each page and the book layout load on demand |
| `/lib/wasm-client.ts` | The browser adapter for `ledger-core` |
| `/lib/api-client.ts` | Every browser API request |
| `/scripts/release.sh` | Version bump, release branch, push, and PR creation. Creates no tag |
| `/scripts/deploy.sh` | Publishes the version tag at one named commit, then builds and restarts. Rebases nothing |
| `/hooks/useBookId.ts` | Client hook for the current book ID |
| `/hooks/useSubmitGuard.ts` | Client hook that lets one save run at a time. `run(save)` drops a submit while a save is in flight; `saving` disables the submit button. `TransactionForm`, `RecurringForm`, `AccountForm` and `SecurityForm` use it. Use it in each new form that sends a write |
| `/hooks/useRegistrationOpen.ts` | Client hook for the registration gate of the login and register pages. `null` until the Rust server answers, `false` when the request fails or does not answer in five seconds |
| `/tests/helpers/navigation.tsx` | `mockNavigation(overrides)`: a full mock of `@/lib/navigation` for component tests. It supplies each export, so a test gives only the hooks that it cares about |
| `/tests/helpers/contract.ts` | `contract(name)`: a strict validator of a response body against a component of `openapi/openapi.json` |
| `/tests/helpers/api-keys.ts`, `/tests/helpers/password.ts` | Test helpers that mint API keys and hash passwords in the formats that the Rust server checks |
