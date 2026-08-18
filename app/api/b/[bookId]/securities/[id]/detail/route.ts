import { NextResponse } from "next/server";
import { authenticateBookRequest, isError } from "@/lib/api-auth";
import { fixedPriceRow } from "@/lib/investments";
import { accounts, investmentLots, investmentSplits, securities, securityPrices, transactions } from "@/db/schema";
import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import { effectiveDateSql } from "@/lib/accounting";

const MICROS_PER_UNIT = 1_000_000;

const calculateValueCents = (sharesMicros: number, priceMicros: number) =>
  Math.round(
    (sharesMicros / MICROS_PER_UNIT) *
      (priceMicros / MICROS_PER_UNIT) *
      100
  );

type PositionState = {
  accountId: number;
  accountName: string;
  isActive: boolean;
  sharesMicros: number;
};

export async function GET(
  request: Request,
  { params }: { params: Promise<{ bookId: string; id: string }> }
) {
  try {
    const { bookId, id } = await params;
    const auth = await authenticateBookRequest(bookId);
    if (isError(auth)) return auth.error;
    const { db, bookId: numericBookId } = auth;

    const securityId = Number.parseInt(id, 10);

    if (Number.isNaN(securityId)) {
      return NextResponse.json({ error: "Invalid security id" }, { status: 400 });
    }

    const security = await db.query.securities.findFirst({
      where: and(eq(securities.id, securityId), eq(securities.bookId, numericBookId)),
    });

    if (!security) {
      return NextResponse.json({ error: "Security not found" }, { status: 404 });
    }

    const [latestPriceRows, splitRows, lotBasisRows] = await Promise.all([
      db
        .select({
          priceMicros: securityPrices.priceMicros,
          priceDate: securityPrices.priceDate,
        })
        .from(securityPrices)
        .where(and(eq(securityPrices.securityId, securityId), eq(securityPrices.bookId, numericBookId)))
        .orderBy(desc(securityPrices.priceDate))
        .limit(1),
      db
        .select({
          id: investmentSplits.id,
          transactionId: investmentSplits.transactionId,
          transactionDate: effectiveDateSql.as("transaction_date"),
          transactionDescription: transactions.description,
          accountId: investmentSplits.accountId,
          accountName: accounts.name,
          accountIsActive: accounts.isActive,
          action: investmentSplits.action,
          sharesMicros: investmentSplits.sharesMicros,
          priceMicros: investmentSplits.priceMicros,
          feesCents: investmentSplits.feesCents,
          splitNumerator: investmentSplits.splitNumerator,
          splitDenominator: investmentSplits.splitDenominator,
        })
        .from(investmentSplits)
        .innerJoin(transactions, eq(transactions.id, investmentSplits.transactionId))
        .leftJoin(accounts, eq(accounts.id, investmentSplits.accountId))
        .where(and(eq(investmentSplits.securityId, securityId), eq(investmentSplits.bookId, numericBookId)))
        .orderBy(asc(effectiveDateSql), asc(investmentSplits.id)),
      // Cost basis comes from actual FIFO lots (the same source of truth
      // getPositions reads), grouped per account rather than per security —
      // this route shows one row per account holding this security. A direct
      // grouped query here (rather than N getPositions(db, bookId, accountId)
      // calls, one per account) avoids each call redundantly re-fetching
      // every security and price row in the book just to answer for one.
      db
        .select({
          accountId: investmentLots.accountId,
          basisCents: sql<number>`cast(coalesce(sum(${investmentLots.remainingBasisCents}), 0) as integer)`,
        })
        .from(investmentLots)
        .where(
          and(
            eq(investmentLots.bookId, numericBookId),
            eq(investmentLots.securityId, securityId),
            gt(investmentLots.remainingSharesMicros, 0)
          )
        )
        .groupBy(investmentLots.accountId),
    ]);

    // A fixed price supersedes anything in security_prices — including rows
    // recorded before the security was marked fixed-price. Same rule
    // getLatestPrices applies for every other consumer.
    const latestPrice =
      security.fixedPriceMicros !== null
        ? fixedPriceRow(security.id, security.fixedPriceMicros)
        : latestPriceRows[0] ?? null;
    const basisByAccount = new Map(lotBasisRows.map((row) => [row.accountId, row.basisCents]));
    const positionsByAccount = new Map<number, PositionState>();

    for (const split of splitRows) {
      if (split.action === "split") {
        const ratio =
          split.splitNumerator && split.splitDenominator
            ? split.splitNumerator / split.splitDenominator
            : null;

        if (!ratio) {
          continue;
        }

        if (split.accountId === null) {
          for (const [accountId, current] of positionsByAccount.entries()) {
            positionsByAccount.set(accountId, {
              ...current,
              sharesMicros: Math.round(current.sharesMicros * ratio),
            });
          }
          continue;
        }

        const current = positionsByAccount.get(split.accountId) ?? {
          accountId: split.accountId,
          accountName: split.accountName ?? `Account ${split.accountId}`,
          isActive: split.accountIsActive ?? true,
          sharesMicros: 0,
        };

        positionsByAccount.set(split.accountId, {
          ...current,
          sharesMicros: Math.round(current.sharesMicros * ratio),
        });
        continue;
      }

      if (split.accountId === null) {
        continue;
      }

      if (split.action !== "buy" && split.action !== "sell") {
        continue;
      }

      const current = positionsByAccount.get(split.accountId) ?? {
        accountId: split.accountId,
        accountName: split.accountName ?? `Account ${split.accountId}`,
        isActive: split.accountIsActive ?? true,
        sharesMicros: 0,
      };

      const isSell = split.action === "sell";
      const sharesDelta = isSell ? -split.sharesMicros : split.sharesMicros;

      positionsByAccount.set(split.accountId, {
        ...current,
        sharesMicros: current.sharesMicros + sharesDelta,
      });
    }

    const positionRows = [...positionsByAccount.values()]
      .filter((position) => position.sharesMicros > 0)
      .map((position) => ({
        ...position,
        costBasisCents: basisByAccount.get(position.accountId) ?? 0,
        marketValueCents:
          latestPrice !== null
            ? calculateValueCents(position.sharesMicros, latestPrice.priceMicros)
            : null,
      }))
      .sort((a, b) => a.accountName.localeCompare(b.accountName));

    const splits = splitRows
      .slice()
      .sort((a, b) => {
        const dateCompare = b.transactionDate.localeCompare(a.transactionDate);
        return dateCompare !== 0 ? dateCompare : b.id - a.id;
      })
      .map((split) => ({
        id: split.id,
        transactionId: split.transactionId,
        transactionDate: split.transactionDate,
        transactionDescription: split.transactionDescription,
        accountId: split.accountId,
        accountName:
          split.accountId === null
            ? "All Accounts"
            : split.accountName ?? `Account ${split.accountId}`,
        action: split.action,
        sharesMicros: split.sharesMicros,
        priceMicros: split.priceMicros,
        feesCents: split.feesCents,
        splitNumerator: split.splitNumerator,
        splitDenominator: split.splitDenominator,
      }));

    return NextResponse.json({
      security: {
        ...security,
        latestPriceMicros: latestPrice?.priceMicros ?? null,
        latestPriceDate: latestPrice?.priceDate ?? null,
      },
      positionsByAccount: positionRows,
      splits,
    });
  } catch (error) {
    console.error("Error fetching security detail:", error);
    return NextResponse.json(
      { error: "Failed to fetch security detail" },
      { status: 500 }
    );
  }
}
