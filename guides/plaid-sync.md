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
  the exchange (at most 120 seconds, the request timeout), so 10 minutes is
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
  refreshes with `prune: true`, through
  `POST sync/tokens/[id]/accounts/refresh`.
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
- **Manual**: POST `/api/b/[bookId]/sync/tokens/[id]/sync` — syncs a single token on demand. Sync is always per token: there is **no** per-account sync route. `DELETE` on that same path clears the token's staged sync data (the reset; see "The connection lease and the cursor"). The only route under `sync/accounts/[id]/` is `reconcile`
- **Scheduled**: the server syncs all tokens with linked accounts every 6 hours (12am, 6am, 12pm, 6pm, in `TZ`; `rust-api/server/src/scheduler/mod.rs`). The scheduled run syncs three tokens per step, in ID order, and keeps the last ID in its slot's cursor (`job_slots`), so one step fits in a Workers alarm. GET `/api/cron/plaid-sync` runs the same job now, every token in one call, and requires the `CRON_SECRET` bearer token. **Tokens with `isDemo = true` are excluded**, and `sync_token()` refuses them outright. The seed gives a demo book a Plaid connection with a synthetic access token so the Sync page has something to show; it is linked to a liability account exactly like a real connection, so nothing but that column tells them apart. Without the exclusion, every demo book makes a guaranteed-failing call to Plaid every six hours and writes the rejection to `lastError`, which the Sync page renders as "Last sync failed". The guard in `sync_locked()` runs *before* the step that writes `lastError` for that reason: a demo connection must not be recorded as a broken one.

## The connection lease and the cursor

`plaid_tokens.sync_cursor` says where the next sync starts. Plaid sends a
bank row one time for each cursor position, so a cursor that moves past a
row that is not staged loses that row for good. Two guards keep the cursor
and the staged rows together:

- **Each writer of the cursor holds the lease `plaid-sync:<id>`**
  (`connection_lease()` in `plaid_sync.rs`). The sync holds it for its whole
  life. The reset (`DELETE sync/tokens/[id]/sync`), the edit
  (`PUT sync/tokens/[id]`) and the delete (`DELETE sync/tokens/[id]`) take
  it for their write. Each one answers 409 `A sync is already running for
  this connection` while another run holds it, as a second sync does, and
  does not wait. Before this rule, a reset during a sync deleted the pending
  rows and cleared the cursor, and the sync then saved its `next_cursor`:
  the next sync started past the deleted rows. Take the lease only after
  the route proves that the connection is in the book. The lease name has
  no book in it.
- **The sync saves its cursor with a compare**: `WHERE id = ?1 AND
  sync_cursor IS ?4`, where `?4` is the cursor that the sync read at its
  start. A lease can lapse (`leases.rs`: a process that stops for longer
  than the TTL), so the lease alone is not enough. When the compare fails,
  the sync answers 409 `The connection changed during the sync. Sync
  again.`, records that text in `last_error`, and leaves the stored cursor.
  The rows that it staged stay; the next sync fetches from the stored cursor
  and stages them again (the upsert makes that safe). The cron counts the
  409 as skipped.

**An edit that changes the Item resets the cursor.** A cursor belongs to
one Plaid Item. `PUT sync/tokens/[id]` sets `sync_cursor` to NULL when the
`itemId` changes or when the body has an access token that is not the stored
one. A new name, or the same token again, keeps the cursor. The reconnect
(update mode) keeps the Item and its access token, so it keeps the cursor.

## Auto-Match Algorithm (`auto_match()` in `rust-api/server/src/routes/plaid_sync.rs`)
Auto-match runs automatically after every sync (both manual and cron). It uses a learned payee map built from previously human-matched reconciliation rows:
1. **Build payee map**: Query all `matched` reconciliation rows to create a map of normalized Plaid merchant names → Counterpoise payee IDs
2. **For each pending row** (without `reviewReason`):
   - Look up the Plaid merchant name in the payee map
   - Find candidate transactions with: exact amount match, matching payee ID, on the mapped Counterpoise account
   - Drop a candidate that is already reconciled (`isReconciled`), unless a bank row links it. The match stamps the date of its transaction, and a transaction that the user reconciled by hand must keep its date. A transaction that a bank row links is a transfer that the other link matched: it stays a candidate, and the per-link rule below keeps it off its own link
   - Filter candidates to ±1 day of **either** the Plaid authorization date **or** the posted date (the union keeps delayed settlements in range — a transaction the user entered on the posted date matches even when the authorization date is 7+ days earlier — without matching anything in the gap between the two dates)
   - If any candidates remain, pick the one whose date is CLOSEST to the date the match will stamp (`pick_matched_date()`). Candidates are ordered by date then ID, and that ordering breaks ties at equal distance. Nearest-to-stamped avoids re-dating an earlier transaction and stranding the real posted-date one
   - Atomically set `resolutionStatus = 'matched'`, mark the local transaction as reconciled (and `isFloating = false`), and stamp its `date` (see date rule below)
