# Investment Transaction Handling

One of the guides [CLAUDE.md](../CLAUDE.md) points to. Read that file first;
it carries the rules that apply everywhere and says when to come here.

## Creating Investment Transactions
Use builder functions from `lib/accounting.ts`:
```typescript
// Buy 100 shares at $50.00 with $10 fee
const splits = buildBuySplits({
  securityAccountId: 5,
  cashAccountId: 6,
  feeAccountId: 7,
  sharesMicros: 100_000_000,  // 100 shares
  priceMicros: 50_000_000,    // $50.00
  feesCents: 1000,            // $10.00
});
```

## Investment Split Validation
Before creating investment transactions, validate:
1. Investment account exists and is active
2. Security exists
3. Shares and prices are positive and finite
4. For sells: lot matching will be applied (FIFO)

## Lot Tracking

Lots and allocations are **derived state**, not something any write path is
meant to populate directly. The lot rebuild is the only code that **inserts**
rows into `investment_lots` or `investment_lot_allocations`. It exists twice:

- **Rust**: `rebuild_lots()` in `rust-api/db/src/lots.rs` (the `ledger-db`
  crate). Every write path runs it: the transaction routes, the Moneydance
  importer, the seed, and `ledger-cli rebuild-lots`.
- **TypeScript**: `rebuildLots()` in `/lib/lots-db.ts`. Only the backfill
  script (`/scripts/rebuild-lots.ts`) runs it, from `npm run db:migrate`. The
  Docker entrypoint runs the Rust backfill, `ledger-cli rebuild-lots`.

`tests/http/rebuild-lots.test.ts` holds the two to the same rows (see below).

The rebuild is not the only thing that writes those tables. One other path
touches them:
- Rows disappear via FK cascade (`onDelete: "cascade"` in `/db/schema.ts`)
  wherever a transaction, investment split, or lot is deleted, without going
  through the rebuild at all: deleting a transaction cascades to its
  investment splits and their lot allocations (the transaction DELETE route,
  `tests/helpers/db-utils.ts` test teardown); deleting a lot cascades to its
  allocations (`overwrite_book()` in `rust-api/cli/src/import_moneydance/mod.rs`,
  which deletes `investment_lots` directly and never touches
  `investment_lot_allocations` itself). Grepping the code for
  `insert`/`update`/`delete` cannot see a cascade declared in the DDL — check
  the schema, not only the call sites.

Aside from that path, the rebuild is the sole writer. It deletes and
regenerates one (account, security) pair by replaying that pair's investment
splits through the pure `replay_lots()` engine in `rust-api/core/src/lots.rs`
(`replayLots()` in `/lib/lots.ts` for the TypeScript backfill).

The Rust transaction routes (`rust-api/server/src/routes/transactions.rs`) run
the rebuild inside the same database transaction as the write itself:
`collect_affected_pairs()` then `rebuild_lots_for_pairs()` on create, update
(for both the prior and current pairs, since an edit can move a split to a
different security or account), and delete.

**The importer and the seed are the exceptions.** Both write splits first and
rebuild afterwards, per pair, in their own transactions — the importer in
phase 6.5, after stock splits are in. A rebuild that fails there leaves the
splits it was rebuilding from already committed. Recompute-over-increment is deliberate: transactions are freely
backdated, so an incremental engine has no cheap way to answer which existing
allocations a newly inserted earlier buy invalidates — recomputing the whole
pair from its splits sidesteps that question entirely.


The rebuild takes `pg_advisory_xact_lock(accountId, securityId)` as its
*first* statement, before it even runs the SELECT that reads the pair's
splits. The lock has to come first because the rows it inserts are computed
from that read — locking only at the later DELETE would leave the read itself
unprotected, letting two concurrent rebuilds of the same pair each read a
stale view and then both write from it. This locking only works when the
rebuild runs inside an explicit database transaction: the advisory lock is
released at commit or rollback, so a caller that runs it outside one acquires
and releases it within its own implicit single-statement transaction and gets
no protection across calls. Every production caller passes a connection
inside a transaction.

