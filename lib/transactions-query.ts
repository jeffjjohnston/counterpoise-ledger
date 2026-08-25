// lib/transactions-query.ts
import { type AppDb } from "@/db";
import { accounts, payees, transactions, transactionSplits } from "@/db/schema";
import { and, desc, eq, gte, inArray, lte, or, sql, type SQL } from "drizzle-orm";
import { effectiveDateSql } from "@/lib/accounting";
import { TransactionValidationError } from "@/lib/transactions";

/** Which rows. Shared by the page select and the position count. */
export interface TransactionFilters {
  accountIds?: number[] | null;
  payeeId?: number | null;
  startDate?: string | null;
  endDate?: string | null;
}

export interface TransactionPageRow {
  id: number;
  /**
   * The EFFECTIVE date, not the stored one. The web route anchors its
   * running-balance sum on the oldest row of the page, so a caller handed
   * only ids cannot compute it without a second query.
   */
  date: string;
}

export interface SelectTransactionPageOptions extends TransactionFilters {
  /**
   * `null` means no LIMIT clause — the route's `limit=0` sentinel.
   *
   * A `null` limit also skips `.offset()`: rows come back from the top of
   * the order regardless of `offset`. No caller sends `limit: null` with a
   * nonzero `offset` today, so this is the pre-refactor behaviour, kept
   * as-is rather than changed — flagged here for the caller that adds one.
   */
  limit?: number | null;
  offset?: number;
  /** When false, `totalCount` comes back null and no COUNT runs. */
  withCount?: boolean;
}

export interface TransactionPage {
  rows: TransactionPageRow[];
  totalCount: number | null;
}

const DEFAULT_LIMIT = 100;

/**
 * The one place transaction filters are built.
 *
 * Before this existed the two surfaces built them differently — MCP with a
 * subquery on transaction_splits, the web route with an inner join and
 * GROUP BY. They agreed, but nothing held them in agreement.
 *
 * `joinsSplits` tells the caller whether its FROM clause needs the splits
 * join, because the account filter is the only condition that lives on
 * another table.
 */
function buildTransactionFilters(
  bookId: number,
  filters: TransactionFilters,
): { conditions: SQL[]; joinsSplits: boolean } {
  // An empty accountIds array is a caller bug, not "no filter". A caller
  // that computes "the accounts this user may see", gets [], and would
  // otherwise fall through to the whole book is the wrong failure
  // direction — fail loudly instead of widening the query.
  if (filters.accountIds !== undefined && filters.accountIds !== null && filters.accountIds.length === 0) {
    throw new TransactionValidationError("accountIds must not be empty");
  }
  const accountIds =
    filters.accountIds && filters.accountIds.length > 0 ? filters.accountIds : null;

  const conditions: SQL[] = [eq(transactions.bookId, bookId)];

  if (accountIds) {
    conditions.push(inArray(transactionSplits.accountId, accountIds));
  }
  if (filters.startDate) {
    conditions.push(gte(effectiveDateSql, filters.startDate));
  }
  if (filters.endDate) {
    conditions.push(lte(effectiveDateSql, filters.endDate));
  }
  if (filters.payeeId !== undefined && filters.payeeId !== null) {
    conditions.push(eq(transactions.payeeId, filters.payeeId));
  }

  return { conditions, joinsSplits: accountIds !== null };
}

/**
 * A payeeId that is an integer is not thereby yours. Filtering by another
 * book's payee returns nothing, which reads as "this payee has no
 * transactions" — a wrong answer rather than an empty one.
 */
async function assertPayeeInBook(
  db: AppDb,
  bookId: number,
  payeeId: number,
): Promise<void> {
  const [payee] = await db
    .select({ id: payees.id })
    .from(payees)
    .where(and(eq(payees.id, payeeId), eq(payees.bookId, bookId)));

  if (!payee) {
    throw new TransactionValidationError("Invalid payeeId");
  }
}

/**
 * An accountId that is an integer is not thereby yours. Filtering by
 * another book's account returns nothing, which reads as "this account has
 * no transactions" — a wrong answer rather than an empty one.
 *
 * Checked eagerly, before the page query runs, rather than lazily on an
 * empty result. Lazy checking was considered and rejected: a mixed list
 * like [mine, theirs] still returns rows, so "the page came back empty"
 * would never trigger for it, and the caller would silently get fewer
 * accounts than it asked for rather than an error. One indexed IN lookup
 * against a small table is marginal next to the page query, count,
 * relational hydration, and starting-balance query this request already
 * runs.
 */
