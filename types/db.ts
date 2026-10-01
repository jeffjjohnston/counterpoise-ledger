/**
 * The rows of the database tables, as the client and the tests read them:
 * camelCase keys, `Date` for a timestamp, `boolean` for a flag, `number` for
 * every integer. The Rust code owns the schema; keep these types in step
 * with the tables.
 */
import type { MatchSnapshot, TypeSafeAnswers } from "@/lib/typesafe/types";

export type AccountType = "asset" | "liability" | "equity" | "income" | "expense";
export type AccountSubtype = "bank" | "credit_card" | "loan" | "investment" | "cash" | "other";
export type BookRole = "owner" | "editor" | "viewer";
export type SecurityType = "etf" | "mutual_fund" | "stock";
export type InvestmentAction = "buy" | "sell" | "dividend" | "capGain" | "fee" | "split";
export type RecurringFrequency = "daily" | "weekly" | "monthly" | "yearly";
export type ResolutionStatus = "pending" | "matched" | "created" | "ignored";
export type ReviewReason = "plaid_modified" | "plaid_removed";

export interface User {
  id: number;
  username: string;
  passwordHash: string;
  createdAt: Date;
}

export interface Session {
  id: number;
  tokenHash: string;
  userId: number;
  expiresAt: Date;
  createdAt: Date;
}

export interface ApiKey {
  id: number;
  userId: number;
  name: string;
  keyHash: string;
  keyPrefix: string;
  lastUsedAt: Date | null;
  createdAt: Date;
}

export interface Book {
  id: number;
  userId: number;
  name: string;
  upcomingDays: number;
  typesafeReconciliationEnabled: boolean;
  typesafeRevision: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface BookMemberRow {
  bookId: number;
  userId: number;
  role: BookRole;
  createdAt: Date;
}

export interface TypeSafeEvaluation {
  id: number;
  bookId: number;
  reconciliationId: number;
  linkId: number;
  revision: number;
  fingerprint: string;
  attempt: string;
  snapshot: MatchSnapshot;
  status: "pending" | "ready" | "error" | "stale" | "skipped";
  choice: string | null;
  probabilities: Record<string, number> | null;
  confidence: number | null;
  usage: { input_tokens: number; output_tokens: number } | null;
  answers: TypeSafeAnswers | null;
  errorCode: string | null;
  startedAt: Date;
  completedAt: Date | null;
  displayedAt: Date | null;
  latencyMs: number | null;
}

export interface TypeSafeDecision {
  id: number;
  bookId: number;
  reconciliationId: number;
  evaluationId: number | null;
  action: string;
  transactionId: number | null;
  suggestionVisible: boolean;
  acceptedSuggestion: boolean;
  proposalPayeeKept: boolean | null;
  proposalCategoryKept: boolean | null;
  activeReviewMs: number | null;
  decidedAt: Date;
}

export interface IssueReport {
  id: number;
  userId: number;
  description: string;
  type: "bug" | "improvement" | "other";
  page: string;
  status: "new" | "resolved" | "wontfix";
  createdAt: Date;
}

export interface Account {
  id: number;
  bookId: number;
  name: string;
  type: AccountType;
  subtype: AccountSubtype | null;
  parentId: number | null;
  isActive: boolean;
  isFavorite: boolean;
  isInvestmentCash: boolean;
  /** One emoji grapheme. `null` means "inherit from the parent", not "no icon". */
  icon: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Payee {
  id: number;
  bookId: number;
  name: string;
  createdAt: Date;
}

export interface Transaction {
  id: number;
  bookId: number;
  date: string;
  description: string | null;
  checkNumber: string | null;
  notes: string | null;
  payeeId: number | null;
  isReconciled: boolean;
  isFloating: boolean;
  recurringRuleId: number | null;
  createdBy: number | null;
  updatedBy: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Security {
  id: number;
  bookId: number;
  name: string;
  symbol: string;
  securityType: SecurityType;
  fetchPrices: boolean;
  /** A price that never moves. `null` means the price comes from the price rows. */
  fixedPriceMicros: number | null;
  createdAt: Date;
}

export interface SecurityPrice {
  securityId: number;
  bookId: number;
  priceDate: string;
  priceMicros: number;
  source: string | null;
}

export interface InvestmentLot {
  id: number;
  bookId: number;
  accountId: number;
  securityId: number;
  acquiredDate: string;
  openedSplitId: number | null;
  openedTransactionId: number | null;
  closedTransactionId: number | null;
  originalSharesMicros: number;
  originalBasisCents: number;
  remainingSharesMicros: number;
  remainingBasisCents: number;
  createdAt: Date;
}

export interface InvestmentSplit {
  id: number;
  bookId: number;
  transactionId: number;
  accountId: number | null;
  securityId: number;
  action: InvestmentAction;
  sharesMicros: number;
  priceMicros: number;
  feesCents: number;
  splitNumerator: number | null;
  splitDenominator: number | null;
}

export interface InvestmentLotAllocation {
  id: number;
  bookId: number;
  lotId: number;
  sellSplitId: number;
  transactionId: number;
  sharesMicros: number;
  basisCents: number;
  proceedsCents: number;
}

export interface TransactionSplit {
  id: number;
  bookId: number;
  transactionId: number;
  accountId: number;
  /** Positive is a debit, negative a credit. */
  amount: number;
}

export interface RecurringRule {
  id: number;
  bookId: number;
  name: string;
  frequency: RecurringFrequency;
  interval: number;
  daysOfWeek: string | null;
  weekOfMonth: string | null;
  daysOfMonth: string | null;
  startDate: string;
  endDate: string | null;
  nextDate: string;
  businessDaysOnly: boolean;
  autoCreateDaysBefore: number;
  templateDescription: string | null;
  payeeId: number | null;
  isActive: boolean;
  createdAt: Date;
}

export interface RecurringTemplateSplit {
  id: number;
  bookId: number;
  recurringRuleId: number;
  accountId: number;
  amount: number;
}

export interface PlaidToken {
  id: number;
  bookId: number;
  financialInstitution: string;
  itemId: string;
  accessToken: string;
  syncCursor: string | null;
  lastSyncedAt: Date | null;
  lastError: string | null;
  isDemo: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface PlaidAccount {
  id: number;
  bookId: number;
  tokenId: number;
  plaidAccountId: string;
  name: string;
  officialName: string | null;
  mask: string | null;
  type: string;
  subtype: string | null;
  counterpoiseAccountId: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PlaidTransactionReconciliation {
  id: number;
  bookId: number;
  plaidAccountLinkId: number;
  plaidTransactionId: string;
  date: string;
  authorizedDate: string | null;
  amountCents: number;
  name: string;
  merchantName: string | null;
  originalDescription: string | null;
  pending: boolean;
  pendingTransactionId: string | null;
  isoCurrencyCode: string | null;
  unofficialCurrencyCode: string | null;
  categoryPrimary: string | null;
  categoryDetailed: string | null;
  rawJson: string;
  resolutionStatus: ResolutionStatus;
  reviewReason: ReviewReason | null;
  reviewMetadataJson: string | null;
  matchedTransactionId: number | null;
  resolvedAt: Date | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  createdAt: Date;
  updatedAt: Date;
}
