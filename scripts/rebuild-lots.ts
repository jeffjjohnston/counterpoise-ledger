/**
 * Regenerates investment lots and allocations from investment splits.
 *
 * Runs automatically from docker-entrypoint.sh after schema migrations, and
 * is chained into `npm run db:migrate` (see package.json) for local/bare-metal
 * use. It guards itself: it no-ops if allocations already exist, or if there
 * are no buys AND no sells to replay (nothing for the engine to do either
 * way) — not merely "no sells", since a book with only open buys and no
 * allocations yet still needs lots created. Pass --force to rebuild
 * regardless.
 *
 * A failure here aborts container startup by design. Migration A empties the
 * lots table, so a silent failure would serve zero cost basis on every
 * position with nothing to indicate anything was wrong.
 */

import { getDb, type AppDb } from "@/db";
import { books, investmentLotAllocations, investmentSplits } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import { findAllLotPairs, rebuildLots } from "@/lib/lots-db";

export type BackfillResult = {
  booksProcessed: number;
  pairsRebuilt: number;
  skipped: boolean;
};

export async function backfillLots(
  db: AppDb,
  options: { force?: boolean } = {}
): Promise<BackfillResult> {
  if (!options.force) {
    const [{ count: allocationCount }] = await db
      .select({ count: sql<number>`cast(count(*) as integer)` })
      .from(investmentLotAllocations);

    if (allocationCount > 0) {
      return { booksProcessed: 0, pairsRebuilt: 0, skipped: true };
    }

    const [{ count: sellCount }] = await db
      .select({ count: sql<number>`cast(count(*) as integer)` })
      .from(investmentSplits)
      .where(eq(investmentSplits.action, "sell"));

    const [{ count: buyCount }] = await db
      .select({ count: sql<number>`cast(count(*) as integer)` })
      .from(investmentSplits)
      .where(eq(investmentSplits.action, "buy"));

    if (sellCount === 0 && buyCount === 0) {
      return { booksProcessed: 0, pairsRebuilt: 0, skipped: true };
    }
  }

  // The whole run is one transaction, not one per pair: pairs land
  // incrementally, so a per-pair transaction would let the guard above see
  // partial progress as "already populated" after a mid-run failure and
  // restart (docker-compose's `restart: unless-stopped` on `app` guarantees
  // one happens) — silently skipping the remaining pairs and serving zero
  // cost basis for them. Wrapping everything here makes the run
  // all-or-nothing: either every pair commits, so "allocations exist"
  // genuinely means "the backfill completed," or nothing commits and a
  // restart retries cleanly against an empty table. `pairsRebuilt` is only
  // assigned to the return value after `db.transaction` resolves, so a
  // rollback surfaces as a thrown error instead of a result with a stale
  // count — there is no path that returns a count that didn't fully commit.
  //
  // Holding every pair's advisory lock for the whole run is fine here: this
  // runs before the server starts, so there are no concurrent writers to
  // block.
  let booksProcessed = 0;
  let pairsRebuilt = 0;
  await db.transaction(async (tx) => {
    const bookRows = await tx.select({ id: books.id }).from(books).orderBy(books.id);
    booksProcessed = bookRows.length;

    for (const book of bookRows) {
      const pairs = await findAllLotPairs(tx, book.id);
      for (const pair of pairs) {
        await rebuildLots(tx, book.id, pair.accountId, pair.securityId);
        pairsRebuilt += 1;
      }
    }
  });

  return { booksProcessed, pairsRebuilt, skipped: false };
}

// Only run when invoked directly, so importing this module in tests is inert.
if (process.argv[1]?.includes("rebuild-lots")) {
  const force = process.argv.includes("--force");
  backfillLots(getDb(), { force })
    .then((result) => {
      if (result.skipped) {
        console.log("Lot rebuild: already populated, skipping.");
      } else {
        console.log(
          `Lot rebuild: ${result.pairsRebuilt} pair(s) across ${result.booksProcessed} book(s).`
        );
      }
      process.exit(0);
    })
    .catch((error) => {
      console.error("Lot rebuild FAILED:", error);
      process.exit(1);
    });
}
