/**
 * Persistence for the FIFO lot engine.
 *
 * `rebuildLots` is the only code that INSERTS rows into investment_lots or
 * investment_lot_allocations at runtime. Everything that can change a pair's
 * split history calls it, inside the same DB transaction as the write. It is
 * not the only thing that ever writes those tables, in two other ways:
 *
 * - The Moneydance importer's superseded Pass 1/2 (scripts/import-moneydance/
 *   parsers/investment-transactions.ts) still insert investment_lots directly
 *   while building the initial import — never investment_lot_allocations —
 *   and those direct writes are overwritten by a `rebuildLots` pass run later
 *   in the same import, after stock splits are imported (see
 *   scripts/import-moneydance/index.ts).
 * - Rows disappear via FK cascade wherever a transaction, investment split,
 *   or lot is deleted, without going through this file at all: deleting a
 *   transaction cascades to its investment splits and their lot allocations
 *   (the transaction DELETE route, tests/helpers/db-utils.ts teardown);
 *   deleting a lot cascades to its allocations (scripts/import-moneydance/
 *   overwrite.ts, which deletes investment_lots directly and never touches
 *   investment_lot_allocations itself).
 *
 * This comment has been wrong before — grepping TypeScript for insert/update/
 * delete cannot see a cascade declared in the DDL (db/schema.ts's
 * `onDelete: "cascade"`), so "only writer" claims here need to be checked
 * against the schema, not just against other .ts files.
 */

import { type AppDb } from "@/db";
import {
  investmentLots,
  investmentLotAllocations,
  investmentSplits,
  transactions,
} from "@/db/schema";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { effectiveDateSql } from "@/lib/accounting";
import { replayLots, type ReplaySplit } from "@/lib/lots";

export type LotPair = { accountId: number; securityId: number };

export async function rebuildLots(
  tx: AppDb,
  bookId: number,
  accountId: number,
  securityId: number
): Promise<void> {
  // Serialize concurrent rebuilds of the same pair. The SELECT below captures
  // the data that drives the INSERTs at the bottom of this function, but the
  // DELETE further down is the only row-level lock this function otherwise
  // takes — and by then the SELECT has already read its snapshot. Locking only
  // at the DELETE would leave that read unprotected: two concurrent rebuilds of
  // the same existing pair could each read before the other's DELETE commits,
  // then both try to insert lots derived from a stale view. (For a pair with no
  // existing lots yet, the DELETE matches zero rows and takes no lock at all,
  // so without this, concurrent first-writes to a brand-new pair wouldn't
  // serialize either.) accountId and securityId are both globally unique
  // serials, so the pair alone identifies the lot pair — bookId adds nothing
  // and pg_advisory_xact_lock only takes two int4 keys anyway.
  //
  // This only serializes when rebuildLots runs inside an explicit
  // db.transaction(...): pg_advisory_xact_lock is released automatically at
  // commit or rollback, so a caller that passes the top-level `db` (rather
  // than a `tx`) acquires and releases the lock within its own
  // implicit single-statement transaction, providing no protection across
  // calls. Every write path that calls rebuildLots passes a real `tx` (see the
  // module comment above), so this holds in production; don't assume it holds
  // for a caller that doesn't.
  await tx.execute(sql`select pg_advisory_xact_lock(${accountId}, ${securityId})`);

  // Stock-split rows carry accountId = null and apply to every account holding
  // the security, so they must be pulled in alongside this account's own rows.
  const rows: ReplaySplit[] = await tx
    .select({
      investmentSplitId: investmentSplits.id,
      transactionId: investmentSplits.transactionId,
      action: investmentSplits.action,
      sharesMicros: investmentSplits.sharesMicros,
      priceMicros: investmentSplits.priceMicros,
      feesCents: investmentSplits.feesCents,
      splitNumerator: investmentSplits.splitNumerator,
      splitDenominator: investmentSplits.splitDenominator,
      transactionDate: effectiveDateSql.as("transaction_date"),
    })
    .from(investmentSplits)
    .innerJoin(transactions, eq(transactions.id, investmentSplits.transactionId))
    .where(
      and(
        eq(investmentSplits.bookId, bookId),
        eq(investmentSplits.securityId, securityId),
        or(
          eq(investmentSplits.accountId, accountId),
          and(isNull(investmentSplits.accountId), eq(investmentSplits.action, "split"))
        )
      )
    )
    .orderBy(effectiveDateSql, transactions.id, investmentSplits.id);

  // Allocations cascade from lots, so deleting lots clears both.
  await tx
    .delete(investmentLots)
    .where(
      and(
        eq(investmentLots.bookId, bookId),
        eq(investmentLots.accountId, accountId),
        eq(investmentLots.securityId, securityId)
      )
    );

  const result = replayLots(rows);
  if (result.lots.length === 0) return;

  // lot.acquiredDate is the buy row's effectiveDateSql (see the `transactionDate`
  // column in the SELECT above), materialized here as a fixed value at rebuild
  // time. For a floating buy, the true effective date keeps advancing to today
  // until it's reconciled, but this persisted acquiredDate does not — it stays
  // at whatever "today" was on the last rebuild, drifting stale and biasing
  // term classification toward long-term (and skewing FIFO order relative to
  // fixed-date trades) until the pair is next written and rebuildLots runs
  // again. See CLAUDE.md's Lot Tracking section.
  const inserted = await tx
    .insert(investmentLots)
    .values(
      result.lots.map((lot) => ({
        bookId,
        accountId,
        securityId,
        acquiredDate: lot.acquiredDate,
        openedSplitId: lot.openedSplitId,
        openedTransactionId: lot.openedTransactionId,
        closedTransactionId: lot.closedTransactionId,
        originalSharesMicros: lot.originalSharesMicros,
        originalBasisCents: lot.originalBasisCents,
        remainingSharesMicros: lot.remainingSharesMicros,
        remainingBasisCents: lot.remainingBasisCents,
      }))
    )
    .returning({ id: investmentLots.id, openedSplitId: investmentLots.openedSplitId });

  if (result.allocations.length === 0) return;

  // Map by openedSplitId (unique per lot — one buy split opens one lot) rather
  // than by RETURNING row order, so the mapping does not depend on insert order.
  const idByOpenedSplit = new Map(inserted.map((row) => [row.openedSplitId, row.id]));
  const idByKey = new Map(
    result.lots.map((lot) => [lot.lotKey, idByOpenedSplit.get(lot.openedSplitId)])
  );

  await tx.insert(investmentLotAllocations).values(
    result.allocations.map((allocation) => {
      const lotId = idByKey.get(allocation.lotKey);
      if (lotId === undefined) {
        throw new Error(
          `rebuildLots: no persisted lot for key ${allocation.lotKey} ` +
            `(book ${bookId}, account ${accountId}, security ${securityId})`
        );
      }
      return {
        bookId,
        lotId,
        sellSplitId: allocation.sellSplitId,
        transactionId: allocation.transactionId,
        sharesMicros: allocation.sharesMicros,
        basisCents: allocation.basisCents,
        proceedsCents: allocation.proceedsCents,
      };
    })
  );
}

