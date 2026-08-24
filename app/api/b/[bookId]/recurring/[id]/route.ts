import { NextResponse } from "next/server";
import { authenticateBookRequest, isError } from "@/lib/api-auth";
import {
  deleteRecurringRule,
  getRecurringRule,
  RecurringRuleNotFoundError,
  RecurringRuleValidationError,
  updateRecurringRule,
} from "@/lib/recurring-rules";
import { updateRuleSchema } from "@/lib/schemas/recurring";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ bookId: string; id: string }> }
) {
  try {
    const { bookId, id } = await params;
    const auth = await authenticateBookRequest(bookId);
    if (isError(auth)) return auth.error;
    const { db, bookId: numericBookId } = auth;

    const ruleId = parseInt(id);

    const rule = await getRecurringRule(db, numericBookId, ruleId);
    if (!rule) {
      return NextResponse.json(
        { error: "Recurring rule not found" },
        { status: 404 }
      );
    }

    return NextResponse.json(rule);
  } catch (error) {
    console.error("Error fetching recurring rule:", error);
    return NextResponse.json(
      { error: "Failed to fetch recurring rule" },
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

    const ruleId = parseInt(id);
    const parsed = updateRuleSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
    }

    const result = await updateRecurringRule(db, numericBookId, ruleId, parsed.data);

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof RecurringRuleValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof RecurringRuleNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    console.error("Error updating recurring rule:", error);
    return NextResponse.json(
      { error: "Failed to update recurring rule" },
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

    const ruleId = parseInt(id);

    await deleteRecurringRule(db, numericBookId, ruleId);

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof RecurringRuleValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof RecurringRuleNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    console.error("Error deleting recurring rule:", error);
    return NextResponse.json(
      { error: "Failed to delete recurring rule" },
      { status: 500 }
    );
  }
}
