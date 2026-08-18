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
} from "@/db/schema";

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
  lotId?: number | null;
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
  counterpoiseAccountId: number;
  counterpoiseAccountName: string;
  lastSyncedAt: string | null;
  lastError: string | null;
  pendingCount: number;
  reviewCount: number;
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
  pending: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
  candidates: SyncMatchCandidate[];
  suggestedCounterAccountId: number | null;
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
