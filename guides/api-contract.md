# API Contract

One of the guides [CLAUDE.md](../CLAUDE.md) points to. Read that file first;
it carries the rules that apply everywhere and says when to come here.

## What it is

`openapi/openapi.json` describes the routes a native client uses. The Rust
server writes it. Do not edit it by hand.

The source is `rust-api/server/src/openapi/`:

- `schemas.rs` — the component schemas, in document order. The name of each
  is the name of the type a client generates. `dsl.rs` gives the small
  vocabulary they are written in (`object`, `nullable`, `reference`,
  `.describe()`, ...), over utoipa's schema model. It writes the exact JSON
  Schema shape of the contract: no `format` on an integer, `anyOf` with
  `null` for a nullable field, and a required nullable field where the
  contract has one. The utoipa derive macros write other shapes, and a
  client's generated types follow the shape.
- `operations.rs` — the list of routes in the contract. Every path
  placeholder is a required integer path parameter, except `{date}`: a
  required `YYYY-MM-DD` string. An error status that a
  client must handle as a different case goes in the operation's `errors`
  list. An example is the 409 on transaction `PUT` and `DELETE`. A unit test
  fails when an operation is not a route in `rust-api/routes.json`.
- `mod.rs` — builds the OpenAPI 3.1 document, and the `openapi` command.
- `lib/api-contract.ts` — `API_CONTRACT`, the number a client compares. The
  Rust server reads it at build time, with the package version.

`GET /api/version` is public and returns the package version and
`API_CONTRACT`.

## Commands

- `npm run openapi:generate` — write `openapi/openapi.json`
  (`counterpoise-rust-api openapi`). The release script runs it after the
  version bump.
- `npm run openapi:check` — fail when the file is stale. CI runs this in the
  Rust job, and `cargo test` checks it too.

## Rules

1. A pull request that adds or changes a route a native client uses registers
   it in `rust-api/server/src/openapi/operations.rs` and regenerates the file.
   CI enforces the regeneration.
2. Adding an optional field is additive. `API_CONTRACT` stays the same.
   Recent examples: the book response's optional `role`, and the transaction
   response's optional `createdBy`/`updatedBy`. The four book-member routes
   (`GET`/`POST /api/books/{bookId}/members`,
   `PUT`/`DELETE /api/books/{bookId}/members/{userId}`) were added the same
   way — new routes, registered in the operation list, do not bump
   the contract either.
3. Adding a value to an enum is a breaking change. A generated client decodes
   an enum as a closed set, so an unknown value fails the decode. Increase
   `API_CONTRACT`. The enums in the contract today are `AccountType`,
   `AccountSubtype`, `SecurityRow.securityType`, and
   `InvestmentSplitRow.action`.
4. Removing or renaming a field, changing a type, or removing a route is a
   breaking change. Increase `API_CONTRACT` and add a line to its history
   comment.
5. Response schemas are strict in the tests. The HTTP suite under
   `tests/http/` checks each response body against its component schema in
   `openapi/openapi.json`, through `contract()` in `tests/helpers/contract.ts`.
   That helper adds `additionalProperties: false` to every object, so an
   undeclared field fails the test. Fix the schema, not the handler.
6. The generated document strips `additionalProperties`, so a client accepts
   fields it does not know. That is what makes rule 2 safe.
7. When `API_CONTRACT` changes, the release notes name the minimum client
   version. See guides/release-and-deploy.md.
8. When practical, keep the previous fields for one minor release after a
   breaking change, so an installed client has a window to update.

## Investment routes

All of these have the tag `investments` and accept a bearer key or a cookie.
`listAccountMarketValues` is older; the others were added later. They are new
routes, so `API_CONTRACT` did not change.

| Operation | Route |
| --- | --- |
| `listInvestmentPositions` | `GET /investments/positions` |
| `listSecurities`, `createSecurity` | `GET`, `POST /securities` |
| `getSecurity`, `updateSecurity`, `deleteSecurity` | `GET`, `PUT`, `DELETE /securities/{id}` |
| `getSecurityDetail` | `GET /securities/{id}/detail` |
| `listSecurityLots` | `GET /securities/{id}/lots` |
| `listSecuritySplits` | `GET /securities/{id}/splits` |
| `listSecurityPrices` | `GET /securities/{id}/prices` |
| `putSecurityPrice`, `deleteSecurityPrice` | `PUT`, `DELETE /securities/{id}/prices/{date}` |
| `listPricesDue` | `GET /securities/prices-due` |
| `bulkUpdatePrices` | `POST /security-prices/bulk` |
| `fetchTiingoPrices` | `POST /security-prices/tiingo` |
| `getRealizedGainsReport` | `GET /reports/realized-gains` |

Each path is under `/api/b/{bookId}`. Rules to know:

- `putSecurityPrice` is not an upsert. It answers 404 when the security has no
  entry on the path date.
- A `priceDate` in the body that differs from the path date moves the entry.
  It answers 409 when the target date already has an entry.
- To add a price, use `bulkUpdatePrices`. It replaces an entry on the same
  date.
- `bulkUpdatePrices` drops an item that is not valid and does not report it.
  Read `count` in the result.
