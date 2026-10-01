import { createDatabase, workerDatabasePath } from "./test-database";
import { insert, insertRows, script } from "./sql";
import type {
  AccountSubtype, AccountType, Account, Book, InvestmentLot, InvestmentSplit, Payee, PlaidAccount,
  PlaidToken, PlaidTransactionReconciliation, RecurringRule, Security, SecurityPrice, Transaction, User,
} from "../../types/db";

let didSetup = false;

// The baseline rows: user 1 owns book 1. A trigger makes user 1 the owner.
const BASELINE = `
  INSERT INTO users (id, username, password_hash, created_at)
  VALUES (1, 'testuser', 'unused', strftime('%Y-%m-%d %H:%M:%f', 'now'));
  INSERT INTO books (id, user_id, name, created_at, updated_at)
  VALUES (1, 1, 'Test Book', strftime('%Y-%m-%d %H:%M:%f', 'now'),
          strftime('%Y-%m-%d %H:%M:%f', 'now'));
`;

/**
 * Creates this worker's database from the migrations (`ledger-cli migrate`)
 * with the baseline rows. Once per test file.
 */
export const setupTestDatabase = async () => {
  if (didSetup) return;
  createDatabase(workerDatabasePath());
  await script(BASELINE);
  didSetup = true;
};

/**
 * Clears every row and restarts every ID sequence, then writes the baseline
 * rows again. Every application table depends on users through books or a
 * direct foreign key, so the cascade clears them without a table order.
 */
export const resetTestDatabase = async () => {
  if (!didSetup) throw new Error("Call setupTestDatabase before resetting test data");
  await script(`
    DELETE FROM users;
    DELETE FROM sqlite_sequence;
    ${BASELINE}
  `);
};

export const createAccount = async (data: {
  name: string;
  type: AccountType;
  subtype?: AccountSubtype | null;
  parentId?: number | null;
  isActive?: boolean;
  isFavorite?: boolean;
  isInvestmentCash?: boolean;
  bookId?: number;
}) => {
  const account = await insert<Account>("accounts", {
      bookId: data.bookId ?? 1,
      name: data.name,
      type: data.type,
      subtype: data.subtype ?? null,
      parentId: data.parentId ?? null,
      isActive: data.isActive ?? true,
      isFavorite: data.isFavorite ?? false,
      isInvestmentCash: data.isInvestmentCash ?? false,
    });

  return account;
};

export const createUser = async (data: { username: string; passwordHash?: string }) => {
  const user = await insert<User>("users", {
      username: data.username,
      passwordHash: data.passwordHash ?? "test-hash-not-a-real-credential",
    });

  return user;
};

export const createBook = async (data: {
  name: string;
  userId?: number;
}) => {
  const book = await insert<Book>("books", {
      userId: data.userId ?? 1,
      name: data.name,
    });

  return book;
};

export const addBookMember = async (data: {
  bookId: number;
  userId: number;
  role: "owner" | "editor" | "viewer";
}) => {
  await insert("book_members", data);
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
  const transaction = await insert<Transaction>("transactions", {
      bookId,
      date: data.date,
      description: data.description ?? null,
      checkNumber: data.checkNumber ?? null,
      notes: data.notes ?? null,
      payeeId: data.payeeId ?? null,
      isFloating: data.isFloating ?? false,
      isReconciled: data.isReconciled ?? false,
      recurringRuleId: data.recurringRuleId ?? null,
    });

  await insertRows("transaction_splits", 
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
  const rule = await insert<RecurringRule>("recurring_rules", {
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
    });

  await insertRows("recurring_template_splits", 
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
  const payee = await insert<Payee>("payees", {
      bookId: data.bookId ?? 1,
      name: data.name,
    });

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
  const security = await insert<Security>("securities", {
      bookId: data.bookId ?? 1,
      name: data.name,
      symbol: data.symbol,
      securityType: data.securityType,
      ...(data.fetchPrices !== undefined ? { fetchPrices: data.fetchPrices } : {}),
      ...(data.fixedPriceMicros !== undefined
        ? { fixedPriceMicros: data.fixedPriceMicros }
        : {}),
    });

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
  const lot = await insert<InvestmentLot>("investment_lots", {
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
    });

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
  const split = await insert<InvestmentSplit>("investment_splits", {
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
    });

  return split;
};

export const createSecurityPrice = async (data: {
  securityId: number;
  priceDate: string;
  priceMicros: number;
  source?: string | null;
  bookId?: number;
}) => {
  const price = await insert<SecurityPrice>("security_prices", {
      bookId: data.bookId ?? 1,
      securityId: data.securityId,
      priceDate: data.priceDate,
      priceMicros: data.priceMicros,
      source: data.source ?? null,
    });

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
  const token = await insert<PlaidToken>("plaid_tokens", {
      bookId: data.bookId ?? 1,
      financialInstitution: data.financialInstitution,
      itemId: data.itemId,
      accessToken: data.accessToken,
      syncCursor: data.syncCursor ?? null,
      lastSyncedAt: data.lastSyncedAt ?? null,
      isDemo: data.isDemo ?? false,
    });

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
  const record = await insert<PlaidAccount>("plaid_accounts", {
      bookId: data.bookId ?? 1,
      tokenId: data.tokenId,
      plaidAccountId: data.plaidAccountId,
      name: data.name,
      officialName: data.officialName ?? null,
      mask: data.mask ?? null,
      type: data.type,
      subtype: data.subtype ?? null,
      counterpoiseAccountId: data.counterpoiseAccountId ?? null,
    });

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
  const record = await insert<PlaidTransactionReconciliation>("plaid_transaction_reconciliation", {
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
    });

  return record;
};
