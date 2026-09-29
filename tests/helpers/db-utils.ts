import postgres from "postgres";
import { afterAll } from "vitest";
import { ensureTestDatabase, leaseTestDatabase, workerDatabaseName, workerDatabaseUrl } from "./database-safety";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { getDb, getSqlClient_raw } from "../../db";
import {
  accounts,
  bookMembers,
  transactions,
  transactionSplits,
  recurringRules,
  recurringTemplateSplits,
  securities,
  investmentLots,
  investmentSplits,
  securityPrices,
  payees,
  plaidTokens,
  plaidAccounts,
  plaidTransactionReconciliation,
  users,
  books,
} from "../../db/schema";
import type { Account } from "../../db/schema";
import { MIGRATIONS_FOLDER } from "../../db/create-book";

const db = getDb();

export { db };

let didMigrate = false;
let releaseLease: (() => Promise<void>) | undefined;
afterAll(async () => {
  await releaseLease?.();
  releaseLease = undefined;
  didMigrate = false;
});

function createQuietSql(url: string) {
  return postgres(url, {
    onnotice: () => {},
  });
}

async function resetMetaSequences() {
  await db.execute(
    sql`SELECT setval(pg_get_serial_sequence('users', 'id'), 1, true),
               setval(pg_get_serial_sequence('books', 'id'), 1, true)`
  );
}

export const setupTestDatabase = async () => {
  if (didMigrate) return;

  const url = workerDatabaseUrl();
  const name = workerDatabaseName();
  // This run's database does not exist until the first suite in this worker
  // asks for it. Creating it costs about 25ms; the migrate below costs about
  // 250ms and already ran per file under the old scheme, so nothing here is
  // new work beyond the CREATE.
  await ensureTestDatabase(url, name);
  releaseLease ??= await leaseTestDatabase(url, name);

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
  workerDatabaseUrl();
  if (!releaseLease) throw new Error("Call setupTestDatabase before resetting test data");
  // Every application table depends on users through books or a direct FK, so
  // cascading deletes clear them without a hand-kept table order. Reset all
  // public sequences, then advance the two explicit baseline ids. This entire
  // reset and reseed uses one simple-protocol round trip.
  await getSqlClient_raw()`
    DELETE FROM users;
    SELECT setval(format('%I.%I', schemaname, sequencename)::regclass, 1, false)
    FROM pg_sequences WHERE schemaname = 'public';
    INSERT INTO users (id, username, password_hash, created_at)
    VALUES (1, 'testuser', 'unused', NOW());
    INSERT INTO books (id, user_id, name, created_at, updated_at)
    VALUES (1, 1, 'Test Book', NOW(), NOW());
    SELECT setval(pg_get_serial_sequence('users', 'id'), 1, true),
           setval(pg_get_serial_sequence('books', 'id'), 1, true);
  `.simple();
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

export const createUser = async (data: { username: string; passwordHash?: string }) => {
  const [user] = await db
    .insert(users)
    .values({
      username: data.username,
      passwordHash: data.passwordHash ?? "test-hash-not-a-real-credential",
    })
    .returning();

  return user;
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

export const addBookMember = async (data: {
  bookId: number;
  userId: number;
  role: "owner" | "editor" | "viewer";
}) => {
  await db.insert(bookMembers).values(data);
};

export const createTransactionWithSplits = async (data: {
  date: string;
  description?: string | null;
  checkNumber?: string | null;
  notes?: string | null;
  payeeId?: number | null;
  isFloating?: boolean;
  isReconciled?: boolean;
  recurringRuleId?: number | null;
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
      recurringRuleId: data.recurringRuleId ?? null,
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
  businessDaysOnly?: boolean;
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
      businessDaysOnly: data.businessDaysOnly ?? false,
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
