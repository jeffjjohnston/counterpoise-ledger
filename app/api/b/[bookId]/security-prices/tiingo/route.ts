import { NextResponse } from "next/server";
import { authenticateBookRequest, isError } from "@/lib/api-auth";
import { fetchLatestTiingoPrices, isTiingoConfigured } from "@/lib/tiingo";
import { tiingoFetchSchema } from "@/lib/schemas/security-prices";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ bookId: string }> }
) {
  try {
    const { bookId } = await params;
    const auth = await authenticateBookRequest(bookId);
    if (isError(auth)) return auth.error;

    if (!isTiingoConfigured()) {
      return NextResponse.json(
        { error: "TIINGO_API_KEY environment variable not configured" },
        { status: 500 }
      );
    }

    const parsed = tiingoFetchSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
    }
    const { symbols } = parsed.data;

    const { prices, errors } = await fetchLatestTiingoPrices(symbols);

    return NextResponse.json({ prices, errors });
  } catch (error) {
    console.error("Error fetching prices from Tiingo:", error);
    return NextResponse.json(
      { error: "Failed to fetch prices from Tiingo" },
      { status: 500 }
    );
  }
}
