import { sql } from "drizzle-orm";
import type { AccountWithBalance } from "@/types";
import { toDateString, getAccountShortName } from "@/lib/formatters";
import { transactions } from "@/db/schema";

/** `transaction_splits.amount` is an int4 column holding whole cents. */
const INT4_MIN = -2_147_483_648;
const INT4_MAX = 2_147_483_647;

export function validateSplits(splits: Array<{ amount: number }>): boolean {
  // Checked before the sum, not after: a fractional amount balances against its
  // own negation (3.5 + -3.5 === 0), so the zero-sum test alone passes it
  // through to PostgreSQL, which rejects the insert with an opaque 500 instead
  // of the 400 every other invalid payload gets. Range is checked here for the
  // same reason. Number.isInteger also excludes NaN and both infinities.
  if (
    !splits.every(
      (split) =>
        Number.isInteger(split.amount) &&
        split.amount >= INT4_MIN &&
        split.amount <= INT4_MAX
    )
  ) {
    return false;
  }

  const total = splits.reduce((sum, split) => sum + split.amount, 0);
  return total === 0;
}

export type InvestmentAction = "buy" | "sell" | "dividend" | "capGain" | "fee" | "split";

export type InvestmentActionInput = {
  action: InvestmentAction;
  sharesMicros: number;
  priceMicros: number;
  feesCents?: number;
  splitNumerator?: number;
  splitDenominator?: number;
};

