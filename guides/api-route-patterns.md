# API Route Patterns

One of the guides [CLAUDE.md](../CLAUDE.md) points to. Read that file first;
it carries the rules that apply everywhere and says when to come here.

The Rust server (`rust-api/server/`) serves every API route. No other process
has API handlers. In development, Vite forwards each `/api/*` request to Rust.
See [architecture.md](architecture.md).

A route does not check the origin of a write and does not set the security
headers: the layers in `rust-api/server/src/security.rs` do this for every
route, before the handler. A route still authenticates its own requests
(`authenticate_book`, or the session and key helpers in `auth.rs`). Before the
router, the layers refuse an `/api/` request that has no session cookie and no
bearer header with 401, unless its path is public or is `/api/mcp`. Thus a
wrong method gives 401, not 405, to a request without credentials. An `/api/`
path that no route matches gets 404. See "Security layers" in
[architecture.md](architecture.md).

## Add a Route

1. Write the handler in the route area under
   `rust-api/server/src/routes/` (for example `payees.rs`).
2. Add an arm for it to the match in `routes()` in `routes/mod.rs`, and add
   its method, path and handler name to `rust-api/routes.json`. The router
   registers a route only when both agree.
3. Add HTTP cases to `tests/http/` (see [testing.md](testing.md)). When a
   native client uses the route, add it to the contract too: see
   [api-contract.md](api-contract.md).

## Book-Scoped Pattern

A book route authenticates first, then binds the book ID into every query:

```rust
pub(crate) async fn list_payees(
    State(state): State<AppState>,
    Path(raw_book_id): Path<String>,
    RawQuery(raw_query): RawQuery,
    headers: HeaderMap,
) -> ApiResult {
    let book = authenticate_book(
        &state, &headers, &raw_book_id, AccessLevel::Read, "Failed to fetch payees",
    )
    .await?;
    let params = first_query_values(raw_query.as_deref());
    // ...
    let rows: Vec<PayeeListRow> = sqlx::query_as("SELECT ... WHERE p.book_id = $1 ...")
        .bind(book.book_id)
        // ...
        .fetch_all(&state.pool)
        .await
        .map_err(|cause| internal_error(cause, "Failed to fetch payees"))?;
    Ok(Json(to_value(rows).expect("payee rows serialize")))
}
```

- **Errors**: return `ApiResult` (`Result<Json<Value>, ApiError>`). Every
  failure keeps the `{ "error": message }` envelope. Use `error(status,
  message)` for a fixed message, `error_owned()` for a message built from the
  request, and `internal_error(cause, message)` for a database failure. It
  logs the cause and answers 500 with the route's message. They are in
  `rust-api/server/src/error.rs`.
- **Bodies**: read the body as `Bytes` and parse it with `parse_json_body()`
  or `from_json_bytes()` in `validation.rs`. Then validate it with a typed
  validator, such as `validate_payee_create()` or `validate_account_create()`.
  See "Rust request validation and references" below.
- **Never pass a raw body on to SQL.** A validator carries only the declared
  fields into a write. That is what stops a client setting `book_id`, `id`,
  or any other column it does not own.
- **Referenced IDs**: an ID that references another row (`parentId`,
  `payeeId`, `balanceAccountId`, …) must be proved to belong to this book
  before use. A validator proves the shape of an ID, not that it is yours.
  `require_account_parent()` in `validation.rs` checks `id` **and** `book_id`;
  follow that pattern.
- **SQL**: `sqlx::query!` and `sqlx::query_as!` check the query against the
  schema at build time, from the metadata in `rust-api/.sqlx/`. After you
  change such a query, run `cargo sqlx prepare` (see
  [testing.md](testing.md)). `sqlx::query()` and `sqlx::query_as()` are not
  checked at build time.

## Access Levels

`authenticate_book(state, headers, raw_book_id, level, failure_message)` in
`rust-api/server/src/book_auth.rs` checks the caller's membership of the book
at a level, not just that a book exists. It accepts the session cookie or an
API key. There are three roles — owner, editor, viewer — and three levels —
`AccessLevel::Read`, `Write` and `Owner`. `Read` accepts every role. `Write`
accepts owner and editor. `Owner` accepts owner only.

