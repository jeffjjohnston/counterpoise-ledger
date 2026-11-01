export type TypeSafeSettings = {
  enabled: boolean;
  /** The entry suggestions of the transaction form; a second opt-in. */
  entrySuggestionsEnabled: boolean;
  configured: boolean;
  revision: number;
};
export type MatchSnapshot = {
  bookId: number;
  linkId: number;
  reconciliationId: number;
  revision: number;
  mappedAccountId: number;
  effectiveDay: string;
  model: string;
  promptVersion: string;
  merchantSeenBefore: boolean;
  bank: {
    merchant: string;
    name: string;
    amountCents: number;
    authorizedDate: string | null;
    postedDate: string;
    currency: string | null;
  };
  baselineIds: number[];
  candidates: {
    label: string;
    transactionId: number;
    payee: string | null;
    date: string;
    amountCents: number;
    counterpartAccounts: {
      name: string;
      kind: "income" | "expense";
    }[];
  }[];
  // v2 fields. A v1 snapshot has none of them and is match-only.
  history?: {
    merchantPayee: string | null;
    payeeCategories: { account: string; count: number }[];
  };
  payeeOptions?: PayeeOption[];
  categoryOptions?: CategoryOption[];
  baselineCategoryId?: number | null;
};
export type MatchSuggestion =
  | {
      status: "ready";
      evaluationId: number;
      revision: number;
      transactionId: number | null;
      proposal?: Proposal | null;
    }
  | {
      status:
        | "disabled"
        | "skipped"
        | "busy"
        | "limited"
        | "unavailable"
        | "stale";
      evaluationId?: number;
    };

export type ChoiceAnswer = {
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
};

export type PayeeOption = {
  label: string;
  payeeId: number | null;
  name: string;
  source: "merchant_history" | "existing" | "new_from_merchant";
};

export type CategoryOption = {
  label: string;
  accountId: number;
  name: string;
  kind: "income" | "expense";
};

export type TypeSafeAnswers = {
  match?: ChoiceAnswer;
  payee?: ChoiceAnswer;
  category?: ChoiceAnswer;
};

export type Proposal = {
  payee: { name: string; payeeId: number | null };
  category: { accountId: number; name: string };
};

/** A pattern of a payee in one account (`GET …/payees/{id}/entry-patterns`). */
export type EntryPattern = {
  key: string;
  /** Every split of the latest use, the splits on the account included. */
  splits: { accountId: number; amount: number }[];
  count: number;
  lastDate: string;
  /** The last uses have the same amounts, so the fill includes them. */
  stable: boolean;
  range: { min: number; max: number };
};

/** The answer of `POST …/entry-suggestion`. */
export type EntrySuggestion =
  | { status: "ready"; evaluationId: number; choice: string | null; confidence: number }
  | { status: "skipped"; evaluationId: number }
  | { status: "failed"; evaluationId: number; error: string }
  | { status: "busy" | "limited" | "stale" };
