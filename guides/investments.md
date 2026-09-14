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
meant to populate directly. `rebuildLots()` in `/lib/lots-db.ts` is the only
code that **inserts** rows into `investment_lots` or `investment_lot_allocations`
— but it is not the only thing that ever writes those tables, and an earlier
version of this section overstated that it was. One other path touches them:
- Rows disappear via FK cascade (`onDelete: "cascade"` in `/db/schema.ts`)
  wherever a transaction, investment split, or lot is deleted, without going
  through `rebuildLots` at all: deleting a transaction cascades to its
  investment splits and their lot allocations (the transaction DELETE route,
  `tests/helpers/db-utils.ts` test teardown); deleting a lot cascades to its
  allocations (`scripts/import-moneydance/overwrite.ts`, which deletes
  `investment_lots` directly and never touches `investment_lot_allocations`
  itself). Grepping TypeScript for `insert`/`update`/`delete` cannot see a
  cascade declared in the DDL, which is exactly how this claim ended up wrong
  more than once — check the schema, not just the call sites.

Aside from that path, `rebuildLots` is the sole writer. It deletes and
regenerates one (account, security) pair by replaying that pair's investment
splits through the pure `replayLots()` engine in `/lib/lots.ts`.

The transaction CRUD paths call `rebuildLots` inside the same DB transaction
as the write itself: `createTransaction`, `updateTransaction` (for both the
prior and current pairs, since an edit can move a split to a different
security or account), and the transaction DELETE route.

**The importer and the seed are the exceptions.** Both write splits first and
rebuild afterwards, per pair, in their own transactions — the importer in
phase 6.5, after stock splits are in. A rebuild that fails there leaves the
splits it was rebuilding from already committed. Recompute-over-increment is deliberate: transactions are freely
backdated, so an incremental engine has no cheap way to answer which existing
allocations a newly inserted earlier buy invalidates — recomputing the whole
pair from its splits sidesteps that question entirely.

`rebuildLots` takes `pg_advisory_xact_lock(accountId, securityId)` as its
*first* statement, before it even runs the SELECT that reads the pair's
splits. The lock has to come first because the rows it inserts are computed
from that read — locking only at the later DELETE would leave the read itself
unprotected, letting two concurrent rebuilds of the same pair each read a
stale view and then both write from it. This locking only works when
`rebuildLots` runs inside an explicit `db.transaction(...)`: the advisory lock
is released at commit or rollback, so a caller that passes the top-level `db`
instead of a `tx` acquires and releases it within its own implicit
single-statement transaction and gets no protection across calls. Every
production call site passes a real `tx`.

The deploy-time backfill (`/scripts/rebuild-lots.ts`, run by
`docker-entrypoint.sh` after migrations, guarded — see the Critical Files
Reference table in [guides/library-reference.md](library-reference.md)) does every book and pair inside **one transaction**, not one per
pair. That's what makes its "allocations already exist" guard trustworthy:
with per-pair commits, a crash partway through plus Docker's
`restart: unless-stopped` on the `app` service would let the guard see partial
progress as "already populated" on the next boot and silently skip the
remaining pairs — serving zero cost basis for them while reporting success. A
failure aborts container startup on purpose, because the alternative is
serving that zero cost basis with no visible error. Note that this only
catches a rebuild that *fails*. A rebuild that succeeds and is wrong — say
from a bug in `replayLots` — starts up cleanly and serves incorrect cost
basis and realized gains with no error anywhere, which no automated signal
here can distinguish from a correct one.

Short positions (sell-to-open) are **not** modeled — the `action` enum has no
open/close discriminator, `lib/investments.ts` skips positions with
`sharesMicros <= 0` in two places, and short-lot economics invert the normal
basis/proceeds relationship. Adding them is not a matter of relaxing that
filter: the enum, the lot matching and the gain calculation each need a
direction before any of it means anything.

**Floating transactions drift, latently.** `rebuildLots` materializes
`effectiveDateSql` into `investment_lots.acquiredDate` at rebuild time — a
snapshot, not a live value. A **floating** transaction's effective date
advances to today every day until it's reconciled, but a floating buy's
persisted `acquiredDate` freezes at whatever "today" was on the last rebuild
and does not follow it. Left open, the lot looks older than it actually is
(biasing term classification toward long-term) and its FIFO ordering can drift
relative to fixed-date trades. The drift is latent until an installation
actually holds a floating investment transaction, and a ledger with none is
unaffected. The pair self-heals on any write that triggers `rebuildLots` for
it — there is nothing to migrate ahead of time.

The Moneydance importer used to keep its own lot bookkeeping — Pass 1 created
buys and lots, Pass 2 matched sells to them FIFO and stamped
`investmentSplits.lotId`. Both were superseded by the Lot Rebuild phase and
have been deleted, along with the `lotId` column itself (migration 0020). The
importer now writes investment splits only; lots and allocations come from
`rebuildLots` alone.

Two things about that removal are worth keeping:

- **It was proven, not assumed.** Importing `tests/fixtures/moneydance-sample.json`
  before and after the deletion produced byte-identical `investment_lots` and
  `investment_lot_allocations`. That fixture is the right control because it
  holds a 2-for-1 split between the buys and the sell, so the rebuild has to
  apply the corporate action to get the sell's basis right. Pass 2's stamp did
  not even survive its own import run: the FK was `onDelete: "set null"`, so
  `rebuildLots` deleting Pass 1's lots nulled every value Pass 2 had written.
- **Dropping the column shipped alone.** Adding the lots tables was backward
  compatible, so that release could be rolled back from. This one cannot:
  Drizzle's relational `with: { investmentSplits: … }` selects every column, so
  the previous image's SQL still names `lot_id` on every transaction read and
  would 500 against the new schema — the same trap
  [guides/release-and-deploy.md](release-and-deploy.md) records for the
  session-hash migration. Nothing else went in the release.
