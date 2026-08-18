import { NextResponse } from "next/server";
import { authenticateBookRequest, isError } from "@/lib/api-auth";
import { securities, securityPrices } from "@/db/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import { getPositions } from "@/lib/investments";
import { toDateString } from "@/lib/formatters";

function lastWeekdayOnOrBefore(date: Date): string {
  const d = new Date(date);
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() - 1);
  }
  return toDateString(d);
}

/**
 * Manually-priced securities (fetchPrices = false, no fixed price) with an
 * open position and no price for the last market day. Drives the navbar price
 * entry pill.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ bookId: string }> }
) {
  try {
    const { bookId } = await params;
    const auth = await authenticateBookRequest(bookId);
    if (isError(auth)) return auth.error;
    const { db, bookId: numericBookId } = auth;

    // Fixed-price securities carry their price on their own row and are never
    // prompted for, so they are not part of the manually-priced population at
    // all — this is what excludes them, not the staleness check further down.
    const manual = await db
      .select({ id: securities.id })
      .from(securities)
      .where(
        and(
          eq(securities.bookId, numericBookId),
          eq(securities.fetchPrices, false),
          isNull(securities.fixedPriceMicros)
        )
      );

    if (manual.length === 0) {
      return NextResponse.json({ dueDate: null, securities: [] });
    }

    // The newest price across auto-fetched securities is the last market day
    // (the price-sync cron keeps them current, including around holidays).
    // Books without fetchable prices fall back to the last calendar weekday.
    const [latest] = await db
      .select({ maxDate: sql<string | null>`max(${securityPrices.priceDate})` })
      .from(securityPrices)
      .innerJoin(securities, eq(securityPrices.securityId, securities.id))
      .where(
        and(eq(securities.bookId, numericBookId), eq(securities.fetchPrices, true))
      );
    const dueDate = latest?.maxDate ?? lastWeekdayOnOrBefore(new Date());

    const manualIds = new Set(manual.map((s) => s.id));
    const positions = await getPositions(db, numericBookId);
    const due = positions
      .filter(
        (p) =>
          manualIds.has(p.securityId) &&
          p.sharesMicros > 0 &&
          (p.priceDate === null || p.priceDate < dueDate)
      )
      .map((p) => ({
        securityId: p.securityId,
        name: p.securityName,
        symbol: p.securitySymbol,
        lastPriceMicros: p.priceMicros,
        lastPriceDate: p.priceDate,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return NextResponse.json({ dueDate, securities: due });
  } catch (error) {
    console.error("Error fetching prices due:", error);
    return NextResponse.json(
      { error: "Failed to fetch securities needing prices" },
      { status: 500 }
    );
  }
}
