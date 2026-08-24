import { and, asc, count, desc, eq, gt, sql } from "drizzle-orm";
import type { AppDb } from "@/db";
import { payees, transactions, transactionSplits, type Payee } from "@/db/schema";
import { effectiveDateSql } from "@/lib/accounting";

export const normalizePayeeName = (name: string) => {
  return name
    .trim()
    .replace(/\s+/g, " ")
    // Normalize various quote characters to straight apostrophe
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u0060\u00B4]/g, "'");
};

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

/** Error for bad input to a payee write. */
export class PayeeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayeeValidationError";
  }
}

/** Error when a payee ID does not exist in this book. */
export class PayeeNotFoundError extends Error {
  constructor(message: string = "Payee not found") {
    super(message);
    this.name = "PayeeNotFoundError";
  }
}

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface CreatePayeeInput {
  name: string;
}

export interface ListPayeesOptions {
  /**
   * Case-insensitive substring match on the payee name. Normalized the same
   * way a stored name is, so a search typed with curly quotes finds the row
   * saved with straight ones. An empty string means "no filter", the same as
   * omitting it.
   */
  search?: string;
  /** Maximum rows to return. Omit for all of them. */
  limit?: number;
}

export interface PayeeListRow {
  id: number;
  name: string;
  /** Effective date of this payee's most recent transaction; null when unused. */
  lastTransactionDate: string | null;
  transactionCount: number;
}

export interface PayeeSummary {
  id: number;
  name: string;
  createdAt: Date;
  transactionCount: number;
}

export interface PayeeDetail extends PayeeSummary {
  /**
   * The account on the largest debit split of this payee's most recent
   * transaction — the "To Account" the transaction form prefills. Null when
   * the payee has no transactions.
   */
  lastAccountId: number | null;
}

// ---------------------------------------------------------------------------
// Read functions
//
// Each of these has two callers — an API route and an MCP tool — which is why
// they live here rather than in either one. They previously existed as two
// hand-kept copies, and the copies had already drifted: the MCP list_payees
// tool never grew the route's `search` and `limit`, so it dumped every payee
// in the book while the route-parity guard, which maps route to tool by name,
// recorded the route as covered.
// ---------------------------------------------------------------------------

/** Lists payees with their transaction count and most recent transaction date. */
export async function listPayees(
  db: AppDb,
  bookId: number,
  options: ListPayeesOptions = {}
): Promise<PayeeListRow[]> {
  const normalizedSearch = options.search ? normalizePayeeName(options.search) : "";
  const bookFilter = eq(payees.bookId, bookId);
  // `%` and `_` in the search term are deliberately not escaped — they behave
  // as LIKE wildcards, exactly as they did before this function existed.
  const whereClause = normalizedSearch
    ? and(bookFilter, sql`lower(${payees.name}) like ${`%${normalizedSearch.toLowerCase()}%`}`)
    : bookFilter;

  const query = db
    .select({
      id: payees.id,
      name: payees.name,
      lastTransactionDate: sql<string | null>`max(${effectiveDateSql})`.as("lastTransactionDate"),
      transactionCount: sql<number>`cast(count(${transactions.id}) as integer)`.as(
        "transactionCount"
      ),
    })
    .from(payees)
    .leftJoin(transactions, eq(transactions.payeeId, payees.id))
    .where(whereClause)
    .groupBy(payees.id)
    .orderBy(asc(payees.name));

  return options.limit ? await query.limit(options.limit) : await query;
}

/**
 * One payee with its transaction count, or undefined when no payee with that
 * id exists in this book.
 */
export async function getPayee(
  db: AppDb,
  bookId: number,
  payeeId: number
): Promise<PayeeSummary | undefined> {
  const [row] = await db
    .select({
      id: payees.id,
      name: payees.name,
      createdAt: payees.createdAt,
      transactionCount: sql<number>`cast(count(${transactions.id}) as integer)`.as(
        "transactionCount"
      ),
    })
    .from(payees)
    .leftJoin(transactions, eq(transactions.payeeId, payees.id))
    .where(and(eq(payees.id, payeeId), eq(payees.bookId, bookId)))
    .groupBy(payees.id);

  return row;
}

/**
 * The account on the largest debit split of a payee's most recent
 * transaction, or null when the payee has no transactions.
 *
 * The split query is scoped by transaction id alone. It does not need its own
 * bookId filter: the transaction it names was already selected within this
 * book, and a split can only belong to one transaction.
 */
