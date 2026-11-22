import type {
  Account,
  Transaction,
  TransactionSplit,
  RecurringRule,
  RecurringTemplateSplit,
  Payee,
  Security,
  SecurityPrice,
  InvestmentLot,
  InvestmentSplit,
  PlaidToken,
  PlaidAccount,
} from "@/types/db";

export type AccountWithBalance = Account & {
  balance: number;
  hasTransactions: boolean;
  children?: AccountWithBalance[];
};

export type TransactionWithSplits = Transaction & {
  payee: Payee | null;
  splits: Array<
    TransactionSplit & {
      account: Account;
    }
  >;
  investmentSplits: Array<
    InvestmentSplit & {
      security?: Security | null;
      account?: Account | null;
    }
  >;
};

export type DisplayTransaction = TransactionWithSplits & {
  isProjected?: boolean;
  /** Synthesized from an unmatched Plaid transaction (not a local transaction). */
  isPlaidPending?: boolean;
  /** Plaid's category for a pending row, shown where split accounts would be. */
  plaidCategory?: string | null;
};

export type RecurringRuleWithSplits = RecurringRule & {
  payee?: Payee | null;
  templateSplits: Array<
    RecurringTemplateSplit & {
      account: Account;
    }
  >;
};

export interface SplitInput {
  accountId: number;
  amount: number;
}

export interface TransactionInput {
  date: string;
  description?: string;
  notes?: string;
  checkNumber?: string;
  payeeName?: string;
  splits: SplitInput[];
}

export interface InvestmentSplitInput {
  securityId: number;
  action: "buy" | "sell" | "dividend" | "capGain" | "fee" | "split";
  sharesMicros: number;
  priceMicros: number;
  feesCents?: number;
  splitNumerator?: number;
  splitDenominator?: number;
}

export interface NetWorthSummary {
  assets: number;
  liabilities: number;
  equity: number;
  netWorth: number;
  income: number;
  expenses: number;
  netIncome: number;
}

export type SecurityWithPrices = Security & {
  prices: SecurityPrice[];
};

export type InvestmentSplitWithDetails = InvestmentSplit & {
  security: Security;
  lot?: InvestmentLot | null;
  transaction?: Transaction;
};

export type PlaidTokenListItem = Pick<
  PlaidToken,
  "id" | "createdAt" | "updatedAt"
> & {
  financialInstitution: string;
  itemId: string;
  accessTokenMasked: string;
  mappedAccountCount: number;
  totalAccountCount: number;
  /** A demo connection has no Plaid Item and cannot be reconnected. */
  isDemo: boolean;
};

/**
 * A Plaid Hosted Link session (`POST sync/link-sessions` and its `check`).
 * It never holds an access token, a public token or a link token.
 */
export type PlaidLinkSession = {
  id: number;
  /** `create` connects a new bank; `update` reconnects `tokenId`. */
  mode: "create" | "update";
  /** The server can add a value. Treat an unknown one as `failed`. */
  status: "pending" | "complete" | "expired" | "failed";
  tokenId: number | null;
  financialInstitution: string | null;
  /** The URL to open in a new tab. Null when the session is not pending. */
  hostedLinkUrl: string | null;
  expiresAt: string;
  error: string | null;
};

export type PlaidAccountAssignment = Pick<
  PlaidAccount,
  "name" | "officialName" | "mask" | "type" | "subtype"
> & {
  plaidAccountId: string;
  counterpoiseAccountId: number | null;
};

export type AssignedSyncAccount = {
  plaidLinkId: number;
  financialInstitution: string;
  tokenId: number;
  itemId: string;
  plaidAccountId: string;
  plaidAccountName: string;
  plaidAccountMask: string | null;
  counterpoiseAccountId: number;
  counterpoiseAccountName: string;
  lastSyncedAt: string | null;
  lastError: string | null;
  pendingCount: number;
  reviewCount: number;
  /** A demo connection has no Plaid Item and cannot be reconnected. */
  isDemo: boolean;
};