async function assertAccountsInBook(
  db: AppDb,
  bookId: number,
  accountIds: number[],
): Promise<void> {
  const uniqueIds = [...new Set(accountIds)];
  const owned = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(inArray(accounts.id, uniqueIds), eq(accounts.bookId, bookId)));

  if (owned.length !== uniqueIds.length) {
    throw new TransactionValidationError(
      "One or more accounts do not belong to this book",
    );
  }
}

/**
 * The page of transactions matching these filters, newest first.
 *
 * Returns rows rather than ids because the caller may need the effective
 * date; see TransactionPageRow.
 */
export async function selectTransactionPage(
  db: AppDb,
  bookId: number,
  options: SelectTransactionPageOptions = {},
): Promise<TransactionPage> {
  const {
    limit = DEFAULT_LIMIT,
    offset = 0,
    withCount = true,
    ...filters
  } = options;

  if (filters.payeeId !== undefined && filters.payeeId !== null) {
    await assertPayeeInBook(db, bookId, filters.payeeId);
  }
  if (filters.accountIds !== undefined && filters.accountIds !== null && filters.accountIds.length > 0) {
    await assertAccountsInBook(db, bookId, filters.accountIds);
  }

  const { conditions, joinsSplits } = buildTransactionFilters(bookId, filters);
  const where = and(...conditions);

  let rows: TransactionPageRow[];
  let totalCount: number | null = null;

  if (joinsSplits) {
    // GROUP BY is what stops a transaction with splits on two filtered
    // accounts coming back twice.
    const query = db
      .select({ id: transactions.id, date: effectiveDateSql.as("date") })
      .from(transactions)
      .innerJoin(
        transactionSplits,
        eq(transactionSplits.transactionId, transactions.id),
      )
      .where(where)
      .groupBy(transactions.id, transactions.date)
      .orderBy(desc(effectiveDateSql), desc(transactions.id));

    rows = limit === null ? await query : await query.limit(limit).offset(offset);

    if (withCount) {
      const [result] = await db
        .select({
          count: sql<number>`cast(count(distinct ${transactions.id}) as integer)`.as(
            "count",
          ),
        })
        .from(transactions)
        .innerJoin(
          transactionSplits,
          eq(transactionSplits.transactionId, transactions.id),
        )
        .where(where);
      totalCount = result?.count ?? 0;
    }
  } else {
    const query = db
      .select({ id: transactions.id, date: effectiveDateSql.as("date") })
      .from(transactions)
      .where(where)
      .orderBy(desc(effectiveDateSql), desc(transactions.id));

    rows = limit === null ? await query : await query.limit(limit).offset(offset);

    if (withCount) {
      const [result] = await db
        .select({ count: sql<number>`cast(count(*) as integer)`.as("count") })
        .from(transactions)
        .where(where);
      totalCount = result?.count ?? 0;
    }
  }

  return { rows, totalCount };
}

/**
 * How many rows matching these filters sort ahead of `at` in the page's
 * order. The web route uses it to widen a page so a target transaction stays
 * on it; nothing else should need it.
 *
 * It deliberately does NOT re-run the payee or account ownership checks. Its
 * only caller calls selectTransactionPage moments later, which does — so an
 * out-of-book payee or account still produces the same error, after one
 * wasted count, rather than paying for the lookup twice on every register
 * load.
 */
export async function countTransactionsBefore(
  db: AppDb,
  bookId: number,
  filters: TransactionFilters,
  at: { date: string; id: number },
): Promise<number> {
  const { conditions, joinsSplits } = buildTransactionFilters(bookId, filters);

  const positionFilter = or(
    sql`${effectiveDateSql} > ${at.date}`,
    and(
      sql`${effectiveDateSql} = ${at.date}`,
      sql`${transactions.id} > ${at.id}`,
    ),
  );

  const where = and(...conditions, positionFilter);

  if (joinsSplits) {
    const [result] = await db
      .select({
        count: sql<number>`cast(count(distinct ${transactions.id}) as integer)`.as(
          "count",
        ),
      })
      .from(transactions)
      .innerJoin(
        transactionSplits,
        eq(transactionSplits.transactionId, transactions.id),
      )
      .where(where);
    return result?.count ?? 0;
  }

  const [result] = await db
    .select({ count: sql<number>`cast(count(*) as integer)`.as("count") })
    .from(transactions)
    .where(where);
  return result?.count ?? 0;
}
