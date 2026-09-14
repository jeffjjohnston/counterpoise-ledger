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
- **Cron**: GET `/api/cron/plaid-sync` — syncs all tokens with linked accounts every 6 hours (via Docker `scheduler` sidecar at 12am, 6am, 12pm, 6pm). Requires `CRON_SECRET` bearer token. **Tokens with `isDemo = true` are excluded**, and `syncToken` refuses them outright. The seed gives a demo book a Plaid connection with a synthetic access token so the Sync page has something to show; it is linked to a liability account exactly like a real connection, so nothing but that column tells them apart. Without the exclusion, every demo book makes a guaranteed-failing call to Plaid every six hours and writes the rejection to `lastError`, which the Sync page renders as "Last sync failed". `syncToken`'s guard sits *above* its try block for that reason — the catch inside writes `lastError`, and a demo connection must not be recorded as a broken one.

## Auto-Match Algorithm (`/lib/plaid-auto-match.ts`)
Auto-match runs automatically after every sync (both manual and cron). It uses a learned payee map built from previously human-matched reconciliation rows:
1. **Build payee map**: Query all `matched` reconciliation rows to create a map of normalized Plaid merchant names → Counterpoise payee IDs
2. **For each pending row** (without `reviewReason`):
   - Look up the Plaid merchant name in the payee map
   - Find candidate transactions with: exact amount match, matching payee ID, on the mapped Counterpoise account
   - Filter candidates to ±1 day of **either** the Plaid authorization date **or** the posted date (the union keeps delayed settlements in range — a transaction the user entered on the posted date matches even when the authorization date is 7+ days earlier — without matching anything in the gap between the two dates)
   - If any candidates remain, pick the one whose date is CLOSEST to the date the match will stamp (`pickMatchedDate`). Candidates are ordered by date then ID, and that ordering breaks ties at equal distance. Nearest-to-stamped avoids re-dating an earlier transaction and stranding the real posted-date one
   - Atomically set `resolutionStatus = 'matched'`, mark the local transaction as reconciled (and `isFloating = false`), and stamp its `date` (see date rule below)
3. **Per-link uniqueness**: A transaction can only be auto-matched once per Plaid account link (but the same transaction can match on different linked accounts for transfers)

**Auto-match date rule**: When stamping the matched transaction's `date`, prefer the Plaid **authorization** date (closest to when the user entered the transaction) over the **posted** date. Fall back to the posted date only when it lands 7+ days after authorization (a gap that large means the posted/settlement date is the meaningful one), or when Plaid provides no `authorizedDate`. The manual `match` action in the reconcile route applies the same rule, but **only to a floating transaction** — it settles one by clearing `isFloating` and stamping this date. A non-floating transaction keeps the date the user entered.

## Sync Handling of Modified/Removed Transactions
- **Modified**: If a previously matched/created row is modified by Plaid, it gets `reviewReason: 'plaid_modified'` with before/after metadata for human review
- **Removed**: If a previously resolved row is removed by Plaid, it gets `reviewReason: 'plaid_removed'`
- **Pending rows**: Modified pending rows are simply updated in place

## Transaction Unlink
- POST `/api/b/[bookId]/transactions/[id]/plaid/unlink` — Removes the Plaid link from a matched transaction (sets reconciliation back to `pending`, clears `isReconciled`). The `isReconciled` clear is real, not aspirational: before the MCP-parity Plaid work, the route reset only the reconciliation row and left `transactions.isReconciled` untouched. A transaction stuck marked reconciled would assert a match to a bank record that no longer links to it — and since `getStaleUnmatched()` only flags rows with `isReconciled = false`, it could never resurface in the sync health check either.

## Reconciliation

`/lib/plaid-reconcile.ts` owns the queue read and the six-action resolver, shared by `sync/accounts/[id]/reconcile` and the two MCP tools. Six things about it are easy to get wrong:

- **It does not take an advisory lock**, unlike `syncToken`. It mutates one already-staged row by id inside `db.transaction()` on the pooled connection, so Postgres row locking is the whole concurrency story. The reserved-connection warning in [guides/architecture.md](architecture.md) is about `/lib/plaid-sync.ts`, not this file.
- **`resolveReconciliation` checks the action's required field as its first statement**, before the transaction opens. That ordering is what makes the route report `"transactionId is required for match"` (400) ahead of `"Reconciliation row not found"` (404). Moving the check after the row load silently swaps the two answers.
- **A bank row that is already linked cannot be linked again** — `match`, `match_update_amount` and `create` all refuse when `matchedTransactionId` is set and `reviewReason` is null. Without it a repeated `create` inserts a second transaction and repoints the link at it, orphaning the first (still marked reconciled, attached to nothing, and invisible to `getStaleUnmatched()`, which filters `isReconciled = false`). The `reviewReason` half is load-bearing: the queue is "pending OR flagged for review", `ReconciliationModal` renders those buttons for anything in it, so a row Plaid has since modified is both already-linked and legitimately re-linkable. What stays closed is what the UI cannot reach — `loadReconciliationRow` matches on id, link and book but not queue membership, so MCP can address a fully-resolved row long after it left the queue.
- **`unlink` un-reconciles its transaction, but only when nothing else matches it.** Per-link uniqueness is enforced per link, so one transaction can be matched on two links at once — that is how a transfer reconciles against both sides — and an unconditional clear would make a correctly-reconciled transfer a false positive in the health check.
- **Matching a floating transaction settles it**: `isFloating` is cleared and `date` stamped with `pickMatchedDate` (shared with the auto-matcher, not reimplemented). A floating transaction's stored date is its original entry date, so clearing the flag alone would snap it backwards in the register. A non-floating transaction keeps its date untouched — see the auto-match date rule above.
- **The action-conditional rules live once**, in `reconcileActionIssue()` in `/lib/schemas/sync.ts`. `reconcileSchema`'s `superRefine` calls it for the route; `resolveReconciliation` calls it for MCP, because `toolShape()` spreads a schema's `.shape` and drops object-level refinements (always pass the original schema to the guard — see Sharing a Zod Schema With a Tool in [guides/mcp-server.md](mcp-server.md)). Two call sites, one implementation — the action list is already kept in step by hand in four places and must not become five.

## Environment Variables
| Variable | Purpose |
| -------- | ------- |
| `PLAID_CLIENT_ID` | Plaid API client ID |
| `PLAID_SECRET` | Plaid API secret |
| `PLAID_ENV` | Plaid environment — `sandbox` or `production`. Any other value is rejected |
| `CRON_SECRET` | Shared secret for cron endpoint auth (also used by recurring cron) |

## Key Classes and Functions
- `syncToken(db, bookId, tokenId)` — Main sync entry point, returns `SyncTokenResult` with counts of added/modified/removed/auto-matched. Serialised per token by `withAdvisoryLock`, so the cron and a manual click cannot fetch the same Plaid pages twice; the loser gets `SyncTokenError` 409 rather than waiting. The whole sync therefore runs on a reserved connection — see Database Connection in [guides/architecture.md](architecture.md)
- `SyncTokenError` — Error class with HTTP status (404 token not found, 400 invalid config)
- `autoMatchPendingTransactions(db, bookId, linkIds)` — Returns count of successful auto-matches
- `buildPayeeMap(db, bookId)` — Builds the learned payee map from historical matches
- `isPlaidConfigured()` — Checks if all three Plaid env vars are set
