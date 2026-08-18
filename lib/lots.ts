/**
 * Pure FIFO lot engine.
 *
 * Given every buy/sell/stock-split investment split for ONE (account, security)
 * pair, produces the lots those buys opened and the allocations those sells
 * consumed. No database access — `lib/lots-db.ts` wraps this with persistence.
 *
 * Recompute-over-increment is deliberate: transactions in this app are freely
 * backdated and edited, so "which existing allocations does this new row
 * invalidate?" has no cheap answer. Replaying the pair sidesteps it.
 */

import { calculateValueCents } from "@/lib/investments";

export type ReplaySplit = {
  investmentSplitId: number;
  transactionId: number;
  action: "buy" | "sell" | "dividend" | "capGain" | "fee" | "split";
  sharesMicros: number;
  priceMicros: number;
  feesCents: number;
  splitNumerator: number | null;
  splitDenominator: number | null;
  /** Effective date (floating transactions resolve to today), YYYY-MM-DD. */
  transactionDate: string;
};

export type ReplayLot = {
  /** Stable index within this replay; maps to a real row id on persist. */
  lotKey: number;
  openedSplitId: number;
  openedTransactionId: number;
  acquiredDate: string;
  originalSharesMicros: number;
  originalBasisCents: number;
  remainingSharesMicros: number;
  remainingBasisCents: number;
  closedTransactionId: number | null;
};

export type ReplayAllocation = {
  lotKey: number;
  sellSplitId: number;
  transactionId: number;
  sharesMicros: number;
  basisCents: number;
  proceedsCents: number;
};

export type ReplayResult = {
  lots: ReplayLot[];
  allocations: ReplayAllocation[];
  /** Sell shares with no lot to draw from. Basis is unknown, not zero. */
  unallocated: Array<{ sellSplitId: number; sharesMicros: number }>;
};

function orderSplits(splits: ReplaySplit[]): ReplaySplit[] {
  return [...splits].sort((a, b) => {
    const byDate = a.transactionDate.localeCompare(b.transactionDate);
    if (byDate !== 0) return byDate;
    if (a.transactionId !== b.transactionId) return a.transactionId - b.transactionId;
    return a.investmentSplitId - b.investmentSplitId;
  });
}

export function replayLots(splits: ReplaySplit[]): ReplayResult {
  const lots: ReplayLot[] = [];
  const allocations: ReplayAllocation[] = [];
  const unallocated: ReplayResult["unallocated"] = [];

  for (const split of orderSplits(splits)) {
    if (split.action === "buy") {
      if (split.sharesMicros <= 0) continue;
      const basis = calculateValueCents(split.sharesMicros, split.priceMicros) + split.feesCents;
      lots.push({
        lotKey: lots.length,
        openedSplitId: split.investmentSplitId,
        openedTransactionId: split.transactionId,
        acquiredDate: split.transactionDate,
        originalSharesMicros: split.sharesMicros,
        originalBasisCents: basis,
        remainingSharesMicros: split.sharesMicros,
        remainingBasisCents: basis,
        closedTransactionId: null,
      });
      continue;
    }

    if (split.action === "split") {
      const ratio =
        split.splitNumerator && split.splitDenominator
          ? split.splitNumerator / split.splitDenominator
          : null;
      if (!ratio) continue;

      // Only OPEN lots are restated. A lot closed before the split was disposed
      // of at its pre-split share count, and that disposal is already reported.
      for (const lot of lots) {
        if (lot.remainingSharesMicros <= 0) continue;
        lot.originalSharesMicros = Math.round(lot.originalSharesMicros * ratio);
        lot.remainingSharesMicros = Math.round(lot.remainingSharesMicros * ratio);
      }
      continue;
    }

    if (split.action !== "sell" || split.sharesMicros <= 0) continue;

    const totalShares = split.sharesMicros;
    const netProceeds =
      calculateValueCents(split.sharesMicros, split.priceMicros) - split.feesCents;

    let needed = totalShares;
    let allocatedShares = 0;
    let allocatedProceeds = 0;

    // `lots` is in acquisition order by construction, so array order IS FIFO.
    for (const lot of lots) {
      if (needed <= 0) break;
      if (lot.remainingSharesMicros <= 0) continue;

      const taken = Math.min(lot.remainingSharesMicros, needed);

      // Closing the lot relieves exactly what is left, so no cent is stranded.
      const basisCents =
        taken === lot.remainingSharesMicros
          ? lot.remainingBasisCents
          : Math.round((lot.remainingBasisCents * taken) / lot.remainingSharesMicros);

      // Cumulative apportionment: each share of proceeds is assigned once, so
      // the parts sum to netProceeds exactly once every share is allocated.
      allocatedShares += taken;
      const proceedsSoFar = Math.round((netProceeds * allocatedShares) / totalShares);
      const proceedsCents = proceedsSoFar - allocatedProceeds;
      allocatedProceeds = proceedsSoFar;

      allocations.push({
        lotKey: lot.lotKey,
        sellSplitId: split.investmentSplitId,
        transactionId: split.transactionId,
        sharesMicros: taken,
        basisCents,
        proceedsCents,
      });

      lot.remainingSharesMicros -= taken;
      lot.remainingBasisCents -= basisCents;
      needed -= taken;

      if (lot.remainingSharesMicros === 0) {
        lot.closedTransactionId = split.transactionId;
      }
    }

    if (needed > 0) {
      unallocated.push({ sellSplitId: split.investmentSplitId, sharesMicros: needed });
    }
  }

  return { lots, allocations, unallocated };
}
