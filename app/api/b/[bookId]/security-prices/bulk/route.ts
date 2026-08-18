import { NextResponse } from "next/server";
import { authenticateBookRequest, isError } from "@/lib/api-auth";
import { securities, securityPrices } from "@/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { bulkPricesSchema } from "@/lib/schemas/security-prices";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ bookId: string }> }
) {
  try {
    const { bookId } = await params;
    const auth = await authenticateBookRequest(bookId);
    if (isError(auth)) return auth.error;
    const { db, bookId: numericBookId } = auth;

    const parsed = bulkPricesSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
    }
    const validUpdates = parsed.data.priceUpdates;

    // Validate all securityIds belong to this book
    const securityIds = [...new Set(validUpdates.map((u) => u.securityId))];
    const ownedSecurities = await db
      .select({ id: securities.id })
      .from(securities)
      .where(and(eq(securities.bookId, numericBookId), inArray(securities.id, securityIds)));

    if (ownedSecurities.length !== securityIds.length) {
      return NextResponse.json(
        { error: "One or more securities do not belong to this book" },
        { status: 400 }
      );
    }

    // Batch insert/update prices
    for (const update of validUpdates) {
      const { securityId, priceMicros, priceDate } = update;

      // Check if price already exists for this date
      const [existing] = await db
        .select()
        .from(securityPrices)
        .where(
          and(
            eq(securityPrices.bookId, numericBookId),
            eq(securityPrices.securityId, securityId),
            eq(securityPrices.priceDate, priceDate)
          )
        );

      if (existing) {
        // Update existing price
        await db.update(securityPrices)
          .set({ priceMicros })
          .where(
            and(
              eq(securityPrices.bookId, numericBookId),
              eq(securityPrices.securityId, securityId),
              eq(securityPrices.priceDate, priceDate)
            )
          );
      } else {
        // Insert new price
        await db.insert(securityPrices)
          .values({
            securityId,
            priceDate,
            priceMicros,
            source: "manual",
            bookId: numericBookId,
          });
      }
    }

    return NextResponse.json({
      message: `Successfully updated ${validUpdates.length} price(s)`,
      count: validUpdates.length,
    });
  } catch (error) {
    console.error("Error updating security prices:", error);
    return NextResponse.json(
      { error: "Failed to update security prices" },
      { status: 500 }
    );
  }
}
