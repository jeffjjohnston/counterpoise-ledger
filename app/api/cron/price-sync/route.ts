import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { securities, securityPrices } from "@/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { fetchLatestTiingoPrices, isTiingoConfigured } from "@/lib/tiingo";
import { verifyCronSecret } from "@/lib/cron-auth";

const PRICE_SCALE = 1_000_000;

export async function GET(request: Request) {
  try {
    if (!verifyCronSecret(request)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (!isTiingoConfigured()) {
      return NextResponse.json({ success: true, skipped: true, reason: "Tiingo not configured" });
    }

    const db = getDb();

    // A fixed-price security has no feed to fetch — Tiingo does not quote a
    // money market fund's fixed NAV. Setting a fixed price already forces
    // fetchPrices off, so this filter only matters if the two ever disagree.
    const fetchable = await db
      .select()
      .from(securities)
      .where(
        and(eq(securities.fetchPrices, true), isNull(securities.fixedPriceMicros))
      );

    if (fetchable.length === 0) {
      return NextResponse.json({
        success: true,
        securitiesFound: 0,
        pricesInserted: 0,
        pricesSkipped: 0,
      });
    }

    // The same symbol can appear in multiple books; fetch it once
    const symbols = [...new Set(fetchable.map((s) => s.symbol.toUpperCase()))];
    const { prices, errors } = await fetchLatestTiingoPrices(symbols);
    const priceBySymbol = new Map(prices.map((p) => [p.symbol.toUpperCase(), p]));

    const rows = fetchable.flatMap((security) => {
      const latest = priceBySymbol.get(security.symbol.toUpperCase());
      if (!latest) return [];
      return [
        {
          securityId: security.id,
          bookId: security.bookId,
          priceDate: latest.date,
          priceMicros: Math.round(latest.price * PRICE_SCALE),
          source: "tiingo",
        },
      ];
    });

    // Never overwrite an existing price (e.g. a manual entry): conflicts on
    // the (securityId, priceDate) primary key are skipped. This also makes
    // the cron idempotent: after holidays Tiingo returns the previous market
    // day's close, whose date is already recorded.
    let pricesInserted = 0;
    if (rows.length > 0) {
      const inserted = await db
        .insert(securityPrices)
        .values(rows)
        .onConflictDoNothing({
          target: [securityPrices.securityId, securityPrices.priceDate],
        })
        .returning({ securityId: securityPrices.securityId });
      pricesInserted = inserted.length;
    }
    const pricesSkipped = rows.length - pricesInserted;

    return NextResponse.json({
      success: true,
      securitiesFound: fetchable.length,
      pricesInserted,
      pricesSkipped,
      ...(errors.length > 0 ? { errors } : {}),
    });
  } catch (error) {
    console.error("Error in price sync cron:", error);
    return NextResponse.json(
      { error: "Failed to run price sync cron" },
      { status: 500 }
    );
  }
}
