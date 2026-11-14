/**
 * The types of the ledger-core accounting and account-tree functions.
 *
 * This module has no code. The Rust crate in rust-api/core is the only copy of
 * these functions (accounting.rs, accounts.rs and recurring.rs), and
 * lib/wasm-client.ts calls it as WASM. `AccountingCore` gives the signature of
 * each function that lib/wasm-client.ts exports.
 */
import type { AccountWithBalance } from "@/types";

export type InvestmentAction = "buy" | "sell" | "dividend" | "capGain" | "fee" | "split";

export type InvestmentActionInput = {
  action: InvestmentAction;
  sharesMicros: number;
  priceMicros: number;
  feesCents?: number;
  splitNumerator?: number;
  splitDenominator?: number;
};

export type InvestmentSplitInput = {
  accountId: number;
  amount: number;
};

export type InvestmentIncomeBuilderInput = {
  cashAccountId: number;
  incomeAccountId: number;
  amountCents: number;
};

export type InvestmentBuyBuilderInput = {
  securityAccountId: number;
  cashAccountId: number;
  feeAccountId?: number;
  sharesMicros: number;
  priceMicros: number;
  feesCents?: number;
};

export type InvestmentSellBuilderInput = {
  securityAccountId: number;
  cashAccountId: number;
  feeAccountId?: number;
  gainLossAccountId?: number;
  sharesMicros: number;
  priceMicros: number;
  feesCents?: number;
  costBasisCents?: number;
};

export interface RecurrenceConfig {
  frequency: "daily" | "weekly" | "monthly" | "yearly";
  interval: number;
  daysOfWeek?: number[];
  weekOfMonth?: string;
  daysOfMonth?: number[];
}

export type AccountDepthRow = {
  account: AccountWithBalance;
  depth: number;
};

export type ResolvedAccountIcon = {
  /** The inherited or own icon. */
  icon: string;
  /** Short name of the account the icon came from. It can be the account itself. */
  sourceName: string;
};

export type CategoryLabel = {
  /** The resolved icon, or null when neither this account nor an ancestor has one. */
  icon: string | null;
  /** What the ledger prints beside the icon. */
  text: string;
  /** Always the full hierarchy path, for a `title` tooltip. */
  title: string;
};

type IconResolvable = { icon: string | null; parentId: number | null };

type CategoryLabelAccount = {
  id: number;
  name: string;
  type: string;
  icon: string | null;
  parentId: number | null;
  isInvestmentCash?: boolean;
};

export interface AccountingCore {
  /** True when every amount is a whole int4 cent value and the amounts add up to zero. */
  validateSplits(splits: Array<{ amount: number }>): boolean;
  /** Shares x price in cents, exact, with a half cent rounded up. */
  getInvestmentGrossAmountCents(sharesMicros: number, priceMicros: number): number;
  buildDividendSplits(input: InvestmentIncomeBuilderInput): InvestmentSplitInput[];
  buildCapGainSplits(input: InvestmentIncomeBuilderInput): InvestmentSplitInput[];
  /** Throws when there are fees and no fee account. */
  buildBuySplits(input: InvestmentBuyBuilderInput): InvestmentSplitInput[];
  /** Throws when there are fees and no fee account, or a gain or loss and no gain account. */
  buildSellSplits(input: InvestmentSellBuilderInput): InvestmentSplitInput[];
  /** The stored date, or today for a floating transaction. */
  getEffectiveDate(transaction: { date: string; isFloating: boolean }): string;
  /** The next Monday to Friday after the date. Throws on a date that is not a calendar date. */
  getNextBusinessDay(date: string): string;
  getNextDate(currentDate: string, config: RecurrenceConfig): string;
  /** The balance with the sign of the normal balance of the account type. */
  getDisplayBalance(balance: number, type: string): number;
  describeRecurrence(rule: {
    frequency: string;
    interval: number;
    daysOfWeek?: number[] | null;
    weekOfMonth?: string | null;
    daysOfMonth?: number[] | null;
  }): string;
  buildAccountTree(accounts: AccountWithBalance[]): AccountWithBalance[];
  flattenAccounts(accounts: AccountWithBalance[]): AccountWithBalance[];
  flattenAccountTreeWithDepth(accounts: AccountWithBalance[]): AccountDepthRow[];
  /** True when `candidate` is below `ancestorId`. A parentId cycle gives false. */
  isDescendantOf(
    candidate: { parentId: number | null },
    ancestorId: number,
    allAccounts: Array<{ id: number; parentId: number | null }>
  ): boolean;
  /** The display path, such as "Parent : Child". */
  buildAccountHierarchyName(
    account: { name: string; parentId: number | null; isInvestmentCash?: boolean },
    allAccounts: Array<{ id: number; name: string; parentId: number | null; isInvestmentCash?: boolean }>
  ): string;
  /** The first icon on the account or an ancestor, and the account it came from. */
  resolveAccountIconSource(
    account: IconResolvable & { name: string },
    allAccounts: Array<IconResolvable & { id: number; name: string }>
  ): ResolvedAccountIcon | null;
  /** One label for each income and expense account. Other accounts have no entry. */
  buildCategoryLabelMap(allAccounts: CategoryLabelAccount[]): Map<number, CategoryLabel>;
}
