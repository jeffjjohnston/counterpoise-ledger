import { getInvestmentGrossAmountCents } from "@/lib/accounting";

const calculateAverageCostReduction = (
  currentSharesMicros: number,
  currentCostBasisCents: number,
  sharesSoldMicros: number
) => {
  if (currentSharesMicros <= 0 || currentCostBasisCents <= 0) {
    return 0;
  }

  const proportionalReduction = Math.round(
    (currentCostBasisCents * sharesSoldMicros) / currentSharesMicros
  );

  return Math.min(proportionalReduction, currentCostBasisCents);
};

export type InvestmentSplitRow = {
  securityId: number;
  sharesMicros: number;
  priceMicros: number;
  feesCents: number;
  action: "buy" | "sell" | "dividend" | "capGain" | "fee" | "split";
  splitNumerator?: number | null;
  splitDenominator?: number | null;
  transactionDate: string;
};

export type SecurityRow = {
  id: number;
  name: string;
  symbol: string;
};

export type SecurityPriceRow = {
  securityId: number;
  priceMicros: number;
  priceDate: string;
};

export type PositionSummary = {
  securityId: number;
  securityName: string;
  securitySymbol: string;
  sharesMicros: number;
  costBasisCents: number;
  priceMicros: number | null;
  priceDate: string | null;
  marketValueCents: number | null;
};

/**
 * Kept as a named export because market value and lot proceeds read better
 * under this name, but it is the same computation as the split builders use —
 * see getInvestmentGrossAmountCents for why it is exact rather than a double.
 */
export const calculateValueCents = getInvestmentGrossAmountCents;

export function aggregatePositions(input: {
  splits: InvestmentSplitRow[];
  securities: SecurityRow[];
  prices: SecurityPriceRow[];
}): PositionSummary[] {
  const securityMap = new Map(input.securities.map((row) => [row.id, row]));
  const latestPriceMap = new Map<
    number,
    { priceMicros: number; priceDate: string }
  >();

  for (const row of input.prices) {
    const existing = latestPriceMap.get(row.securityId);
    if (!existing || row.priceDate > existing.priceDate) {
      latestPriceMap.set(row.securityId, {
        priceMicros: row.priceMicros,
        priceDate: row.priceDate,
      });
    }
  }

  const positionMap = new Map<number, { sharesMicros: number; costBasisCents: number }>();
  const orderedSplits = input.splits
    .map((split, index) => ({ split, index }))
    .sort((a, b) => {
      const dateCompare = a.split.transactionDate.localeCompare(b.split.transactionDate);
      return dateCompare !== 0 ? dateCompare : a.index - b.index;
    })
    .map(({ split }) => split);

  for (const split of orderedSplits) {
    const current = positionMap.get(split.securityId) ?? {
      sharesMicros: 0,
      costBasisCents: 0,
    };

    if (split.action === "split") {
      const ratio =
        split.splitNumerator && split.splitDenominator
          ? split.splitNumerator / split.splitDenominator
          : null;
      if (ratio) {
        positionMap.set(split.securityId, {
          sharesMicros: Math.round(current.sharesMicros * ratio),
          costBasisCents: current.costBasisCents,
        });
      } else {
        positionMap.set(split.securityId, current);
      }
      continue;
    }

    if (split.action !== "buy" && split.action !== "sell") {
      continue;
    }

    const isSell = split.action === "sell";
    const sharesDelta = isSell ? -split.sharesMicros : split.sharesMicros;
    const tradeValueCents = calculateValueCents(split.sharesMicros, split.priceMicros);
    const costDelta = isSell
      ? -calculateAverageCostReduction(
          current.sharesMicros,
          current.costBasisCents,
          split.sharesMicros
        )
      : tradeValueCents + split.feesCents;

    positionMap.set(split.securityId, {
      sharesMicros: current.sharesMicros + sharesDelta,
      costBasisCents: current.costBasisCents + costDelta,
    });
  }

  const positions: PositionSummary[] = [];

  for (const [securityId, totals] of positionMap) {
    const security = securityMap.get(securityId);
    if (!security) {
      continue;
    }

    // Skip positions with 0 or negative shares
    // (e.g., fully sold, expired options, or orphaned sells)
    if (totals.sharesMicros <= 0) {
      continue;
    }

    const latestPrice = latestPriceMap.get(securityId) ?? null;
    const marketValueCents =
      latestPrice && totals.sharesMicros !== 0
        ? calculateValueCents(totals.sharesMicros, latestPrice.priceMicros)
        : null;

    positions.push({
      securityId,
      securityName: security.name,
      securitySymbol: security.symbol,
      sharesMicros: totals.sharesMicros,
      costBasisCents: totals.costBasisCents,
      priceMicros: latestPrice?.priceMicros ?? null,
      priceDate: latestPrice?.priceDate ?? null,
      marketValueCents,
    });
  }

  return positions.sort((a, b) => a.securityName.localeCompare(b.securityName));
}


