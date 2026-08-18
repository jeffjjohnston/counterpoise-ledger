import { NextResponse } from "next/server";
import { authenticateBookRequest, isError } from "@/lib/api-auth";
import { accounts, transactionSplits } from "@/db/schema";
import { eq, sql, and } from "drizzle-orm";
import { type AppDb } from "@/db";
import { updateAccountSchema } from "@/lib/schemas/accounts";

const isInvestmentAccount = (account: { type: string; subtype?: string | null }) =>
  account.type === "asset" && account.subtype === "investment";

const buildInvestmentCashName = (name: string) => `${name} Cash`;

type DbOrTransaction = AppDb | Parameters<Parameters<AppDb["transaction"]>[0]>[0];

async function ensureInvestmentCashAccount(
  accountId: number,
  accountName: string,
  tx: DbOrTransaction,
  bookId: number
) {
  const [existingCash] = await tx
    .select()
    .from(accounts)
    .where(and(eq(accounts.bookId, bookId), eq(accounts.parentId, accountId), eq(accounts.isInvestmentCash, true)));

  if (!existingCash) {
    await tx
      .insert(accounts)
      .values({
        name: buildInvestmentCashName(accountName),
        type: "asset",
        subtype: "cash",
        parentId: accountId,
        isActive: true,
        isInvestmentCash: true,
        bookId,
      });
    return;
  }

  const desiredName = buildInvestmentCashName(accountName);
  if (existingCash.name !== desiredName) {
    await tx
      .update(accounts)
      .set({ name: desiredName, updatedAt: new Date() })
      .where(and(eq(accounts.id, existingCash.id), eq(accounts.bookId, bookId)));
  }
}

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
    const { name, subtype, parentId, isActive, isFavorite, icon } = parsed.data;

    if (parentId) {
      const [parent] = await db
        .select({ id: accounts.id })
        .from(accounts)
        .where(and(eq(accounts.id, parentId), eq(accounts.bookId, numericBookId)));

      if (!parent) {
        return NextResponse.json({ error: "Invalid parentId" }, { status: 400 });
      }
    }

    const updateResult = await db.transaction(async (tx) => {
      const [existingAccount] = await tx
        .select()
        .from(accounts)
        .where(and(eq(accounts.id, accountId), eq(accounts.bookId, numericBookId)));

      if (!existingAccount) {
        return null;
      }

      const nextName = name ?? existingAccount.name;
      const nextSubtype = subtype ?? existingAccount.subtype;
      const nextParentId = parentId ?? existingAccount.parentId;

      await tx
        .update(accounts)
        .set({
          ...(name !== undefined && { name }),
          ...(subtype !== undefined && { subtype }),
          ...(parentId !== undefined && { parentId }),
          ...(isActive !== undefined && { isActive }),
          ...(isFavorite !== undefined && { isFavorite }),
          ...(icon !== undefined && { icon }),
          updatedAt: new Date(),
        })
        .where(and(eq(accounts.id, accountId), eq(accounts.bookId, numericBookId)));

      const updatedSnapshot = {
        ...existingAccount,
        name: nextName,
        subtype: nextSubtype,
        parentId: nextParentId,
        isActive: isActive ?? existingAccount.isActive,
        isFavorite: isFavorite ?? existingAccount.isFavorite,
      };

      if (isInvestmentAccount(updatedSnapshot)) {
        await ensureInvestmentCashAccount(accountId, updatedSnapshot.name, tx, numericBookId);
        if (isActive !== undefined) {
          await tx
            .update(accounts)
            .set({ isActive, updatedAt: new Date() })
            .where(
              and(
                eq(accounts.parentId, accountId),
                eq(accounts.isInvestmentCash, true),
                eq(accounts.bookId, numericBookId)
              )
            );
        }
      }

      return true;
    });

    if (!updateResult) {
      return NextResponse.json({ error: "Account not found" }, { status: 404 });
    }

    const updatedAccount = await db.query.accounts.findFirst({
      where: and(eq(accounts.id, accountId), eq(accounts.bookId, numericBookId)),
      with: {
        children: true,
      },
    });

    if (!updatedAccount) {
      return NextResponse.json({ error: "Account not found" }, { status: 404 });
    }

    return NextResponse.json(updatedAccount);
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

    // Check for transactions using this account
    const splitsCount = await db
      .select({ count: sql<number>`cast(count(*) as integer)` })
      .from(transactionSplits)
      .where(and(eq(transactionSplits.accountId, accountId), eq(transactionSplits.bookId, numericBookId)));

    if (splitsCount[0].count > 0) {
      return NextResponse.json(
        { error: "Cannot delete account with transactions" },
        { status: 400 }
      );
    }

    // Check for child accounts
    const childCount = await db
      .select({ count: sql<number>`cast(count(*) as integer)` })
      .from(accounts)
      .where(and(eq(accounts.parentId, accountId), eq(accounts.bookId, numericBookId)));

    if (childCount[0].count > 0) {
      return NextResponse.json(
        { error: "Cannot delete account with sub-accounts" },
        { status: 400 }
      );
    }

    const result = await db
      .delete(accounts)
      .where(and(eq(accounts.id, accountId), eq(accounts.bookId, numericBookId)))
      .returning();

    if (result.length === 0) {
      return NextResponse.json({ error: "Account not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error deleting account:", error);
    return NextResponse.json(
      { error: "Failed to delete account" },
      { status: 500 }
    );
  }
}
