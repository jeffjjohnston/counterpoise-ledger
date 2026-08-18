import { and, eq, lte, sql } from "drizzle-orm";
import type { AppDb } from "@/db";
import { accounts, transactions, transactionSplits } from "@/db/schema";
import { effectiveDateSql } from "@/lib/accounting";

export type AccountType = (typeof accounts.$inferSelect)["type"];

export type AccountBalanceRow = {
  id: number;
  bookId: number;
  name: string;
  type: AccountType;
  subtype: (typeof accounts.$inferSelect)["subtype"];
  parentId: number | null;
  isActive: boolean;
  isFavorite: boolean;
  isInvestmentCash: boolean;
  icon: string | null;
  createdAt: Date;
  updatedAt: Date;
  balanceCents: number;
  hasTransactions: boolean;
};

/**
 * Accounts with their balances, as a flat list.
 *
 * The single source of truth for "which accounts, and what are they worth as
 * of when" across the web API and the MCP server. Shaping — tree, grouped by
 * type, display-formatted — belongs to the caller: those differ legitimately
 * per surface, while the numbers must not.
 *
 * Balances come from one grouped query rather than a correlated subquery per
 * account, so cost does not scale with the number of accounts.
 */
export async function getAccountsWithBalances(
  db: AppDb,
  bookId: number,
  opts: { type?: AccountType; includeInactive?: boolean; asOfDate?: string } = {}
): Promise<AccountBalanceRow[]> {
  const { type, includeInactive = false, asOfDate } = opts;

  const conditions = [eq(accounts.bookId, bookId)];
  if (!includeInactive) conditions.push(eq(accounts.isActive, true));
  if (type) conditions.push(eq(accounts.type, type));

  const rows = await db
    .select({
      id: accounts.id,
      bookId: accounts.bookId,
      name: accounts.name,
      type: accounts.type,
      subtype: accounts.subtype,
      parentId: accounts.parentId,
      isActive: accounts.isActive,
      isFavorite: accounts.isFavorite,
      isInvestmentCash: accounts.isInvestmentCash,
      icon: accounts.icon,
      createdAt: accounts.createdAt,
      updatedAt: accounts.updatedAt,
    })
    .from(accounts)
    .where(and(...conditions))
    .orderBy(accounts.type, accounts.name);

  const balanceSelect = db
    .select({
      accountId: transactionSplits.accountId,
      total: sql<number>`cast(sum(${transactionSplits.amount}) as integer)`.as("total"),
      count: sql<number>`cast(count(*) as integer)`.as("count"),
    })
    .from(transactionSplits);

  // The join is only needed when filtering by date: effectiveDateSql
  // references transactions.date / transactions.is_floating.
  const balances = asOfDate
    ? await balanceSelect
        .innerJoin(transactions, eq(transactions.id, transactionSplits.transactionId))
        .where(and(eq(transactionSplits.bookId, bookId), lte(effectiveDateSql, asOfDate)))
        .groupBy(transactionSplits.accountId)
    : await balanceSelect
        .where(eq(transactionSplits.bookId, bookId))
        .groupBy(transactionSplits.accountId);

  const totals = new Map(balances.map((b) => [b.accountId, b.total ?? 0]));
  const counts = new Map(balances.map((b) => [b.accountId, b.count ?? 0]));

  return rows.map((row) => ({
    ...row,
    balanceCents: totals.get(row.id) ?? 0,
    hasTransactions: (counts.get(row.id) ?? 0) > 0,
  }));
}
