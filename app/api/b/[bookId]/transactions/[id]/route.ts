import { NextResponse } from "next/server";
import { authenticateBookRequest, isError } from "@/lib/api-auth";
import { plaidTransactionReconciliation, transactions } from "@/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { captureEvent, diffTransactionFields } from "@/lib/posthog-server";
import {
  updateTransaction as updateTransactionShared,
  TransactionValidationError,
  TransactionNotFoundError,
} from "@/lib/transactions";
import { collectAffectedPairs, rebuildLotsForPairs } from "@/lib/lots-db";
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

    const result = await db.transaction(async (tx) => {
      // Captured before the delete: the transaction's investment splits
      // cascade away with it, so this is the last point their (account,
      // security) pairs are still queryable.
      const affectedPairs = await collectAffectedPairs(tx, numericBookId, transactionId);

      // Explicit, not left to the FK. onDelete: "set null" clears the id but
      // leaves resolution_status saying "matched" — that inconsistency is exactly
      // what hides the row from the reconciliation queue forever.
      await tx
        .update(plaidTransactionReconciliation)
        .set({
          resolutionStatus: "pending",
          matchedTransactionId: null,
          resolvedAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(plaidTransactionReconciliation.matchedTransactionId, transactionId),
            eq(plaidTransactionReconciliation.bookId, numericBookId)
          )
        );

      const deleted = await tx
        .delete(transactions)
        .where(and(eq(transactions.id, transactionId), eq(transactions.bookId, numericBookId)))
        .returning();

      // Sweep for a row stranded by a race with a concurrent auto-match: if
      // auto-match claimed this row and set matchedTransactionId = transactionId
      // in an uncommitted transaction, our reset above (scoped to that id) ran
      // before the claim was visible and missed it. The delete above then
      // blocked on the FK until auto-match committed, at which point
      // ON DELETE SET NULL cleared the id but left resolutionStatus at
      // "matched" — the same stranding the reset exists to prevent. Catch it
      // here instead of narrowing the race further. Idempotent: normally
      // matches nothing.
      await tx
        .update(plaidTransactionReconciliation)
        .set({ resolutionStatus: "pending", resolvedAt: null, updatedAt: new Date() })
        .where(
          and(
            eq(plaidTransactionReconciliation.bookId, numericBookId),
            eq(plaidTransactionReconciliation.resolutionStatus, "matched"),
            isNull(plaidTransactionReconciliation.matchedTransactionId)
          )
        );

      // Lots are derived state: regenerate every pair this delete could affect.
      await rebuildLotsForPairs(tx, numericBookId, affectedPairs);

      return deleted;
    });

    if (result.length === 0) {
      return NextResponse.json(
        { error: "Transaction not found" },
        { status: 404 }
      );
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