3. **Per-link uniqueness**: A transaction can only be auto-matched once per Plaid account link (but the same transaction can match on different linked accounts for transfers)

**Auto-match date rule**: When stamping the matched transaction's `date`, prefer the Plaid **authorization** date (closest to when the user entered the transaction) over the **posted** date. Fall back to the posted date only when it lands 7+ days after authorization (a gap that large means the posted/settlement date is the meaningful one), or when Plaid provides no `authorizedDate`. The manual `match` action in the reconcile route applies the same rule, but **only to a floating transaction** — it settles one by clearing `isFloating` and stamping this date. A non-floating transaction keeps the date the user entered.

## Sync Handling of Modified/Removed Transactions
- **Modified**: If a previously matched/created row is modified by Plaid, it gets `reviewReason: 'plaid_modified'` with before/after metadata for human review
- **Removed**: If a pending, matched or created row is removed by Plaid, it gets `reviewReason: 'plaid_removed'`. An ignored row stays as it is
- **Pending rows**: Modified pending rows are simply updated in place. A flag on such a row goes, and `reviewMetadataJson` goes with it

The transition table in "Reconciliation" lists each of these writes with the
decisions.

## Transaction Unlink
- POST `/api/b/[bookId]/transactions/[id]/plaid/unlink` — Removes the Plaid link from a matched transaction (sets reconciliation back to `pending`, clears `isReconciled`). It is the Unlink of the transition table for each row that links the transaction: the write has the same `WHERE` and the same columns (`UNLINK_SET` in `reconcile.rs`), so the flag of a row that the bank removed stays. Clearing `isReconciled` is necessary. A transaction left marked reconciled asserts a match to a bank record that no longer links to it, and the `stale-unmatched` read flags only rows with `isReconciled = false`, so the sync health check would never show it again.

## Reconciliation

`rust-api/server/src/routes/reconcile.rs` owns the two queue reads and the six decisions. The route `sync/accounts/[id]/reconcile` serves them, and the two MCP tools send their requests through that route.

### Transition table

A staged bank row (`plaid_transaction_reconciliation`) has a status
(`resolution_status`: `pending`, `matched`, `created`, `ignored`) and a flag
(`review_reason`: NULL, `plaid_modified`, `plaid_removed`). "Linked" below is
`matched` or `created`. The queue shows a row that is `pending` or has a flag.

The six decisions. Each cell is the state after the decision, or "refused"
(400, and nothing is written):

| State of the row | `match`, `match_update_amount` | `create` | `ignore` | `keep_local` | `unlink` |
| --- | --- | --- | --- | --- | --- |
| `pending`, no flag | `matched`, no flag | `created`, no flag | `ignored`, no flag | refused | refused |
| `pending`, `plaid_modified` (its transaction was deleted) | `matched`, no flag | `created`, no flag | `ignored`, no flag | `pending`, no flag | refused |
| `pending`, `plaid_removed` | `matched`, no flag | `created`, no flag | `ignored`, no flag | refused | refused |
| linked, no flag | refused: unlink first | refused: unlink first | refused: unlink first | refused | `pending`, no flag |
| linked, `plaid_modified` | `matched`, no flag | `created`, no flag | `ignored`, no flag | same status, no flag | `pending`, no flag |
| linked, `plaid_removed` | `matched`, no flag | `created`, no flag | `ignored`, no flag | refused | `pending`, `plaid_removed` |
| `ignored` | refused | refused | refused | refused | refused |

A decision that removes or replaces the link of a linked row also releases
the old transaction (`release_previous()`, below). A status that is not one
of the four takes no decision.

The other writers of these columns:

| Writer | From | To |
| --- | --- | --- |
| Sync, added (`stage_added()`) | no row | `pending`, no flag |
| Sync, added again | any | same status, no flag |
| Sync, modified (`stage_modified()`) | no row | `pending`, no flag |
| Sync, modified | `pending`, any flag | `pending`, no flag, no metadata |
| Sync, modified | linked, any flag | same status, `plaid_modified` |
| Sync, modified | `ignored` | no change to the status or the flag |
| Sync, removed (`stage_removed()`) | `pending` or linked, any flag | same status, `plaid_removed` |
| Sync, removed | `ignored` | no change |
| Auto-match (`auto_match()`) | `pending`, no flag | `matched`, no flag |
| Transaction unlink route (`sync.rs`) | linked, any flag | as `unlink` above |
| Transaction delete (`transactions.rs`) | linked, any flag | `pending`, same flag |
| Reset (`clear_sync_data()`) | `pending`, any flag | the row is deleted |

