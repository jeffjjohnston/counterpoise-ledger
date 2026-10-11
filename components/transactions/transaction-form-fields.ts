// Pure helpers for TransactionForm. They change a saved transaction into
// field values, change field values into splits, and make the onSubmit
// payload. They do not touch React state, so the form keeps the order of its
// state updates and its side effects (toast, confirm, focus).

import { buildReinvestSplits, parseStrictCurrency } from "@/lib/wasm-client";
import type {
  InvestmentSplitInput,
  SplitInput,
  TransactionWithSplits,
} from "@/types";

export type TransactionMode = "simple" | "journal" | "investment";

/**
 * The Action of the investment form. "reinvest" (Dividend Reinvest) is a UI
 * value only: it saves a dividend split and a buy split, not a new action.
 */
export type InvestmentFormAction = InvestmentSplitInput["action"] | "reinvest";

/** The data that the form gives to its `onSubmit` callback. */
export interface TransactionFormSubmitData {
  date: string;
  description: string;
  notes?: string;
  checkNumber?: string;
  payeeName?: string;
  isReconciled?: boolean;
  isFloating?: boolean;
  splits: SplitInput[];
  investmentSplits?: InvestmentSplitInput[];
}

/** The splits of an entry, or the message to show when the entry is not valid. */
export type EntryResult =
  | { splits: SplitInput[]; investmentSplits?: InvestmentSplitInput[] }
  | { error: string };

/** Shares and prices in micros, as the text of an input. Trailing zeros go. */
export const formatMicrosInput = (value: number) => {
  const formatted = (value / 1_000_000).toFixed(6);
  return formatted.replace(/\.?0+$/, "");
};

export interface SimpleFields {
  amount: string;
  toAccountId: number;
  fromAccountId: number;
}

/**
 * The investment fields of a saved transaction. A field that is undefined
 * was not found in the transaction, and the form keeps its current value.
 */
export interface InvestmentFields {
  securityId: number;
  action: InvestmentFormAction;
  shares: string;
  price: string;
  fee: string;
  splitNumerator: string;
  splitDenominator: string;
  dividendAmount?: string;
  capGainAmount?: string;
  accountId?: number;
  incomeAccountId?: number;
  feeAccountId?: number;
}

export interface EditFields {
  date: string;
  description: string;
  checkNumber: string;
  notes: string;
  payeeName: string;
  isReconciled: boolean;
  isFloating: boolean;
  splits: SplitInput[];
  mode: TransactionMode;
  /** Null when the splits are not one debit and one credit. */
  simple: SimpleFields | null;
  /**
   * Null when the transaction does not have exactly one investment split and
   * is not a reinvested dividend that the form can save again unchanged.
   */
  investment: InvestmentFields | null;
}

const centsInput = (cents: number) => (cents / 100).toFixed(2);

/** The simple-mode fields of two splits: the debit is To, the credit is From. */
export function simpleFieldsFromSplits(splits: SplitInput[]): SimpleFields | null {
  if (splits.length !== 2) return null;
  const debitSplit = splits.find((s) => s.amount > 0);
  const creditSplit = splits.find((s) => s.amount < 0);
  if (!debitSplit || !creditSplit) return null;
  return {
    amount: centsInput(debitSplit.amount),
    toAccountId: debitSplit.accountId,
    fromAccountId: creditSplit.accountId,
  };
}

/**
 * The investment fields of a saved transaction, from its first investment
 * split and the accounts of its splits.
 */
