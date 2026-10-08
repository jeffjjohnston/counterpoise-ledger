# Database Schema Reference

One of the guides [CLAUDE.md](../CLAUDE.md) points to. Read that file first;
it carries the rules that apply everywhere — the Critical Accounting Rules
among them — and says when to come here.

## Core Tables

The entries below use the camelCase names of the API and the client. The SQL
tables and columns use snake_case (`investmentSplits.sharesMicros` is
`investment_splits.shares_micros`).

### Timezones and timestamp columns

The schema is the SQL in `rust-api/db/migrations/`. See
[database-management.md](database-management.md) for the type rules.

A timestamp column is `TEXT` that holds a **UTC wall-clock value**
(`YYYY-MM-DD HH:MM:SS[.fff]`). The Rust code always binds it: use
`Utc::now().naive_utc()` for new rows and updates. When you read one in Rust,
`.and_utc()` is correct only because the stored value is already UTC. No
column has a SQL default for a timestamp. Do not write one from SQL
(`CURRENT_TIMESTAMP`, `datetime('now')`) either: bind the value from Rust, as
every write path does.

A calendar date is `TEXT` `YYYY-MM-DD` in the app's local day. In SQL, use
`cp_today()` (the `today!()` macro in `ledger_db::sql`), which gives today in
`TZ`. SQLite's own `CURRENT_DATE` and `date('now')` give the UTC date, which
is a different day for some hours of each day. A wrong date moves a floating
transaction, a recurring rule or a cleanup cutoff by one day. The `books`
insert trigger also copies `books.created_at` into the creator's
`book_members.created_at`, so a bad book timestamp propagates to membership
ordering.

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
  is `book_creator_owner`, in `0001_baseline.sql`. Thus no path that inserts a
  book can make a book without an owner row. This applies to a route, an MCP
  tool, the seed, the importer, and raw SQL.

  `book_members` also has the `*_mark` triggers that count changes in
  `change_marks`. The table is in `CHANGE_TABLES` in
  `rust-api/server/src/book_changes.rs`. Thus an open page sees a role
  change.

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
  - `idx_transaction_splits_book_account` (book_id, account_id,
    transaction_id, amount) covers the balance sums of the account list and
    the income statement. Those queries join `transactions` only when a date
    filter needs it: the join reads each transaction row, and it made the
    account list five times slower on a large book. The income statement
    joins with `s.book_id = a.book_id AND s.account_id = a.id` so that it can
    use this index. Tests in `routes/accounts.rs` and `routes/reports.rs`
    assert the query plans

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

- **transactionChanges**: The change log of the delta sync
  (`GET /api/b/{bookId}/transactions/changes`). Fields: `seq` (the cursor),
  `bookId`, `transactionId`. It has no foreign key and no timestamp.
  - Migration `0003_transaction_changes.sql` adds insert, update and delete
    triggers on `transactions`, `transaction_splits` and `investment_splits`.
    A split row logs the ID of its parent transaction. An update that moves a
    row to a different transaction or book logs the old and the new IDs.
  - A row with `bookId` 0 is a floor marker, not a change. The migration and
    each snapshot add one. A delta cursor below the newest marker gets 410.
  - Do not write to this table, and do not prune it. A pruned row is a change
    that a client never sees.
  - A deleted book keeps its log rows. `resetTestDatabase` deletes them
    after the cascade, because they have no foreign key.
  - A change to a payee, an account or a security does not log the
    transactions that embed it. A client reads those tables again.

- **recurringRules** / **recurringTemplateSplits**: Recurring transaction templates

- **apiKeys**: User API keys for MCP server authentication
  - Fields: `userId`, `name`, `keyHash` (scrypt), `keyPrefix` (first 8 chars for lookup), `lastUsedAt`

- **oauthClients** / **oauthGrants** / **oauthCodes** / **oauthTokens**: OAuth for `/api/mcp` (migration 0004, [mcp-server.md](mcp-server.md#oauth-for-custom-connectors))
  - `oauthClients` has no `userId`: any user can grant a client access. `clientId` is the HTTPS URL of a Client ID Metadata Document (`metadataDocument` 1, `fetchedAt` set) or a `cpc_` ID from registration. `redirectUris` is a JSON array. `resetTestDatabase` deletes these rows itself, because the `users` cascade does not reach them
  - `oauthGrants`: one approval on the consent page (`userId`, `clientId` → `oauthClients.id`). `resource` is the canonical MCP URI at grant time; a token whose grant has another `resource` is refused. To revoke deletes the grant, and its codes and tokens cascade
  - `oauthCodes` / `oauthTokens`: `codeHash` / `tokenHash` are SHA-256 hex digests, never the secret. `usedAt` marks the one exchange of a code or a refresh token; a later use revokes the grant. `oauthTokens.kind` is `access` or `refresh`

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
