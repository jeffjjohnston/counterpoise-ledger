import { NextResponse } from "next/server";
import { authenticateBookRequest, isError } from "@/lib/api-auth";
import { transactions } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { captureEvent, diffTransactionFields } from "@/lib/posthog-server";
import {
  deleteTransaction,
  updateTransaction as updateTransactionShared,
  TransactionValidationError,
  TransactionNotFoundError,
} from "@/lib/transactions";
import { updateTransactionBodySchema } from "@/lib/schemas/transactions";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ bookId: string; id: string }> }
) {
  try {
    const { bookId, id } = await params;
    const auth = await authenticateBookRequest(bookId);
    if (isError(auth)) return auth.error;
    const { db, bookId: numericBookId } = auth;

    const transactionId = parseInt(id);

    const transaction = await db.query.transactions.findFirst({
      where: and(eq(transactions.id, transactionId), eq(transactions.bookId, numericBookId)),
      with: {
        payee: true,
        splits: {
          with: {
            account: true,
          },
        },
        investmentSplits: {
          with: {
            security: true,
            account: true,
          },
        },
      },
    });

    if (!transaction) {
      return NextResponse.json(
        { error: "Transaction not found" },
        { status: 404 }
      );
    }

    return NextResponse.json(transaction);
  } catch (error) {
    console.error("Error fetching transaction:", error);
    return NextResponse.json(
      { error: "Failed to fetch transaction" },
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

    const transactionId = parseInt(id);
    const parsed = updateTransactionBodySchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
    }
    const body = parsed.data;

    // Fetch existing transaction for field-level diff
    const existing = await db.query.transactions.findFirst({
      where: and(eq(transactions.id, transactionId), eq(transactions.bookId, numericBookId)),
      with: {
        payee: true,
        splits: true,
      },
    });

    const result = await updateTransactionShared(db, numericBookId, transactionId, body);

    // Compute which fields actually changed
    const diff = existing
      ? diffTransactionFields(existing, body)
      : { fieldsChanged: [], splitsAccountsChanged: false };

    captureEvent(auth.userId, "transaction_updated", {
      bookId: numericBookId,
      fieldsChanged: diff.fieldsChanged,
      splitsAccountsChanged: diff.splitsAccountsChanged,
    });

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof TransactionNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof TransactionValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("Error updating transaction:", error);
    return NextResponse.json(
      { error: "Failed to update transaction" },
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

    const transactionId = parseInt(id);

    try {
      await deleteTransaction(db, numericBookId, transactionId);
    } catch (error) {
      if (error instanceof TransactionNotFoundError) {
        return NextResponse.json({ error: "Transaction not found" }, { status: 404 });
      }
      throw error;
    }

    captureEvent(auth.userId, "transaction_deleted", { bookId: numericBookId });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error deleting transaction:", error);
    return NextResponse.json(
      { error: "Failed to delete transaction" },
      { status: 500 }
    );
  }
}
