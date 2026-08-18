import { NextResponse } from "next/server";
import { sql, and, eq, desc, inArray } from "drizzle-orm";
import { authenticateBookRequest, isError } from "@/lib/api-auth";
import { securities, investmentSplits, transactions, accounts, transactionSplits } from "@/db/schema";
import { effectiveDateSql } from "@/lib/accounting";
import { securitySplitListQuery } from "@/lib/schemas/securities";

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

    const { searchParams } = new URL(request.url);
    const parsedQuery = securitySplitListQuery.safeParse({
      limit: searchParams.get("limit") || undefined,
      offset: searchParams.get("offset") || undefined,
    });
    if (!parsedQuery.success) {
      return NextResponse.json(
        { error: parsedQuery.error.issues[0].message },
        { status: 400 }
      );
    }
    const { limit, offset } = parsedQuery.data;

    const [splitRows, countRows] = await Promise.all([
      db
        .select({
          id: investmentSplits.id,
          transactionId: investmentSplits.transactionId,
          transactionDate: effectiveDateSql.as("transaction_date"),
          transactionDescription: transactions.description,
          accountId: investmentSplits.accountId,
          accountName: accounts.name,
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
        .orderBy(desc(effectiveDateSql), desc(investmentSplits.id))
        .limit(limit)
        .offset(offset),
      db
        .select({
          count: sql<number>`cast(count(*) as integer)`.as("count"),
        })
        .from(investmentSplits)
        .where(and(eq(investmentSplits.securityId, securityId), eq(investmentSplits.bookId, numericBookId))),
    ]);

    const totalCount = countRows[0]?.count ?? 0;
    const hasMore = offset + splitRows.length < totalCount;

    // For dividend and capGain transactions, fetch the cash amounts
    const dividendOrCapGainTransactionIds = splitRows
      .filter((s) => s.action === "dividend" || s.action === "capGain")
      .map((s) => s.transactionId);

    const cashAmountsMap = new Map<number, number>();

    if (dividendOrCapGainTransactionIds.length > 0) {
      const cashSplits = await db
        .select({
          transactionId: transactionSplits.transactionId,
          accountId: transactionSplits.accountId,
          amount: transactionSplits.amount,
        })
        .from(transactionSplits)
        .innerJoin(accounts, eq(accounts.id, transactionSplits.accountId))
        .where(
          inArray(transactionSplits.transactionId, dividendOrCapGainTransactionIds)
        );

      // Group by transaction and find the cash amount (positive amount for asset accounts)
      const transactionAmounts = new Map<number, number[]>();
      for (const split of cashSplits) {
        if (!transactionAmounts.has(split.transactionId)) {
          transactionAmounts.set(split.transactionId, []);
        }
        transactionAmounts.get(split.transactionId)!.push(split.amount);
      }

      // For each transaction, the cash amount is the positive amount (debit to cash)
      for (const [transactionId, amounts] of transactionAmounts) {
        const cashAmount = amounts.find((amt) => amt > 0) ?? 0;
        cashAmountsMap.set(transactionId, cashAmount);
      }
    }

    const splits = splitRows.map((split) => ({
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
      cashAmountCents:
        split.action === "dividend" || split.action === "capGain"
          ? cashAmountsMap.get(split.transactionId) ?? 0
          : undefined,
    }));

    return NextResponse.json({
      splits,
      totalCount,
      hasMore,
    });
  } catch (error) {
    console.error("Error fetching security splits:", error);
    return NextResponse.json(
      { error: "Failed to fetch security splits" },
      { status: 500 }
    );
  }
}
