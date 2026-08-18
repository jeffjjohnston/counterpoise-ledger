import postgres from "postgres";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { getDb } from "../../db";
import {
  accounts,
  transactions,
  transactionSplits,
  recurringRules,
  recurringTemplateSplits,
  securities,
  investmentLots,
  investmentLotAllocations,
  investmentSplits,
  securityPrices,
  payees,
  plaidTokens,
  plaidAccounts,
  plaidTransactionReconciliation,
  issueReports,
  apiKeys,
  sessions,
  users,
  books,
} from "../../db/schema";
import type { Account } from "../../db/schema";
import { MIGRATIONS_FOLDER } from "../../db/create-book";

const db = getDb();

export { db };

let didMigrate = false;

function createQuietSql(url: string) {
  return postgres(url, {
    onnotice: () => {},
  });
}

async function resetMetaSequences() {
  await db.execute(
    sql`SELECT setval(pg_get_serial_sequence('users', 'id'), 1, true)`
  );
  await db.execute(
    sql`SELECT setval(pg_get_serial_sequence('books', 'id'), 1, true)`
  );
}

export const setupTestDatabase = async () => {
  if (didMigrate) return;

  // Drop and recreate schema for clean slate (including drizzle migration metadata)
  const setupSql = createQuietSql(process.env.DATABASE_URL!);
  await setupSql`DROP SCHEMA IF EXISTS drizzle CASCADE`;
  await setupSql`DROP SCHEMA IF EXISTS public CASCADE`;
  await setupSql`CREATE SCHEMA public`;
  await setupSql.end();

  // Run migrations using a fresh connection
  const migrationSql = createQuietSql(process.env.DATABASE_URL!);
  await migrate(drizzle(migrationSql), { migrationsFolder: MIGRATIONS_FOLDER });
  await migrationSql.end();

  // Insert test user and book so foreign key constraints are satisfied
  await db.insert(users).values({ id: 1, username: "testuser", passwordHash: "unused" });
  await db.insert(books).values({ id: 1, userId: 1, name: "Test Book" });
  await resetMetaSequences();

  didMigrate = true;
};

export const resetTestDatabase = async () => {
  // Delete book-scoped data (FK ordering)
  await db.delete(investmentLotAllocations);
  // Must run before transactions: a lot's opened_split_id (-> investment_splits,
  // set null) and closed_transaction_id (-> transactions, set null) can each
  // point at a DIFFERENT transaction than the one it's associated with by
  // account. Deleting every transaction in one bulk statement cascades both
  // FK paths at once, and Postgres's set-null trigger ordering across that
  // combination fails with a bogus FK violation rather than nulling the
  // column. Deleting investment_lots first removes the rows before the
  // cascade has anything to trip over.
  await db.delete(investmentLots);
  await db.delete(plaidTransactionReconciliation);
  await db.delete(plaidAccounts);
  await db.delete(plaidTokens);
  await db.delete(transactionSplits);
  await db.delete(transactions);
  await db.delete(recurringTemplateSplits);
  await db.delete(recurringRules);
  await db.delete(investmentSplits);
  await db.delete(securityPrices);
  await db.delete(securities);
  await db.delete(payees);
  await db.delete(accounts);
  // Delete and re-insert meta data so FK targets always exist
  await db.delete(issueReports);
  await db.delete(apiKeys);
  await db.delete(sessions);
  await db.delete(books);
  await db.delete(users);
  await db.insert(users).values({ id: 1, username: "testuser", passwordHash: "unused" });
  await db.insert(books).values({ id: 1, userId: 1, name: "Test Book" });
  await resetMetaSequences();
};

export const createAccount = async (data: {
  name: string;
  type: Account["type"];
  subtype?: Account["subtype"];
  parentId?: number | null;
  isActive?: boolean;
  isFavorite?: boolean;
  isInvestmentCash?: boolean;
  bookId?: number;
}) => {
  const [account] = await db
    .insert(accounts)
    .values({
      bookId: data.bookId ?? 1,
      name: data.name,
      type: data.type,
      subtype: data.subtype ?? null,
      parentId: data.parentId ?? null,
      isActive: data.isActive ?? true,
      isFavorite: data.isFavorite ?? false,
      isInvestmentCash: data.isInvestmentCash ?? false,
    })
    .returning();

  return account;
};

export const createBook = async (data: {
  name: string;
  userId?: number;
}) => {
  const [book] = await db
    .insert(books)
    .values({
      userId: data.userId ?? 1,
      name: data.name,
    })
    .returning();

  return book;
};