**Every handler gives its level in its own body.** A GET handler gives
`AccessLevel::Read`. An owner-only handler gives `AccessLevel::Owner`. Every
other handler gives `AccessLevel::Write`.

A static test, `tests/lib/book-access-levels.test.ts`, reads each
`/api/b/[bookId]` route in `rust-api/routes.json`, finds its handler through
the match arms in `routes/mod.rs`, and checks the `AccessLevel::` in the
handler's body against the level its method implies (GET → `Read`,
everything else → `Write`, unless the route is one of the owner-only Plaid
routes below). A level in a private helper is not seen. A route that
authenticates in a shared helper (the TypeSafe suggestion routes in
`typesafe_suggestion.rs`) is named directly in the test instead, so its exact
call still has to match. The test also checks every MCP tool the same way,
against the level each Rust tool handler gives `caller.book` — see
[mcp-server.md](mcp-server.md). The book CRUD and member routes under
`/api/books/` are outside that scan and give their level by hand the same way.

Owner-only routes under `/api/b/[bookId]/` — an editor is refused even
though editors can write everywhere else, and the static test enforces this:

- `POST /api/b/[bookId]/sync/tokens` (Plaid link)
- `PUT` and `DELETE /api/b/[bookId]/sync/tokens/[id]` (Plaid unlink and rename)
- `PUT /api/b/[bookId]/sync/tokens/[id]/accounts` (map bank accounts)

Owner-only under `/api/books/`: rename the book, change `upcomingDays`,
delete the book; add a member, change a member's role, and remove another
member. `DELETE /api/books/[bookId]/members/[userId]` authenticates at
`Read` and then checks the role by hand, because it allows one case a level
alone cannot express: any member may remove their own row (leave the book)
without being an owner.

`authenticate_book` answers:

- Not a member: **404** `{ "error": "Book not found" }`. This does not tell a
  stranger that the book exists.
- A member below the level: **403**. `{ "error": "You have read-only access
  to this book" }` for `Write`; `{ "error": "Only an owner can do this" }`
  for `Owner`.

It returns an `AuthenticatedBook` with the numeric book ID, the user ID and
the role. Use its book ID for scoped queries and its user ID for event
attribution.

A removed member's open `events` (SSE) stream is not closed. It keeps sending
invalidation hints — no data, just "something changed" — for up to five
minutes, until the stream's own lifetime ends. Every *data* request answers
404 at once, because each one re-checks membership. The stream reconnect does
too.

## Route Areas

The sections below record the rules of each route area. Many of them come from
the former Node handlers: the contract kept their behavior, so a client saw no
change when the routes moved to Rust. "Node" below names those former
handlers.

### Book members

`authenticate_book` reads `book_members` on each request. Book-member reads
use `Read`; additions and role changes use `Owner`. Removing yourself uses `Read` and checks the
target user, while removing someone else requires `Owner`. Member writes lock
the book's membership rows inside one transaction before checking the actor
and the last-owner rule. The Rust `book-member-add` rate-limit scope counts
unknown usernames, while an already-added user gets the same public error.

The read-only account detail, payee, report, search, and pending-count handlers
are in `rust-api/server/src/routes/{accounts,payees,reports,search,sync}.rs`.
Each asks for `AccessLevel::Read`. Report and search date filters use the
effective date: a floating transaction uses today's local calendar date,
bound from Rust, while a settled transaction uses its stored date. Report
aggregates cast to integer JSON values. Both report handlers emit the existing
`report_generated` PostHog event with their original report types.
`tests/http/` covers these contracts.

The account and payee writes are also in Rust: `POST /accounts`,
`PUT` and `DELETE /accounts/[id]`, `POST /payees`, and `DELETE /payees/[id]`.
They keep these Node rules:

