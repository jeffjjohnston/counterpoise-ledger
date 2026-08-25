import { NextResponse } from "next/server";
import { authenticateBookRequest, isError } from "@/lib/api-auth";
import { bulkPricesSchema } from "@/lib/schemas/security-prices";
import { setSecurityPrices } from "@/lib/security-prices";
import { SecurityValidationError } from "@/lib/securities";

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

    try {
      const { count } = await setSecurityPrices(db, numericBookId, parsed.data.priceUpdates);
      return NextResponse.json({
        message: `Successfully updated ${count} price(s)`,
        count,
      });
    } catch (err) {
      if (err instanceof SecurityValidationError) {
        return NextResponse.json({ error: err.message }, { status: 400 });
      }
      throw err;
    }
  } catch (error) {
    console.error("Error updating security prices:", error);
    return NextResponse.json(
      { error: "Failed to update security prices" },
      { status: 500 }
    );
  }
}
