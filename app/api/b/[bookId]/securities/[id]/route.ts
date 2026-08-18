import { NextResponse } from "next/server";
import { authenticateBookRequest, isError } from "@/lib/api-auth";
import { investmentSplits, securities } from "@/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { updateSecuritySchema } from "@/lib/schemas/securities";

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

    return NextResponse.json(security);
  } catch (error) {
    console.error("Error fetching security:", error);
    return NextResponse.json(
      { error: "Failed to fetch security" },
      { status: 500 }
    );
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ bookId: string; id: string }> }
) {
  try {
    const { bookId, id } = await params;
    const auth = await authenticateBookRequest(bookId);
    if (isError(auth)) return auth.error;
    const { db, bookId: numericBookId } = auth;

    const securityId = Number.parseInt(id, 10);
    // request.json() is awaited unconditionally here, before the id check,
    // to match the original control flow exactly (it parsed the body first
    // too) — reordering would change which error a malformed body plus an
    // invalid id produces.
    const rawBody = await request.json();

    if (Number.isNaN(securityId)) {
      return NextResponse.json({ error: "Invalid security id" }, { status: 400 });
    }

    const parsed = updateSecuritySchema.safeParse(rawBody);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
    }
    const { name, symbol, securityType, fetchPrices, fixedPriceMicros } =
      parsed.data;

    // Setting a fixed price switches fetching off with it: there is no feed for
    // a fixed NAV, and the cron and the price entry pill both read the pair.
    // Clearing the fixed price leaves fetching where it was — turning it back
    // on is the user's call.
    const nextFetchPrices =
      fixedPriceMicros !== undefined && fixedPriceMicros !== null
        ? false
        : fetchPrices;

    const existingSecurity = await db.query.securities.findFirst({
      where: and(eq(securities.id, securityId), eq(securities.bookId, numericBookId)),
    });

    if (!existingSecurity) {
      return NextResponse.json({ error: "Security not found" }, { status: 404 });
    }

    await db.update(securities)
      .set({
        ...(name !== undefined && { name }),
        ...(symbol !== undefined && { symbol }),
        ...(securityType !== undefined && { securityType }),
        ...(nextFetchPrices !== undefined && { fetchPrices: nextFetchPrices }),
        ...(fixedPriceMicros !== undefined && { fixedPriceMicros }),
      })
      .where(and(eq(securities.id, securityId), eq(securities.bookId, numericBookId)));

    const updatedSecurity = await db.query.securities.findFirst({
      where: and(eq(securities.id, securityId), eq(securities.bookId, numericBookId)),
    });

    if (!updatedSecurity) {
      return NextResponse.json({ error: "Security not found" }, { status: 404 });
    }

    return NextResponse.json(updatedSecurity);
  } catch (error) {
    console.error("Error updating security:", error);
    return NextResponse.json(
      { error: "Failed to update security" },
      { status: 500 }
    );
  }
}

export async function DELETE(
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

    // Investment splits, lots, and prices all cascade from securities, so a
    // delete here would silently erase the security's entire investment history
    // while leaving the double-entry transactions in place.
    const splitsCount = await db
      .select({ count: sql<number>`cast(count(*) as integer)` })
      .from(investmentSplits)
      .where(
        and(
          eq(investmentSplits.securityId, securityId),
          eq(investmentSplits.bookId, numericBookId)
        )
      );

    if (splitsCount[0].count > 0) {
      return NextResponse.json(
        { error: "Cannot delete security with investment transactions" },
        { status: 400 }
      );
    }

    const deleted = await db
      .delete(securities)
      .where(and(eq(securities.id, securityId), eq(securities.bookId, numericBookId)))
      .returning();

    if (deleted.length === 0) {
      return NextResponse.json({ error: "Security not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error deleting security:", error);
    return NextResponse.json(
      { error: "Failed to delete security" },
      { status: 500 }
    );
  }
}
