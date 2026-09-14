import { eq, like, or, and, gte, lte, desc, asc, sql } from "drizzle-orm";
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
 * One bucket of ranked results, plus enough to tell a caller the LIMIT cut
 * some rows: `total` is the true match count and `truncated` is whether
 * `items.length` is less than it. Without this, a model reading the MCP
 * search tool cannot tell a complete list from a cut one, and the web route
 * cannot render "25 of 112".
 */
export type SearchBucket<T> = {
  items: T[];
  total: number;
  truncated: boolean;
};

/**
 * Rows here are a SUPERSET of what either surface returns. Each caller
 * projects down to its own response contract — the web route and the MCP tool
 * expose different fields, and neither should change shape just because the
 * query behind them became shared.
 */
export type SearchResults = {
  transactions: SearchTransactionRow[];
  accounts: SearchBucket<{
    id: number;
    name: string;
    type: string;
    subtype: string | null;
    isFavorite: boolean;
    isActive: boolean;
  }>;
  payees: SearchBucket<{ id: number; name: string }>;
  recurringRules: SearchBucket<{
    id: number;
    name: string;
    frequency: string;
    /** Scheduled date — shift it with getOccurrenceDate() before display. */
    nextDate: string;
    businessDaysOnly: boolean;
    isActive: boolean;
  }>;
};

function emptyBucket<T>(): SearchBucket<T> {
  return { items: [], total: 0, truncated: false };
}

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
    return {
      transactions: [],
      accounts: emptyBucket(),
      payees: emptyBucket(),
      recurringRules: emptyBucket(),
    };
  }

  const { startDate, endDate, limit: LIMIT = 25 } = opts;
  const qLower = q.toLowerCase();
  const pattern = `%${qLower}%`;
  // Relevance banding on the same lowered value the WHERE clause already
  // matches on: exact match first, then prefix, then substring. Without this,
  // an exactly-matched row can sort behind 25 prefix/substring matches and
  // become unreachable under the LIMIT.
  const prefixPattern = `${qLower}%`;

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
    // The id tiebreak decides which rows survive the LIMIT, not only their
    // order: transactions that share an effective date are the usual case, so
    // without it the cut through a same-date group is up to the planner and
    // two identical searches can return different transactions. desc(id) is
    // also the order the register uses for this same sort key — see
    // lib/transactions-query.ts.
    .orderBy(desc(effectiveDateSql), desc(transactions.id))
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

  // Search accounts. Relevance band on name, then alphabetical within a band.
  // Each unique index applies to the RAW name, so two names that differ only
  // in case share a relevance band and a lower(name); recurring rule names
  // have no unique index at all. The id tiebreak makes the order total, so
  // .limit() keeps the same rows on every identical search. It is the same
  // tiebreak the transaction query above applies with desc(transactions.id).
  const accountsWhere = and(eq(accounts.bookId, bookId), like(sql`lower(${accounts.name})`, pattern));
  const accountRelevance = sql<number>`case
    when lower(${accounts.name}) = ${qLower} then 0
    when lower(${accounts.name}) like ${prefixPattern} then 1
    else 2
  end`;
  const [accountRows, accountCountRows] = await Promise.all([
    db
      .select({
        id: accounts.id,
        name: accounts.name,
        type: accounts.type,
        subtype: accounts.subtype,
        isFavorite: accounts.isFavorite,
        isActive: accounts.isActive,
      })
      .from(accounts)
      .where(accountsWhere)
      .orderBy(accountRelevance, asc(sql`lower(${accounts.name})`), desc(accounts.id))
      .limit(LIMIT),
    db.select({ count: sql<number>`cast(count(*) as integer)` }).from(accounts).where(accountsWhere),
  ]);
  const accountsTotal = accountCountRows[0]?.count ?? 0;

  // Search payees. Same relevance band as accounts.
  const payeesWhere = and(eq(payees.bookId, bookId), like(sql`lower(${payees.name})`, pattern));
  const payeeRelevance = sql<number>`case
    when lower(${payees.name}) = ${qLower} then 0
    when lower(${payees.name}) like ${prefixPattern} then 1
    else 2
  end`;
  const [payeeRows, payeeCountRows] = await Promise.all([
    db
      .select({
        id: payees.id,
        name: payees.name,
      })
      .from(payees)
      .where(payeesWhere)
      .orderBy(payeeRelevance, asc(sql`lower(${payees.name})`), desc(payees.id))
      .limit(LIMIT),
    db.select({ count: sql<number>`cast(count(*) as integer)` }).from(payees).where(payeesWhere),
  ]);
  const payeesTotal = payeeCountRows[0]?.count ?? 0;

  // Search recurring rules. Matches on name OR templateDescription, but the
  // relevance band is on name alone — a row that matches only
  // templateDescription has no name-relevance band to sit in, so it lands in
  // the substring band (2) along with a plain name substring match.
  const rulesWhere = and(
    eq(recurringRules.bookId, bookId),
    or(
      like(sql`lower(${recurringRules.name})`, pattern),
      like(sql`lower(${recurringRules.templateDescription})`, pattern)
    )
  );
  const ruleRelevance = sql<number>`case
    when lower(${recurringRules.name}) = ${qLower} then 0
    when lower(${recurringRules.name}) like ${prefixPattern} then 1
    else 2
  end`;
  const [ruleRows, ruleCountRows] = await Promise.all([
    db
      .select({
        id: recurringRules.id,
        name: recurringRules.name,
        frequency: recurringRules.frequency,
        nextDate: recurringRules.nextDate,
        businessDaysOnly: recurringRules.businessDaysOnly,
        isActive: recurringRules.isActive,
      })
      .from(recurringRules)
      .where(rulesWhere)
      .orderBy(ruleRelevance, asc(sql`lower(${recurringRules.name})`), desc(recurringRules.id))
      .limit(LIMIT),
    db.select({ count: sql<number>`cast(count(*) as integer)` }).from(recurringRules).where(rulesWhere),
  ]);
  const rulesTotal = ruleCountRows[0]?.count ?? 0;

  return {
    transactions: txnResults,
    accounts: {
      items: accountRows,
      total: accountsTotal,
      truncated: accountsTotal > LIMIT,
    },
    payees: {
      items: payeeRows,
      total: payeesTotal,
      truncated: payeesTotal > LIMIT,
    },
    recurringRules: {
      items: ruleRows,
      total: rulesTotal,
      truncated: rulesTotal > LIMIT,
    },
  };
}