- An investment account and its cash sub-account change in one transaction.
  The update applies the pair rule with `??`, so a `subtype` sent as `null`
  still counts as the stored subtype for that request.
- Node reads the account `[id]` path with `parseInt(id)`, so `0x1F` is
  account 31. Book IDs use `parseInt(id, 10)`. Both forms skip JavaScript
  whitespace only: U+FEFF is skipped and U+0085 makes the ID NaN. Use
  `parse_int_auto_radix` or `parse_int_prefix` in `validation.rs`, never
  Rust's `trim` or `str::parse`. For a value that Node reads with `Number()`
  or `z.coerce.number()`, use `parse_js_number`, which also refuses the `inf`
  and `nan` words that Rust's `f64` parser accepts.
- A path or body ID that is NaN or outside the int4 range makes the Node query
  fail. Rust returns the same 500 message and does not report "not found".
- The payee name uses JavaScript whitespace for trim and collapse. Rust's
  `char::is_whitespace` differs at U+0085 and U+FEFF, so use
  `is_js_whitespace` in `validation.rs`.
- `POST /payees` returns the stored payee for a case variant. It lowercases
  the name in Rust and compares with PostgreSQL `lower()`, as Node does.

The investment and security routes are in
`rust-api/server/src/routes/{investments,securities,realized_gains}.rs`:
`investments/positions`, `investments/account-values`, `securities` GET and
POST, `securities/[id]` GET, PUT and DELETE, `securities/[id]/detail`,
`securities/[id]/lots`, `securities/[id]/splits`, and
`reports/realized-gains`. The security `[id]` routes use `parseInt(id, 10)`,
so an unparsable ID is a 400 there, not a 500. `PUT` validates the body
before an out-of-range ID fails at the database, and a clashing symbol on
`PUT` is a 500 because the Node route does not map that error.
`tests/http/investments.test.ts` and `securities.test.ts` compare full bodies
with snapshots.

The price routes are in `rust-api/server/src/routes/security_prices.rs`:
`securities/[id]/prices` GET, `securities/[id]/prices/[date]` PUT and DELETE,
`securities/prices-due`, `security-prices/bulk`, and `security-prices/tiingo`.
They keep these Node rules:

- `PUT` refuses a NaN ID first, then reads and validates the body. An ID
  outside the int4 range then fails at the database with the 500 message.
  A new `priceDate` moves the entry, and a move onto an occupied date is 409.
- `source` is not validated. A value that is not a string or null is stored
  as JavaScript `String(value)`, which `js_string` in `validation.rs` gives.
- The bulk write drops each item that fails the item schema. It is 400 only
  when no item is left. An update keeps the stored source; an insert has the
  source `manual`. All items change in one transaction.
- The Tiingo route checks the key before it reads the body. Each symbol is
  put into the URL as `String(symbol)`, without encoding. A failure message
  names the symbol as Node does. A V8 TypeError in Node names a minified
  variable, so the test compares only the end of those messages. A Tiingo
  body that is not JSON gets a different message in Rust.
- `prices-due` falls back to the last weekday in the server time zone.

`tests/http/security-prices.test.ts` starts a Tiingo mock and gives the
server its URL.

The transaction routes are in `rust-api/server/src/routes/transactions.rs`:
`transactions` GET and POST, and `transactions/[id]` GET, PUT, and DELETE.
The request schemas are in `rust-api/server/src/transaction_input.rs`. Each
schema returns the first zod issue in schema key order. The routes keep these
Node rules:

- The `[id]` routes read the ID with `parseInt(id)` and no radix. An
  unparsable ID or an ID outside the int4 range is a 500, not a 404. `PUT`
  validates the body first. `DELETE` validates `expectedUpdatedAt` first.
- The register repeats `REGISTER_ORDER` and the starting-balance boundary of
  the Node route. Only the `limit` spelling `0` means every row. `00` is a
  limit of zero. With `ensureId`, the position count binds every filter ID
  before the ownership checks run, so an ID outside the int4 range is a 500
  there and a 400 without `ensureId`.
