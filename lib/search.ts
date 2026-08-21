import { eq, like, or, and, gte, lte, desc, sql } from "drizzle-orm";
import type { AppDb } from "@/db";
import {
  accounts,
  payees,
  transactions,
  transactionSplits,
  recurringRules,
} from "@/db/schema";
import { effectiveDateSql } from "@/lib/accounting";

export type SearchTransactionRow = {
  id: number;
  date: string;
  description: string | null;
  // Both surfaces MATCH on notes; MCP also returned them. Carrying the field
  // here keeps that, and is additive for the web route.
  notes: string | null;
  checkNumber: string | null;
  payee: { id: number; name: string } | null;
  splits: Array<{
    accountId: number;
    accountName: string;
    amount: number;
    isFavorite: boolean;
    subtype: string | null;
    isInvestmentCash: boolean;
  }>;
};

/**
 * Rows here are a SUPERSET of what either surface returns. Each caller
 * projects down to its own response contract — the web route and the MCP tool
 * expose different fields, and neither should change shape just because the
 * query behind them became shared.
 */
export type SearchResults = {
  transactions: SearchTransactionRow[];
  accounts: Array<{
    id: number;
    name: string;
    type: string;
    subtype: string | null;
    isFavorite: boolean;
    isActive: boolean;
  }>;
  payees: Array<{ id: number; name: string }>;
  recurringRules: Array<{
    id: number;
    name: string;
    frequency: string;
    /** Scheduled date — shift it with getOccurrenceDate() before display. */
    nextDate: string;
    businessDaysOnly: boolean;
    isActive: boolean;
  }>;
};

/** "$1,234.50" -> 123450 cents; null when the query is not a number. */
export function parseCurrencyQuery(q: string): number | null {
  const cleaned = q.replace(/[$,]/g, "");
  const parsed = parseFloat(cleaned);
  if (isNaN(parsed) || !isFinite(parsed)) return null;
  return Math.round(parsed * 100);
}

/**
 * Text and amount search across a book, shared by the web search route and
 * MCP's `search` tool so the two cannot answer the same question differently.
 */
