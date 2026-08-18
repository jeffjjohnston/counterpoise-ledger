import { NextResponse } from "next/server";
import { authenticateBookRequest, isError } from "@/lib/api-auth";
import {
  accounts,
  plaidAccounts,
  plaidTokens,
  plaidTransactionReconciliation,
} from "@/db/schema";
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ bookId: string }> }
) {
  try {
    const { bookId } = await params;
    const auth = await authenticateBookRequest(bookId);
    if (isError(auth)) return auth.error;
    const { db, bookId: numericBookId } = auth;

    const rows = await db
      .select({
        plaidLinkId: plaidAccounts.id,
        financialInstitution: plaidTokens.financialInstitution,
        tokenId: plaidTokens.id,
        itemId: plaidTokens.itemId,
        plaidAccountId: plaidAccounts.plaidAccountId,
        plaidAccountName: plaidAccounts.name,
        counterpoiseAccountId: plaidAccounts.counterpoiseAccountId,
        counterpoiseAccountName: accounts.name,
        lastSyncedAt: plaidTokens.lastSyncedAt,
        lastError: plaidTokens.lastError,
        pendingCount: sql<number>`
          cast(coalesce(
            sum(
              case
                when ${plaidTransactionReconciliation.resolutionStatus} = 'pending'
                  and ${plaidTransactionReconciliation.reviewReason} is null
                then 1
                else 0
              end
            ),
            0
          ) as integer)
        `.as("pendingCount"),
        reviewCount: sql<number>`
          cast(coalesce(
            sum(
              case
                when ${plaidTransactionReconciliation.reviewReason} is not null
                then 1
                else 0
              end
            ),
            0
          ) as integer)
        `.as("reviewCount"),
      })
      .from(plaidAccounts)
      .innerJoin(plaidTokens, eq(plaidAccounts.tokenId, plaidTokens.id))
      .innerJoin(accounts, eq(plaidAccounts.counterpoiseAccountId, accounts.id))
      .leftJoin(
        plaidTransactionReconciliation,
        eq(plaidTransactionReconciliation.plaidAccountLinkId, plaidAccounts.id)
      )
      .where(and(eq(plaidTokens.bookId, numericBookId), isNotNull(plaidAccounts.counterpoiseAccountId)))
      .groupBy(
        plaidAccounts.id,
        plaidTokens.financialInstitution,
        plaidTokens.itemId,
        plaidAccounts.plaidAccountId,
        plaidAccounts.name,
        plaidAccounts.counterpoiseAccountId,
        accounts.name,
        plaidTokens.id,
        plaidTokens.lastSyncedAt,
        plaidTokens.lastError
      )
      .orderBy(
        asc(plaidTokens.financialInstitution),
        asc(plaidTokens.itemId),
        asc(plaidAccounts.name)
      );

    return NextResponse.json(rows);
  } catch (error) {
    console.error("Error fetching assigned sync accounts:", error);
    return NextResponse.json(
      { error: "Failed to fetch assigned sync accounts" },
      { status: 500 }
    );
  }
}