- A write validates first. Then one database transaction changes the
  transaction, its splits, its investment splits, and its lots. A payee that
  `payeeName` creates rolls back with a failed write.
- `updated_at` has millisecond precision, as a JavaScript `Date` has. The
  conflict check compares at that precision. It truncates extra fraction
  digits in `expectedUpdatedAt`, as JavaScript `Date` parsing does.
- `PUT` on a missing transaction is a 404, unless the body has splits. Then
  the split insert fails its foreign key and the route returns its 500
  message. `DELETE` commits the Plaid sweep also when it deletes no row.
- The routes send `transaction_created`, `transaction_updated` with the
  `diffTransactionFields` result, and `transaction_deleted`.

`tests/http/transactions.test.ts` and `transaction-writes.test.ts` compare full
bodies and lot rows with snapshots.

The recurring routes are in `rust-api/server/src/routes/recurring.rs`:
`recurring` GET and POST, `recurring/[id]` GET, PUT, and DELETE,
`recurring/process`, `recurring/projected`, and `recurring/transactions`. The
request schemas are in `rust-api/server/src/recurring_input.rs`. The
recurrence math is `ledger_core::recurring`. The routes keep these Node rules:

- The `[id]` routes read the ID with `parseInt(id)` and no radix. An
  unparsable ID or an ID outside the int4 range is a 500. `PUT` validates the
  body first, and the 500 comes at the first query that uses the ID.
- The schema declares `interval`, `daysOfWeek`, `weekOfMonth`, `daysOfMonth`,
  `templateDescription`, `payeeId`, and `payeeName` with `z.any()` or
  `z.unknown()`. Rust keeps each value as sent. A text column stores
  JavaScript `String(value)`, as Drizzle writes it. A day list stores
  `JSON.stringify(value)`. The interval is bound as text and cast in SQL, so
  PostgreSQL accepts and refuses the same values as it does for Node.
- A write validates first. Then one database transaction resolves the payee
  and writes the rule and its template splits. A payee that `payeeName`
  creates rolls back with a failed write.
- `PUT` recomputes `nextDate` only when the schedule changes, not when a
  schedule field is present. It then resumes after the last transaction that
  the rule created.
- Processing claims a due date with a guarded `UPDATE` of `next_date` as the
  first statement of the transaction. A concurrent run blocks on the row,
  then matches no row, so a due date makes one transaction only. The routes
  insert the transaction directly, as Node does, not through the transaction
  service.
- `weekOfMonth` is read with JavaScript `parseInt`, as the TypeScript
  recurrence helpers read it, so `" 2 "` is the second week.
  `ledger_core::js` holds `parseInt` and the JavaScript whitespace set.
- `recurring/transactions` checks its query before authentication.
  `recurring/projected` authenticates first.

These differences from Node remain. Each needs a request that the recurring
form does not send:

- Node reads the rules, the projection, and the rule-linked transactions
  without an ORDER BY, which gives heap order. Rust uses ID order.
- Node computes a date from a numeric string `interval` with JavaScript string
  arithmetic. Rust reads the number.
- A day list that is not an array of integers is stored as Node stores it.
  The Rust schedule treats it as absent.
- A schedule whose next date is outside the JavaScript date range is stored
  as `NaN-NaN-NaN` by Node. Rust returns the route's 500 message.
- Node never returns from `processAll` for a rule whose schedule does not
  advance, such as an interval below 1. Rust does not claim that rule, so the
  rule stays unchanged. The response reports it in `skipped` with the reason
  `schedule does not advance`.

`tests/http/recurring.test.ts` compares full bodies with snapshots. A result
that depends on today is compared with the value that the TypeScript
recurrence helpers in `lib/recurring.ts` and `lib/accounting.ts` compute.