export async function searchBook(
  db: AppDb,
  bookId: number,
  query: string,
  opts: { startDate?: string; endDate?: string; limit?: number } = {}
): Promise<SearchResults> {
  const q = query.trim();
  if (q.length === 0) {
    return { transactions: [], accounts: [], payees: [], recurringRules: [] };
  }

  const { startDate, endDate, limit: LIMIT = 25 } = opts;
  const pattern = `%${q.toLowerCase()}%`;

  // Try parsing as currency amount (e.g., "50" or "50.00" -> 5000 cents)
  const amountCents = parseCurrencyQuery(q);

  // Search transactions
  const txnConditions = [
    like(sql`lower(${transactions.description})`, pattern),
    like(sql`lower(${transactions.notes})`, pattern),
    like(sql`lower(${payees.name})`, pattern),
    like(sql`lower(${transactions.checkNumber})`, pattern),
  ];

  if (amountCents !== null) {
    txnConditions.push(eq(transactionSplits.amount, amountCents));
    txnConditions.push(eq(transactionSplits.amount, -amountCents));
  }

  const dateConditions = [];
  if (startDate) dateConditions.push(gte(effectiveDateSql, startDate));
  if (endDate) dateConditions.push(lte(effectiveDateSql, endDate));

  const txnWhereClause =
    dateConditions.length > 0
      ? and(eq(transactions.bookId, bookId), or(...txnConditions), ...dateConditions)
      : and(eq(transactions.bookId, bookId), or(...txnConditions));

  // Get matching transaction IDs first (with dedup)
  // PostgreSQL requires ORDER BY columns to appear in SELECT DISTINCT list
  const matchingTxnIds = await db
    .selectDistinct({ id: transactions.id, date: effectiveDateSql.as("date") })
    .from(transactions)
    .leftJoin(payees, eq(transactions.payeeId, payees.id))
    .leftJoin(
      transactionSplits,
      eq(transactionSplits.transactionId, transactions.id)
    )
    .where(txnWhereClause)
    .orderBy(desc(effectiveDateSql))
    .limit(LIMIT);

  const txnIds = matchingTxnIds.map((r) => r.id);

  // Fetch full transaction data for matching IDs
  let txnResults: SearchTransactionRow[] = [];

  if (txnIds.length > 0) {
    const txnRows = await db
      .select({
        id: transactions.id,
        date: effectiveDateSql.as("date"),
        description: transactions.description,
        notes: transactions.notes,
        checkNumber: transactions.checkNumber,
        payeeId: payees.id,
        payeeName: payees.name,
        splitAccountId: transactionSplits.accountId,
        splitAmount: transactionSplits.amount,
        accountName: accounts.name,
        accountIsFavorite: accounts.isFavorite,
        accountSubtype: accounts.subtype,
        accountIsInvestmentCash: accounts.isInvestmentCash,
      })
      .from(transactions)
      .leftJoin(payees, eq(transactions.payeeId, payees.id))
      .innerJoin(
        transactionSplits,
        eq(transactionSplits.transactionId, transactions.id)
      )
      .innerJoin(accounts, eq(transactionSplits.accountId, accounts.id))
      .where(
        and(
          eq(transactions.bookId, bookId),
          eq(transactionSplits.bookId, bookId),
          eq(accounts.bookId, bookId),
          sql`${transactions.id} IN (${sql.join(
            txnIds.map((id) => sql`${id}`),
            sql`, `
          )})`
        )
      )
      .orderBy(desc(effectiveDateSql));

    // Group rows by transaction
    const txnMap = new Map<number, SearchTransactionRow>();
    for (const row of txnRows) {
      if (!txnMap.has(row.id)) {
        txnMap.set(row.id, {
          id: row.id,
          date: row.date,
          description: row.description,
          notes: row.notes,
          checkNumber: row.checkNumber,
          payee:
            row.payeeId && row.payeeName
              ? { id: row.payeeId, name: row.payeeName }
              : null,
          splits: [],
        });
      }
      const txn = txnMap.get(row.id)!;
      if (row.splitAccountId && row.accountName) {
        txn.splits.push({
          accountId: row.splitAccountId,
          accountName: row.accountName,
          amount: row.splitAmount,
          isFavorite: row.accountIsFavorite,
          subtype: row.accountSubtype,
          isInvestmentCash: row.accountIsInvestmentCash,
        });
      }
    }

    // Maintain date desc order
    txnResults = txnIds
      .map((id) => txnMap.get(id))
      .filter((t): t is SearchTransactionRow => t !== undefined);
  }

  // Search accounts
  const accountResults = await db
    .select({
      id: accounts.id,
      name: accounts.name,
      type: accounts.type,
      subtype: accounts.subtype,
      isFavorite: accounts.isFavorite,
      isActive: accounts.isActive,
    })
    .from(accounts)
    .where(and(eq(accounts.bookId, bookId), like(sql`lower(${accounts.name})`, pattern)))
    .limit(LIMIT);

  // Search payees
  const payeeResults = await db
    .select({
      id: payees.id,
      name: payees.name,
    })
    .from(payees)
    .where(and(eq(payees.bookId, bookId), like(sql`lower(${payees.name})`, pattern)))
    .limit(LIMIT);

  // Search recurring rules
  const ruleResults = await db
    .select({
      id: recurringRules.id,
      name: recurringRules.name,
      frequency: recurringRules.frequency,
      nextDate: recurringRules.nextDate,
      businessDaysOnly: recurringRules.businessDaysOnly,
      isActive: recurringRules.isActive,
    })
    .from(recurringRules)
    .where(
      and(
        eq(recurringRules.bookId, bookId),
        or(
          like(sql`lower(${recurringRules.name})`, pattern),
          like(sql`lower(${recurringRules.templateDescription})`, pattern)
        )
      )
    )
    .limit(LIMIT);

  return {
    transactions: txnResults,
    accounts: accountResults,
    payees: payeeResults,
    recurringRules: ruleResults,
  };
}
