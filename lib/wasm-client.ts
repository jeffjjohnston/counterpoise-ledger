/** Synchronous browser adapter for ledger-core. Keep server imports on lib/*.ts. */
import { initSync, invoke } from "@/lib/wasm/generated/ledger_core";
import { CORE_WASM_BASE64 } from "@/lib/wasm/generated/core-bytes";
import type * as accounting from "@/lib/accounting";
import type * as recurring from "@/lib/recurring";
import type * as formatters from "@/lib/formatters";
import type * as expression from "@/lib/expression";
import { getInvestmentGrossAmountCents as grossAmountFallback } from "@/lib/investment-arithmetic";
import { formatCurrency as formatCurrencyFallback } from "@/lib/formatters";

export type { RecurrenceConfig } from "@/lib/accounting";

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

export const validateSplits = wrap("validateSplits") as typeof accounting.validateSplits;
const MAX_I64 = 9_223_372_036_854_775_807n;
export const getInvestmentGrossAmountCents: typeof accounting.getInvestmentGrossAmountCents = (shares, price) => {
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
export const buildDividendSplits = wrap("buildDividendSplits") as typeof accounting.buildDividendSplits;
export const buildCapGainSplits = wrap("buildCapGainSplits") as typeof accounting.buildCapGainSplits;
export const buildBuySplits = wrap("buildBuySplits") as typeof accounting.buildBuySplits;
export const buildSellSplits = wrap("buildSellSplits") as typeof accounting.buildSellSplits;
export const getNextBusinessDay = wrap("getNextBusinessDay") as typeof accounting.getNextBusinessDay;
export const getNextDate = wrap("getNextDate") as typeof accounting.getNextDate;
export const getDisplayBalance = wrap("getDisplayBalance") as typeof accounting.getDisplayBalance;
export const describeRecurrence = wrap("describeRecurrence") as typeof accounting.describeRecurrence;
export const buildAccountTree = wrap("buildAccountTree") as typeof accounting.buildAccountTree;
export const flattenAccounts = wrap("flattenAccounts") as typeof accounting.flattenAccounts;
export const isDescendantOf = wrap("isDescendantOf") as typeof accounting.isDescendantOf;
export const buildAccountHierarchyName = wrap("buildAccountHierarchyName") as typeof accounting.buildAccountHierarchyName;
export function descendantAccountIds(ancestorId: number, accounts: Parameters<typeof accounting.isDescendantOf>[2]): Set<number> {
  return new Set(call<number[]>("descendantAccountIds", [ancestorId, accounts]));
}
export function accountHierarchyNames(accounts: Parameters<typeof accounting.buildAccountHierarchyName>[1]): Map<number, string> {
  const names = call<Record<string, string>>("accountHierarchyNames", [accounts]);
  return new Map(Object.entries(names).map(([id, name]) => [Number(id), name]));
}
export const resolveAccountIconSource = wrap("resolveAccountIconSource") as typeof accounting.resolveAccountIconSource;
export function buildCategoryLabelMap(
  accounts: Parameters<typeof accounting.buildCategoryLabelMap>[0]
): ReturnType<typeof accounting.buildCategoryLabelMap> {
  const labels = call<Record<string, accounting.CategoryLabel>>("buildCategoryLabelMap", [accounts]);
  return new Map(Object.entries(labels).map(([id, label]) => [Number(id), label]));
}

export const ACCOUNT_TYPE_LABELS = call<typeof accounting.ACCOUNT_TYPE_LABELS>("accountTypeLabels", []);
export const ACCOUNT_SUBTYPE_LABELS = call<typeof accounting.ACCOUNT_SUBTYPE_LABELS>("accountSubtypeLabels", []);
export const ACCOUNT_TYPE_ORDER = call<typeof accounting.ACCOUNT_TYPE_ORDER>("accountTypeOrder", []);
export const BALANCE_SHEET_TYPES = call<typeof accounting.BALANCE_SHEET_TYPES>("balanceSheetTypes", []);

export function getEffectiveDate(transaction: Parameters<typeof accounting.getEffectiveDate>[0]): string {
  if (!transaction.isFloating) return transaction.date;
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return call("getEffectiveDate", [{ date: transaction.date, isFloating: true }, today]);
}

export function flattenAccountTreeWithDepth(
  accounts: Parameters<typeof accounting.flattenAccountTreeWithDepth>[0],
  depth = 0,
  rows: accounting.AccountDepthRow[] = []
): accounting.AccountDepthRow[] {
  rows.push(...call<accounting.AccountDepthRow[]>("flattenAccountTreeWithDepth", [accounts, depth]));
  return rows;
}

export const buildRuleRecurrenceConfig = wrap("buildRuleRecurrenceConfig") as typeof recurring.buildRuleRecurrenceConfig;
export function getOccurrenceDate(
  scheduledDate: string,
  businessDaysOnly: boolean
): string {
  return call("getOccurrenceDate", [scheduledDate, Boolean(businessDaysOnly)]);
}
export const isRecurringRuleDue = wrap("isRecurringRuleDue") as typeof recurring.isRecurringRuleDue;
export const maxIntervalFor = wrap("maxIntervalFor") as typeof recurring.maxIntervalFor;
export const scheduleKey = wrap("scheduleKey") as typeof recurring.scheduleKey;
export const MAX_AUTO_CREATE_DAYS_BEFORE = call<number>("maxAutoCreateDaysBefore", []);

export function previewOccurrences(input: Parameters<typeof recurring.previewOccurrences>[0]): string[] {
  return call("previewOccurrences", [{ ...input, today: input.today ?? toDateString(new Date()) }]);
}

export const formatCurrency: typeof formatters.formatCurrency = (cents) =>
  Number.isSafeInteger(cents) ? call("formatCurrency", [cents]) : formatCurrencyFallback(cents);
export const formatDate = wrap("formatDate") as typeof formatters.formatDate;
export const formatDateShort = wrap("formatDateShort") as typeof formatters.formatDateShort;
export const isValidDateString = wrap("isValidDateString") as typeof formatters.isValidDateString;
export const parseStrictCurrency = wrap("parseStrictCurrency") as typeof formatters.parseStrictCurrency;
export const resolveAmountOnBlur = wrap("resolveAmountOnBlur") as typeof formatters.resolveAmountOnBlur;
export const getAccountShortName = wrap("getAccountShortName") as typeof formatters.getAccountShortName;
export const formatRelativeAge = wrap("formatRelativeAge") as typeof formatters.formatRelativeAge;
export const formatPriceMicrosInput = wrap("formatPriceMicrosInput") as typeof formatters.formatPriceMicrosInput;
export const evaluateExpression = wrap("evaluateExpression") as typeof expression.evaluateExpression;

export function toDateString(date: Date): string {
  if (Number.isNaN(date.getTime())) throw new RangeError("Invalid date passed to toDateString");
  return call("toDateString", [date.getFullYear(), date.getMonth() + 1, date.getDate()]);
}