export type InvestmentActionSplit = {
  amount: number;
  role: "security" | "cash" | "income" | "expense";
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

/** micros x micros -> cents: 10^6 x 10^6 / 10^2. */
const MICROS_PRODUCT_PER_CENT = 10_000_000_000n;

/**
 * floor((2n + d) / 2d) — the exact integer form of `Math.round(n / d)`,
 * including its half-toward-positive-infinity tie rule, with no double
 * arithmetic anywhere. BigInt division truncates toward zero, so the negative
 * branch corrects it to a true floor; shares and prices are non-negative by
 * contract, but a total function costs one comparison.
 */
function roundHalfUp(numerator: bigint, denominator: bigint): bigint {
  const doubled = numerator * 2n + denominator;
  const divisor = denominator * 2n;
  const quotient = doubled / divisor;
  return doubled < 0n && doubled % divisor !== 0n ? quotient - 1n : quotient;
}

/**
 * The single definition of "shares x price, in cents". `calculateValueCents` in
 * lib/investments.ts delegates here, so positions, lot proceeds and the buy /
 * sell split builders cannot disagree about the same trade.
 *
 * Exact rather than floating point for two reasons found by measurement, not
 * theory. A double loses the half-cent tie at 25 shares x $0.0014 (3.5c, which
 * has to round to 4c), and past 2^53 — reached by any trade over ~$9,000 once
 * both operands are in micros — it cannot represent the product at all. Neither
 * shows up in a typical trade, and both are silent when they do.
 *
 * Inputs are rounded because a caller may have produced them by multiplying
 * user input by 10^6; BigInt() throws on a fractional Number, and a crash is a
 * worse failure than the cent this function exists to get right.
 */
export function getInvestmentGrossAmountCents(
  sharesMicros: number,
  priceMicros: number
): number {
  const shares = BigInt(Math.round(sharesMicros));
  const price = BigInt(Math.round(priceMicros));
  return Number(roundHalfUp(shares * price, MICROS_PRODUCT_PER_CENT));
}

export function buildDividendSplits(
  input: InvestmentIncomeBuilderInput
): InvestmentSplitInput[] {
  return [
    {
      accountId: input.cashAccountId,
      amount: input.amountCents,
    },
    {
      accountId: input.incomeAccountId,
      amount: -input.amountCents,
    },
  ];
}

export function buildCapGainSplits(
  input: InvestmentIncomeBuilderInput
): InvestmentSplitInput[] {
  return buildDividendSplits(input);
}

export function buildBuySplits(
  input: InvestmentBuyBuilderInput
): InvestmentSplitInput[] {
  const grossAmount = getInvestmentGrossAmountCents(
    input.sharesMicros,
    input.priceMicros
  );
  const fees = input.feesCents ?? 0;

  if (fees > 0 && input.feeAccountId === undefined) {
    throw new Error("feeAccountId is required when feesCents is provided.");
  }

  return [
    {
      accountId: input.securityAccountId,
      amount: grossAmount,
    },
    ...(fees > 0 && input.feeAccountId !== undefined
      ? [
          {
            accountId: input.feeAccountId,
            amount: fees,
          },
        ]
      : []),
    {
      accountId: input.cashAccountId,
      amount: -(grossAmount + fees),
    },
  ];
}

export function buildSellSplits(
  input: InvestmentSellBuilderInput
): InvestmentSplitInput[] {
  const grossAmount = getInvestmentGrossAmountCents(
    input.sharesMicros,
    input.priceMicros
  );
  const fees = input.feesCents ?? 0;
  const netCash = grossAmount - fees;
  const securityAmount =
    input.costBasisCents !== undefined ? input.costBasisCents : grossAmount;
  const gainLoss =
    input.costBasisCents !== undefined ? grossAmount - input.costBasisCents : 0;

  if (fees > 0 && input.feeAccountId === undefined) {
    throw new Error("feeAccountId is required when feesCents is provided.");
  }

  if (gainLoss !== 0 && input.gainLossAccountId === undefined) {
    throw new Error(
      "gainLossAccountId is required when costBasisCents produces a gain or loss."
    );
  }

  return [
    {
      accountId: input.cashAccountId,
      amount: netCash,
    },
    ...(fees > 0 && input.feeAccountId !== undefined
      ? [
          {
            accountId: input.feeAccountId,
            amount: fees,
          },
        ]
      : []),
    ...(gainLoss !== 0 && input.gainLossAccountId !== undefined
      ? [
          {
            accountId: input.gainLossAccountId,
            amount: -gainLoss,
          },
        ]
      : []),
    {
      accountId: input.securityAccountId,
      amount: -securityAmount,
    },
  ];
}

export function mapInvestmentActionToSplits(
  input: InvestmentActionInput
): InvestmentActionSplit[] {
  const grossAmount = getInvestmentGrossAmountCents(
    input.sharesMicros,
    input.priceMicros
  );
  const fees = input.feesCents ?? 0;

  switch (input.action) {
    case "buy": {
      return [
        { role: "security", amount: grossAmount },
        ...(fees > 0 ? [{ role: "expense" as const, amount: fees }] : []),
        { role: "cash", amount: -(grossAmount + fees) },
      ];
    }
    case "sell": {
      return [
        { role: "cash", amount: grossAmount - fees },
        ...(fees > 0 ? [{ role: "expense" as const, amount: fees }] : []),
        { role: "security", amount: -grossAmount },
      ];
    }
    case "dividend":
    case "capGain": {
      return [
        { role: "cash", amount: grossAmount },
        { role: "income", amount: -grossAmount },
      ];
    }
    case "fee": {
      const feeAmount = fees > 0 ? fees : grossAmount;
      return [
        { role: "expense", amount: feeAmount },
        { role: "cash", amount: -feeAmount },
      ];
    }
    case "split": {
      return [];
    }
  }
}

export function validateInvestmentAction(input: InvestmentActionInput): boolean {
  const grossAmount = getInvestmentGrossAmountCents(
    input.sharesMicros,
    input.priceMicros
  );
  const fees = input.feesCents ?? 0;

  if (input.sharesMicros < 0 || input.priceMicros < 0 || fees < 0) {
    return false;
  }

  if (input.action === "split") {
    const numerator = input.splitNumerator ?? 0;
    const denominator = input.splitDenominator ?? 0;
    if (!Number.isInteger(numerator) || !Number.isInteger(denominator)) {
      return false;
    }
    return numerator > 0 && denominator > 0;
  }

  if (input.action === "fee") {
    if (fees <= 0 && grossAmount <= 0) {
      return false;
    }
  } else if (input.action === "dividend" || input.action === "capGain") {
    // Dividends and capital gains legitimately have sharesMicros=0, priceMicros=0;
    // the actual dollar amount is in the transaction splits, not in shares × price.
  } else if (grossAmount <= 0) {
    return false;
  }

  const splits = mapInvestmentActionToSplits(input);
  return validateSplits(splits);
}

export function validateInvestmentActions(inputs: InvestmentActionInput[]): boolean {
  return inputs.every((input) => validateInvestmentAction(input));
}

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidDateString(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }

  const match = ISO_DATE_RE.exec(value);
  if (!match) {
    return false;
  }

  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  const candidate = new Date(Date.UTC(year, month - 1, day));

  return (
    candidate.getUTCFullYear() === year &&
    candidate.getUTCMonth() === month - 1 &&
    candidate.getUTCDate() === day
  );
}

/**
 * Returns the effective date for a transaction.
 * Floating transactions always resolve to today; settled transactions use their stored date.
 */
