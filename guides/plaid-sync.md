# Plaid Bank Sync

One of the guides [CLAUDE.md](../CLAUDE.md) points to. Read that file first;
it carries the rules that apply everywhere and says when to come here.

## How Plaid Sync Works
1. User connects a bank via Plaid Link (stores access token in `plaidTokens`)
2. User maps Plaid accounts to Counterpoise accounts (stored in `plaidAccounts`)
3. Sync fetches new/modified/removed transactions from Plaid's transaction sync API
4. Transactions are staged in `plaidTransactionReconciliation` as `pending`
5. Auto-match runs on pending rows, then remaining items await manual reconciliation in the UI

## Sync Trigger Points
- **Manual**: POST `/api/b/[bookId]/sync/tokens/[id]/sync` — syncs a single token on demand. Sync is always per token: there is **no** per-account sync route. `DELETE` on that same path clears the token's staged sync data. The only route under `sync/accounts/[id]/` is `reconcile`
- **Cron**: GET `/api/cron/plaid-sync` — syncs all tokens with linked accounts every 6 hours (via Docker `scheduler` sidecar at 12am, 6am, 12pm, 6pm). Requires `CRON_SECRET` bearer token. **Tokens with `isDemo = true` are excluded**, and `sync_token()` refuses them outright. The seed gives a demo book a Plaid connection with a synthetic access token so the Sync page has something to show; it is linked to a liability account exactly like a real connection, so nothing but that column tells them apart. Without the exclusion, every demo book makes a guaranteed-failing call to Plaid every six hours and writes the rejection to `lastError`, which the Sync page renders as "Last sync failed". The guard in `sync_locked()` runs *before* the step that writes `lastError` for that reason: a demo connection must not be recorded as a broken one.

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

- **It does not take an advisory lock**, unlike `sync_token()`. It changes one staged row by id inside one database transaction, so PostgreSQL row locking is the whole concurrency story. `apply()` reads the staged row `FOR UPDATE` (`load_row()` with `for_update`). Without that lock, two resolves of one row that run at the same time (two tabs, or the ordinary route and a TypeSafe confirmation) both read it as pending, both insert a transaction, and the second UPDATE overwrites the link, so the first transaction is left orphaned. With the lock, the second resolve waits, reads the row as linked, and the already-linked guard refuses it.
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
- `rust-api/server/src/plaid.rs`: the Plaid client.
- `rust-api/server/src/routes/typesafe_suggestion.rs`: the TypeSafe
  suggestion route. See [TypeSafe experiment](typesafe-experiment.md#rust-port).

`lib/plaid.ts` remains only for `npm run plaid:link`, which mints a sandbox
access token. The `tests/http/plaid-*.test.ts` and `tests/http/cron.test.ts`
suites cover the routes. See [the Rust book routes](api-route-patterns.md) for
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
- `sync_token(state, book_id, token_id)` in `routes/plaid_sync.rs` — Main sync entry point, returns `SyncResult` with counts of added/modified/removed/auto-matched. Serialized per token by `with_advisory_lock()` in `db_scope.rs`, so the cron and a manual click cannot fetch the same Plaid pages twice; the loser gets a 409 refusal rather than waiting. The whole sync therefore runs on one reserved connection
- `SyncError` — `Refused` carries an HTTP status (404 token not found, 400 invalid config, 409 sync already running); `Failed` carries any other failure
- `auto_match(connection, analytics, book_id, link_ids)` — Builds the learned payee map from historical matches, then returns the count of successful auto-matches
- `Plaid::is_configured()` in `plaid.rs` — Checks if all three Plaid env vars are set