export async function rebuildLotsForPairs(
  tx: AppDb,
  bookId: number,
  pairs: LotPair[]
): Promise<void> {
  // `seen` is a round-trip optimization, not a correctness guard: rebuildLots
  // deletes a pair's lots before recomputing and reinserting them, so calling
  // it twice for the same pair is already idempotent. Skipping repeats here
  // just avoids redundant DELETE/SELECT/INSERT cycles when callers (e.g. a
  // transaction edit) pass overlapping prior/current pairs.
  const seen = new Set<string>();
  const deduped: LotPair[] = [];
  for (const pair of pairs) {
    const key = `${pair.accountId}:${pair.securityId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(pair);
  }

  // Sort into a canonical order before acquiring any advisory locks. Two
  // concurrent callers with overlapping pair lists (e.g. two transaction
  // edits touching the same security in different accounts) would otherwise
  // acquire pg_advisory_xact_lock in whatever order their own pair list
  // happened to be in, and opposite orders between two callers is a classic
  // AB-BA deadlock: Postgres detects it and aborts one caller's transaction
  // with 40P01, which surfaces as a 500. Sorting by (accountId, securityId)
  // guarantees every caller locks pairs in the same order, so lock
  // acquisition can only ever queue, never cycle.
  deduped.sort((a, b) => a.accountId - b.accountId || a.securityId - b.securityId);

  for (const pair of deduped) {
    await rebuildLots(tx, bookId, pair.accountId, pair.securityId);
  }
}

/**
 * Every (account, security) pair with at least one buy or sell in the book.
 * Stock-split rows are excluded — their accountId is null, and they only ever
 * modify pairs that some buy already established.
 */
export async function findAllLotPairs(db: AppDb, bookId: number): Promise<LotPair[]> {
  return findPairsWhere(db, bookId, undefined);
}

/**
 * Every pair a single transaction's investment splits could affect.
 *
 * Stock-split rows carry accountId = null and restate every account holding the
 * security, so they fan out to all of them — derived from investment SPLITS,
 * not from existing lots, so this is correct even before any lot exists.
 */
export async function collectAffectedPairs(
  tx: AppDb,
  bookId: number,
  transactionId: number
): Promise<LotPair[]> {
  const rows = await tx
    .select({
      accountId: investmentSplits.accountId,
      securityId: investmentSplits.securityId,
      action: investmentSplits.action,
    })
    .from(investmentSplits)
    .where(
      and(eq(investmentSplits.bookId, bookId), eq(investmentSplits.transactionId, transactionId))
    );

  const pairs: LotPair[] = [];
  for (const row of rows) {
    if (row.action === "split") {
      const holders = await findPairsWhere(tx, bookId, row.securityId);
      pairs.push(...holders);
    } else if (row.accountId !== null) {
      pairs.push({ accountId: row.accountId, securityId: row.securityId });
    }
  }
  return pairs;
}

async function findPairsWhere(
  db: AppDb,
  bookId: number,
  securityId: number | undefined
): Promise<LotPair[]> {
  const rows = await db
    .selectDistinct({
      accountId: investmentSplits.accountId,
      securityId: investmentSplits.securityId,
    })
    .from(investmentSplits)
    .where(
      and(
        eq(investmentSplits.bookId, bookId),
        sql`${investmentSplits.action} in ('buy', 'sell')`,
        sql`${investmentSplits.accountId} is not null`,
        securityId === undefined ? undefined : eq(investmentSplits.securityId, securityId)
      )
    )
    .orderBy(investmentSplits.accountId, investmentSplits.securityId);

  return rows
    .filter((row): row is { accountId: number; securityId: number } => row.accountId !== null)
    .map((row) => ({ accountId: row.accountId, securityId: row.securityId }));
}
