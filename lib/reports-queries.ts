/**
 * Server-side report queries shared by the web API routes and the MCP server.
 *
 * Deliberately separate from `lib/reports.ts`: that module holds the pure
 * grouping helpers and is imported by client components, so it must not pull
 * the database driver into the browser bundle. Anything here touches the DB and
 * is server-only.
 */
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import type { AppDb } from "@/db";
import { accounts, payees, transactions, transactionSplits } from "@/db/schema";
import { effectiveDateSql } from "@/lib/accounting";
import type { AccountType } from "@/lib/accounts";

export type IncomeStatementRow = {
  accountId: number;
  name: string;
  type: "income" | "expense";
  isActive: boolean;
  balanceCents: number;
};

/**
 * Income and expense accounts with their balances over an optional date range.
 *
 * Balances are RAW and signed: income is negative, expenses positive, per the
 * normal-balance conventions in lib/accounting.ts. Zero-balance accounts are
 * included. Callers decide whether to display-adjust and whether to hide zero
 * rows — the web report and the MCP tool legitimately differ on both, and that
 * is presentation, not fact.
 */
export async function getIncomeStatement(
  db: AppDb,
  bookId: number,
  opts: { startDate?: string; endDate?: string; includeInactive?: boolean } = {}
): Promise<IncomeStatementRow[]> {
  const { startDate, endDate, includeInactive = false } = opts;

  const baseWhere = and(
    eq(accounts.bookId, bookId),
    inArray(accounts.type, ["income", "expense"])
  );
  const whereClause = includeInactive
    ? baseWhere
    : and(baseWhere, eq(accounts.isActive, true));

  const balanceExpression =
    startDate && endDate
      ? sql<number>`cast(coalesce(sum(case when ${effectiveDateSql} >= ${startDate} and ${effectiveDateSql} <= ${endDate} then ${transactionSplits.amount} else 0 end), 0) as integer)`
      : sql<number>`cast(coalesce(sum(${transactionSplits.amount}), 0) as integer)`;

  const rows = await db
    .select({
      accountId: accounts.id,
      name: accounts.name,
      type: accounts.type,
      isActive: accounts.isActive,
      balanceCents: balanceExpression,
    })
    .from(accounts)
    .leftJoin(transactionSplits, eq(transactionSplits.accountId, accounts.id))
    .leftJoin(transactions, eq(transactions.id, transactionSplits.transactionId))
    .where(whereClause)
    .groupBy(accounts.id)
    .orderBy(accounts.type, accounts.name);

  return rows as IncomeStatementRow[];
}

export type ReportSplitRow = {
  splitId: number;
  transactionId: number;
  date: string;
  description: string | null;
  amount: number;
  accountId: number;
  accountName: string;
  accountType: AccountType;
  accountParentId: number | null;
  payeeId: number | null;
  payeeName: string | null;
};

/**
 * Raw split rows for report building, as a superset of what each surface
 * shows: the web report route drops `description`, MCP drops `splitId`,
 * `accountParentId` and `payeeId`.
 *
 * Ordering ends on the split id, which is unique per row. Date alone is not
 * enough, and neither is (date, transaction_id): a transaction holds many
 * splits that share both, so those rows would still come back in whatever
 * order PostgreSQL chose, and `limit` could truncate a different subset each
 * time. Same nondeterminism class as the fix in lib/investments.ts.
 *
 * `totalCount` costs a second query only when `limit` is supplied, since an
 * unlimited query already returns every matching row.
 */
export async function getReportSplits(
  db: AppDb,
  bookId: number,
  opts: {
    startDate?: string;
    endDate?: string;
    accountIds?: number[];
    accountTypes?: AccountType[];
    limit?: number;
  } = {}
): Promise<{ splits: ReportSplitRow[]; totalCount: number }> {
  const { startDate, endDate, accountIds, accountTypes, limit } = opts;

  const conditions = [eq(transactions.bookId, bookId)];
  if (startDate) conditions.push(gte(effectiveDateSql, startDate));
  if (endDate) conditions.push(lte(effectiveDateSql, endDate));
  if (accountIds && accountIds.length > 0) {
    conditions.push(inArray(transactionSplits.accountId, accountIds));
  }
  if (accountTypes && accountTypes.length > 0) {
    conditions.push(inArray(accounts.type, accountTypes));
  }
  const whereClause = and(...conditions);

  const base = db
    .select({
      splitId: transactionSplits.id,
      transactionId: transactionSplits.transactionId,
      date: effectiveDateSql.as("date"),
      description: transactions.description,
      amount: transactionSplits.amount,
      accountId: transactionSplits.accountId,
      accountName: accounts.name,
      accountType: accounts.type,
      accountParentId: accounts.parentId,
      payeeId: sql<number | null>`${payees.id}`,
      payeeName: sql<string | null>`${payees.name}`,
    })
    .from(transactionSplits)
    .innerJoin(transactions, eq(transactions.id, transactionSplits.transactionId))
    .innerJoin(accounts, eq(accounts.id, transactionSplits.accountId))
    .leftJoin(payees, eq(payees.id, transactions.payeeId))
    .where(whereClause)
    .orderBy(effectiveDateSql, transactions.id, transactionSplits.id);

  const splits = limit ? await base.limit(limit) : await base;

  if (!limit) {
    return { splits, totalCount: splits.length };
  }

  const [{ totalCount }] = await db
    .select({ totalCount: sql<number>`cast(count(*) as integer)` })
    .from(transactionSplits)
    .innerJoin(transactions, eq(transactions.id, transactionSplits.transactionId))
    .innerJoin(accounts, eq(accounts.id, transactionSplits.accountId))
    .where(whereClause);

  return { splits, totalCount };
}
