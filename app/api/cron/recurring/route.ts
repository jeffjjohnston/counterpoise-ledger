import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { books } from "@/db/schema";
import { processAllRecurringRules } from "@/lib/recurring-processing";
import { verifyCronSecret } from "@/lib/cron-auth";

export async function GET(request: Request) {
  try {
    if (!verifyCronSecret(request)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const db = getDb();
    const allBooks = await db.select().from(books);

    let totalCreated = 0;
    const allTransactionIds: number[] = [];

    for (const book of allBooks) {
      try {
        const result = await processAllRecurringRules(db, book.id);
        totalCreated += result.transactionsCreated;
        allTransactionIds.push(...result.transactionIds);
      } catch (error) {
        console.error(`Error processing recurring rules for book ${book.id}:`, error);
      }
    }

    return NextResponse.json({
      success: true,
      booksProcessed: allBooks.length,
      transactionsCreated: totalCreated,
      transactionIds: allTransactionIds,
    });
  } catch (error) {
    console.error("Error processing recurring rules via cron:", error);
    return NextResponse.json(
      { error: "Failed to process recurring rules" },
      { status: 500 }
    );
  }
}