The Plaid connection routes and the sync reads are in
`rust-api/server/src/routes/sync.rs`: `sync/tokens` GET and POST,
`sync/tokens/[id]` PUT and DELETE, `sync/tokens/[id]/accounts` GET and PUT,
`sync/tokens/[id]/sync` DELETE, `sync/assigned-accounts`,
`sync/pending-transactions`, `sync/stale-unmatched`, `transactions/[id]/plaid`
GET, and `transactions/[id]/plaid/unlink` POST. The sync
(`sync/tokens/[id]/sync` POST) and the auto-matcher are in
`rust-api/server/src/routes/plaid_sync.rs`. The reconciliation queues
(`sync/reconcile` GET and `sync/accounts/[id]/reconcile` GET) and the six
decisions (`sync/accounts/[id]/reconcile` POST) are in
`rust-api/server/src/routes/reconcile.rs`. The Plaid client is
`rust-api/server/src/plaid.rs`, and the TypeSafe observations are in
`rust-api/server/src/typesafe.rs`. The reconcile suggestion route
(`sync/accounts/[id]/reconcile/suggestion`) is in
`rust-api/server/src/routes/typesafe_suggestion.rs`; see
[the TypeSafe guide](typesafe-experiment.md#rust-port). The Plaid cron runs
in `rust-api/server/src/routes/cron.rs` and calls the same `sync_token()`.
`settings/typesafe` (GET, PATCH, DELETE) runs in
`rust-api/server/src/routes/typesafe.rs`. It checks the ID shape before it
authenticates, and it answers every database failure with 503 `TypeSafe is
temporarily unavailable`, as `typeSafeHttpError` does.
The routes keep these Node rules:

- A connection write needs the owner. Clearing the staged rows of a
  connection needs only write access.
- The `[id]` routes read the ID with `parseInt(id, 10)`. A value that is not a
  finite number is a 400. An ID outside the int4 range fails only when a
  query binds it, so a `PUT` validates its body first. `transactions/[id]/plaid`
  answers `null` for an ID that is not a number.
- The item-ID check covers the book only. Item IDs are unique across the
  installation, so a duplicate in another book fails the insert with the 500
  message.
- The access-token mask counts UTF-16 code units, as JavaScript does.
- A refresh repeats the message of its failure. A message that names a Plaid
  variable is a 500, and every other message is a 502. The messages for a
  Plaid error body, an invalid account list, a JSON null body, a null account,
  and a network failure are the Node messages.
- The account assignments report the first zod issue in element and key
  order, then the duplicate checks. The unknown-account check comes before
  the account-type and mapping checks. Every mapping in the request is
  cleared before any is set, in one transaction.
- The stale check uses the stored date of a transaction, not its effective
  date, and the local calendar date of the server.
- Unlink records the TypeSafe `unlink` observations after its own
  transaction commits, as `recordTypeSafeUnlink` does. A failure there is
  logged and does not change the response. The route sends
  `sync_transaction_unlinked`.
- A sync holds the session advisory lock `(1000001, token ID)` on one
  reserved connection and runs every query on it. A second sync of the
  connection gets 409 and does not wait. A demo connection is refused before
  the step that records `last_error`; every later failure is recorded there.
  An ID outside the int4 range gets the PostgreSQL message of the lock query
  with a 502, as in Node.
- The sync stores `raw_json` as `JSON.stringify(item)` writes it. The server
  crate turns on serde_json's `preserve_order`, and `js_stringify()` lists
  array-index keys first, as a JavaScript object does. `amount_cents` is
  `Math.round(amount * 100)`, so a half rounds toward positive infinity.
  Items are staged account by account, in the order in which each account
  first appears in the Plaid page.
- Plaid leaves out some fields, such as `original_description`, which it
  sends only on request. Node holds such a field as `undefined`: an insert
  stores NULL, an update of a staged row keeps the stored value, and the
  review metadata leaves the key out. Rust keeps the three cases apart for
  the six optional fields (`KEPT_WHEN_MISSING` in `plaid_sync.rs`).
- The `create` decision inserts a new payee without a conflict clause, as
  Node does. JavaScript and PostgreSQL lowercase a final sigma differently,
  so the case-insensitive match can miss a payee of the same name. The
  insert then fails on the unique index, and the decision rolls back with a
  500.
- A mutation during pagination restarts the whole fetch from the stored
  cursor, at most twice. The first request of an initial sync asks for seven
  days, and the initial sync drops items older than seven local days.
- Auto-match stamps the transaction with `pickMatchedDate` and chooses the
  candidate nearest that date. It claims the staged row with a guarded
  `UPDATE`, so a row resolved in the meantime is not matched. It sends one
  `sync_transaction_auto_matched` per match to the book owner.
- The reconcile POST checks the link before it reads the body. The schema
  runs the action rule only on a body without field issues. The resolver
  reads the staged row `FOR UPDATE`. A floating transaction that is matched
  is settled with `pickMatchedDate`; another transaction keeps its date.
  After the commit, the route records the TypeSafe decision, as
  `recordTypeSafeDecision` does, and sends the event of the action.
- The queue candidates are sorted with a stable sort. An empty payee or
  description is contained in every name, so it counts as `name_similar`, as
  in Node.

These differences from Node remain. Each needs data that Plaid or the Sync
page does not send:

- A mask that splits a UTF-16 surrogate pair has U+FFFD in Rust. Node writes
  the lone surrogate as a JSON escape.
- A Plaid body that is not JSON, and a database failure during a refresh, get
  different messages. Node reports the V8 SyntaxError or the Drizzle "Failed
  query" text.
- A Plaid account field that is an object or an array is stored as
  JavaScript `String(value)`.
- Node reads the pending bank transactions, the earlier TypeSafe decisions,
  the linked accounts and pending rows of a sync, the splits of a candidate,
  and the counterpart splits of a suggestion without an ORDER BY. Rust reads
  them in ID order. The pending list is then sorted by date, newest first,
  with a stable sort in both.
- A database failure in a sync or in the reconciliation routes gets the
  PostgreSQL message in Rust. Node reports the Drizzle "Failed query" text,
  and the per-link queue and the reconcile POST repeat it. A reconcile body
  that is not JSON is a 500 with the route's message; Node repeats the V8
  SyntaxError.
- A field of a Plaid transaction that has another JSON type is stored as
  JavaScript `String(value)`.

`tests/http/plaid-tokens.test.ts` and `plaid-sync.test.ts` start a Plaid mock
and give the server its URL in `PLAID_API_URL`.
`tests/http/plaid-reads.test.ts` covers the reads, the link, and unlink.
`tests/http/plaid-reconcile.test.ts` compares the queues and the resolved
items with snapshots.

The `counterpoise_changes` triggers fire on all of these writes, because they
are database triggers. `tests/http/account-writes.test.ts` listens on that
channel to prove that live updates still see a Rust write.

`/api/books` CRUD, `POST /api/books/demo`, and `/api/issue-reports` use the
authenticated principal without a book scope. The Rust demo route runs the seed
in a spawned task, so it commits when the client leaves before the response. Book lists join `book_members`, so a shared book includes
the caller's role. Issue reports filter every read and write by user ID, and
creation sends `issue_report_created` through the shared PostHog helper.

`/api/health` is public and returns only `{ ok, db }`, with a 503 response
when the database probe fails. The deploy check reads it. `/health` answers
the `rust-api` container's healthcheck with an empty 200 or 503. `/api/system/status`
requires authentication and reads the scheduler status directory with the same
missing, failed, stale, unverified, and unreadable states as the Node handler.

For any route writing a `timestamp without time zone` column, follow the UTC
storage rule in [the schema guide](schema.md#timezones-and-timestamp-columns).
The app's `TZ` and PostgreSQL session `TimeZone` define calendar dates, not
the representation of stored instants.

The API gate in `security.rs` applies the common cookie gate before the
router. A request without a cookie or a bearer header is rejected there with
401 `Unauthorized`; the Rust helper's 401 `Not authenticated` covers a request
that reaches a route but has no valid session or API key.

### Rust live updates

`GET /api/b/[bookId]/events` runs in `routes/events.rs`. It authenticates with
`AccessLevel::Read` before it subscribes. Every 500 from that step becomes 503
`Live updates unavailable`, because the Node route answers every thrown error
with 503. The frames, the headers, the 10-second wait for LISTEN, the
25-second heartbeat and the five-minute lifetime are the same as in Node.

The differences that remain:

- A new stream waits until the hub has a live LISTEN. Node waits only for the
  first LISTEN, so during a reconnect Node opens the stream at once and Rust
  waits for the new LISTEN.
- The hub drops a subscriber whose queue of eight frames is full. Node drops a
  stream whose queue is full. The effect is the same: the stream ends after
  the frames already queued, and the browser reconnects.
- Node's postgres.js sent a TCP keepalive on its LISTEN socket every 60
  seconds. SQLx has no keepalive setting, so Rust probes instead: after 60 seconds with
  no message, the hub sends `SELECT 1` on the LISTEN connection. With no
  answer in 10 seconds, it connects again and sends `reset`. A network device
  that drops the idle connection without a FIN or RST therefore stops hints
  for about 70 seconds. Each LISTEN connection has its own
  one-connection pool: a dropped `PgListener` runs `UNLISTEN *` before it
  gives its connection back, and on a dead socket that waits until TCP gives
  up.

`tests/http/book-events.test.ts` covers access, the frames, per-book
filtering, the windows, and `reset` after it terminates the LISTEN backend.
The Rust unit tests in `book_changes.rs` and `routes/events.rs` cover the
stalled reader, the heartbeat, the lifetime and the shutdown with paused time.
With `COUNTERPOISE_RUST_TEST_DATABASE_URL` set, a test in `book_changes.rs`
silences the LISTEN connection behind a TCP proxy and expects `reset`.

### Rust request validation and references

`rust-api/server/src/validation.rs` has shared JSON body parsing, first-value
query parsing, and the first typed write payload, `validate_account_create`.
Parse every JSON body, and every JSON response from Plaid, Tiingo or
TypeSafe, with `from_json_bytes`, never `serde_json::from_slice`. It reads
the bytes as `request.json()` and `response.json()` do: invalid UTF-8
becomes U+FFFD, and up to two leading byte order marks are removed (undici
removes one, and its `TextDecoder` removes one more). `from_slice` refuses
both, so Node accepts a body that Rust would refuse.
Malformed JSON receives the route's existing 500 message; a parsed body with
invalid fields receives the first zod-compatible 400 `{ error }`
message for the account create schema, normalizes the icon as a grapheme, and
only carries declared fields into a write handler. Unknown JSON keys such as
`bookId` and `id` cannot be passed on to SQL. `require_account_parent` checks
`id` **and** `book_id` before accepting a parent reference. Port each new zod
schema to a similarly typed Rust validator; do not deserialize a raw request
object and spread its keys into an insert. The account GET uses
`first_query_values` before checking its list schema, preserving duplicate,
unknown-key, and date-error behavior.

`JSON.parse` reads a number beyond the double range as Infinity, and a number
below it as 0. The server crate turns on serde_json's `arbitrary_precision`,
so such a body parses and the number stays a JSON number. Read a number with
`js_number()`, which gives the JavaScript double, infinities included.
`Number::as_f64()` gives `None` for an infinity, so a validator that takes
only finite numbers can use it. Name a value in a zod issue with
`zod_type_name()`: zod refuses an infinity where it expects a number and
reports "received Infinity". Before a response repeats a value from a request
or an upstream body, pass it through `js_json()`, which writes an infinity as
null, as `JSON.stringify` does. `tests/http/json-numbers.test.ts` compares
these cases.

Every Rust write handler uses these helpers, account `POST` included.

### Rust rate limiting

`rust-api/server/src/rate_limit.rs` holds one in-memory limiter shared by all
auth scopes (`login`, `register`, `password`, `apikey`, `book-member-add`). It
matches the Node 15-minute window, five-failure username budget,
twenty-failure IP budget, escalating one-to-fifteen-minute lockouts, and
ten-thousand-entry bound that retains active lockouts during eviction.

A route must not read `X-Forwarded-For` for a rate-limit key. A client that
connects directly can write any value in it and get a new IP bucket for each
attempt. `rust-api/server/src/client_ip.rs` runs before every route: it
removes a client's `x-counterpoise-client-ip` and writes the address to use.
Read it with `client_ip::from_headers()`. The address is the rightmost
`X-Forwarded-For` entry only when `TRUST_PROXY=true`, or when `TRUST_PROXY` is
unset and the published address (`APP_BIND`, else the host of `RUST_BIND`) is
loopback. In all other cases it is the TCP peer address from `ConnectInfo`,
which is why `serve()` uses `client_ip::service()`. A server without that
layer, as in a unit test, gives no address, and only the username bucket
applies. The API key authenticator already uses it with an
IP-and-key-prefix bucket, so a revoked key does not lock out its replacement.
Rust caches a verified key digest for five minutes, coalesces concurrent
verification, and still checks the key row on every cache hit so revocation
takes effect on the next request. It writes `last_used_at` at most once per
five minutes per cached key.

Every bearer request reaches Rust, so failed keys have one process-local
rate-limit bucket. Multiple Rust replicas would require a shared throttle
before that topology is used.

`rust-api/server/src/routes/auth.rs` handles login, registration, logout,
identity, password changes, and API-key management. Password changes and key
management require a cookie session; a bearer key cannot mint another key.
The `/api/auth/registration-open` GET exposes the registration gate to the
login and register pages, while registration itself checks the gate again
under a PostgreSQL transaction advisory lock.

### Rust cron auth, analytics, and database scopes

`rust-api/server/src/cron_auth.rs` checks the entire `Authorization` header
against `Bearer ${CRON_SECRET}` using fixed-width SHA-256 digests and a
constant-time comparison. `require_cron_secret` returns the existing 401
`{ "error": "Unauthorized" }` response. An unset or empty secret always
denies. Every cron route uses it.

All four cron routes run in Rust: `rust-api/server/src/routes/cron.rs` serves
`plaid-sync`, `price-sync`, and `recurring`, and
`rust-api/server/src/routes/typesafe.rs` serves `typesafe-cleanup`. Each one
writes on every call.

A cron route reports a failure of one token, symbol, or book in its body with
status 200, as the Node route does. The `scheduler` container records job
health from the HTTP status alone, so such a failure does not mark the job
failed. `GET /api/system/status` reads those status files in
`rust-api/server/src/routes/system.rs`; the server that ran the job does not
change it.

`rust-api/server/src/analytics.rs` is the server capture helper. It is a no-op
without `NEXT_PUBLIC_POSTHOG_KEY`; otherwise it sends the user ID as the
PostHog distinct ID, the unchanged event name, and the route's property object.
Call it after a successful write as the Node handler does. Analytics failures
are logged and do not change the route response.

`rust-api/server/src/db_scope.rs` provides `with_advisory_lock` and
`with_transaction`. The advisory lock reserves one SQLx connection for its
whole callback, tries the two-int PostgreSQL session lock without waiting, and
unlocks before closing the connection. Cancellation closes the connection too,
so a session lock cannot leak into the pool. The transaction helper uses a
SQLx transaction on the caller's connection, so a transaction inside a lock
stays on that same connection and rolls back on cancellation.
Pass the callback's connection into every query and nested helper; borrowing
the pool while holding a lock can deadlock when enough holders occupy it.

The Rust HTTP contract adapters in `server/src/http_contract_tests.rs` exercise
these helpers against a local PostgreSQL connection without publishing a test
route. `tests/e2e/rust-api-parity.spec.ts` checks the HTTP contract through
the Rust server that serves the E2E client build.

## Transaction Creation Pattern
The transaction routes in `routes/transactions.rs` hold the write path: the
validation in `transaction_input.rs`, the one database transaction that writes
the transaction, its splits, its investment splits and its lots, and the
analytics event. The MCP transaction tools send their writes through these
routes, so both surfaces get the same rules. Put creation logic in the route
module, not in a tool.