export type SyncReviewReason = "plaid_modified" | "plaid_removed";

export type SyncReconciliationStatus = "pending" | "matched" | "created" | "ignored";

export type SyncMatchCandidate = {
  transactionId: number;
  date: string;
  description: string | null;
  payeeName: string | null;
  checkNumber: string | null;
  linkedSplitAmount: number;
  expectedAmount: number;
  amountDelta: number;
  dayDelta: number;
  counterpartAccountNames: string[];
  splitCount: number;
  /** The transaction has investment splits. The server cannot change its amount. */
  isInvestment: boolean;
  score: number;
  scoreTags: string[];
  alreadyLinked: boolean;
};

export type SyncReconciliationItem = {
  id: number;
  plaidAccountLinkId: number;
  plaidTransactionId: string;
  date: string;
  authorizedDate: string | null;
  amountCents: number;
  name: string;
  merchantName: string | null;
  originalDescription: string | null;
  resolutionStatus: SyncReconciliationStatus;
  reviewReason: SyncReviewReason | null;
  matchedTransactionId: number | null;
  /** The account that the link was made on. A remap of the bank account can change the current one. */
  linkedAccountId: number | null;
  pending: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
  candidates: SyncMatchCandidate[];
  suggestedCounterAccountId: number | null;
  /** On a row flagged `plaid_modified`, the fields that the bank changed. Empty otherwise. */
  reviewChanges: SyncReviewChange[];
};

/** One field that the bank changed on a linked row. `amountCents` is in the bank's sign. */
export type SyncReviewChange = {
  field:
    | "date"
    | "amountCents"
    | "name"
    | "merchantName"
    | "originalDescription"
    | "categoryPrimary"
    | "categoryDetailed";
  previous: string | number | null;
  incoming: string | number | null;
};

export type SyncResolveActionPayload =
  | {
      action: "match";
      reconciliationId: number;
      transactionId: number;
    }
  | {
      action: "match_update_amount";
      reconciliationId: number;
      transactionId: number;
    }
  | {
      action: "create";
      reconciliationId: number;
      counterAccountId: number;
      payeeName?: string;
    }
  | {
      action: "ignore" | "keep_local" | "unlink";
      reconciliationId: number;
    };

export type PlaidLinkData = {
  id: number;
  plaidTransactionId: string;
  date: string;
  authorizedDate: string | null;
  amountCents: number;
  name: string;
  merchantName: string | null;
  originalDescription: string | null;
  pending: boolean;
  isoCurrencyCode: string | null;
  categoryPrimary: string | null;
  categoryDetailed: string | null;
  rawJson: string;
};

export type WeeklyReviewKind = "check" | "insight";
export type WeeklyReviewCategory =
  | "duplicate" | "missed_payment" | "unusual_amount" | "price_change"
  | "new_recurring" | "spending_change" | "other";

export interface WeeklyReviewItem {
  id: number;
  kind: WeeklyReviewKind;
  category: WeeklyReviewCategory;
  title: string;
  detail: string;
  transactionIds: number[];
  /** The register account of each transaction; null when it was deleted. */
  transactions: Array<{ id: number; accountId: number | null }>;
  recurringRuleId: number | null;
  dismissedAt: string | null;
}

export interface WeeklyReview {
  id: number;
  source: "schedule" | "manual";
  periodStart: string;
  periodEnd: string;
  status: "running" | "complete" | "failed";
  summary: string | null;
  error: string | null;
  model: string | null;
  startedAt: string;
  completedAt: string | null;
  items: WeeklyReviewItem[];
}

export interface WeeklyReviewState {
  configured: boolean;
  enabled: boolean;
  latest: WeeklyReview | null;
  running: Pick<WeeklyReview, "id" | "periodStart" | "periodEnd" | "startedAt"> | null;
  lastFailure: Pick<WeeklyReview, "id" | "error" | "completedAt"> | null;
}

export interface WeeklyReviewSettings {
  enabled: boolean;
  revision: number;
  configured: boolean;
}
