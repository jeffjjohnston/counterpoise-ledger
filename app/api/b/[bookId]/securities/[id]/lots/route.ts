import { NextResponse } from "next/server";
import { authenticateBookRequest, isError } from "@/lib/api-auth";
import { accounts, investmentLots, securities } from "@/db/schema";
import { and, asc, eq, gt } from "drizzle-orm";

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

    const rows = await db
      .select({
        lotId: investmentLots.id,
        accountId: investmentLots.accountId,
        accountName: accounts.name,
        acquiredDate: investmentLots.acquiredDate,
        sharesMicros: investmentLots.remainingSharesMicros,
        basisCents: investmentLots.remainingBasisCents,
      })
      .from(investmentLots)
      .innerJoin(accounts, eq(accounts.id, investmentLots.accountId))
      .where(
        and(
          eq(investmentLots.bookId, numericBookId),
          eq(investmentLots.securityId, securityId),
          gt(investmentLots.remainingSharesMicros, 0)
        )
      )
      .orderBy(asc(investmentLots.acquiredDate), asc(investmentLots.id));

    return NextResponse.json(rows);
  } catch (error) {
    console.error("Error fetching security lots:", error);
    return NextResponse.json({ error: "Failed to fetch lots" }, { status: 500 });
  }
}