export function investmentFieldsFromTransaction(
  transaction: TransactionWithSplits
): InvestmentFields | null {
  const investmentSplit = transaction.investmentSplits?.[0];
  if (!investmentSplit) return null;

  const { splits } = transaction;
  const investmentAccount = splits.find((split) => split.account.subtype === "investment");
  const investmentCashAccount = splits.find((split) => split.account.isInvestmentCash);
  const incomeAccount = splits.find((split) => split.account.type === "income");
  const expenseAccount = splits.find((split) => split.account.type === "expense");
  // The cash split holds the amount of a dividend or a capital gain.
  const cashAmount = investmentCashAccount ? centsInput(investmentCashAccount.amount) : undefined;

  return {
    securityId: investmentSplit.securityId,
    action: investmentSplit.action,
    shares: formatMicrosInput(investmentSplit.sharesMicros),
    price: formatMicrosInput(investmentSplit.priceMicros),
    fee: centsInput(investmentSplit.feesCents ?? 0),
    splitNumerator: investmentSplit.splitNumerator ? String(investmentSplit.splitNumerator) : "",
    splitDenominator: investmentSplit.splitDenominator
      ? String(investmentSplit.splitDenominator)
      : "",
    dividendAmount: investmentSplit.action === "dividend" ? cashAmount : undefined,
    capGainAmount: investmentSplit.action === "capGain" ? cashAmount : undefined,
    // Without a split on the investment account, the parent of the cash
    // account is the investment account.
    accountId: investmentAccount
      ? investmentAccount.accountId
      : investmentCashAccount?.account.parentId || undefined,
    incomeAccountId: incomeAccount?.accountId,
    feeAccountId: expenseAccount?.accountId,
  };
}

/**
 * The Dividend Reinvest fields of a saved transaction: exactly one dividend
 * split and one buy split of the same security. Null for another shape, or
 * when the form would not save the same ledger legs again, for example an
 * imported reinvestment that keeps its fee in the investment leg. Such a
 * transaction opens in journal mode, which keeps its investment splits.
 */
export function reinvestFieldsFromTransaction(
  transaction: TransactionWithSplits
): InvestmentFields | null {
  const investmentSplits = transaction.investmentSplits ?? [];
  if (investmentSplits.length !== 2) return null;
  const dividend = investmentSplits.find((split) => split.action === "dividend");
  const buy = investmentSplits.find((split) => split.action === "buy");
  if (!dividend || !buy || dividend.securityId !== buy.securityId) return null;
  if (!buy.accountId || dividend.accountId !== buy.accountId) return null;

  const { splits } = transaction;
  const incomeSplits = splits.filter((split) => split.account.type === "income");
  const expenseSplits = splits.filter((split) => split.account.type === "expense");
  const cashSplits = splits.filter((split) => split.account.isInvestmentCash);
  if (incomeSplits.length !== 1 || expenseSplits.length > 1 || cashSplits.length > 1) return null;
  // The form saves the remainder to the cash account of the investment
  // account. A remainder in another cash account would move on save.
  if (cashSplits[0] && cashSplits[0].account.parentId !== buy.accountId) return null;
  const dividendCents = -incomeSplits[0].amount;
  const feesCents = buy.feesCents ?? 0;
  const feeAccountId = expenseSplits[0]?.accountId;

  let rebuilt: SplitInput[];
  try {
    rebuilt = buildReinvestSplits({
      securityAccountId: buy.accountId,
      // A remainder of 0 has no cash leg, so the cash account is not read.
      cashAccountId: cashSplits[0]?.accountId ?? 0,
      incomeAccountId: incomeSplits[0].accountId,
      feeAccountId: feesCents > 0 ? feeAccountId : undefined,
      dividendCents,
      sharesMicros: buy.sharesMicros,
      priceMicros: buy.priceMicros,
      feesCents,
    }).splits;
  } catch {
    return null;
  }
  const stored = splits.map((split) => ({ accountId: split.accountId, amount: split.amount }));
  if (!sameSplits(stored, rebuilt)) return null;

  return {
    securityId: buy.securityId,
    action: "reinvest",
    shares: formatMicrosInput(buy.sharesMicros),
    price: formatMicrosInput(buy.priceMicros),
    fee: centsInput(feesCents),
    splitNumerator: "",
    splitDenominator: "",
    dividendAmount: centsInput(dividendCents),
    accountId: buy.accountId,
    incomeAccountId: incomeSplits[0].accountId,
    feeAccountId,
  };
}

/**
 * The field values that open a saved transaction for edit.
 *
 * Investment mode shows one investment split, and its save replaces all the
 * investment splits of the transaction. A transaction with more than one
 * investment split therefore opens in journal mode, unless it is a reinvested
 * dividend that Dividend Reinvest saves again unchanged. A journal save sends
 * no investment splits, and the server keeps the splits that the transaction
 * has.
 */
