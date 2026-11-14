/**
 * Synchronous browser adapter for ledger-core. lib/accounting.ts,
 * lib/recurring.ts and lib/formatters.ts give the signatures of the functions.
 */
import { initSync, invoke } from "@/lib/wasm/generated/ledger_core";
import { CORE_WASM_BASE64 } from "@/lib/wasm/generated/core-bytes";
import type * as accounting from "@/lib/accounting";
import type { RecurringCore } from "@/lib/recurring";
import type { FormattersCore } from "@/lib/formatters";
import { getInvestmentGrossAmountCents as grossAmountFallback } from "@/lib/investment-arithmetic";
import { formatCurrency as formatCurrencyFallback } from "@/lib/formatters";

export type { RecurrenceConfig } from "@/lib/accounting";

type Accounting = accounting.AccountingCore;

// The binary is part of the client chunk. Initialization happens before the
// first component render, so amount-field validation never waits for a fetch.
const binary = atob(CORE_WASM_BASE64);
const bytes = new Uint8Array(binary.length);
for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
initSync({ module: bytes });

function call<T>(operation: string, args: unknown[]): T {
  const response = JSON.parse(invoke(operation, JSON.stringify(args))) as
    | { ok: T }
    | { error: string };
  if ("error" in response) throw new Error(response.error);
  return response.ok;
}

const wrap = (operation: string) => (...args: unknown[]) => call(operation, args);

export const validateSplits = wrap("validateSplits") as Accounting["validateSplits"];
const MAX_I64 = 9_223_372_036_854_775_807n;
export const getInvestmentGrossAmountCents: Accounting["getInvestmentGrossAmountCents"] = (shares, price) => {
  // JSON/i64 cannot carry fractional or out-of-range values. The input form can
  // produce both while the user types, so use the exact JavaScript calculation there.
  if (!Number.isFinite(shares) || !Number.isFinite(price)) return 0;
  if (!Number.isSafeInteger(shares) || !Number.isSafeInteger(price)) {
    return grossAmountFallback(shares, price);
  }
  const product = BigInt(shares) * BigInt(price);
  if (product > MAX_I64 * 10_000_000_000n || product < -MAX_I64 * 10_000_000_000n) {
    return grossAmountFallback(shares, price);
  }
  return call("getInvestmentGrossAmountCents", [shares, price]);
};
export const buildDividendSplits = wrap("buildDividendSplits") as Accounting["buildDividendSplits"];
export const buildCapGainSplits = wrap("buildCapGainSplits") as Accounting["buildCapGainSplits"];
export const buildBuySplits = wrap("buildBuySplits") as Accounting["buildBuySplits"];
export const buildSellSplits = wrap("buildSellSplits") as Accounting["buildSellSplits"];

/** The input of `buildReinvestSplits`: a dividend `D` that buys shares and pays a fee. */
export type ReinvestBuilderInput = {
  securityAccountId: number;
  cashAccountId: number;
  incomeAccountId: number;
  feeAccountId?: number;
  dividendCents: number;
  sharesMicros: number;
  priceMicros: number;
  feesCents?: number;
};
export type ReinvestSplits = {
  splits: accounting.InvestmentSplitInput[];
  investmentSplits: Array<{
    action: "dividend" | "buy";
    sharesMicros: number;
    priceMicros: number;
    feesCents: number;
  }>;
};
/**
 * A reinvested dividend as one transaction (`build_reinvest_splits` in
 * rust-api/core/src/accounting.rs). Throws when the dividend does not cover
 * the shares and the fee.
 */
export const buildReinvestSplits = wrap("buildReinvestSplits") as (input: ReinvestBuilderInput) => ReinvestSplits;
/** `(D - F) / shares`, rounded down to micros; null when it is not positive. */
export const reinvestPriceMicros = wrap("reinvestPriceMicros") as (
  dividendCents: number, feesCents: number, sharesMicros: number
) => number | null;
export const getNextBusinessDay = wrap("getNextBusinessDay") as Accounting["getNextBusinessDay"];
export const getNextDate = wrap("getNextDate") as Accounting["getNextDate"];
export const getDisplayBalance = wrap("getDisplayBalance") as Accounting["getDisplayBalance"];
export const describeRecurrence = wrap("describeRecurrence") as Accounting["describeRecurrence"];
export const buildAccountTree = wrap("buildAccountTree") as Accounting["buildAccountTree"];
export const flattenAccounts = wrap("flattenAccounts") as Accounting["flattenAccounts"];
export const isDescendantOf = wrap("isDescendantOf") as Accounting["isDescendantOf"];
export const buildAccountHierarchyName = wrap("buildAccountHierarchyName") as Accounting["buildAccountHierarchyName"];
export function descendantAccountIds(ancestorId: number, accounts: Parameters<Accounting["isDescendantOf"]>[2]): Set<number> {
  return new Set(call<number[]>("descendantAccountIds", [ancestorId, accounts]));
}
export function accountHierarchyNames(accounts: Parameters<Accounting["buildAccountHierarchyName"]>[1]): Map<number, string> {
  const names = call<Record<string, string>>("accountHierarchyNames", [accounts]);
  return new Map(Object.entries(names).map(([id, name]) => [Number(id), name]));
}
export const resolveAccountIconSource = wrap("resolveAccountIconSource") as Accounting["resolveAccountIconSource"];
export function buildCategoryLabelMap(
  accounts: Parameters<Accounting["buildCategoryLabelMap"]>[0]
): ReturnType<Accounting["buildCategoryLabelMap"]> {
  const labels = call<Record<string, accounting.CategoryLabel>>("buildCategoryLabelMap", [accounts]);
  return new Map(Object.entries(labels).map(([id, label]) => [Number(id), label]));
}

