import { NextResponse } from "next/server";
import { authenticateBookRequest, isError } from "@/lib/api-auth";
import { accounts, transactionSplits } from "@/db/schema";
import { eq, sql, and } from "drizzle-orm";
import {
  updateAccount,
  deleteAccount,
  AccountValidationError,
  AccountNotFoundError,
} from "@/lib/accounts";
import { updateAccountSchema } from "@/lib/schemas/accounts";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ bookId: string; id: string }> }
) {
  try {
    const { bookId, id } = await params;
    const auth = await authenticateBookRequest(bookId);
    if (isError(auth)) return auth.error;
    const { db, bookId: numericBookId } = auth;

    const accountId = parseInt(id);

    const account = await db.query.accounts.findFirst({
      where: and(eq(accounts.id, accountId), eq(accounts.bookId, numericBookId)),
      with: {
        children: true,
      },
    });

    if (!account) {
      return NextResponse.json({ error: "Account not found" }, { status: 404 });
    }

    const balanceResult = await db
      .select({
        total: sql<number>`cast(sum(${transactionSplits.amount}) as integer)`.as("total"),
        count: sql<number>`cast(count(*) as integer)`.as("count"),
      })
      .from(transactionSplits)
      .where(and(eq(transactionSplits.accountId, accountId), eq(transactionSplits.bookId, numericBookId)));

    return NextResponse.json({
      ...account,
      balance: balanceResult[0]?.total || 0,
      hasTransactions: (balanceResult[0]?.count || 0) > 0,
    });
  } catch (error) {
    console.error("Error fetching account:", error);
    return NextResponse.json(
      { error: "Failed to fetch account" },
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

    const accountId = parseInt(id);
    const parsed = updateAccountSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
    }

    try {
      const updatedAccount = await updateAccount(db, numericBookId, accountId, parsed.data);
      return NextResponse.json(updatedAccount);
    } catch (error) {
      if (error instanceof AccountValidationError) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
      if (error instanceof AccountNotFoundError) {
        return NextResponse.json({ error: error.message }, { status: 404 });
      }
      throw error;
    }
  } catch (error) {
    console.error("Error updating account:", error);
    return NextResponse.json(
      { error: "Failed to update account" },
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

    const accountId = parseInt(id);

    try {
      await deleteAccount(db, numericBookId, accountId);
      return NextResponse.json({ success: true });
    } catch (error) {
      if (error instanceof AccountValidationError) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
      if (error instanceof AccountNotFoundError) {
        return NextResponse.json({ error: error.message }, { status: 404 });
      }
      throw error;
    }
  } catch (error) {
    console.error("Error deleting account:", error);
    return NextResponse.json(
      { error: "Failed to delete account" },
      { status: 500 }
    );
  }
}
