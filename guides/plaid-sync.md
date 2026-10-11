# Plaid Bank Sync

One of the guides [CLAUDE.md](../CLAUDE.md) points to. Read that file first;
it carries the rules that apply everywhere and says when to come here.

## How Plaid Sync Works
1. An owner connects a bank from the Sync page through Plaid Hosted Link (see
   "Connect and reconnect" below). The server stores the access token in
   `plaidTokens`
2. User maps Plaid accounts to Counterpoise accounts (stored in `plaidAccounts`)
3. Sync fetches new/modified/removed transactions from Plaid's transaction sync API
4. Transactions are staged in `plaidTransactionReconciliation` as `pending`
5. Auto-match runs on pending rows, then remaining items await manual reconciliation in the UI

## Connect and reconnect (Hosted Link)

`rust-api/server/src/routes/plaid_link.rs` runs Plaid Link for the Sync page
and the connections page (`components/sync/PlaidLinkModal.tsx`). The server
makes every Plaid call. The access token never goes to the browser.

1. `POST /api/b/[bookId]/sync/link-sessions` starts a session, or continues
   one (see "Resume and restart" below). The body has two fields, `tokenId`
   and `restart`. Without `tokenId` (or with null), the server calls
   `/link/token/create` with `hosted_link: {}` and `products: ["transactions"]`
   for a new Item. With it, the route first proves that the connection is in
   this book (404 `Token not found` if not) and is not a demo connection
   (400). Then it sends that connection's access token with
   `update: { account_selection_enabled: true }`: update mode, which lets the
   user sign in again and select more accounts. The response
   (`PlaidLinkSession`) has the session `id` and `hostedLinkUrl`.
2. The browser shows **Open Plaid**, a link that opens `hostedLinkUrl` in a
   new tab. It is a link and not `window.open` after the request, because a
   browser blocks a pop-up that does not come directly from a click.
3. Hosted Link sends no callback to the page. The modal calls
   `POST .../sync/link-sessions/[id]/check` every three seconds while it is
   open. The server calls `/link/token/get` and reads the result with
   `link_outcome()` in `rust-api/server/src/plaid.rs`. A session that the user
   closed stays pending: the URL works again until the link token expires.
4. When the session is complete:
   - **New Item**: the server exchanges the public token
     (`/item/public_token/exchange`), keeps the duplicate `item_id` check of
     `POST sync/tokens`, and inserts the connection into `plaid_tokens` with
     the institution name from Plaid (`Bank` when Plaid gives none). Then it
     loads the accounts. The owner maps them next (**Map accounts**).
   - **Update mode**: the access token stays the same. The server clears
     `last_error` and loads the account list again. The connection keeps its
     ID, its account mappings, its sync cursor and its staged history.

Rules that are easy to get wrong:

- **The session is in the table `plaid_link_sessions`** (migration 0005), not
  in memory, so a restart during a session does not lose the link token. A
  session expires four hours after it starts, or when Plaid's link token
  expires, if that is earlier. A session past that time gets **one** Plaid
  call: Plaid keeps the result of a session after its link token expires, and
  the public token can still work. If the owner finished at Plaid just before
  the expiry, the check (or the create, when the owner opens the modal again)
  saves the connection, so no second Item is made at Plaid. With no result,
  or when Plaid refuses the call or the exchange (an `INVALID_*` code,
  `is_definitive_error()`), the session becomes `expired`, and a later check
  answers `expired` with no Plaid call. A transient failure (network, rate
  limit, Plaid server error) leaves the session as it is, and a later check
  tries again. While such a late session is open, a create without
  `restart` answers the failure and starts no second session, which could
  save the same bank two times. A new session deletes
  the sessions that expired more than one day before.