export const createTransactionWithSplits = async (data: {
  date: string;
  description?: string | null;
  checkNumber?: string | null;
  notes?: string | null;
  payeeId?: number | null;
  isFloating?: boolean;
  isReconciled?: boolean;
  bookId?: number;
  splits: Array<{ accountId: number; amount: number }>;
}) => {
  const bookId = data.bookId ?? 1;
  const [transaction] = await db
    .insert(transactions)
    .values({
      bookId,
      date: data.date,
      description: data.description ?? null,
      checkNumber: data.checkNumber ?? null,
      notes: data.notes ?? null,
      payeeId: data.payeeId ?? null,
      isFloating: data.isFloating ?? false,
      isReconciled: data.isReconciled ?? false,
    })
    .returning();

  await db.insert(transactionSplits)
    .values(
      data.splits.map((split) => ({
        bookId,
        transactionId: transaction.id,
        accountId: split.accountId,
        amount: split.amount,
      }))
    );

  return transaction;
};

export const createRecurringRule = async (data: {
  name: string;
  frequency: "daily" | "weekly" | "monthly" | "yearly";
  interval?: number;
  daysOfWeek?: number[] | null;
  weekOfMonth?: string | null;
  daysOfMonth?: number[] | null;
  startDate: string;
  endDate?: string | null;
  nextDate: string;
  autoCreateDaysBefore?: number;
  templateDescription?: string | null;
  payeeId?: number | null;
  isActive?: boolean;
  bookId?: number;
  templateSplits: Array<{ accountId: number; amount: number }>;
}) => {
  const bookId = data.bookId ?? 1;
  const [rule] = await db
    .insert(recurringRules)
    .values({
      bookId,
      name: data.name,
      frequency: data.frequency,
      interval: data.interval ?? 1,
      daysOfWeek:
        data.daysOfWeek === undefined || data.daysOfWeek === null
          ? null
          : JSON.stringify(data.daysOfWeek),
      weekOfMonth: data.weekOfMonth ?? null,
      daysOfMonth:
        data.daysOfMonth === undefined || data.daysOfMonth === null
          ? null
          : JSON.stringify(data.daysOfMonth),
      startDate: data.startDate,
      endDate: data.endDate ?? null,
      nextDate: data.nextDate,
      autoCreateDaysBefore: data.autoCreateDaysBefore ?? 0,
      templateDescription: data.templateDescription ?? null,
      payeeId: data.payeeId ?? null,
      isActive: data.isActive ?? true,
    })
    .returning();

  await db.insert(recurringTemplateSplits).values(
    data.templateSplits.map((split) => ({
      bookId,
      recurringRuleId: rule.id,
      accountId: split.accountId,
      amount: split.amount,
    }))
  );

  return rule;
};

export const createPayee = async (data: { name: string; bookId?: number }) => {
  const [payee] = await db
    .insert(payees)
    .values({
      bookId: data.bookId ?? 1,
      name: data.name,
    })
    .returning();

  return payee;
};

export const createSecurity = async (data: {
  name: string;
  symbol: string;
  securityType: "etf" | "mutual_fund" | "stock";
  fetchPrices?: boolean;
  fixedPriceMicros?: number | null;
  bookId?: number;
}) => {
  const [security] = await db
    .insert(securities)
    .values({
      bookId: data.bookId ?? 1,
      name: data.name,
      symbol: data.symbol,
      securityType: data.securityType,
      ...(data.fetchPrices !== undefined ? { fetchPrices: data.fetchPrices } : {}),
      ...(data.fixedPriceMicros !== undefined
        ? { fixedPriceMicros: data.fixedPriceMicros }
        : {}),
    })
    .returning();

  return security;
};

export const createInvestmentLot = async (data: {
  securityId: number;
  accountId: number;
  acquiredDate: string;
  originalSharesMicros: number;
  originalBasisCents: number;
  remainingSharesMicros?: number;
  remainingBasisCents?: number;
  openedSplitId?: number | null;
  openedTransactionId?: number | null;
  closedTransactionId?: number | null;
  bookId?: number;
}) => {
  const [lot] = await db
    .insert(investmentLots)
    .values({
      bookId: data.bookId ?? 1,
      accountId: data.accountId,
      securityId: data.securityId,
      acquiredDate: data.acquiredDate,
      originalSharesMicros: data.originalSharesMicros,
      originalBasisCents: data.originalBasisCents,
      remainingSharesMicros: data.remainingSharesMicros ?? data.originalSharesMicros,
      remainingBasisCents: data.remainingBasisCents ?? data.originalBasisCents,
      openedSplitId: data.openedSplitId ?? null,
      openedTransactionId: data.openedTransactionId ?? null,
      closedTransactionId: data.closedTransactionId ?? null,
    })
    .returning();

  return lot;
};

