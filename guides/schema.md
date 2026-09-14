# Database Schema Reference

One of the guides [CLAUDE.md](../CLAUDE.md) points to. Read that file first;
it carries the rules that apply everywhere — the Critical Accounting Rules
among them — and says when to come here.

## Core Tables
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

