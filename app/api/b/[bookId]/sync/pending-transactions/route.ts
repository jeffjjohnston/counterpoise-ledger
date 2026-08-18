import { NextResponse } from "next/server";
import { authenticateBookRequest, isError } from "@/lib/api-auth";
import {
  accounts,
  plaidAccounts,
  plaidTransactionReconciliation,
} from "@/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import type { DisplayTransaction } from "@/types";
import { pendingTransactionsQuery } from "@/lib/schemas/sync";

/**
 * Offset keeping synthesized IDs clear of the negative IDs the projected
 * recurring endpoint generates (-(ruleId * 10000 + occurrence)) — a collision
 * would need a rule ID of 100 million. Still well within safe integer range.
 */
const PLAID_PENDING_ID_OFFSET = 1_000_000_000_000;

/** "FOOD_AND_DRINK" → "Food And Drink" */
const formatCategory = (category: string | null) =>
  category
    ? category
        .toLowerCase()
        .split("_")
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ")
    : null;

/**
 * Unmatched Plaid transactions shaped as display transactions, so the
 * transaction list can interleave them with real ones. Shown at their
 * authorized date (when the user actually spent) rather than the posted date.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ bookId: string }> }
) {
  try {
    const { bookId } = await params;
    const auth = await authenticateBookRequest(bookId);
    if (isError(auth)) return auth.error;
    const { db, bookId: numericBookId } = auth;

    const { searchParams } = new URL(request.url);
    const parsedQuery = pendingTransactionsQuery.safeParse({
      accountId: searchParams.get("accountId") || undefined,
    });
    if (!parsedQuery.success) {
      return NextResponse.json({ error: parsedQuery.error.issues[0].message }, { status: 400 });
    }
    const filterAccountId = parsedQuery.data.accountId ?? null;

    const rows = await db
      .select({
        recon: plaidTransactionReconciliation,
        account: accounts,
      })
      .from(plaidTransactionReconciliation)
      .innerJoin(
        plaidAccounts,
        and(
          eq(plaidTransactionReconciliation.plaidAccountLinkId, plaidAccounts.id),
          eq(plaidAccounts.bookId, numericBookId)
        )
      )
      .innerJoin(
        accounts,
        and(
          eq(plaidAccounts.counterpoiseAccountId, accounts.id),
          eq(accounts.bookId, numericBookId)
        )
      )
      .where(
        and(
          eq(plaidTransactionReconciliation.bookId, numericBookId),
          eq(plaidTransactionReconciliation.resolutionStatus, "pending"),
          isNull(plaidTransactionReconciliation.reviewReason),
          ...(filterAccountId !== null ? [eq(accounts.id, filterAccountId)] : [])
        )
      );

    const epoch = new Date(0);
    const pending: DisplayTransaction[] = rows.map(({ recon, account }) => {
      const txId = -(PLAID_PENDING_ID_OFFSET + recon.id);
      const payeeName = recon.merchantName ?? recon.name;
      return {
        id: txId,
        bookId: numericBookId,
        date: recon.authorizedDate ?? recon.date,
        description: recon.name,
        checkNumber: null,
        notes: null,
        payeeId: null,
        isReconciled: false,
        isFloating: false,
        recurringRuleId: null,
        createdAt: epoch,
        updatedAt: epoch,
        payee: { id: txId, bookId: numericBookId, name: payeeName, createdAt: epoch },
        splits: [
          {
            id: txId,
            bookId: numericBookId,
            transactionId: txId,
            accountId: account.id,
            // Plaid amounts are positive for outflows; local asset splits
            // are the negation
            amount: -recon.amountCents,
            account,
          },
        ],
        investmentSplits: [],
        isPlaidPending: true,
        plaidCategory: formatCategory(recon.categoryPrimary),
      };
    });

    pending.sort((a, b) => b.date.localeCompare(a.date));

    return NextResponse.json(pending);
  } catch (error) {
    console.error("Error fetching pending Plaid transactions:", error);
    return NextResponse.json(
      { error: "Failed to fetch pending Plaid transactions" },
      { status: 500 }
    );
  }
}
