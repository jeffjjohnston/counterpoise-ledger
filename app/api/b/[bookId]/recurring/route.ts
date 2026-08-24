import { NextResponse } from "next/server";
import { authenticateBookRequest, isError } from "@/lib/api-auth";
import {
  createRecurringRule,
  listRecurringRules,
  RecurringRuleNotFoundError,
  RecurringRuleValidationError,
} from "@/lib/recurring-rules";
import { captureEvent } from "@/lib/posthog-server";
import { createRuleSchema } from "@/lib/schemas/recurring";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ bookId: string }> }
) {
  try {
    const { bookId } = await params;
    const auth = await authenticateBookRequest(bookId);
    if (isError(auth)) return auth.error;
    const { db, bookId: numericBookId } = auth;

    const rules = await listRecurringRules(db, numericBookId);

    return NextResponse.json(rules);
  } catch (error) {
    console.error("Error fetching recurring rules:", error);
    return NextResponse.json(
      { error: "Failed to fetch recurring rules" },
      { status: 500 }
    );
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ bookId: string }> }
) {
  try {
    const { bookId } = await params;
    const auth = await authenticateBookRequest(bookId);
    if (isError(auth)) return auth.error;
    const { db, bookId: numericBookId } = auth;

    const parsed = createRuleSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
    }

    const result = await createRecurringRule(db, numericBookId, parsed.data);

    captureEvent(auth.userId, "recurring_rule_created", { bookId: numericBookId });

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof RecurringRuleValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof RecurringRuleNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    console.error("Error creating recurring rule:", error);
    return NextResponse.json(
      { error: "Failed to create recurring rule" },
      { status: 500 }
    );
  }
}