export async function getPayeeLastAccountId(
  db: AppDb,
  bookId: number,
  payeeId: number
): Promise<number | null> {
  const [lastTxn] = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(and(eq(transactions.payeeId, payeeId), eq(transactions.bookId, bookId)))
    .orderBy(desc(effectiveDateSql), desc(transactions.id))
    .limit(1);

  if (!lastTxn) return null;

  const [debitSplit] = await db
    .select({ accountId: transactionSplits.accountId })
    .from(transactionSplits)
    .where(and(eq(transactionSplits.transactionId, lastTxn.id), gt(transactionSplits.amount, 0)))
    .orderBy(desc(transactionSplits.amount))
    .limit(1);

  return debitSplit?.accountId ?? null;
}

/**
 * A payee plus its lastAccountId — what the MCP get_payee tool returns.
 *
 * The web UI reads these as two requests (GET /payees/[id] and GET
 * /payees/[id]/last-account) because it needs the last account on its own,
 * while filling in a transaction form. MCP folds them into one tool, which is
 * the permanent waiver tests/mcp/route-coverage.ts records for the
 * last-account route. Both halves come from the functions above, so the
 * folding cannot drift from what the routes return.
 */
export async function getPayeeDetail(
  db: AppDb,
  bookId: number,
  payeeId: number
): Promise<PayeeDetail | undefined> {
  const payee = await getPayee(db, bookId, payeeId);
  if (!payee) return undefined;

  return { ...payee, lastAccountId: await getPayeeLastAccountId(db, bookId, payeeId) };
}

// ---------------------------------------------------------------------------
// Write functions
// ---------------------------------------------------------------------------

/**
 * Creates a payee.
 *
 * This function normalizes the name and inserts a row. It does not change
 * the case of the name. "IKEA" and "Ikea" stay as two different payees. See
 * the Payee Normalization note in CLAUDE.md.
 *
 * The book allows only one payee per exact name — `payees_name_book_unique`,
 * a unique index on (name, bookId) in db/schema.ts. This function does not
 * search for a near-duplicate: a case variant like "Ikea" after "IKEA"
 * always inserts a new row. An EXACT repeat of an existing name in this
 * book is different — the database cannot hold two such rows, so this
 * function checks for one first and raises a clear PayeeValidationError
 * instead of letting the insert hit that constraint and fail with a raw
 * driver error.
 *
 * POST /api/b/[bookId]/payees runs its own broader, case-insensitive search
 * before it calls this function, and returns the match it finds instead of
 * a new row (or an error). That search is a convenience for the "new payee"
 * field on the transaction form — it treats "Blue Bottle" and "blue bottle"
 * as the same payee. This function does not; it only refuses an exact
 * repeat, and it refuses with an error rather than handing back the
 * existing row.
 */
export async function createPayee(
  db: AppDb,
  bookId: number,
  input: CreatePayeeInput
): Promise<Payee> {
  const normalizedName = normalizePayeeName(input.name);
  if (!normalizedName) {
    throw new PayeeValidationError("Name is required");
  }

  const [existing] = await db
    .select({ id: payees.id })
    .from(payees)
    .where(and(eq(payees.bookId, bookId), eq(payees.name, normalizedName)))
    .limit(1);

  if (existing) {
    throw new PayeeValidationError(`A payee named "${normalizedName}" already exists in this book`);
  }

  const [created] = await db
    .insert(payees)
    .values({ name: normalizedName, bookId })
    .returning();

  if (!created) {
    throw new Error("Failed to create payee");
  }

  return created;
}

/**
 * Deletes a payee. Checks run in this order:
 * 1. Confirm the payee exists in this book.
 * 2. Confirm the payee has no transactions.
 * 3. Delete the payee.
 */
export async function deletePayee(db: AppDb, bookId: number, payeeId: number): Promise<void> {
  const [existing] = await db
    .select({ id: payees.id })
    .from(payees)
    .where(and(eq(payees.id, payeeId), eq(payees.bookId, bookId)));

  if (!existing) {
    throw new PayeeNotFoundError("Payee not found");
  }

  const [{ txCount }] = await db
    .select({ txCount: count(transactions.id) })
    .from(transactions)
    .where(eq(transactions.payeeId, payeeId));

  if (txCount > 0) {
    throw new PayeeValidationError("Cannot delete a payee that has associated transactions");
  }

  await db.delete(payees).where(and(eq(payees.id, payeeId), eq(payees.bookId, bookId)));
}