export function getEffectiveDate(transaction: { date: string; isFloating: boolean }): string {
  if (transaction.isFloating) return toDateString(new Date());
  return transaction.date;
}

/**
 * SQL expression that resolves to CURRENT_DATE for floating transactions, otherwise the stored date.
 * Use this in place of `transactions.date` in balance, ordering, and filtering queries.
 */
export const effectiveDateSql = sql<string>`CASE WHEN ${transactions.isFloating} THEN CURRENT_DATE::text ELSE ${transactions.date} END`;

/**
 * Returns the next business day (Mon–Fri) strictly after the given YYYY-MM-DD date.
 * Weekends are skipped; bank holidays are not modeled, so a holiday result just
 * takes another nudge. Throws on a malformed or non-calendar date (Date parsing
 * would otherwise silently normalize overflow, e.g. 2026-02-30 -> 2026-03-02).
 */
export function getNextBusinessDay(date: string): string {
  if (!isValidDateString(date)) {
    throw new Error(`Invalid date: ${date}`);
  }
  const next = parseDateStr(date);
  do {
    next.setDate(next.getDate() + 1);
  } while (next.getDay() === 0 || next.getDay() === 6);
  return formatDateStr(next);
}

/**
 * True when the date falls Mon–Fri. Bank holidays are not modeled, so a
 * holiday reads as a business day — same limitation getNextBusinessDay
 * documents. Throws on a malformed or non-calendar date, for the same reason.
 */
export function isBusinessDay(date: string): boolean {
  if (!isValidDateString(date)) {
    throw new Error(`Invalid date: ${date}`);
  }
  const day = parseDateStr(date).getDay();
  return day !== 0 && day !== 6;
}

/**
 * Returns the given date when it is already a business day, otherwise the next
 * one. This is deliberately not getNextBusinessDay: that answers "what comes
 * after this date?" and always moves, while this answers "when is this date
 * observed?" and leaves a weekday alone.
 */
export function advanceToBusinessDay(date: string): string {
  return isBusinessDay(date) ? date : getNextBusinessDay(date);
}

export function validateInvestmentSplitPayload(
  input: InvestmentActionInput & { securityId: number }
): boolean {
  if (!Number.isFinite(input.securityId)) {
    return false;
  }

  if (!Number.isFinite(input.sharesMicros) || !Number.isFinite(input.priceMicros)) {
    return false;
  }

  if (input.feesCents !== undefined && !Number.isFinite(input.feesCents)) {
    return false;
  }

  if (input.splitNumerator !== undefined && !Number.isInteger(input.splitNumerator)) {
    return false;
  }

  if (input.splitDenominator !== undefined && !Number.isInteger(input.splitDenominator)) {
    return false;
  }

  if (input.action === "split") {
    const numerator = input.splitNumerator ?? 0;
    const denominator = input.splitDenominator ?? 0;
    if (!Number.isInteger(numerator) || !Number.isInteger(denominator)) {
      return false;
    }
    return numerator > 0 && denominator > 0;
  }

  return true;
}

export const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  asset: "Assets",
  liability: "Liabilities",
  equity: "Equity",
  income: "Income",
  expense: "Expenses",
};

export const ACCOUNT_SUBTYPE_LABELS: Record<string, string> = {
  bank: "Bank Account",
  credit_card: "Credit Card",
  loan: "Loan",
  investment: "Investment",
  cash: "Cash",
  other: "Other",
};

// For balance sheet accounts, determines if normal balance is debit (positive) or credit (negative)
// Assets & Expenses: normal balance is debit (positive increases)
// Liabilities, Equity & Income: normal balance is credit (negative increases)
export function getNormalBalanceSign(type: string): number {
  switch (type) {
    case "asset":
    case "expense":
      return 1; // Debit normal
    case "liability":
    case "equity":
    case "income":
      return -1; // Credit normal
    default:
      return 1;
  }
}

// Get display balance (always positive for "normal" balances)
export function getDisplayBalance(balance: number, type: string): number {
  const sign = getNormalBalanceSign(type);
  return balance * sign;
}

