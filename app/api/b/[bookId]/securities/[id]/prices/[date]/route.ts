import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { authenticateBookRequest, isError } from "@/lib/api-auth";
import { securities, securityPrices } from "@/db/schema";
import { updateSecurityPriceSchema } from "@/lib/schemas/security-prices";

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ bookId: string; id: string; date: string }> }
) {
  try {
    const { bookId, id, date } = await params;
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

    const parsed = updateSecurityPriceSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
    }
    const { priceDate, priceMicros, source } = parsed.data;

    // Check if old price entry exists
    const oldPrice = await db.query.securityPrices.findFirst({
      where: and(
        eq(securityPrices.securityId, securityId),
        eq(securityPrices.priceDate, date)
      ),
    });

    if (!oldPrice) {
      return NextResponse.json({ error: "Price entry not found" }, { status: 404 });
    }

    // If the date changed, we need to delete the old entry and insert a new one
    // (since priceDate is part of the primary key)
    if (priceDate !== date) {
      await db.transaction(async (tx) => {
        // Delete old entry
        await tx
          .delete(securityPrices)
          .where(
            and(eq(securityPrices.securityId, securityId), eq(securityPrices.priceDate, date))
          );

        // Insert new entry
        await tx.insert(securityPrices).values({
          securityId,
          priceDate,
          priceMicros,
          source: source ?? null,
          bookId: numericBookId,
        });
      });
    } else {
      // Just update the existing entry
      await db
        .update(securityPrices)
        .set({
          priceMicros,
          source: source ?? null,
        })
        .where(
          and(eq(securityPrices.securityId, securityId), eq(securityPrices.priceDate, date))
        );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error updating security price:", error);
    return NextResponse.json({ error: "Failed to update security price" }, { status: 500 });
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ bookId: string; id: string; date: string }> }
) {
  try {
    const { bookId, id, date } = await params;
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

    // Check if price entry exists
    const priceEntry = await db.query.securityPrices.findFirst({
      where: and(
        eq(securityPrices.securityId, securityId),
        eq(securityPrices.priceDate, date)
      ),
    });

    if (!priceEntry) {
      return NextResponse.json({ error: "Price entry not found" }, { status: 404 });
    }

    await db
      .delete(securityPrices)
      .where(and(eq(securityPrices.securityId, securityId), eq(securityPrices.priceDate, date)));

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error deleting security price:", error);
    return NextResponse.json({ error: "Failed to delete security price" }, { status: 500 });
  }
}