The deploy-time backfill (`ledger-cli rebuild-lots`, run by
`docker-entrypoint.sh` after migrations, guarded — see the Critical Files
Reference table in [guides/library-reference.md](library-reference.md); its
TypeScript copy `/scripts/rebuild-lots.ts` works the same way) does every book
and pair inside **one transaction**, not one per pair. That's what makes its
"allocations already exist" guard trustworthy: with per-pair commits, a crash
partway through followed by the next run (the container's
`restart: unless-stopped`, or the next deploy) would let the guard see partial
progress as "already populated" and silently skip the
remaining pairs — serving zero cost basis for them while reporting success. A
failure stops the container before the server starts. This is on purpose, because the alternative is
serving that zero cost basis with no visible error. Note that this only
catches a rebuild that *fails*. A rebuild that succeeds and is wrong — say
from a bug in the replay engine — starts up cleanly and serves incorrect cost
basis and realized gains with no error anywhere, which no automated signal
here can distinguish from a correct one.

Short positions (sell-to-open) are **not** modeled — the `action` enum has no
open/close discriminator, `lib/investments.ts` skips positions with
`sharesMicros <= 0` in two places, and short-lot economics invert the normal
basis/proceeds relationship. Adding them is not a matter of relaxing that
filter: the enum, the lot matching and the gain calculation each need a
direction before any of it means anything.

**Floating transactions drift, latently.** The rebuild materializes the
effective date (`effectiveDateSql`) into `investment_lots.acquiredDate` at rebuild time — a
snapshot, not a live value. A **floating** transaction's effective date
advances to today every day until it's reconciled, but a floating buy's
persisted `acquiredDate` freezes at whatever "today" was on the last rebuild
and does not follow it. Left open, the lot looks older than it actually is
(biasing term classification toward long-term) and its FIFO ordering can drift
relative to fixed-date trades. The drift is latent until an installation
actually holds a floating investment transaction, and a ledger with none is
unaffected. The pair self-heals on any write that triggers the rebuild for
it — there is nothing to migrate ahead of time.

The Moneydance importer writes investment splits only; lots and allocations come
from the rebuild alone.

### The two lot rebuilds

`rust-api/db/src/lots.rs` holds `rebuild_lots()`, `rebuild_lots_for_pairs()`,
`find_all_lot_pairs()`, `collect_affected_pairs()`, and `backfill_lots()`.
`/lib/lots-db.ts` holds the TypeScript copies (`rebuildLots()`,
`rebuildLotsForPairs()`, `findAllLotPairs()`, `collectAffectedPairs()`) that
the deploy-time backfill runs. The rules above apply to both: the advisory
lock is the first statement, the caller passes a connection inside a
transaction, and the backfill is one transaction for every book. The Rust
rebuild evaluates the effective date with `CURRENT_DATE` in the session time
zone, as `effectiveDateSql` does.

`ledger-cli rebuild-lots [--force]` runs the backfill with the guard and
messages of `scripts/rebuild-lots.ts`, and exits 1 on failure. The `migrate`
job's entrypoint still runs the TypeScript script. An update collects the pairs
before and after it replaces the splits, because a replaced account or
security still needs a rebuild.

`tests/http/rebuild-lots.test.ts` seeds and imports through `ledger-cli`, adds
edge cases, runs both backfills, and requires identical rows. A change to one
engine must change the other. Run the same
comparison on a production-shaped copy before a change to either engine
ships.

The Rust routes that read lots — positions, account values, security detail,
security lots, and realized gains — keep two JavaScript details. The security
detail route values a position with a floating-point product, not the exact
micros product. The realized-gain term adds one year with `setUTCFullYear`, so
a lot bought on 29 February reaches one year on 1 March.

- **`tests/fixtures/moneydance-sample.json` is the control for importer lot
  changes.** Compare `investment_lots` and `investment_lot_allocations` before
  and after the change. The fixture holds a 2-for-1 split between the buys and
  the sell, so the rebuild must apply the corporate action to get the sell's
  basis correct.
- **Dropping the `lotId` column (migration 0020) shipped alone.** Adding the lots tables was backward
  compatible, so that release could be rolled back from. This one cannot:
  Drizzle's relational `with: { investmentSplits: … }` selects every column, so
  the previous image's SQL still names `lot_id` on every transaction read and
  would 500 against the new schema — the same trap
  [guides/release-and-deploy.md](release-and-deploy.md) records for the
  session-hash migration. Nothing else went in the release.