Rules that the table follows:

- **The code has the table one time.** `Action::allowed_from()` in
  `reconcile.rs` gives, for each decision, the states that it can start
  from, as an SQL condition. `apply()` checks it before the first write, and
  each decision's `UPDATE` has it in its `WHERE` (`resolve_row()`,
  `UNLINK_SET`). A write that changes no row fails the decision, and the
  transaction rolls back. `Action::refusal()` only selects the message.
  Change the table here and that function together.
- **`keep_local` is for a row that the bank changed.** A row that the bank
  removed has no bank side to keep. Before this rule, Keep local made a
  `pending` row with `plaid_removed` a plain pending row, and the
  auto-matcher could then match a row that the bank had deleted. Ignore is
  the way out of that state. For the same reason `unlink` keeps the
  `plaid_removed` flag.
- **`ignored` is final for the decisions.** No decision brings an ignored row
  back, and the queue does not show it. A sync that adds the row again keeps
  it ignored.
- **A linked row with no flag takes only `unlink`.** It left the queue. This
  is the already-linked guard below, and it now covers `ignore` too.
- **`create` on a linked row that has a flag stays open.** It adds a second
  transaction for the same bank charge and releases the old one. The modal
  asks first ("Create a second transaction?") on a `plaid_modified` row. The
  MCP tool has no such question.
- **The client follows the table.** `ReconciliationModal` enables Keep local
  only on a `plaid_modified` row (`canKeep`) and Unlink only on a linked row
  (`canUnlink`), for the buttons and for the keys.
- **The columns have no CHECK constraint yet.** The
  guards are in the code only.

### Rules of the resolver

Eight things about it are easy to get wrong:

- **It does not take a session lock**, unlike `sync_token()`. It changes one staged row by id inside one database transaction, and that transaction is the whole concurrency story. The transaction opens with `BEGIN IMMEDIATE` (`Database::transaction`), which holds the write lock of the database file before `apply()` reads the staged row (`load_row()`). Without that lock, two resolves of one row that run at the same time (two tabs, or the ordinary route and a TypeSafe confirmation) both read it as pending, both insert a transaction, and the second UPDATE overwrites the link, so the first transaction is left orphaned. With the lock, the second resolve waits, reads the row as linked, and the already-linked guard refuses it. Do not open this transaction with a plain `BEGIN`: a deferred transaction reads without the lock.
- **The route checks the action's required field before it loads the row.** `validate_reconcile()` runs on the body first, so the route reports `"transactionId is required for match"` (400) ahead of `"Reconciliation row not found"` (404). `apply()` expects a validated decision: it does not check the field again. The TypeSafe confirmation builds its decision itself, from a stored candidate or proposal, so it must give the id that the action needs.
- **A bank row that is already linked cannot be linked again** — `match`, `match_update_amount`, `create` and `ignore` all refuse when the row is `matched` or `created` and `reviewReason` is null (the transition table above). Without it a repeated `create` inserts a second transaction and repoints the link at it, orphaning the first (still marked reconciled, attached to nothing, and invisible to the `stale-unmatched` read, which filters `isReconciled = false`). The `reviewReason` half is load-bearing: the queue is "pending OR flagged for review", `ReconciliationModal` renders those buttons for anything in it, so a row Plaid has since modified is both already-linked and legitimately re-linkable. What stays closed is what the UI cannot reach — `load_row()` matches on id, link and book but not queue membership, so MCP can address a fully-resolved row long after it left the queue.
- **`unlink` un-reconciles its transaction, but only when nothing else matches it.** Per-link uniqueness is enforced per link, so one transaction can be matched on two links at once — that is how a transfer reconciles against both sides — and an unconditional clear would make a correctly-reconciled transfer a false positive in the health check.
- **Every decision that removes or replaces a link releases the old transaction** with that same rule (`release_previous()`): `unlink`, `ignore` on a linked row, and `match`, `match_update_amount` or `create` on a row flagged for review that links a different transaction. A row that Plaid modified is still linked, and `ReconciliationModal` shows Ignore for it. Ignore once cleared the link and left the old transaction reconciled with no link, the same orphan that the already-linked guard prevents.
- **Matching a floating transaction settles it**: `isFloating` is cleared and `date` stamped with `pick_matched_date()` (shared with the auto-matcher, not reimplemented). A floating transaction's stored date is its original entry date, so clearing the flag alone would snap it backwards in the register. A non-floating transaction keeps its date untouched — see the auto-match date rule above.
- **There are two queue reads, and they sort differently.** `link_queue()` reads one link, for `sync/accounts/[id]/reconcile`. `book_queue()` reads the whole book, or one link with `linkId`, for `GET sync/reconcile`. The Sync page's review modal uses only the book-wide read, so it can show one list across all accounts. Both put rows that need review first. After that, the per-link read sorts by `lastSeenAt` and the book-wide read sorts by the bank date (`authorizedDate`, else `date`), newest first. A list that mixes accounts is easy to scan only in date order. The book-wide read keeps a link only when it maps to an asset or liability account, which is the rule `reconcilable_link()` applies to one link. There is no book-wide write: the modal posts each decision to `sync/accounts/[id]/reconcile` with the row's own `plaidAccountLinkId`.
- **The action list is kept in step by hand** in `Action` and `validate_reconcile()` in `reconcile.rs`, the decision branches of `apply()`, `SyncResolveActionPayload` in `types/index.ts`, and the MCP tool's schema in `rust-api/server/mcp-tools.json`. A new action needs all of them.