- **Resume and restart.** The browser can lose the session ID: the user
  reloads the page, or closes the modal, while the Plaid tab stays open.
  Thus the create first finds the open sessions (`pending` or `completing`,
  also the ones past `expires_at` that are not yet `expired`) of the same book and the same `token_id` (`token_id IS $2`,
  so NULL, a new connection, matches only NULL). The sessions of every owner
  of the book count: the connection is the book's. The create advances each
  one with `advance_session()`, the same helper as the check, which asks
  Plaid. If one becomes `complete`, the create answers it, and the modal
  shows the saved connection. Otherwise, without `restart`, it answers the
  newest open session that is not past `expires_at`: the same `id` and `hostedLinkUrl`, and no new Plaid
  session. With `restart: true` ("Start again" and "Try again" in the
  modal), it makes the pending sessions and the stale claims `expired` and
  starts a new one, in one transaction after Plaid gave the new link token.
  If Plaid refuses, the open sessions stay open. A Plaid failure for an open
  session does not fail the create: the log has the cause, and the session
  stays as it is.
- **The create looks again inside its write transaction.** The checks above
  run without the write lock, so two tabs that start the same connection at
  the same time both pass them. The transaction that inserts (it holds the
  write lock, `BEGIN IMMEDIATE`) reads the open sessions again. If one is
  there, the create answers it and inserts nothing; the new link token is
  not used and expires at Plaid. After a restart, the only open session that
  can be there is a live claim.
- **A restart and a completion do not overlap.** A restart, and the expiry
  of a session after its `expires_at`, never stop a live claim: the request
  that holds it has the public token, and it completes the session. The
  restart answers that claim (the client sees `pending`, then `complete`).
  The completion (`complete_claimed_session()`, in the transaction that
  writes the connection) makes the session `complete` only `WHERE status =
  'completing'`. If the session is no longer `completing` (a stale claim
  that a restart expired), the connection is saved all the same and the
  session keeps its state. The public token is already exchanged, so to drop
  the access token would leave the Item at Plaid with no connection in the
  book. `fail_session()` also changes only a `completing` session. The
  modal shows "Try again" only after a network failure or a 5xx answer. A
  4xx answer (a demo connection, a connection of another book) fails on each
  try, so the modal shows only "Close".
- **Only one check exchanges the result.** A check claims the session with a
  guarded `UPDATE ... SET status = 'completing'`. A check that loses the
  claim answers the stored state, which shows `completing` as `pending`. If
  the exchange fails, the claim goes back to `pending` (502), so a later
  check tries again. After a successful exchange the public token is used; a
  failure from then on (a duplicate Item, 409, or a failed insert, 500) makes
  the session `failed` with the message in `error`. The access token is then
  the only one, so a failed save is tried three times (`SAVE_ATTEMPTS`; the
  save is one transaction). If the last try fails, the server calls
  `/item/remove` before it drops the access token, so that no Item is left
  at Plaid that the book cannot use or remove. It never removes an Item that
  a book of the installation stores (`item_id` is unique across it): that
  is a duplicate (409), and the other connection uses the Item. When it
  cannot check, it leaves the Item at Plaid.
- **A claim has a lease** (`CLAIM_LEASE`, 10 minutes). If the server exits
  while it holds a claim, no request completes the session. A `completing`
  claim with an `updated_at` older than the lease is stale, and the next
  check treats it as `pending`: it asks Plaid, and takes the claim again in
  the same guarded `UPDATE` (`status = 'pending' OR (status = 'completing'
  AND updated_at < $stale_before)`). A fresh claim answers the stored state,
  with no Plaid call. The request that holds a claim makes one Plaid call,
  the exchange (at most 120 seconds, the client timeout), so 10 minutes is
  more than four times the longest live claim. If the server exited after
  the exchange, the public token is used: the new exchange fails, the claim
  goes back, and the session stays `pending` until it expires. The user then
  starts again. Nothing that was saved is lost: a connection is saved in one
  transaction, which also completes the session when the claim still holds.
- **A demo connection cannot be reconnected.** It has no Plaid Item, so
  `POST sync/link-sessions` refuses it (400). `GET sync/tokens` and
  `GET sync/assigned-accounts` give `isDemo` for each connection, and the
  Sync and Connections pages do not offer Reconnect for a demo connection.
- **The completion does not prune accounts.** The account load after a
  connect or a reconnect calls `refresh_accounts(..., prune: false)`: it adds
  and updates accounts, and deletes none. A delete of a `plaid_accounts` row
  cascades to its staged bank transactions, and a user who deselects an
  account in update mode must not lose that history. **Map accounts** still
  refreshes with `prune: true`, as before.
