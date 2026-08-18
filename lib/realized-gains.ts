/**
 * Realized gain/loss from lot allocations.
 *
 * One row per allocation: a sell that spanned three lots produces three rows,
 * which is what a 1099-B looks like. Unallocated sell shares (no lot to draw
 * from) produce a separate `term: "unknown"` row with null basis, deliberately
 * excluded from the short/long totals so a data gap cannot move a reported gain.
 */

import { type AppDb } from "@/db";
import {
  accounts,
  investmentLotAllocations,
  investmentLots,
  investmentSplits,
  securities,
  transactions,
} from "@/db/schema";
import { and, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import { effectiveDateSql } from "@/lib/accounting";
import { calculateValueCents } from "@/lib/investments";

export type RealizedGainTerm = "short" | "long" | "unknown";

export type RealizedGainRow = {
  sellDate: string;
  transactionId: number;
  securityId: number;
  securitySymbol: string;
  securityName: string;
  accountId: number;
  accountName: string;
  sharesMicros: number;
  acquiredDate: string | null;
  proceedsCents: number;
  basisCents: number | null;
  gainCents: number | null;
  term: RealizedGainTerm;
};

export type RealizedGainsResult = {
  rows: RealizedGainRow[];
  totals: {
    shortTermGainCents: number;
    longTermGainCents: number;
    proceedsCents: number;
    basisCents: number;
    unknownBasisRows: number;
  };
};

export type RealizedGainsOptions = {
  startDate?: string;
  endDate?: string;
  accountId?: number;
};

/** True when the holding period exceeds one year (IRS long-term threshold). */
function isLongTerm(acquiredDate: string, sellDate: string): boolean {
  const acquired = new Date(`${acquiredDate}T00:00:00Z`);
  const sold = new Date(`${sellDate}T00:00:00Z`);
  const oneYearLater = new Date(acquired);
  oneYearLater.setUTCFullYear(oneYearLater.getUTCFullYear() + 1);
  return sold.getTime() > oneYearLater.getTime();
}

export async function getRealizedGains(
  db: AppDb,
  bookId: number,
  options: RealizedGainsOptions
): Promise<RealizedGainsResult> {
  const filters: SQL[] = [eq(investmentLotAllocations.bookId, bookId)];
  if (options.startDate) filters.push(gte(effectiveDateSql, options.startDate));
  if (options.endDate) filters.push(lte(effectiveDateSql, options.endDate));
  if (options.accountId !== undefined) filters.push(eq(investmentLots.accountId, options.accountId));

  const allocationRows = await db
    .select({
      sellDate: effectiveDateSql.as("sell_date"),
      transactionId: investmentLotAllocations.transactionId,
      securityId: investmentLots.securityId,
      securitySymbol: securities.symbol,
      securityName: securities.name,
      accountId: investmentLots.accountId,
      accountName: accounts.name,
      sharesMicros: investmentLotAllocations.sharesMicros,
      acquiredDate: investmentLots.acquiredDate,
      proceedsCents: investmentLotAllocations.proceedsCents,
      basisCents: investmentLotAllocations.basisCents,
    })
    .from(investmentLotAllocations)
    .innerJoin(investmentLots, eq(investmentLots.id, investmentLotAllocations.lotId))
    .innerJoin(transactions, eq(transactions.id, investmentLotAllocations.transactionId))
    .innerJoin(securities, eq(securities.id, investmentLots.securityId))
    .innerJoin(accounts, eq(accounts.id, investmentLots.accountId))
    .where(and(...filters))
    .orderBy(effectiveDateSql, investmentLotAllocations.id);

  const rows: RealizedGainRow[] = allocationRows.map((row) => ({
    sellDate: row.sellDate,
    transactionId: row.transactionId,
    securityId: row.securityId,
    securitySymbol: row.securitySymbol,
    securityName: row.securityName,
    accountId: row.accountId,
    accountName: row.accountName,
    sharesMicros: row.sharesMicros,
    acquiredDate: row.acquiredDate,
    proceedsCents: row.proceedsCents,
    basisCents: row.basisCents,
    gainCents: row.proceedsCents - row.basisCents,
    term: isLongTerm(row.acquiredDate, row.sellDate) ? "long" : "short",
  }));

  rows.push(...(await findUnallocatedRows(db, bookId, options)));
  rows.sort((a, b) => a.sellDate.localeCompare(b.sellDate));

  const totals = rows.reduce(
    (acc, row) => {
      if (row.term === "unknown" || row.basisCents === null || row.gainCents === null) {
        acc.unknownBasisRows += 1;
        return acc;
      }
      acc.proceedsCents += row.proceedsCents;
      acc.basisCents += row.basisCents;
      if (row.term === "long") acc.longTermGainCents += row.gainCents;
      else acc.shortTermGainCents += row.gainCents;
      return acc;
    },
    {
      shortTermGainCents: 0,
      longTermGainCents: 0,
      proceedsCents: 0,
      basisCents: 0,
      unknownBasisRows: 0,
    }
  );

  return { rows, totals };
}

/**
 * Sell shares no lot could satisfy. Surfaced rather than hidden, because a
 * silently dropped disposal understates a reported gain.
 */
async function findUnallocatedRows(
  db: AppDb,
  bookId: number,
  options: RealizedGainsOptions
): Promise<RealizedGainRow[]> {
  const filters: SQL[] = [
    eq(investmentSplits.bookId, bookId),
    eq(investmentSplits.action, "sell"),
  ];
  if (options.startDate) filters.push(gte(effectiveDateSql, options.startDate));
  if (options.endDate) filters.push(lte(effectiveDateSql, options.endDate));
  if (options.accountId !== undefined) filters.push(eq(investmentSplits.accountId, options.accountId));

  const sellRows = await db
    .select({
      sellSplitId: investmentSplits.id,
      sellDate: effectiveDateSql.as("sell_date"),
      transactionId: investmentSplits.transactionId,
      securityId: investmentSplits.securityId,
      securitySymbol: securities.symbol,
      securityName: securities.name,
      accountId: investmentSplits.accountId,
      accountName: accounts.name,
      sharesMicros: investmentSplits.sharesMicros,
      priceMicros: investmentSplits.priceMicros,
      feesCents: investmentSplits.feesCents,
      allocatedMicros: sql<number>`cast(coalesce((
        select sum(a.shares_micros) from investment_lot_allocations a
        where a.sell_split_id = ${investmentSplits.id}
      ), 0) as bigint)`,
      allocatedProceedsCents: sql<number>`cast(coalesce((
        select sum(a.proceeds_cents) from investment_lot_allocations a
        where a.sell_split_id = ${investmentSplits.id}
      ), 0) as bigint)`,
    })
    .from(investmentSplits)
    .innerJoin(transactions, eq(transactions.id, investmentSplits.transactionId))
    .innerJoin(securities, eq(securities.id, investmentSplits.securityId))
    .innerJoin(accounts, eq(accounts.id, investmentSplits.accountId))
    .where(and(...filters));

  const rows: RealizedGainRow[] = [];
  for (const row of sellRows) {
    const unallocated = row.sharesMicros - Number(row.allocatedMicros);
    if (unallocated <= 0) continue;
    if (row.accountId === null) continue;

    // Derived as a remainder, not an independent apportionment: the sell's net
    // proceeds (calculateValueCents minus fees, same formula lib/lots.ts uses
    // for netProceeds) minus the proceeds actually recorded on this sell's
    // allocation rows. That sum is exact by construction — allocated and
    // unallocated proceeds are complementary shares of the same netProceeds
    // figure, so they always reconstruct it exactly, however unevenly the
    // shares or fee happen to divide. Recomputing gross value for the
    // unallocated shares and separately rounding an apportioned fee slice (the
    // old approach) rounds twice independently and can miss by a cent.
    const netProceedsCents = calculateValueCents(row.sharesMicros, row.priceMicros) - row.feesCents;
    const unallocatedProceedsCents = netProceedsCents - Number(row.allocatedProceedsCents);

    rows.push({
      sellDate: row.sellDate,
      transactionId: row.transactionId,
      securityId: row.securityId,
      securitySymbol: row.securitySymbol,
      securityName: row.securityName,
      accountId: row.accountId,
      accountName: row.accountName,
      sharesMicros: unallocated,
      acquiredDate: null,
      proceedsCents: unallocatedProceedsCents,
      basisCents: null,
      gainCents: null,
      term: "unknown",
    });
  }

  return rows;
}