export const createInvestmentSplit = async (data: {
  transactionId: number;
  accountId?: number | null;
  securityId: number;
  lotId?: number | null;
  action: "buy" | "sell" | "dividend" | "capGain" | "fee" | "split";
  sharesMicros: number;
  priceMicros: number;
  feesCents?: number;
  splitNumerator?: number | null;
  splitDenominator?: number | null;
  bookId?: number;
}) => {
  const [split] = await db
    .insert(investmentSplits)
    .values({
      bookId: data.bookId ?? 1,
      transactionId: data.transactionId,
      accountId: data.accountId ?? null,
      securityId: data.securityId,
      lotId: data.lotId ?? null,
      action: data.action,
      sharesMicros: data.sharesMicros,
      priceMicros: data.priceMicros,
      feesCents: data.feesCents ?? 0,
      splitNumerator: data.splitNumerator ?? null,
      splitDenominator: data.splitDenominator ?? null,
    })
    .returning();

  return split;
};

export const createSecurityPrice = async (data: {
  securityId: number;
  priceDate: string;
  priceMicros: number;
  source?: string | null;
  bookId?: number;
}) => {
  const [price] = await db
    .insert(securityPrices)
    .values({
      bookId: data.bookId ?? 1,
      securityId: data.securityId,
      priceDate: data.priceDate,
      priceMicros: data.priceMicros,
      source: data.source ?? null,
    })
    .returning();

  return price;
};

export const createPlaidToken = async (data: {
  financialInstitution: string;
  itemId: string;
  accessToken: string;
  syncCursor?: string | null;
  lastSyncedAt?: Date | null;
  bookId?: number;
  isDemo?: boolean;
}) => {
  const [token] = await db
    .insert(plaidTokens)
    .values({
      bookId: data.bookId ?? 1,
      financialInstitution: data.financialInstitution,
      itemId: data.itemId,
      accessToken: data.accessToken,
      syncCursor: data.syncCursor ?? null,
      lastSyncedAt: data.lastSyncedAt ?? null,
      isDemo: data.isDemo ?? false,
    })
    .returning();

  return token;
};

export const createPlaidAccount = async (data: {
  tokenId: number;
  plaidAccountId: string;
  name: string;
  officialName?: string | null;
  mask?: string | null;
  type: string;
  subtype?: string | null;
  counterpoiseAccountId?: number | null;
  bookId?: number;
}) => {
  const [record] = await db
    .insert(plaidAccounts)
    .values({
      bookId: data.bookId ?? 1,
      tokenId: data.tokenId,
      plaidAccountId: data.plaidAccountId,
      name: data.name,
      officialName: data.officialName ?? null,
      mask: data.mask ?? null,
      type: data.type,
      subtype: data.subtype ?? null,
      counterpoiseAccountId: data.counterpoiseAccountId ?? null,
    })
    .returning();

  return record;
};

export const createPlaidReconciliation = async (data: {
  plaidAccountLinkId: number;
  plaidTransactionId: string;
  date: string;
  authorizedDate?: string | null;
  amountCents: number;
  name: string;
  merchantName?: string | null;
  originalDescription?: string | null;
  categoryPrimary?: string | null;
  resolutionStatus?: "pending" | "matched" | "created" | "ignored";
  reviewReason?: "plaid_modified" | "plaid_removed" | null;
  matchedTransactionId?: number | null;
  bookId?: number;
}) => {
  const [record] = await db
    .insert(plaidTransactionReconciliation)
    .values({
      bookId: data.bookId ?? 1,
      plaidAccountLinkId: data.plaidAccountLinkId,
      plaidTransactionId: data.plaidTransactionId,
      date: data.date,
      authorizedDate: data.authorizedDate ?? null,
      amountCents: data.amountCents,
      name: data.name,
      merchantName: data.merchantName ?? null,
      originalDescription: data.originalDescription ?? null,
      pending: false,
      pendingTransactionId: null,
      isoCurrencyCode: "USD",
      unofficialCurrencyCode: null,
      categoryPrimary: data.categoryPrimary ?? null,
      categoryDetailed: null,
      rawJson: "{}",
      resolutionStatus: data.resolutionStatus ?? "pending",
      reviewReason: data.reviewReason ?? null,
      reviewMetadataJson: null,
      matchedTransactionId: data.matchedTransactionId ?? null,
    })
    .returning();

  return record;
};
