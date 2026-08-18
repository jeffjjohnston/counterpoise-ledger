import { NextResponse } from "next/server";
import { authenticateBookRequest, isError } from "@/lib/api-auth";
import {
  processAllRecurringRules,
  processRecurringRuleById,
} from "@/lib/recurring-processing";
import { processRulesSchema } from "@/lib/schemas/recurring";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ bookId: string }> }
) {
  try {
    const { bookId } = await params;
    const auth = await authenticateBookRequest(bookId);
    if (isError(auth)) return auth.error;
    const { db, bookId: numericBookId } = auth;

    const parsed = processRulesSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
    }
    const { ruleId, processAll } = parsed.data;
    let transactionsCreated = 0;
    let transactionIds: number[] = [];
    // Returned to the caller: a rule that produced nothing because it is
    // malformed is deliberately left due, and "created 0" alone gives the user
    // no way to tell that apart from "nothing was due yet".
    let skipped: Array<{ ruleId: number; reason: string }> = [];

    if (ruleId) {
      const result = await processRecurringRuleById(db, numericBookId, ruleId);
      if (!result) {
        return NextResponse.json(
          { error: "Recurring rule not found" },
          { status: 404 }
        );
      }
      transactionsCreated = result.transactionsCreated;
      transactionIds = result.transactionIds;
      skipped = result.skipped;
    } else if (processAll) {
      const result = await processAllRecurringRules(db, numericBookId);
      return NextResponse.json({
        success: true,
        transactionsCreated: result.transactionsCreated,
        transactionIds: result.transactionIds,
        skipped: result.skipped,
      });
    }

    return NextResponse.json({
      success: true,
      transactionsCreated,
      transactionIds,
      skipped,
    });
  } catch (error) {
    console.error("Error processing recurring rules:", error);
    return NextResponse.json(
      { error: "Failed to process recurring rules" },
      { status: 500 }
    );
  }
}