export type AccountMarketValue = {
  accountId: number;
  marketValueCents: number;
};

export type AccountSplitRow = InvestmentSplitRow & { accountId: number | null };

/**
 * Pure function: computes total market value per investment account from
 * pre-fetched splits and prices. Single sort, single pass over splits.
 */
export function aggregateMarketValuesByAccount(input: {
  splits: AccountSplitRow[];
  prices: SecurityPriceRow[];
}): AccountMarketValue[] {
  // Build latest-price lookup (single O(n) pass)
  const latestPrices = new Map<number, number>();
  const latestDates = new Map<number, string>();
  for (const row of input.prices) {
    const existingDate = latestDates.get(row.securityId);
    if (!existingDate || row.priceDate > existingDate) {
      latestPrices.set(row.securityId, row.priceMicros);
      latestDates.set(row.securityId, row.priceDate);
    }
  }

  // Sort all splits once by date (stable by original index for ties)
  const orderedSplits = input.splits
    .map((split, index) => ({ split, index }))
    .sort((a, b) => {
      const d = a.split.transactionDate.localeCompare(b.split.transactionDate);
      return d !== 0 ? d : a.index - b.index;
    });

  // Collect all account IDs and track global splits
  const accountIds = new Set<number>();
  const globalSplitIndices: number[] = [];
  for (let i = 0; i < orderedSplits.length; i++) {
    const { split } = orderedSplits[i];
    if (split.accountId === null) {
      globalSplitIndices.push(i);
    } else {
      accountIds.add(split.accountId);
    }
  }

  // Single pass: aggregate positions per (accountId, securityId)
  // Key: `${accountId}:${securityId}` → sharesMicros
  const positions = new Map<string, number>();

  const applyToAccount = (
    accountId: number,
    split: AccountSplitRow
  ) => {
    const key = `${accountId}:${split.securityId}`;
    const current = positions.get(key) ?? 0;

    if (split.action === "split") {
      const ratio =
        split.splitNumerator && split.splitDenominator
          ? split.splitNumerator / split.splitDenominator
          : null;
      if (ratio) {
        positions.set(key, Math.round(current * ratio));
      }
      return;
    }

    if (split.action !== "buy" && split.action !== "sell") return;

    const sign = split.action === "sell" ? -1 : 1;
    positions.set(key, current + sign * split.sharesMicros);
  };

  for (const { split } of orderedSplits) {
    if (split.accountId === null) {
      // Global split (e.g., stock split) applies to all accounts
      for (const accountId of accountIds) {
        applyToAccount(accountId, split);
      }
    } else {
      applyToAccount(split.accountId, split);
    }
  }

  // Sum market values per account
  const totals = new Map<number, number>();
  for (const [key, sharesMicros] of positions) {
    if (sharesMicros <= 0) continue;
    const [accountStr, securityStr] = key.split(":");
    const accountId = Number(accountStr);
    const securityId = Number(securityStr);
    const priceMicros = latestPrices.get(securityId);
    if (priceMicros === undefined) continue;
    const current = totals.get(accountId) ?? 0;
    totals.set(accountId, current + calculateValueCents(sharesMicros, priceMicros));
  }

  const results: AccountMarketValue[] = [];
  for (const [accountId, marketValueCents] of totals) {
    results.push({ accountId, marketValueCents });
  }
  return results.sort((a, b) => a.accountId - b.accountId);
}
