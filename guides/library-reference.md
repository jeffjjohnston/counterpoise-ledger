# Library & File Reference

One of the guides [CLAUDE.md](../CLAUDE.md) points to. Read that file first;
it carries the rules that apply everywhere and says when to come here.

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
- `getPositions(db, bookId, accountId?)` - Full position query with market values; cost basis is summed from `investmentLots.remainingBasisCents`, not recomputed from splits (see Lot Tracking in [guides/investments.md](investments.md))
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
- `deleteTransaction(db, bookId, transactionId)` - Deletes a transaction, its splits, and its investment splits
- `TransactionValidationError` - Invalid input (splits don't balance, etc.)
- `TransactionNotFoundError` - Transaction ID doesn't exist in the book

### `/lib/accounts.ts`
Shared account logic (used by both API routes and MCP tools):
- `getAccountsWithBalances(db, bookId, opts?)` - Accounts with computed balances
- `createAccount(db, bookId, input)` - Creates an account; an `investment` subtype also gets its paired cash sub-account
- `updateAccount(db, bookId, accountId, input)` - Updates an account's fields
- `deleteAccount(db, bookId, accountId)` - Deletes an account; refuses when it still has transactions or children
- `ensureInvestmentCashAccount()`, `isInvestmentAccount()` - Investment cash pairing helpers
- `AccountValidationError`, `AccountNotFoundError` - Error classes both surfaces map to their own status codes

### `/lib/books.ts`
Shared book logic (used by both API routes and MCP tools):
- `createBook(db, userId, input)`, `updateBook(db, userId, bookId, input)` — note `name` is required on update; resend the current name to change only `upcomingDays`
- `deleteBook(db, userId, bookId, confirmBookName)` - Deletes a book and, by FK cascade, its whole ledger. `confirmBookName` must match the stored name **exactly** — this guard is the only thing standing between MCP and an entire book. A tool call is cheap to issue and a book is not recoverable, so the caller has to name what it is destroying. Do not relax the comparison
- `createDemoBook(db, userId)` - Creates a book and fills it with the `db/seed.ts` sample dataset. The only caller allowed to reach `seedBook`, and it always passes the id of the book it just created — `seedBook` deletes the target book's rows first, so a caller-supplied id would be a data-loss bug
- `BookValidationError`, `BookNotFoundError` - Error classes

### `/lib/issue-reports.ts`
Shared issue-report logic (used by both API routes and MCP tools). These are scoped to `userId`, not `bookId`:
- `createIssueReport()`, `listIssueReports()`, `updateIssueReport()`, `deleteIssueReport()`
- `IssueReportValidationError`, `IssueReportNotFoundError` - Error classes

### Other lib files
- `/lib/payees.ts` - Payee reads and writes shared by API routes and MCP tools:
  - `normalizePayeeName()` for deduplication (trims, collapses whitespace runs, straightens curly quotes; does **not** lowercase)
  - `listPayees(db, bookId, {search, limit})`, `getPayee()`, `getPayeeLastAccountId()`, `getPayeeDetail()` — the reads behind `GET /payees`, `GET /payees/[id]`, `GET /payees/[id]/last-account` and the `list_payees`/`get_payee` tools. `getPayeeDetail()` is `getPayee` + `getPayeeLastAccountId`, which is why MCP folds the last-account route into `get_payee`
  - `createPayee()`, `deletePayee()` — writes; `deletePayee` refuses a payee that still has transactions
  - `PayeeValidationError`, `PayeeNotFoundError` - Error classes
- `/lib/pricing.ts` - Security price data handling
- `/lib/securities.ts` - Security reads and writes shared by API and MCP: `listSecurities()`, `createSecurity()`, `updateSecurity()`, `deleteSecurity()`. `deleteSecurity` refuses a security that still has investment splits — splits, lots, and prices all cascade from `securities`, so deleting one would erase its whole investment history while leaving the double-entry transactions in place. Errors: `SecurityValidationError`, `SecurityDuplicateError`, `SecurityNotFoundError`
- `/lib/security-prices.ts` - Price writes and the price-entry queue shared by API and MCP: `setSecurityPrices()` (atomic batch upsert; takes the **raw** array so it can report which entries it discarded — `bulkPricesSchema` filters malformed items inside a `.transform()`, so a caller that parses first cannot say what it lost), `updateSecurityPrice()`, `deleteSecurityPrice()`, `listPricesDue()`. `updateSecurityPrice` treats a date change as a move, and refuses one onto an occupied date with `PriceEntryConflictError`. It checks for an occupant *before* opening the transaction so the delete never runs, then maps a duplicate-key violation from inside it to the same error — the pre-check reads committed rows only, so a concurrent move onto that date slips past it and collides at the unique index. Errors: `PriceEntryNotFoundError`, `PriceEntryConflictError`
- `/lib/expression.ts` - `evaluateExpression()` parser for amount inputs (supports `+`, `-`, `*`, `/`, parens — e.g., user can type `12.50 + 3` in an amount field)
- `/lib/csv.ts` - CSV export helpers (`csvEscape()`, `triggerDownload()`) used by the securities and income statement pages
- `/lib/transactions-query.ts` - The single transaction filter, shared by the register route and `list_transactions`: `selectTransactionPage()` (which rows, in what order, and optionally how many) and `countTransactionsBefore()` (how many sort ahead of a given row — the register's scroll-to-transaction affordance). It returns rows carrying the **effective** date, not bare ids, because the route anchors its running-balance sum on the oldest row of the page. The two surfaces previously built this filter twice and differently — MCP with a subquery on `transaction_splits`, the route with an inner join and `GROUP BY`. They agreed; nothing held them in agreement
  - Presentation stays with each surface: the route keeps `ensureId`'s page widening, `balanceAccountId`/`startingBalance`, the `includeMeta` envelope and its relational hydration; `list_transactions` keeps its own row shaping. Only "which rows, in what order" is shared. `balanceAccountId` and `includeMeta` are deliberately absent from MCP — the first never filters which transactions come back (it only picks which account's splits seed the route's own `startingBalance` sum, and `get_account_balance_history` answers the equivalent question for MCP); the second is an envelope switch and the tool always returns `totalCount`
- `/lib/merge-transactions.ts` - `mergeTransactionsForDisplay()` interleaves projected (recurring) and actual transactions in date order for the transaction list
- `/lib/plaid.ts` - Plaid API client (link tokens, access tokens, transaction sync fetch)
- `/lib/plaid-tokens.ts` - Plaid connection reads and writes shared by API routes and MCP tools: `getPlaidStatus()` (the Sync page's four polls in one call), `listTokenAccounts()` (an optional `refresh` re-pulls the account list from Plaid — the only reason this read is not folded into `getPlaidStatus`; the MCP tool does not expose this option, only the HTTP route does — see `mcp/tools/plaid.ts`), `updatePlaidToken()`, `deletePlaidToken()`, `setTokenAccounts()`, `clearSyncData()`. `maskAccessToken()` and `toTokenListItem()` (exported so the token-creation route can mask its own inserted row the same way) live here too. `getTokenOr404()` is not exported: it returns the unmasked row, including the raw `accessToken`, so nothing outside this file can reach it — every caller-facing read goes through `toTokenListItem()` or `toPlaidAccountPayload()` instead. Its parameter order is `(db, bookId, tokenId, …)`, matching every other exported function here, on purpose: a transposed `(tokenId, bookId)` pair type-checks silently and would query the wrong row. Errors: `PlaidTokenNotFoundError`, `PlaidTokenValidationError`, `PlaidRefreshError` (a refresh's Plaid call, or the write reconciling its response, failed — kept distinct from a plain database failure so callers can tell them apart)
- `/lib/plaid-transactions.ts` - Staged Plaid rows and transaction links shared by API routes and MCP tools: `listPendingPlaidTransactions()`, `getTransactionPlaidLink()`, `unlinkPlaidTransaction()`. Error: `PlaidLinkNotFoundError`
- `/lib/plaid-sync.ts` - `syncToken()` — fetches Plaid transactions, stages in reconciliation table, runs auto-match
- `/lib/plaid-auto-match.ts` - `autoMatchPendingTransactions()` — learned payee-based auto-matching
- `/lib/recurring.ts`, `/lib/recurring-processing.ts`, `/lib/recurring-rules.ts` - Recurring transaction logic
- `/lib/reports.ts` - Financial report logic (`groupSplits()`, `computeGrandTotal()`, `buildTopParentMap()`)
- `/lib/utils.ts` - `cn()` utility for Tailwind class merging

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
| `/lib/transactions-query.ts` | Shared transaction filter, page select, and position count |
| `/lib/security-prices.ts` | Manual price writes, atomic batch upsert, and the price-entry queue |
| `/scripts/rebuild-lots.ts` | Guarded backfill, run by the container entrypoint |
| `/scripts/check-db-credential.sh` | Aborts container startup when `DATABASE_URL` uses the published default credential |
| `/scripts/postgres-init/01-app-role.sh` | Creates the `counterpoise_app` role on first postgres initialization |
| `/lib/reports.ts` | Financial report logic |
| `/lib/api-auth.ts` | API authentication and book access |
| `/lib/api-keys.ts` | API key generation, hashing, and verification |
| `/lib/auth.ts` | Password hashing and verification |
| `/lib/session.ts` | Session management |
| `/lib/transactions.ts` | Shared create/update transaction logic (used by API routes and MCP) |
| `/lib/recurring-rules.ts` | Shared recurring-rule reads and writes (used by API routes and MCP) |
| `/lib/advisory-lock.ts` | `withAdvisoryLock()` — session-scoped lock on a reserved connection; its callback's `db` is not the pooled one |
| `/lib/plaid-tokens.ts` | Plaid connection reads and writes; owns access-token masking |
| `/lib/plaid-transactions.ts` | Staged Plaid rows and transaction links |
| `/lib/plaid-reconcile.ts` | Reconciliation queue read and the six-action resolver, shared by the route and MCP |
| `/lib/plaid-sync.ts` | Plaid transaction sync — fetches, stages, and auto-matches |
| `/lib/plaid-auto-match.ts` | Learned payee-based auto-matching for Plaid transactions |
| `/app/api/cron/plaid-sync/route.ts` | Cron endpoint for periodic Plaid sync (every 6 hours) |
| `/lib/tiingo.ts` | Shared Tiingo price fetching (`fetchLatestTiingoPrices()`, `isTiingoConfigured()`) |
| `/app/api/cron/price-sync/route.ts` | Cron endpoint for automatic security price updates (Tue–Sat 6am ET) |
| `/lib/posthog-server.ts` | Server-side PostHog singleton and `captureEvent()` |
| `/lib/posthog-client.ts` | Client-side PostHog helpers (`identifyUser`, `resetUser`) |
| `/hooks/useBookId.ts` | Client hook for current book ID |
| `/app/api/b/[bookId]/transactions/route.ts` | Main transaction API |
| `/scripts/release.sh` | Version bump, release branch, push, and PR creation. Creates no tag |
| `/scripts/deploy.sh` | Publishes the version tag at one named commit, then builds and restarts. Rebases nothing |
| `/scripts/import-moneydance/index.ts` | Import orchestration |
| `/scripts/posthog-export.ts` | CLI tool for exporting PostHog events |
| `/mcp/auth.ts` | MCP API key authentication and book access verification |
| `/mcp/server.ts` | MCP server entry point (connects the transport, registers no tools itself) |
| `/mcp/register-all.ts` | `registerAllTools()` — the single place every `register*Tools` module is wired in |
| `/scripts/bundle-node-entrypoints.mjs` | Bundles the MCP server and lot rebuild script into `dist/` for the Docker image |
| `/scripts/bundle-config.mjs` | The esbuild options both the bundler and `tests/mcp/bundle-safety.test.ts` build with — shared so the test cannot check a different artifact than Docker ships |
| `/db/seed.ts` | Sample dataset builders. **Declarations only — no top-level side effects.** Application code imports it (`lib/books.ts` → demo route + `create_demo_book`), so anything running at import time gets bundled into `/app/mcp-server.mjs` and runs on MCP startup |
| `/db/seed-cli.ts` | CLI entry for `npm run db:seed`. Holds the main-module guard that used to live in `db/seed.ts`, where — once bundled — it matched `node /app/mcp-server.mjs` and would have dropped the database schemas on every MCP server start |
| `/mcp/tools/usage.ts` | MCP tool for querying PostHog analytics |
