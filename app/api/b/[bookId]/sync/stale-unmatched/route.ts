import { NextResponse } from "next/server";
import { authenticateBookRequest, isError } from "@/lib/api-auth";
import {
  accounts,
  plaidAccounts,
  plaidTransactionReconciliation,
  transactions,
  transactionSplits,
} from "@/db/schema";
import { and, asc, eq, gte, lt, notExists, sql } from "drizzle-orm";
import { toDateString } from "@/lib/formatters";

/** Unmatched local transactions older than this many days are flagged. */
const STALE_AGE_DAYS = 9;
/** Transactions older than this many days are ignored entirely. */
const LOOKBACK_DAYS = 60;

const daysAgo = (days: number) => {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return toDateString(d);
};

/**
 * Finds manually entered transactions on Plaid-synced accounts that no bank
 * transaction has matched — the local entry is either a mistake or its
 * posting is unusually delayed, so the user should take a look.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ bookId: string }> }
) {
  try {
    const { bookId } = await params;
    const auth = await authenticateBookRequest(bookId);
    if (isError(auth)) return auth.error;
    const { db, bookId: numericBookId } = auth;

    const staleCutoff = daysAgo(STALE_AGE_DAYS);
    const lookbackCutoff = daysAgo(LOOKBACK_DAYS);

    // The stored date is used deliberately instead of effectiveDateSql: a
    // floating transaction's effective date advances to today, which would
    // permanently exempt exactly the never-posted entries this flags.
    const rows = await db
      .select({
        accountId: accounts.id,
        accountName: accounts.name,
        count: sql<number>`cast(count(distinct ${transactions.id}) as integer)`.as(
          "count"
        ),
        oldestDate: sql<string>`min(${transactions.date})`.as("oldest_date"),
      })
      .from(transactions)
      .innerJoin(
        transactionSplits,
        and(
          eq(transactionSplits.transactionId, transactions.id),
          eq(transactionSplits.bookId, numericBookId)
        )
      )
      .innerJoin(
        accounts,
        and(
          eq(transactionSplits.accountId, accounts.id),
          eq(accounts.bookId, numericBookId)
        )
      )
      .innerJoin(
        plaidAccounts,
        and(
          eq(plaidAccounts.counterpoiseAccountId, accounts.id),
          eq(plaidAccounts.bookId, numericBookId)
        )
      )
      .where(
        and(
          eq(transactions.bookId, numericBookId),
          eq(transactions.isReconciled, false),
          lt(transactions.date, staleCutoff),
          gte(transactions.date, lookbackCutoff),
          notExists(
            db
              .select({ one: sql`1` })
              .from(plaidTransactionReconciliation)
              .where(
                and(
                  eq(plaidTransactionReconciliation.bookId, numericBookId),
                  eq(
                    plaidTransactionReconciliation.plaidAccountLinkId,
                    plaidAccounts.id
                  ),
                  eq(
                    plaidTransactionReconciliation.matchedTransactionId,
                    transactions.id
                  )
                )
              )
          )
        )
      )
      .groupBy(accounts.id, accounts.name)
      .orderBy(asc(accounts.name));

    const totalCount = rows.reduce((sum, row) => sum + row.count, 0);
    return NextResponse.json({ totalCount, accounts: rows });
  } catch (error) {
    console.error("Error fetching stale unmatched transactions:", error);
    return NextResponse.json(
      { error: "Failed to fetch stale unmatched transactions" },
      { status: 500 }
    );
  }
}
