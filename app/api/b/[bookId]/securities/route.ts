import { NextResponse } from "next/server";
import { authenticateBookRequest, isError } from "@/lib/api-auth";
import { securities, investmentSplits, transactionSplits } from "@/db/schema";
import { asc, eq, inArray, and } from "drizzle-orm";
import { getPositions } from "@/lib/investments";
import {
  createSecurity,
  SecurityValidationError,
  SecurityDuplicateError,
} from "@/lib/securities";
import { createSecuritySchema } from "@/lib/schemas/securities";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ bookId: string }> }
) {
  try {
    const { bookId } = await params;
    const auth = await authenticateBookRequest(bookId);
    if (isError(auth)) return auth.error;
    const { db, bookId: numericBookId } = auth;

    // Fetch all securities
    const allSecurities = await db
      .select({
        id: securities.id,
        name: securities.name,
        symbol: securities.symbol,
        securityType: securities.securityType,
        fetchPrices: securities.fetchPrices,
        fixedPriceMicros: securities.fixedPriceMicros,
      })
      .from(securities)
      .where(eq(securities.bookId, numericBookId))
      .orderBy(asc(securities.name));

    // Calculate positions — shares/price/market value from the split replay,
    // cost basis from FIFO lots (the single source of truth also used by
    // getPositions's other callers: the transactions page and MCP tools).
    // Book-wide, so this intentionally includes inactive accounts' holdings —
    // matching getPositions's own behavior everywhere else it's called
    // unscoped, rather than special-casing this route to exclude them.
    const positions = await getPositions(db, numericBookId);

    // Create a map of securityId -> position data
    const positionMap = new Map(positions.map((p) => [p.securityId, p]));

    // Calculate income (dividends + capital gains) per security.
    // Book-wide, matching getPositions above — a security held only in an
    // archived account should show real income beside its real shares/basis,
    // not $0 income next to a nonzero position.
    // Fetch transaction splits for income transactions
    const allInvestmentSplitsWithTxId = await db
      .select({
        transactionId: investmentSplits.transactionId,
        securityId: investmentSplits.securityId,
        action: investmentSplits.action,
      })
      .from(investmentSplits)
      .where(
        and(
          eq(investmentSplits.bookId, numericBookId),
          inArray(
            investmentSplits.action,
            ["dividend", "capGain"] as const
          )
        )
      );

    const incomeTxIds = allInvestmentSplitsWithTxId.map((s) => s.transactionId);

    // Get transaction splits for these transactions
    const incomeTxSplits = incomeTxIds.length > 0
      ? await db
          .select({
            transactionId: transactionSplits.transactionId,
            amount: transactionSplits.amount,
          })
          .from(transactionSplits)
          .where(inArray(transactionSplits.transactionId, incomeTxIds))
      : [];

    // Map transaction splits back to securities and sum positive amounts (cash received)
    const incomeMap = new Map<number, number>();
    for (const invSplit of allInvestmentSplitsWithTxId) {
      const txSplitsForThisTx = incomeTxSplits.filter(
        (ts) => ts.transactionId === invSplit.transactionId
      );
      // Sum positive amounts (debits to cash accounts = income received)
      const incomeAmount = txSplitsForThisTx
        .filter((ts) => ts.amount > 0)
        .reduce((sum, ts) => sum + ts.amount, 0);

      const currentIncome = incomeMap.get(invSplit.securityId) ?? 0;
      incomeMap.set(invSplit.securityId, currentIncome + incomeAmount);
    }

    // Combine securities with their position data
    const securitiesWithPositions = allSecurities.map((security) => {
      const position = positionMap.get(security.id);
      return {
        ...security,
        sharesMicros: position?.sharesMicros ?? 0,
        costBasisCents: position?.costBasisCents ?? 0,
        priceMicros: position?.priceMicros ?? null,
        priceDate: position?.priceDate ?? null,
        marketValueCents: position?.marketValueCents ?? null,
        incomeCents: incomeMap.get(security.id) ?? 0,
      };
    });

    return NextResponse.json(securitiesWithPositions);
  } catch (error) {
    console.error("Error fetching securities:", error);
    return NextResponse.json(
      { error: "Failed to fetch securities" },
      { status: 500 }
    );
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ bookId: string }> }
) {
  try {
    const { bookId } = await params;
    const auth = await authenticateBookRequest(bookId);
    if (isError(auth)) return auth.error;
    const { db, bookId: numericBookId } = auth;

    const parsed = createSecuritySchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
    }

    try {
      const created = await createSecurity(db, numericBookId, parsed.data);
      return NextResponse.json(created);
    } catch (err) {
      if (err instanceof SecurityValidationError) {
        return NextResponse.json({ error: err.message }, { status: 400 });
      }
      if (err instanceof SecurityDuplicateError) {
        return NextResponse.json({ error: err.message }, { status: 409 });
      }
      throw err;
    }
  } catch (error) {
    console.error("Error creating security:", error);
    return NextResponse.json(
      { error: "Failed to create security" },
      { status: 500 }
    );
  }
}
