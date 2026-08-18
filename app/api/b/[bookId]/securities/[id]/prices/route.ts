import { NextResponse } from "next/server";
import { sql, and, eq, desc } from "drizzle-orm";
import { authenticateBookRequest, isError } from "@/lib/api-auth";
import { securities, securityPrices } from "@/db/schema";
import { securityPriceListQuery } from "@/lib/schemas/securities";

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
    const parsedQuery = securityPriceListQuery.safeParse({
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

    const [priceRows, countRows] = await Promise.all([
      db
        .select({
          priceDate: securityPrices.priceDate,
          priceMicros: securityPrices.priceMicros,
          source: securityPrices.source,
        })
        .from(securityPrices)
        .where(and(eq(securityPrices.securityId, securityId), eq(securityPrices.bookId, numericBookId)))
        .orderBy(desc(securityPrices.priceDate))
        .limit(limit)
        .offset(offset),
      db
        .select({
          count: sql<number>`cast(count(*) as integer)`.as("count"),
        })
        .from(securityPrices)
        .where(and(eq(securityPrices.securityId, securityId), eq(securityPrices.bookId, numericBookId))),
    ]);

    const totalCount = countRows[0]?.count ?? 0;
    const hasMore = offset + priceRows.length < totalCount;

    return NextResponse.json({
      prices: priceRows,
      totalCount,
      hasMore,
    });
  } catch (error) {
    console.error("Error fetching security price history:", error);
    return NextResponse.json(
      { error: "Failed to fetch security price history" },
      { status: 500 }
    );
  }
}
