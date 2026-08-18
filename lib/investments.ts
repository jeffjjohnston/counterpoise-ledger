import { type AppDb } from "@/db";
import {
  investmentLots,
  investmentSplits,
  securities,
  securityPrices,
  transactions,
} from "@/db/schema";
import { and, desc, eq, gt, or, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { effectiveDateSql, getInvestmentGrossAmountCents } from "@/lib/accounting";
import { toDateString } from "@/lib/formatters";

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

/**
 * The price row a fixed-price security is valued at.
 *
 * Dated today so it wins every "newest price" comparison against leftover
 * recorded prices, and so nothing downstream reads the position as stale. The
 * price itself never moves, so the date carries no information beyond that.
 */
export function fixedPriceRow(
  securityId: number,
  fixedPriceMicros: number
): SecurityPriceRow {
  return {
    securityId,
    priceMicros: fixedPriceMicros,
    priceDate: toDateString(new Date()),
  };
}

/**
 * The newest price row per security in a book — one row each, not the whole
 * price history.
 *
 * `security_prices` grows by roughly 250 rows per security per year and every
 * consumer only ever wants the latest, so loading the table and reducing it in
 * JS costs more every year for an answer of fixed size.
 *
 * A lateral `ORDER BY price_date DESC LIMIT 1` per security is the form that
 * actually stays flat as history grows, and it needs no new index: the
 * correlated lookup is a backward scan of the existing
 * `(security_id, price_date)` primary key, one row per security. Measured on a
 * production-sized table (28,812 rows, 193 securities):
 *
 *   load every row       1.7ms, 306 buffers, 28,812 rows returned
 *   DISTINCT ON         17.3ms, 287 buffers      — no index leads with book_id,
 *                                                  so it seq-scans then sorts
 *   lateral (this)       0.6ms, 581 buffers, 193 rows returned
 *
 * DISTINCT ON is the obvious rewrite and the slowest of the three; it is
 * recorded here because it is what the review recommended and what a reader
 * would otherwise try next.
 *
 * Securities with no prices produce no row, exactly as they previously produced
 * no entry in the callers' latest-price maps.
 *
 * `aggregatePositions` and `aggregateMarketValuesByAccount` still fold the rows
 * into a latest-per-security map, which is now a no-op over pre-collapsed
 * input. That is deliberate: both are pure functions tested directly with
 * multi-row price histories, and neither should depend on its caller having
 * done the collapsing.
 */
export async function getLatestPrices(
  db: AppDb,
  bookId: number
): Promise<SecurityPriceRow[]> {
  const latest = db
    .select({
      priceMicros: securityPrices.priceMicros,
      priceDate: securityPrices.priceDate,
    })
    .from(securityPrices)
    .where(
      and(
        eq(securityPrices.securityId, securities.id),
        eq(securityPrices.bookId, bookId)
      )
    )
    .orderBy(desc(securityPrices.priceDate))
    .limit(1)
    .as("latest");

  const [recorded, fixed] = await Promise.all([
    db
      .select({
        securityId: securities.id,
        priceMicros: latest.priceMicros,
        priceDate: latest.priceDate,
      })
      .from(securities)
      .crossJoinLateral(latest)
      .where(eq(securities.bookId, bookId)),
    db
      .select({
        securityId: securities.id,
        fixedPriceMicros: securities.fixedPriceMicros,
      })
      .from(securities)
      .where(
        and(eq(securities.bookId, bookId), isNotNull(securities.fixedPriceMicros))
      ),
  ]);

  if (fixed.length === 0) {
    return recorded;
  }

  // A fixed-price security carries its price on its own row, so it may have no
  // recorded prices at all — and any it does have (from before it was marked
  // fixed) must not value the position. Replace rather than merge.
  const fixedIds = new Set(fixed.map((row) => row.securityId));
  return [
    ...recorded.filter((row) => !fixedIds.has(row.securityId)),
    ...fixed.map((row) => fixedPriceRow(row.securityId, row.fixedPriceMicros!)),
  ];
}

export async function getPositions(db: AppDb, bookId: number, accountId?: number): Promise<PositionSummary[]> {
  const splitQuery = accountId
    ? db
        .select({
          securityId: investmentSplits.securityId,
          sharesMicros: investmentSplits.sharesMicros,
          priceMicros: investmentSplits.priceMicros,
          feesCents: investmentSplits.feesCents,
          action: investmentSplits.action,
          splitNumerator: investmentSplits.splitNumerator,
          splitDenominator: investmentSplits.splitDenominator,
          transactionDate: effectiveDateSql.as("transaction_date"),
        })
        .from(investmentSplits)
        .innerJoin(transactions, eq(transactions.id, investmentSplits.transactionId))
        .where(
          and(
            eq(investmentSplits.bookId, bookId),
            // Include splits for this account OR stock splits (which have null accountId and apply to all accounts)
            or(
              eq(investmentSplits.accountId, accountId),
              and(isNull(investmentSplits.accountId), eq(investmentSplits.action, "split"))
            )
          )
        )
        .orderBy(effectiveDateSql, transactions.id, investmentSplits.id)
    : db
        .select({
          securityId: investmentSplits.securityId,
          sharesMicros: investmentSplits.sharesMicros,
          priceMicros: investmentSplits.priceMicros,
          feesCents: investmentSplits.feesCents,
          action: investmentSplits.action,
          splitNumerator: investmentSplits.splitNumerator,
          splitDenominator: investmentSplits.splitDenominator,
          transactionDate: effectiveDateSql.as("transaction_date"),
        })
        .from(investmentSplits)
        .innerJoin(transactions, eq(transactions.id, investmentSplits.transactionId))
        .where(eq(investmentSplits.bookId, bookId))
        .orderBy(effectiveDateSql, transactions.id, investmentSplits.id);

  const [splitRows, securityRows, priceRows] = await Promise.all([
    splitQuery,
    db
      .select({ id: securities.id, name: securities.name, symbol: securities.symbol })
      .from(securities)
      .where(eq(securities.bookId, bookId)),
    getLatestPrices(db, bookId),
  ]);

  const positions = aggregatePositions({
    splits: splitRows,
    securities: securityRows,
    prices: priceRows,
  });

  // Cost basis comes from actual FIFO lots. Shares keep coming from the split
  // replay above, which already handles stock splits — the redundancy is what
  // lets tests assert the two agree.
  const lotBasisRows = await db
    .select({
      securityId: investmentLots.securityId,
      basisCents: sql<number>`cast(coalesce(sum(${investmentLots.remainingBasisCents}), 0) as integer)`,
    })
    .from(investmentLots)
    .where(
      accountId
        ? and(
            eq(investmentLots.bookId, bookId),
            eq(investmentLots.accountId, accountId),
            gt(investmentLots.remainingSharesMicros, 0)
          )
        : and(eq(investmentLots.bookId, bookId), gt(investmentLots.remainingSharesMicros, 0))
    )
    .groupBy(investmentLots.securityId);

  const basisBySecurity = new Map(lotBasisRows.map((row) => [row.securityId, row.basisCents]));

  // A position with replayed shares but no lot-basis row silently reports $0
  // cost basis (100% unrealized gain) instead of an error. `npm run db:migrate`
  // chains the lot backfill (scripts/rebuild-lots.ts) after schema migrations,
  // same as docker-entrypoint.sh, so the realistic trigger is a book that
  // bypassed both — e.g. ran `db/migrate.ts` directly — rather than one that
  // simply followed the documented migration path. Warn once per call, not
  // once per position, so a book with many affected positions doesn't flood
  // the log.
  const missingBasisCount = positions.filter(
    (position) => position.sharesMicros > 0 && !basisBySecurity.has(position.securityId)
  ).length;
  if (missingBasisCount > 0) {
    console.warn(
      `getPositions: ${missingBasisCount} position(s) in book ${bookId} have shares but no lot-basis row ` +
        `(reporting $0 cost basis). Run \`npm run db:rebuild-lots\` to backfill investment_lots.`
    );
  }

  return positions.map((position) => ({
    ...position,
    costBasisCents: basisBySecurity.get(position.securityId) ?? 0,
  }));
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

/**
 * Returns total market value for each investment account.
 * Fetches data from DB and delegates to the pure aggregateMarketValuesByAccount.
 */
export async function getMarketValuesByAccount(db: AppDb, bookId: number, asOfDate?: string): Promise<AccountMarketValue[]> {
  const baseQuery = db
    .select({
      accountId: investmentSplits.accountId,
      securityId: investmentSplits.securityId,
      sharesMicros: investmentSplits.sharesMicros,
      priceMicros: investmentSplits.priceMicros,
      feesCents: investmentSplits.feesCents,
      action: investmentSplits.action,
      splitNumerator: investmentSplits.splitNumerator,
      splitDenominator: investmentSplits.splitDenominator,
      transactionDate: effectiveDateSql.as("transaction_date"),
    })
    .from(investmentSplits)
    .innerJoin(transactions, eq(transactions.id, investmentSplits.transactionId))
    .orderBy(effectiveDateSql, transactions.id, investmentSplits.id);

  const [splitRows, priceRows] = await Promise.all([
    asOfDate
      ? baseQuery.where(and(eq(investmentSplits.bookId, bookId), lte(effectiveDateSql, asOfDate)))
      : baseQuery.where(eq(investmentSplits.bookId, bookId)),
    // Deliberately NOT filtered by asOfDate, which preserves existing
    // behaviour rather than endorsing it: an as-of-date market value currently
    // combines that date's share counts with today's prices. Changing it moves
    // reported numbers, so it is called out separately rather than folded into
    // a performance change.
    getLatestPrices(db, bookId),
  ]);

  return aggregateMarketValuesByAccount({ splits: splitRows, prices: priceRows });
}