## Rust routes

Rust serves every route in this guide:

- `rust-api/server/src/routes/sync.rs`: the connection routes, the account
  mappings, the reset of a connection (it does not run during a sync: see
  "The connection lease and the cursor"), the four sync reads (`pending-count`,
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
| `PLAID_TOKEN_KEY` | Encrypts the stored access tokens: 32 bytes in base64 (`openssl rand -base64 32`). Required to store a token. See "Access tokens at rest" |
| `PLAID_TOKEN_KEY_PREVIOUS` | Only while rotating: the old keys, comma-separated |
| `CRON_SECRET` | Shared secret for cron endpoint auth (also used by recurring cron) |

## Access tokens at rest

`plaid_tokens.access_token` is a live grant to a bank's data, so the database
holds only its ciphertext. `rust-api/server/src/plaid_token_keys.rs` has the
cipher (XChaCha20-Poly1305, pure Rust, so it also builds for wasm32), and
`Plaid::seal_token()` and `Plaid::open_token()` are the only way in and out.

- **Read a token through `open_token()`, with both columns.** The text means
  nothing without `access_token_key`, the ID of the key that sealed it (eight
  hex digits of a SHA-256 over the key, never the key). A null key ID means the
  text is plaintext: a row from before migration 0011, or a seeded demo
  connection. A query that selects `access_token` alone gets ciphertext.
- **Write a token through `seal_token()`.** Without `PLAID_TOKEN_KEY` it fails
  with a message that names the variable, which the routes answer as a 500
  configuration fault. A link session for a new Item is refused up front for
  the same reason, so no Item is made at Plaid that the server could not keep.
  A reconnect (update mode) writes no token, so it works without a key. If the
  seal fails after the public-token exchange, the Item is removed at Plaid.
- **The startup step** (`prepare()`, after the migrations) refuses a file whose
  rows name a key that neither `PLAID_TOKEN_KEY` nor `PLAID_TOKEN_KEY_PREVIOUS`
  holds. With a key set, it then seals every plaintext row and every row under a
  previous key with the current key, in one transaction. Without a key it
  changes nothing and logs a warning for each start while real connections are
  plaintext. The stdio MCP process runs only the refusal (`check()`).
- **Backups and dumps carry the ciphertext.** Restoring one needs the key that
  sealed it. A tool that copies production into a development database must
  overwrite every token and clear its key ID, so the copy needs no production
  key.
- **Never log a key or a token.** The messages name the variable or the key ID.

## Key Functions
- `sync_token(state, book_id, token_id)` in `routes/plaid_sync.rs` — Main sync entry point, returns `SyncResult` with counts of added/modified/removed/auto-matched. Serialized per token by a lease (`leases::plaid_sync(token_id)`, a row of `job_leases`), so the scheduled job, the MCP process and a manual click cannot fetch the same Plaid pages twice; the loser gets a 409 refusal rather than waiting. The whole sync therefore runs on one reserved connection
- `connection_lease(database, token_id)` in `routes/plaid_sync.rs` — Takes that lease. The sync, the reset, the edit and the delete of a connection call it (see "The connection lease and the cursor")
- `SyncError` — `Refused` carries an HTTP status (404 token not found, 400 invalid config, 409 sync already running, 409 the cursor changed during the sync); `Failed` carries any other failure
- `auto_match(database, access, link_ids)` — Builds the learned payee map from historical matches, then returns the count of successful auto-matches
- `Plaid::is_configured()` in `plaid.rs` — Checks if all three Plaid env vars are set