- `fetchTiingoPrices` writes no price. A price in the result is in decimal
  dollars, not micros. After a Tiingo rate limit (429), the server sends no
  more requests. It lists each remaining symbol in `errors` with the message
  "Not fetched: the Tiingo request limit was reached". There is no
  `rateLimited` field. It answers 500 when the server has no Tiingo key.
- `updateSecurity` answers 409 when another security of the book has the
  symbol.
- `createTransaction` and `updateTransaction` document the 400 messages of
  their investment splits. Test them in `tests/http/`.

## Auth in the contract

Data routes accept a cookie session or `Authorization: Bearer cpk_...`.
Credential routes (password change, API key list, mint, and revoke) accept
the cookie only, through `cookie_session()` in
`rust-api/server/src/routes/auth.rs`. A device that holds one key must not be
able to mint another.

A failed bearer attempt counts in the `ApiKey` rate-limit scope against the
pair of client IP and key prefix, not the IP alone. A device that keeps
sending a revoked key therefore locks only that key's bucket, and a
replacement key on the same address works at once. A valid key clears its own
bucket. The lock is answered as 401, not 429: the key check in `principal()`
(`rust-api/server/src/auth.rs`) reports only that there is no caller, as it
does for a bad key. The limiter is `rust-api/server/src/rate_limit.rs`.

A key grants everything the cookie grants, except the password change and
key management. That includes routes outside this contract: securities,
recurring rules, reports, settings, issue reports, system status, WebMCP, and
every bank-sync route under `/api/b/{bookId}/sync/`. The contract lists what
the client uses. It does not limit what a key can reach.

A native client must not send `Origin` or `Sec-Fetch-Site`. The server's
cross-origin check (`rust-api/server/src/security.rs`) rejects a write whose
`Origin` host differs from `Host`.

## Delta sync

`GET /api/b/{bookId}/transactions/changes` (`listTransactionChanges`) lets a
native client keep a local copy of the transactions. The handler is
`rust-api/server/src/routes/transaction_changes.rs`. It reads in one read
transaction, so the cursor and the rows agree.

- Full mode (no `since`): the transactions with `id > afterId`, in ID order,
  `limit` at a time (default 2000, maximum 5000). `hasMore` is true when more
  rows follow.
- Delta mode (`since=N`): the transactions of the book with a log row after
  `N`. The ones that exist are in `transactions`. The others are in
  `deletedIds`.
- `cursor` is the newest `seq` of the full log, or 0 when the log is empty.
  The log starts with a floor marker at the time of migration 0003 in
  microseconds, so a real cursor is a large number (about 1.8 × 10^15). It
  stays below 2^53.
  The client keeps the cursor of the first page of a full download. After the
  last page, it requests the delta since that cursor. That delta holds the
  changes made during the download.
- 410 when `N` is newer than the log, when `N` is below the newest floor
  marker (a restore; see
  [database-management.md](database-management.md#backups-and-restore)), or
  when more than 5000 transactions changed. The client then does a full
  download.

The DTOs come from `load_transactions`, so they are the same as the
DTOs of `listTransactions`. Each change to a transaction, a split or an
investment split adds a row to `transaction_changes` (see
[schema.md](schema.md)).

A change to a payee, an account or a security does not log the transactions
that embed it. This is deliberate: one account rename would log every
transaction of that account. Thus a client that syncs with this route must
not show the embedded `payee`, `account` and `security` objects. It must look
up each one by `payeeId`, `accountId` or `securityId` in its own copy of
those tables, which it reads again on the SSE hint for the table.

## Live updates

`GET /api/b/{bookId}/events` is a Server-Sent Events stream. It accepts a
bearer key like any data route. It is not in `openapi.json`, because a
generated client cannot consume a stream from the document. The client reads
it by hand. The stream authenticates once when it opens and stays open for
up to five minutes. Revoking a key does not close a stream that is already
open. The next reconnect fails.

A `change` frame is `event: change` with `data: {"tables": [...]}`. It names
the tables that changed in this book, and carries no row data. A client reads
again the data of each table it shows. These table names can occur:

| Table | Changes when |
| --- | --- |
| `transactions`, `transaction_splits` | A transaction is created, updated or deleted. |
| `investment_splits` | A transaction writes, replaces or deletes its investment splits. |
| `investment_lots` | The server rebuilds the lots of an account and security. Each transaction write that touches an investment split does this in the same commit. |
| `securities` | A security is created, updated or deleted. |
| `security_prices` | A price is entered, deleted, fetched or bulk updated. |
| `accounts`, `payees`, `books`, `book_members` | The account, payee, book or its membership changes. |
| `recurring_rules`, `recurring_template_splits` | A recurring rule or its template changes. |
| `plaid_accounts`, `plaid_transaction_reconciliation` | A bank link or its reconciliation changes. |

A trade therefore sends `transactions`, `transaction_splits`,
`investment_splits` and `investment_lots` in one frame. A change to the price
of a security sends only `security_prices`. Database triggers on each table
count the changes, so a write from any process sends a hint, and a write that
rolls back sends none. A fixed-price security has no price rows: its price is
a column of `securities`.
