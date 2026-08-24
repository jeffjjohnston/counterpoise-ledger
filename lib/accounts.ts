import { and, eq, lte, sql } from "drizzle-orm";
import type { AppDb } from "@/db";
import { accounts, transactions, transactionSplits, type Account } from "@/db/schema";
import { effectiveDateSql } from "@/lib/accounting";
import type { CreateAccountInput, UpdateAccountInput } from "@/lib/schemas/accounts";

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

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

export class AccountValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountValidationError";
  }
}

export class AccountNotFoundError extends Error {
  constructor(message: string = "Account not found") {
    super(message);
    this.name = "AccountNotFoundError";
  }
}

// ---------------------------------------------------------------------------
// Investment cash sub-account helpers
//
// Moved here verbatim from app/api/b/[bookId]/accounts/route.ts and
// app/api/b/[bookId]/accounts/[id]/route.ts, which carried byte-for-byte
// identical copies. Kept as one copy so the two routes cannot drift again.
// ---------------------------------------------------------------------------

/** True for an asset account with subtype "investment" — the kind that gets a paired cash sub-account. */
export const isInvestmentAccount = (account: { type: string; subtype?: string | null }) =>
  account.type === "asset" && account.subtype === "investment";

const buildInvestmentCashName = (name: string) => `${name} Cash`;

type DbOrTransaction = AppDb | Parameters<Parameters<AppDb["transaction"]>[0]>[0];

/**
 * Creates or renames the auto-managed cash sub-account for an investment
 * account. Called inside the same DB transaction as the investment account's
 * own insert or update, so the pair is created or renamed atomically.
 */
export async function ensureInvestmentCashAccount(
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

// ---------------------------------------------------------------------------
// Write functions
// ---------------------------------------------------------------------------

/**
 * Creates an account. Creating an account with subtype "investment" also
 * creates its paired cash sub-account, inside the same DB transaction.
 */
export async function createAccount(
  db: AppDb,
  bookId: number,
  input: CreateAccountInput
): Promise<Account> {
  const { name, type, subtype, parentId, icon } = input;

  if (parentId) {
    const [parent] = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.id, parentId), eq(accounts.bookId, bookId)));

    if (!parent) {
      throw new AccountValidationError("Invalid parentId");
    }
  }

  const createdAccount = await db.transaction(async (tx) => {
    const [insertedAccount] = await tx
      .insert(accounts)
      .values({
        name,
        type,
        subtype: subtype || null,
        parentId: parentId || null,
        icon: icon ?? null,
        isActive: true,
        bookId,
      })
      .returning();

    if (!insertedAccount) {
      return null;
    }

    if (isInvestmentAccount(insertedAccount)) {
      await ensureInvestmentCashAccount(insertedAccount.id, insertedAccount.name, tx, bookId);
    }

    return insertedAccount;
  });

  if (!createdAccount) {
    throw new Error("Failed to create account");
  }

  return createdAccount;
}

/**
 * Updates an account's fields, and — when it is or becomes an investment
 * account — keeps its paired cash sub-account's name and active state in
 * step. Returns the updated account with its child accounts, matching what
 * the route has always returned.
 */
export async function updateAccount(
  db: AppDb,
  bookId: number,
  accountId: number,
  input: UpdateAccountInput
): Promise<Account & { children: Account[] }> {
  const { name, subtype, parentId, isActive, isFavorite, icon } = input;

  if (parentId) {
    const [parent] = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.id, parentId), eq(accounts.bookId, bookId)));

    if (!parent) {
      throw new AccountValidationError("Invalid parentId");
    }
  }

  const updateResult = await db.transaction(async (tx) => {
    const [existingAccount] = await tx
      .select()
      .from(accounts)
      .where(and(eq(accounts.id, accountId), eq(accounts.bookId, bookId)));

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
      .where(and(eq(accounts.id, accountId), eq(accounts.bookId, bookId)));

    const updatedSnapshot = {
      ...existingAccount,
      name: nextName,
      subtype: nextSubtype,
      parentId: nextParentId,
      isActive: isActive ?? existingAccount.isActive,
      isFavorite: isFavorite ?? existingAccount.isFavorite,
    };

    if (isInvestmentAccount(updatedSnapshot)) {
      await ensureInvestmentCashAccount(accountId, updatedSnapshot.name, tx, bookId);
      if (isActive !== undefined) {
        await tx
          .update(accounts)
          .set({ isActive, updatedAt: new Date() })
          .where(
            and(
              eq(accounts.parentId, accountId),
              eq(accounts.isInvestmentCash, true),
              eq(accounts.bookId, bookId)
            )
          );
      }
    }

    return true;
  });

  if (!updateResult) {
    throw new AccountNotFoundError("Account not found");
  }

  const updatedAccount = await db.query.accounts.findFirst({
    where: and(eq(accounts.id, accountId), eq(accounts.bookId, bookId)),
    with: {
      children: true,
    },
  });

  if (!updatedAccount) {
    throw new AccountNotFoundError("Account not found");
  }

  return updatedAccount;
}

/**
 * Deletes an account. Refuses when the account still has transaction splits
 * or sub-accounts — those must be cleared or reassigned first. Checked in
 * that order: transactions, then sub-accounts, then the delete itself.
 */
export async function deleteAccount(db: AppDb, bookId: number, accountId: number): Promise<void> {
  // Check for transactions using this account
  const splitsCount = await db
    .select({ count: sql<number>`cast(count(*) as integer)` })
    .from(transactionSplits)
    .where(and(eq(transactionSplits.accountId, accountId), eq(transactionSplits.bookId, bookId)));

  if (splitsCount[0].count > 0) {
    throw new AccountValidationError("Cannot delete account with transactions");
  }

  // Check for child accounts
  const childCount = await db
    .select({ count: sql<number>`cast(count(*) as integer)` })
    .from(accounts)
    .where(and(eq(accounts.parentId, accountId), eq(accounts.bookId, bookId)));

  if (childCount[0].count > 0) {
    throw new AccountValidationError("Cannot delete account with sub-accounts");
  }

  const result = await db
    .delete(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.bookId, bookId)))
    .returning();

  if (result.length === 0) {
    throw new AccountNotFoundError("Account not found");
  }
}
