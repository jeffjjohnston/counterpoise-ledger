# Database Schema Reference

One of the guides [CLAUDE.md](../CLAUDE.md) points to. Read that file first;
it carries the rules that apply everywhere — the Critical Accounting Rules
among them — and says when to come here.

## Core Tables

### Timezones and timestamp columns

The database's `timestamp without time zone` columns hold **UTC wall-clock
values**. A JavaScript `Date` that Drizzle writes is stored as UTC, and the
Rust server must match it: bind `Utc::now().naive_utc()` for new rows and
updates. When reading a naive
timestamp in Rust, `.and_utc()` is correct only because the stored value is
already UTC. Do not insert `NOW()` or `CURRENT_TIMESTAMP` directly into a
naive timestamp column: PostgreSQL converts that `timestamptz` to the session
`TimeZone` first, then drops the zone. For SQL-side timestamps, use
`CURRENT_TIMESTAMP AT TIME ZONE 'UTC'` explicitly.

The app sets each database session's `TimeZone` from `TZ` so SQL calendar
operations such as `CURRENT_DATE` follow the app's local day. That setting
does **not** change the UTC storage convention. A non-UTC session can otherwise
shift an inserted timestamp by hours, change `ORDER BY created_at`, and make a
UTC API response report the wrong instant. The `books` insert trigger also
copies `books.created_at` into the creator's `book_members.created_at`, so a
bad book timestamp propagates to membership ordering.

Test timestamp writes with the server set to an explicit non-UTC zone such as
`America/New_York`. Assert the returned instant falls between timestamps
taken immediately before and after the request, and check ordering against
rows that a TypeScript script or test helper writes. For calendar-date behavior, pin both
the instant and the timezone near a midnight boundary; an ambient-clock test
can pass while the conversion is wrong.

- **books**: `userId` is the user who created the book. It is not the access
  list. `book_members` decides who can open the book and at what role.
  `typesafeReconciliationEnabled` defaults to false; `typesafeRevision`
  invalidates in-flight and cached experiment results across settings
  changes. The dedicated Settings API is the only opt-in surface.

- **book_members**: This table is the only source of book access. It has
  these columns:
  - `bookId`: FK to `books.id`, ON DELETE CASCADE.
  - `userId`: FK to `users.id`, ON DELETE CASCADE.
  - `role`: `owner`, `editor`, or `viewer`. A CHECK constraint limits it to
    these values.
  - `createdAt`.

  The primary key is `(bookId, userId)`. Thus a user has a maximum of one
  role in each book. An index on `userId` serves the book list query.

  An `AFTER INSERT` trigger on `books` adds the creator as owner. The trigger
  is `book_creator_owner`, from migration `0027`. Thus no path that inserts a
  book can make a book without an owner row. This applies to a route, an MCP
  tool, the seed, the importer, and raw SQL.

  `book_members` also has the `counterpoise_changes` NOTIFY trigger. The
  table is in `CHANGE_TABLES` in `rust-api/server/src/book_changes.rs`. Thus
  an open page sees a role change.

  Each book must keep one owner or more. The member routes enforce this rule
  in `rust-api/server/src/routes/members.rs` ("A book must keep at least one
  owner"). No database constraint enforces it.

- **typesafeEvaluations / typesafeDecisions / typesafeQuotas / typesafeAggregates**:
  Book-scoped experiment evidence, explicit UI outcomes, request budgets, and
  text-free retained counts. All cascade on book deletion. Clear-data preserves
  quota counters; hourly cleanup expires detailed records after 30 days. See
  [TypeSafe experiment](typesafe-experiment.md).
  `typesafeEvaluations.answers` holds every answer of a v2 request
  (`match`, `payee`, `category`); `choice`/`probabilities`/`confidence` keep
  the match answer only. `typesafeDecisions.proposalPayeeKept` and
  `proposalCategoryKept` are set only for a create after a visible proposal.
- **accounts**: Chart of accounts with hierarchical structure (parent-child)
  - Types: `asset`, `liability`, `equity`, `income`, `expense`
  - Subtypes: `bank`, `credit_card`, `loan`, `investment`, `cash`, `other`
  - Special field: `isInvestmentCash` for auto-created investment cash accounts
  - `icon` (nullable): one emoji grapheme. **`null` means "inherit from the parent account" — never "no icon".** Resolved at render time by `resolveAccountIcon()`/`resolveAccountIconSource()`; only `income`/`expense` accounts show a picker or resolve an icon for display

- **transactions**: Main transaction records with date, description, payee
  - Links to `payees` (optional) and `recurringRules` (optional)
  - `createdBy` / `updatedBy` (nullable, FK `users.id`, ON DELETE SET NULL):
    who made the write. Null means a system write (recurring processing,
    Plaid auto-match, the importer, the seed) or a row from before this
    feature. A transaction create in `rust-api/server/src/routes/transactions.rs`
    sets both, and an update sets `updatedBy`, to the authenticated user. The
    Plaid reconcile (`routes/reconcile.rs`) and the transaction unlink
    (`routes/sync.rs`) set `updatedBy`, and `createdBy` when they create a
    row.

- **transactionSplits**: Double-entry splits (debits/credits)
  - Positive amounts = debits, negative = credits
  - Must sum to zero per transaction

- **securities**: Investment securities (stocks, ETFs, mutual funds)
  - Fields: name, symbol, securityType (etf/mutual_fund/stock), fetchPrices, fixedPriceMicros
  - `fixedPriceMicros` (nullable): a price that never moves — a money market fund at a $1.00 NAV. Non-null means fixed-price (see Fixed-Price Securities in [guides/securities-and-prices.md](securities-and-prices.md)); null means the price comes from `securityPrices`

- **securityPrices**: Historical price data per security per date
  - Composite key: securityId + priceDate

- **investmentSplits**: Investment-specific transaction data
  - Actions: `buy`, `sell`, `dividend`, `capGain`, `fee`, `split`
  - Links to `securities` and accounts. It does **not** link to `investmentLots`:
    lots point back at the split that opened them (`openedSplitId`), never the
    other way round
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
  - Written by `ReportIssueModal`; read when triaging reports

- **plaidTokens** / **plaidAccounts** / **plaidTransactionReconciliation**: Plaid bank sync integration
  - `plaidTokens`: Stores Plaid access tokens and `syncCursor` for incremental transaction sync
  - `plaidAccounts`: Links Plaid accounts to Counterpoise accounts (`counterpoiseAccountId`)
  - `plaidTransactionReconciliation`: Staged Plaid transactions awaiting reconciliation
    - `resolutionStatus`: `pending`, `matched`, `created`, `ignored`
    - `reviewReason`: `plaid_modified` or `plaid_removed` (flags items needing human review)
    - `matchedTransactionId`: FK to local transaction when matched (manually or auto-matched)