export const ACCOUNT_TYPE_LABELS = call<Record<string, string>>("accountTypeLabels", []);
export const ACCOUNT_SUBTYPE_LABELS = call<Record<string, string>>("accountSubtypeLabels", []);
export const ACCOUNT_TYPE_ORDER = call<string[]>("accountTypeOrder", []);
export const BALANCE_SHEET_TYPES = call<string[]>("balanceSheetTypes", []);

export function getEffectiveDate(transaction: Parameters<Accounting["getEffectiveDate"]>[0]): string {
  if (!transaction.isFloating) return transaction.date;
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return call("getEffectiveDate", [{ date: transaction.date, isFloating: true }, today]);
}

export function flattenAccountTreeWithDepth(
  accounts: Parameters<Accounting["flattenAccountTreeWithDepth"]>[0],
  depth = 0,
  rows: accounting.AccountDepthRow[] = []
): accounting.AccountDepthRow[] {
  rows.push(...call<accounting.AccountDepthRow[]>("flattenAccountTreeWithDepth", [accounts, depth]));
  return rows;
}

export const buildRuleRecurrenceConfig = wrap("buildRuleRecurrenceConfig") as RecurringCore["buildRuleRecurrenceConfig"];
export function getOccurrenceDate(
  scheduledDate: string,
  businessDaysOnly: boolean
): string {
  return call("getOccurrenceDate", [scheduledDate, Boolean(businessDaysOnly)]);
}
export const isRecurringRuleDue = wrap("isRecurringRuleDue") as RecurringCore["isRecurringRuleDue"];
export const maxIntervalFor = wrap("maxIntervalFor") as RecurringCore["maxIntervalFor"];
export const scheduleKey = wrap("scheduleKey") as RecurringCore["scheduleKey"];
export const MAX_AUTO_CREATE_DAYS_BEFORE = call<number>("maxAutoCreateDaysBefore", []);

export function previewOccurrences(input: Parameters<RecurringCore["previewOccurrences"]>[0]): string[] {
  return call("previewOccurrences", [{ ...input, today: input.today ?? toDateString(new Date()) }]);
}

export const formatCurrency: FormattersCore["formatCurrency"] = (cents) =>
  Number.isSafeInteger(cents) ? call("formatCurrency", [cents]) : formatCurrencyFallback(cents);
export const formatDate = wrap("formatDate") as FormattersCore["formatDate"];
export const formatDateShort = wrap("formatDateShort") as FormattersCore["formatDateShort"];
export const isValidDateString = wrap("isValidDateString") as FormattersCore["isValidDateString"];
export const parseStrictCurrency = wrap("parseStrictCurrency") as FormattersCore["parseStrictCurrency"];
export const resolveAmountOnBlur = wrap("resolveAmountOnBlur") as FormattersCore["resolveAmountOnBlur"];
export const getAccountShortName = wrap("getAccountShortName") as FormattersCore["getAccountShortName"];
export const formatRelativeAge = wrap("formatRelativeAge") as FormattersCore["formatRelativeAge"];
export const formatPriceMicrosInput = wrap("formatPriceMicrosInput") as FormattersCore["formatPriceMicrosInput"];
export const evaluateExpression = wrap("evaluateExpression") as FormattersCore["evaluateExpression"];

/**
 * The HTML of a Markdown transaction note (`note_html` in
 * rust-api/core/src/notes.rs). The function drops raw HTML and keeps only
 * http, https and mailto links, so the result is safe to put into the page.
 */
export const noteHtml = wrap("noteHtml") as (markdown: string) => string;

export function toDateString(date: Date): string {
  if (Number.isNaN(date.getTime())) throw new RangeError("Invalid date passed to toDateString");
  return call("toDateString", [date.getFullYear(), date.getMonth() + 1, date.getDate()]);
}