export function editFieldsFromTransaction(transaction: TransactionWithSplits): EditFields {
  const splits = transaction.splits.map((s) => ({
    accountId: s.accountId,
    amount: s.amount,
  }));
  const investmentSplitCount = transaction.investmentSplits?.length ?? 0;
  const investment =
    investmentSplitCount === 1
      ? investmentFieldsFromTransaction(transaction)
      : reinvestFieldsFromTransaction(transaction);
  let mode: TransactionMode = splits.length === 2 ? "simple" : "journal";
  if (investmentSplitCount > 1) mode = "journal";
  if (investment) mode = "investment";
  return {
    date: transaction.date,
    description: transaction.description || "",
    checkNumber: transaction.checkNumber || "",
    notes: transaction.notes || "",
    payeeName: transaction.payee?.name || "",
    isReconciled: transaction.isReconciled,
    isFloating: transaction.isFloating,
    splits,
    mode,
    simple: simpleFieldsFromSplits(splits),
    investment,
  };
}

/** The two splits of a simple entry, from the amount text and the two accounts. */
export function buildSimpleEntry(
  amountInput: string,
  fromAccountId: number | null,
  toAccountId: number | null
): EntryResult {
  const amount = parseStrictCurrency(amountInput);
  if (!fromAccountId || !toAccountId) return { error: "Please select both accounts" };
  if (amount === null) return { error: "Please enter a valid amount" };
  if (amount <= 0) return { error: "Please enter an amount" };

  // Debit the "to" account, credit the "from" account
  return {
    splits: [
      { accountId: toAccountId, amount: amount },
      { accountId: fromAccountId, amount: -amount },
    ],
  };
}

const sortSplits = (splits: SplitInput[]) =>
  [...splits].sort((a, b) => a.accountId - b.accountId || a.amount - b.amount);

/** True when the two lists hold the same splits, in any order. */
function sameSplits(before: SplitInput[], after: SplitInput[]) {
  if (before.length !== after.length) return false;
  const sortedBefore = sortSplits(before);
  const sortedAfter = sortSplits(after);
  return sortedBefore.every(
    (s, i) => s.accountId === sortedAfter[i].accountId && s.amount === sortedAfter[i].amount
  );
}

/**
 * The material changes to a reconciled transaction: "date", "amount/accounts"
 * or both. Empty when the transaction is new, not reconciled, or not changed
 * in these parts.
 */
export function reconciledEditChanges(
  original: { date: string; isReconciled: boolean; splits: SplitInput[] } | null | undefined,
  date: string,
  splits: SplitInput[]
): string[] {
  if (!original?.isReconciled) return [];
  const changes: string[] = [];
  if (date !== original.date) changes.push("date");
  if (!sameSplits(original.splits, splits)) changes.push("amount/accounts");
  return changes;
}

export const reconciledEditPrompt = (changes: string[]) =>
  `This transaction is reconciled. You are changing its ${changes.join(" and ")}.\n\nSave anyway?`;

export interface SubmitFields {
  date: string;
  description: string;
  notes: string;
  checkNumber: string;
  payeeName: string;
  isReconciled: boolean;
  isFloating: boolean;
  /** The check number is sent only when a bank account is in the entry. */
  hasBankAccountInvolved: boolean;
}

/**
 * The onSubmit payload. Notes go only when they are not blank. The
 * `investmentSplits` key is always there, also when its value is undefined.
 */
export function buildSubmitPayload(
  fields: SubmitFields,
  entry: { splits: SplitInput[]; investmentSplits?: InvestmentSplitInput[] }
): TransactionFormSubmitData {
  const notes = fields.notes.trim();
  return {
    date: fields.date,
    description: fields.description,
    ...(notes && { notes }),
    ...(fields.hasBankAccountInvolved && { checkNumber: fields.checkNumber.trim() }),
    payeeName: fields.payeeName.trim(),
    isReconciled: fields.isReconciled,
    isFloating: fields.isFloating,
    splits: entry.splits,
    investmentSplits: entry.investmentSplits,
  };
}