- **No response contains an access token, a public token or a link token**,
  and no log line names one. The HTTP test checks the response text for each
  token.
- **Both routes need the owner** (`AccessLevel::Owner`). They make or change
  the bank credentials of the book, as `POST`, `PUT` and `DELETE sync/tokens`
  do. The check is a `POST` and not a `GET` because it can write a
  connection; a `GET` would have to be `Read` (see
  [api-route-patterns.md](api-route-patterns.md#access-levels)).
- `user.client_user_id` is `counterpoise-user-<user id>`: stable, and not
  personal data, as Plaid asks.

Left out on purpose:

- `hosted_link.completion_redirect_uri`, which sends the Plaid tab back to the
  Sync page. It needs the public HTTPS origin of the install. The only such
  setting, `COUNTERPOISE_PUBLIC_URL`, also turns on OAuth for MCP, so it is
  not a clean opt-in for this. The poll works without it: the user closes the
  Plaid tab and goes back to the Counterpoise tab.
- The `SESSION_FINISHED` webhook. It needs a public URL that Plaid can reach
  and a check of the webhook signature. The poll does the same work.

**Fallback.** `scripts/plaid-link.ts` (`npm run plaid:link`) runs the same
Hosted Link flow in a terminal and prints the Item ID and the access token.
The owner pastes them into **Manage connections → Add with access token**
(`POST sync/tokens`). Keep both for an install where the in-app flow cannot
run. They put the access token on the terminal and the clipboard, so the
in-app flow is the default.

## Sync Trigger Points
- **Manual**: POST `/api/b/[bookId]/sync/tokens/[id]/sync` — syncs a single token on demand. Sync is always per token: there is **no** per-account sync route. `DELETE` on that same path clears the token's staged sync data. The only route under `sync/accounts/[id]/` is `reconcile`
- **Scheduled**: the server syncs all tokens with linked accounts every 6 hours (12am, 6am, 12pm, 6pm, in `TZ`; `rust-api/server/src/scheduler.rs`). GET `/api/cron/plaid-sync` runs the same job now and requires the `CRON_SECRET` bearer token. **Tokens with `isDemo = true` are excluded**, and `sync_token()` refuses them outright. The seed gives a demo book a Plaid connection with a synthetic access token so the Sync page has something to show; it is linked to a liability account exactly like a real connection, so nothing but that column tells them apart. Without the exclusion, every demo book makes a guaranteed-failing call to Plaid every six hours and writes the rejection to `lastError`, which the Sync page renders as "Last sync failed". The guard in `sync_locked()` runs *before* the step that writes `lastError` for that reason: a demo connection must not be recorded as a broken one.

## Auto-Match Algorithm (`auto_match()` in `rust-api/server/src/routes/plaid_sync.rs`)
Auto-match runs automatically after every sync (both manual and cron). It uses a learned payee map built from previously human-matched reconciliation rows:
1. **Build payee map**: Query all `matched` reconciliation rows to create a map of normalized Plaid merchant names → Counterpoise payee IDs
2. **For each pending row** (without `reviewReason`):
   - Look up the Plaid merchant name in the payee map
   - Find candidate transactions with: exact amount match, matching payee ID, on the mapped Counterpoise account
   - Filter candidates to ±1 day of **either** the Plaid authorization date **or** the posted date (the union keeps delayed settlements in range — a transaction the user entered on the posted date matches even when the authorization date is 7+ days earlier — without matching anything in the gap between the two dates)
   - If any candidates remain, pick the one whose date is CLOSEST to the date the match will stamp (`pick_matched_date()`). Candidates are ordered by date then ID, and that ordering breaks ties at equal distance. Nearest-to-stamped avoids re-dating an earlier transaction and stranding the real posted-date one
   - Atomically set `resolutionStatus = 'matched'`, mark the local transaction as reconciled (and `isFloating = false`), and stamp its `date` (see date rule below)
3. **Per-link uniqueness**: A transaction can only be auto-matched once per Plaid account link (but the same transaction can match on different linked accounts for transfers)

**Auto-match date rule**: When stamping the matched transaction's `date`, prefer the Plaid **authorization** date (closest to when the user entered the transaction) over the **posted** date. Fall back to the posted date only when it lands 7+ days after authorization (a gap that large means the posted/settlement date is the meaningful one), or when Plaid provides no `authorizedDate`. The manual `match` action in the reconcile route applies the same rule, but **only to a floating transaction** — it settles one by clearing `isFloating` and stamping this date. A non-floating transaction keeps the date the user entered.

## Sync Handling of Modified/Removed Transactions
- **Modified**: If a previously matched/created row is modified by Plaid, it gets `reviewReason: 'plaid_modified'` with before/after metadata for human review
- **Removed**: If a previously resolved row is removed by Plaid, it gets `reviewReason: 'plaid_removed'`
- **Pending rows**: Modified pending rows are simply updated in place

## Transaction Unlink
- POST `/api/b/[bookId]/transactions/[id]/plaid/unlink` — Removes the Plaid link from a matched transaction (sets reconciliation back to `pending`, clears `isReconciled`). Clearing `isReconciled` is necessary. A transaction left marked reconciled asserts a match to a bank record that no longer links to it, and the `stale-unmatched` read flags only rows with `isReconciled = false`, so the sync health check would never show it again.

## Reconciliation

`rust-api/server/src/routes/reconcile.rs` owns the two queue reads and the six decisions. The route `sync/accounts/[id]/reconcile` serves them, and the two MCP tools send their requests through that route. Seven things about it are easy to get wrong:

- **It does not take a session lock**, unlike `sync_token()`. It changes one staged row by id inside one database transaction, and that transaction is the whole concurrency story. The transaction opens with `BEGIN IMMEDIATE` (`ledger_db::locks::begin`), which holds the write lock of the database file before `apply()` reads the staged row (`load_row()`). Without that lock, two resolves of one row that run at the same time (two tabs, or the ordinary route and a TypeSafe confirmation) both read it as pending, both insert a transaction, and the second UPDATE overwrites the link, so the first transaction is left orphaned. With the lock, the second resolve waits, reads the row as linked, and the already-linked guard refuses it. Do not open this transaction with a plain `BEGIN`: a deferred transaction reads without the lock.
- **The route checks the action's required field before it loads the row.** `validate_reconcile()` runs on the body first, so the route reports `"transactionId is required for match"` (400) ahead of `"Reconciliation row not found"` (404). `apply()` expects a validated decision: it does not check the field again. The TypeSafe confirmation builds its decision itself, from a stored candidate or proposal, so it must give the id that the action needs.
- **A bank row that is already linked cannot be linked again** — `match`, `match_update_amount` and `create` all refuse when `matchedTransactionId` is set and `reviewReason` is null. Without it a repeated `create` inserts a second transaction and repoints the link at it, orphaning the first (still marked reconciled, attached to nothing, and invisible to the `stale-unmatched` read, which filters `isReconciled = false`). The `reviewReason` half is load-bearing: the queue is "pending OR flagged for review", `ReconciliationModal` renders those buttons for anything in it, so a row Plaid has since modified is both already-linked and legitimately re-linkable. What stays closed is what the UI cannot reach — `load_row()` matches on id, link and book but not queue membership, so MCP can address a fully-resolved row long after it left the queue.
- **`unlink` un-reconciles its transaction, but only when nothing else matches it.** Per-link uniqueness is enforced per link, so one transaction can be matched on two links at once — that is how a transfer reconciles against both sides — and an unconditional clear would make a correctly-reconciled transfer a false positive in the health check.
- **Matching a floating transaction settles it**: `isFloating` is cleared and `date` stamped with `pick_matched_date()` (shared with the auto-matcher, not reimplemented). A floating transaction's stored date is its original entry date, so clearing the flag alone would snap it backwards in the register. A non-floating transaction keeps its date untouched — see the auto-match date rule above.
- **There are two queue reads, and they sort differently.** `link_queue()` reads one link, for `sync/accounts/[id]/reconcile`. `book_queue()` reads the whole book, or one link with `linkId`, for `GET sync/reconcile`. The Sync page's review modal uses only the book-wide read, so it can show one list across all accounts. Both put rows that need review first. After that, the per-link read sorts by `lastSeenAt` and the book-wide read sorts by the bank date (`authorizedDate`, else `date`), newest first. A list that mixes accounts is easy to scan only in date order. The book-wide read keeps a link only when it maps to an asset or liability account, which is the rule `reconcilable_link()` applies to one link. There is no book-wide write: the modal posts each decision to `sync/accounts/[id]/reconcile` with the row's own `plaidAccountLinkId`.
- **The action list is kept in step by hand** in `Action` and `validate_reconcile()` in `reconcile.rs`, the decision branches of `apply()`, `SyncResolveActionPayload` in `types/index.ts`, and the MCP tool's schema in `rust-api/server/mcp-tools.json`. A new action needs all of them.

## Rust routes

Rust serves every route in this guide:

- `rust-api/server/src/routes/sync.rs`: the connection routes, the account
  mappings, the reset of a connection, the four sync reads (`pending-count`,
  `assigned-accounts`, `pending-transactions`, `stale-unmatched`), the
  transaction Plaid link, and unlink.
- `rust-api/server/src/routes/plaid_sync.rs`: the manual sync and the
  auto-matcher. `sync_token()` there is the entry point for the manual sync
  and the cron.
- `rust-api/server/src/routes/cron.rs`: the cron (`GET /api/cron/plaid-sync`).
  It counts a 409 from `sync_token()` as skipped, not failed.
- `rust-api/server/src/routes/reconcile.rs`: the two queue reads and the six
  decisions.
- `rust-api/server/src/routes/plaid_link.rs`: the Hosted Link sessions
  (connect and reconnect).
- `rust-api/server/src/plaid.rs`: the Plaid client.
- `rust-api/server/src/routes/typesafe_suggestion.rs`: the TypeSafe
  suggestion route. See [TypeSafe experiment](typesafe-experiment.md#rust-port).

`lib/plaid.ts` remains only for `npm run plaid:link`, the terminal fallback
that mints an access token. The `tests/http/plaid-*.test.ts` and
`tests/http/cron.test.ts` suites cover the routes. `tests/http/plaid-link.test.ts`
starts a Plaid mock for create, the poll (pending, complete, expired) and the
exchange. See [the Rust book routes](api-route-patterns.md) for
the rules that the port keeps.

## Environment Variables

Optional TypeSafe suggestions are a separate, book-opted-in UI experiment. They
do not run inside sync or change the auto-matcher. See
[TypeSafe experiment](typesafe-experiment.md) for settings, data boundaries,
manual confirmation, evaluation, and retention.

| Variable | Purpose |
| -------- | ------- |
| `PLAID_CLIENT_ID` | Plaid API client ID |
| `PLAID_SECRET` | Plaid API secret |
| `PLAID_ENV` | Plaid environment — `sandbox` or `production`. Any other value is rejected |
| `PLAID_API_URL` | Replaces the origin of the selected environment. The HTTP tests set it to a local mock, so that no test calls Plaid. Leave it unset in a deployment |
| `CRON_SECRET` | Shared secret for cron endpoint auth (also used by recurring cron) |

## Key Functions
- `sync_token(state, book_id, token_id)` in `routes/plaid_sync.rs` — Main sync entry point, returns `SyncResult` with counts of added/modified/removed/auto-matched. Serialized per token by `ledger_db::locks::with_session_lock()` (a file lock under `<database>.locks/`), so the scheduled job, the MCP process and a manual click cannot fetch the same Plaid pages twice; the loser gets a 409 refusal rather than waiting. The whole sync therefore runs on one reserved connection
- `SyncError` — `Refused` carries an HTTP status (404 token not found, 400 invalid config, 409 sync already running); `Failed` carries any other failure
- `auto_match(connection, analytics, book_id, link_ids)` — Builds the learned payee map from historical matches, then returns the count of successful auto-matches
- `Plaid::is_configured()` in `plaid.rs` — Checks if all three Plaid env vars are set