export interface RecurrenceConfig {
  frequency: "daily" | "weekly" | "monthly" | "yearly";
  interval: number;
  daysOfWeek?: number[];
  weekOfMonth?: string;
  daysOfMonth?: number[];
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_WEEK = 7 * MS_PER_DAY;

function parseDateStr(dateString: string): Date {
  return new Date(`${dateString}T00:00:00`);
}

function formatDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

function nthWeekdayInMonth(year: number, month: number, weekday: number, n: number): Date | null {
  // Find first occurrence of weekday in month
  const first = new Date(year, month, 1);
  const diff = (weekday - first.getDay() + 7) % 7;
  const firstOccurrence = 1 + diff;
  const day = firstOccurrence + (n - 1) * 7;
  if (day > lastDayOfMonth(year, month)) return null;
  return new Date(year, month, day);
}

function lastWeekdayInMonth(year: number, month: number, weekday: number): Date {
  const last = lastDayOfMonth(year, month);
  const lastDate = new Date(year, month, last);
  const diff = (lastDate.getDay() - weekday + 7) % 7;
  return new Date(year, month, last - diff);
}

function startOfWeek(date: Date): Date {
  const weekStart = new Date(date);
  weekStart.setDate(weekStart.getDate() - weekStart.getDay());
  weekStart.setHours(0, 0, 0, 0);
  return weekStart;
}

function resolveMonthlyDay(day: number, year: number, month: number): number {
  if (day === -1) {
    return lastDayOfMonth(year, month);
  }
  return Math.min(day, lastDayOfMonth(year, month));
}

function normalizeInitialRecurrenceConfig(
  startDate: string,
  config: RecurrenceConfig
): RecurrenceConfig {
  const start = parseDateStr(startDate);
  const interval = Math.max(1, Math.trunc(config.interval || 1));

  if (config.frequency === "weekly") {
    return {
      ...config,
      interval,
      daysOfWeek:
        config.daysOfWeek && config.daysOfWeek.length > 0
          ? config.daysOfWeek
          : [start.getDay()],
      weekOfMonth: config.weekOfMonth || "every",
    };
  }

  if (config.frequency === "monthly") {
    return {
      ...config,
      interval,
      daysOfMonth:
        config.daysOfMonth && config.daysOfMonth.length > 0
          ? config.daysOfMonth
          : [start.getDate()],
    };
  }

  return {
    ...config,
    interval,
  };
}

function isInRequestedWeekOfMonth(date: Date, weekOfMonth: string): boolean {
  if (weekOfMonth === "last") {
    return date.getDate() + 7 > lastDayOfMonth(date.getFullYear(), date.getMonth());
  }

  const weekIndex = Number.parseInt(weekOfMonth, 10);
  if (!Number.isInteger(weekIndex) || weekIndex < 1) {
    return false;
  }

  const dateWeekIndex = Math.floor((date.getDate() - 1) / 7) + 1;
  return dateWeekIndex === weekIndex;
}

function matchesRecurrenceDate(
  dateString: string,
  startDate: string,
  config: RecurrenceConfig
): boolean {
  const date = parseDateStr(dateString);
  const start = parseDateStr(startDate);
  const interval = Math.max(1, Math.trunc(config.interval || 1));

  if (date < start) {
    return false;
  }

  switch (config.frequency) {
    case "daily": {
      const daysDiff = Math.round((date.getTime() - start.getTime()) / MS_PER_DAY);
      return daysDiff % interval === 0;
    }
    case "weekly": {
      const daysOfWeek = config.daysOfWeek && config.daysOfWeek.length > 0
        ? config.daysOfWeek
        : [start.getDay()];

      if (!daysOfWeek.includes(date.getDay())) {
        return false;
      }

      const weekOfMonth = config.weekOfMonth || "every";
      if (weekOfMonth !== "every") {
        return isInRequestedWeekOfMonth(date, weekOfMonth);
      }

      const startWeekStart = startOfWeek(start);
      const dateWeekStart = startOfWeek(date);
      const weeksDiff = Math.round(
        (dateWeekStart.getTime() - startWeekStart.getTime()) / MS_PER_WEEK
      );

      return weeksDiff % interval === 0;
    }
    case "monthly": {
      const monthDiff =
        (date.getFullYear() - start.getFullYear()) * 12 +
        (date.getMonth() - start.getMonth());
      if (monthDiff < 0 || monthDiff % interval !== 0) {
        return false;
      }

      const daysOfMonth = config.daysOfMonth && config.daysOfMonth.length > 0
        ? config.daysOfMonth
        : [start.getDate()];
      return daysOfMonth.some(
        (day) =>
          resolveMonthlyDay(day, date.getFullYear(), date.getMonth()) === date.getDate()
      );
    }
    case "yearly": {
      const yearsDiff = date.getFullYear() - start.getFullYear();
      return (
        yearsDiff % interval === 0 &&
        date.getMonth() === start.getMonth() &&
        date.getDate() === start.getDate()
      );
    }
  }
}

export function getInitialNextDate(
  startDate: string,
  config: RecurrenceConfig
): string {
  const normalizedConfig = normalizeInitialRecurrenceConfig(startDate, config);

  if (matchesRecurrenceDate(startDate, startDate, normalizedConfig)) {
    return startDate;
  }

  return getNextDate(startDate, normalizedConfig);
}

/**
 * Walks a scheduled date forward until it is no longer in the past.
 *
 * `observe` maps a scheduled date to the date the occurrence is actually seen
 * on, and only the comparison against `today` uses it — the returned date stays
 * a scheduled one. A businessDaysOnly rule needs this: its Saturday occurrence
 * is observed on the Monday, so a rule created on that Sunday or Monday must
 * keep the Saturday date rather than discard an occurrence that is still to
 * come. Callers supply getOccurrenceDate() from lib/recurring.ts, which stays
 * the one place the weekend shift is applied; the default leaves dates alone.
 */
export function advanceNextDateToFuture(
  nextDate: string,
  config: RecurrenceConfig,
  today: string = toTodayString(),
  observe: (date: string) => string = (date) => date
): string {
  const MAX_ITERATIONS = 10_000;
  let date = nextDate;
  for (let i = 0; i < MAX_ITERATIONS && observe(date) < today; i++) {
    const next = getNextDate(date, config);
    if (next <= date) {
      return date;
    }
    date = next;
  }
  return date;
}

function toTodayString(): string {
  return toDateString(new Date());
}

export function getNextDate(currentDate: string, config: RecurrenceConfig): string {
  const cur = new Date(currentDate + "T00:00:00");
  const curYear = cur.getFullYear();
  const curMonth = cur.getMonth();
  const curDay = cur.getDate();

  switch (config.frequency) {
    case "daily": {
      const next = new Date(curYear, curMonth, curDay + config.interval);
      return formatDateStr(next);
    }

    case "weekly": {
      const days = config.daysOfWeek && config.daysOfWeek.length > 0
        ? [...config.daysOfWeek].sort((a, b) => a - b)
        : [cur.getDay()];
      const wom = config.weekOfMonth || "every";

      if (wom === "every") {
        // Step forward day-by-day (up to 7*interval) until we land on a matching day
        for (let i = 1; i <= 7 * config.interval; i++) {
          const candidate = new Date(curYear, curMonth, curDay + i);
          if (days.includes(candidate.getDay())) {
            // For interval > 1 ("every Nth week"), check week parity
            if (config.interval === 1) return formatDateStr(candidate);
            // Calculate weeks elapsed from currentDate
            const daysDiff = Math.round((candidate.getTime() - cur.getTime()) / 86400000);
            const weekNum = Math.ceil(daysDiff / 7);
            if (weekNum <= 1 && days.some(d => d > cur.getDay())) {
              // Still in the same week — allow if a later day this week
              if (candidate.getDay() > cur.getDay()) return formatDateStr(candidate);
            } else if (weekNum === config.interval) {
              return formatDateStr(candidate);
            }
          }
        }
        // Fallback: jump interval weeks from the current date's day
        const next = new Date(curYear, curMonth, curDay + 7 * config.interval);
        return formatDateStr(next);
      }

      // Nth week of month or "last"
      const findInMonth = (year: number, month: number, afterDate?: Date): Date | null => {
        const candidates: Date[] = [];
        for (const day of days) {
          let d: Date | null;
          if (wom === "last") {
            d = lastWeekdayInMonth(year, month, day);
          } else {
            const n = parseInt(wom);
            d = nthWeekdayInMonth(year, month, day, n);
          }
          if (d) {
            if (!afterDate || d > afterDate) {
              candidates.push(d);
            }
          }
        }
        if (candidates.length === 0) return null;
        candidates.sort((a, b) => a.getTime() - b.getTime());
        return candidates[0];
      };

      // Try current month first
      let result = findInMonth(curYear, curMonth, cur);
      if (result) return formatDateStr(result);

      // Advance months
      let y = curYear;
      let m = curMonth + 1;
      for (let attempts = 0; attempts < 13; attempts++) {
        if (m > 11) { m = 0; y++; }
        result = findInMonth(y, m);
        if (result) return formatDateStr(result);
        m++;
      }

      // Absolute fallback
      const fallback = new Date(curYear, curMonth + 1, curDay);
      return formatDateStr(fallback);
    }

    case "monthly": {
      const days = config.daysOfMonth && config.daysOfMonth.length > 0
        ? [...config.daysOfMonth].sort((a, b) => {
            // Sort positive days first, then -1 (last) at end
            if (a === -1) return 1;
            if (b === -1) return -1;
            return a - b;
          })
        : [curDay];

      const resolveDay = (day: number, year: number, month: number): number => {
        if (day === -1) return lastDayOfMonth(year, month);
        return Math.min(day, lastDayOfMonth(year, month));
      };

      // Find next matching day in current month
      for (const d of days) {
        const resolved = resolveDay(d, curYear, curMonth);
        if (resolved > curDay) {
          return formatDateStr(new Date(curYear, curMonth, resolved));
        }
      }

      // Advance by interval months
      let y = curYear;
      let m = curMonth + config.interval;
      if (m > 11) {
        y += Math.floor(m / 12);
        m = m % 12;
      }
      const firstDay = resolveDay(days[0], y, m);
      return formatDateStr(new Date(y, m, firstDay));
    }

    case "yearly": {
      const next = new Date(curYear + config.interval, curMonth, curDay);
      return formatDateStr(next);
    }
  }
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export function describeRecurrence(rule: {
  frequency: string;
  interval: number;
  daysOfWeek?: number[] | null;
  weekOfMonth?: string | null;
  daysOfMonth?: number[] | null;
}): string {
  const freq = rule.frequency;
  const interval = rule.interval || 1;

  switch (freq) {
    case "daily": {
      if (interval === 1) return "Daily";
      return `Every ${interval} days`;
    }

    case "weekly": {
      const days = rule.daysOfWeek && rule.daysOfWeek.length > 0
        ? rule.daysOfWeek
        : [];
      const dayNames = days.map(d => DAY_NAMES[d]);
      const wom = rule.weekOfMonth || "every";

      let prefix: string;
      if (wom === "every") {
        prefix = interval === 1 ? "Every" : `Every ${ordinal(interval)}`;
      } else if (wom === "last") {
        prefix = "Last";
      } else {
        prefix = ordinal(parseInt(wom));
      }

      if (dayNames.length === 0) {
        if (wom === "every") return interval === 1 ? "Weekly" : `Every ${interval} weeks`;
        return `${prefix} week of each month`;
      }

      const dayList = dayNames.join(" and ");
      if (wom === "every" && interval === 1) {
        return `Every ${dayList}`;
      }
      if (wom === "every") {
        return `Every ${ordinal(interval)} week on ${dayList}`;
      }
      return `${prefix} ${dayList} of each month`;
    }

    case "monthly": {
      const days = rule.daysOfMonth && rule.daysOfMonth.length > 0
        ? rule.daysOfMonth
        : [];

      let prefix: string;
      if (interval === 1) {
        prefix = "Monthly";
      } else if (interval === 2) {
        prefix = "Every other month";
      } else {
        prefix = `Every ${ordinal(interval)} month`;
      }

      if (days.length === 0) return prefix;

      const dayStrs = days.map(d => d === -1 ? "last day" : ordinal(d));
      return `${prefix} on the ${dayStrs.join(" and ")}`;
    }

    case "yearly": {
      return "Yearly";
    }

    default:
      return freq;
  }
}

// Group accounts by type for display
export function groupAccountsByType<T extends { type: string }>(
  accounts: T[]
): Record<string, T[]> {
  return accounts.reduce(
    (acc, account) => {
      if (!acc[account.type]) {
        acc[account.type] = [];
      }
      acc[account.type].push(account);
      return acc;
    },
    {} as Record<string, T[]>
  );
}

export function flattenAccounts(
  accounts: AccountWithBalance[]
): AccountWithBalance[] {
  const flattened: AccountWithBalance[] = [];
  const walk = (nodes: AccountWithBalance[]) => {
    for (const node of nodes) {
      // Clear children to prevent duplicates when re-flattening
      flattened.push({ ...node, children: [] });
      if (node.children && node.children.length > 0) {
        walk(node.children);
      }
    }
  };
  walk(accounts);
  return flattened;
}

export function buildAccountTree(
  accounts: AccountWithBalance[]
): AccountWithBalance[] {
  const nodeMap = new Map<number, AccountWithBalance>();
  for (const account of accounts) {
    nodeMap.set(account.id, { ...account, children: [] });
  }

  const roots: AccountWithBalance[] = [];
  for (const account of accounts) {
    const node = nodeMap.get(account.id);
    if (!node) continue;
    if (account.parentId && nodeMap.has(account.parentId)) {
      nodeMap.get(account.parentId)?.children?.push(node);
    } else {
      roots.push(node);
    }
  }

  // Sort children alphabetically for all nodes
  const sortChildren = (nodes: AccountWithBalance[]) => {
    for (const node of nodes) {
      if (node.children && node.children.length > 0) {
        node.children.sort((a, b) => a.name.localeCompare(b.name));
        sortChildren(node.children);
      }
    }
  };

  // Sort roots and their children
  roots.sort((a, b) => a.name.localeCompare(b.name));
  sortChildren(roots);

  return roots;
}

export type AccountDepthRow = {
  account: AccountWithBalance;
  depth: number;
};

export function flattenAccountTreeWithDepth(
  accounts: AccountWithBalance[],
  depth = 0,
  rows: AccountDepthRow[] = []
): AccountDepthRow[] {
  for (const account of accounts) {
    rows.push({ account, depth });
    if (account.children && account.children.length > 0) {
      flattenAccountTreeWithDepth(account.children, depth + 1, rows);
    }
  }
  return rows;
}

// Standard order for displaying account types
export const ACCOUNT_TYPE_ORDER = [
  "asset",
  "liability",
  "equity",
  "income",
  "expense",
];

export const BALANCE_SHEET_TYPES = ["asset", "liability", "equity"];
export const INCOME_STATEMENT_TYPES = ["income", "expense"];

/**
 * The maximum number of parent links to follow before giving up. `parentId` is
 * a self-referencing foreign key with no cycle constraint, so a cycle would
 * otherwise recurse until the stack overflows and take the render down with it.
 *
 * A cycle is reachable without any bad data on disk: the account form's live
 * preview builds a label map from an in-memory draft, and choosing one of the
 * edited account's own descendants as its parent makes the two point at each
 * other. Real category trees are two levels deep, so 32 never binds in practice
 * and the cap changes nothing for valid input.
 */
const MAX_HIERARCHY_DEPTH = 32;

/**
 * Is `candidate` somewhere below `ancestorId` in the account tree?
 *
 * Walks upward from the candidate rather than downward from the ancestor, so
 * it costs one pass per candidate with no tree to build. Depth-capped for the
 * same reason as `buildAccountHierarchyName`: the data it reads may already
 * contain a cycle, and a guard against one must not need a cycle-free tree to
 * work.
 *
 * Used to keep an account's own descendants out of its parent picker. Choosing
 * one would make the two point at each other, which the PUT route would happily
 * persist — it validates only that a `parentId` exists in the book.
 */
export function isDescendantOf(
  candidate: { parentId: number | null },
  ancestorId: number,
  allAccounts: Array<{ id: number; parentId: number | null }>
): boolean {
  let current: { parentId: number | null } | undefined = candidate;

  for (let depth = 0; current && depth < MAX_HIERARCHY_DEPTH; depth += 1) {
    const parentId: number | null = current.parentId;
    if (parentId === null) return false;
    if (parentId === ancestorId) return true;

    current = allAccounts.find((a) => a.id === parentId);
  }

  return false;
}

/**
 * Build hierarchical account display name (e.g., "Parent : Child")
 */
export function buildAccountHierarchyName(
  account: { name: string; parentId: number | null; isInvestmentCash?: boolean },
  allAccounts: Array<{ id: number; name: string; parentId: number | null; isInvestmentCash?: boolean }>,
  depth = 0
): string {
  if (!account.parentId || depth >= MAX_HIERARCHY_DEPTH) {
    return account.name;
  }

  const parent = allAccounts.find((a) => a.id === account.parentId);
  if (parent) {
    // For investment cash accounts, just show the parent name
    if (account.isInvestmentCash) {
      return buildAccountHierarchyName(parent, allAccounts, depth + 1);
    }

    // Extract short name (remove parent prefix)
    const lastColonIndex = account.name.lastIndexOf(":");
    const shortName = lastColonIndex === -1 ? account.name : account.name.substring(lastColonIndex + 1);

    // Recursively build parent hierarchy
    const parentHierarchy = buildAccountHierarchyName(parent, allAccounts, depth + 1);
    return `${parentHierarchy} : ${shortName}`;
  }

  return account.name;
}

// `parentId` is a self-referencing foreign key with no cycle constraint, so a
// corrupt row could otherwise loop forever in a direct `resolveAccountIcon` /
// `resolveAccountIconSource` call. It does not protect `buildCategoryLabelMap`:
// that function calls `buildAccountHierarchyName` first, on the same account,
// and that recursion has no depth limit of its own — a cycle stack-overflows
// there before this cap ever gets to run. The account tree is two levels deep
// in practice; 32 is far above any real hierarchy.
const MAX_ICON_DEPTH = 32;

type IconResolvable = { icon: string | null; parentId: number | null };

/**
 * Walks up the account tree and returns the account that supplies the first
 * icon found — the account itself, or the ancestor that owns it.
 *
 * The one and only tree walk for icon resolution. `resolveAccountIcon` and
 * `resolveAccountIconSource` both call this rather than each re-implementing
 * the climb, so the cap, the cycle handling, and the "own icon wins"
 * short-circuit can only ever exist in one place.
 *
 * `if (current.icon)` is truthiness, not a null check, so an empty string
 * would also read as "inherit". That is safe only because
 * `accountIconSchema` in `lib/schemas/accounts.ts` — the sole write path to
 * this column — maps `""` to `null` before it ever reaches the database.
 */
function findIconSource<T extends IconResolvable>(
  account: T,
  allAccounts: Array<T & { id: number }>
): T | undefined {
  let current: T | undefined = account;

  for (let depth = 0; current && depth < MAX_ICON_DEPTH; depth += 1) {
    if (current.icon) return current;
    if (current.parentId === null) return undefined;

    const parentId: number = current.parentId;
    current = allAccounts.find((candidate) => candidate.id === parentId);
  }

  return undefined;
}

/**
 * Walks up the account tree and returns the first icon it finds.
 *
 * `null` on an account means "inherit from the parent", so this returns null
 * only when neither the account nor any ancestor carries one.
 */
export function resolveAccountIcon(
  account: IconResolvable,
  allAccounts: Array<IconResolvable & { id: number }>
): string | null {
  return findIconSource(account, allAccounts)?.icon ?? null;
}

export type ResolvedAccountIcon = {
  /** The inherited or own icon. */
  icon: string;
  /** Short name of the account the icon came from — may be the account itself. */
  sourceName: string;
};

/**
 * Walks up the account tree and returns the first icon found together with
 * the account it came from.
 *
 * `resolveAccountIcon` answers "what icon?"; the account form also needs
 * "from where?", to say "Inherits 🚗 from Automobile". Both run the same
 * walk (`findIconSource`), so the two answers cannot drift apart.
 */
export function resolveAccountIconSource(
  account: IconResolvable & { name: string },
  allAccounts: Array<IconResolvable & { id: number; name: string }>
): ResolvedAccountIcon | null {
  const source = findIconSource(account, allAccounts);
  // `findIconSource` only ever stops on a truthy icon, so `source.icon` is a
  // string here — this guard is for the type checker, not a real case.
  if (!source || !source.icon) return null;

  return { icon: source.icon, sourceName: getAccountShortName(source.name) };
}

export type CategoryLabel = {
  /** The resolved icon, or null when neither this account nor an ancestor has one. */
  icon: string | null;
  /** What the ledger prints beside the icon. */
  text: string;
  /** Always the full hierarchy path, for a `title` tooltip. */
  title: string;
};

type CategoryLabelAccount = {
  id: number;
  name: string;
  type: string;
  icon: string | null;
  parentId: number | null;
  isInvestmentCash?: boolean;
};

/**
 * Precomputes how every category should be displayed.
 *
 * Built once per account list and memoized by the caller, so a long
 * transaction list costs one pass over the accounts rather than a tree walk
 * per row.
 *
 * Only `income` and `expense` accounts get an entry. That is what keeps the
 * feature scoped to categories without a branch in any renderer: an asset
 * account is simply a lookup miss, and the caller keeps its existing display.
 */
export function buildCategoryLabelMap(
  allAccounts: CategoryLabelAccount[]
): Map<number, CategoryLabel> {
  const labels = new Map<number, CategoryLabel>();

  for (const account of allAccounts) {
    if (account.type !== "income" && account.type !== "expense") continue;

    const title = buildAccountHierarchyName(account, allAccounts);
    const icon = resolveAccountIcon(account, allAccounts);

    labels.set(account.id, {
      icon,
      // With no icon the ancestor path is the only thing identifying the
      // category, so it stays. With one, the icon carries what the path did.
      text: icon ? getAccountShortName(account.name) : title,
      title,
    });
  }

  return labels;
}
