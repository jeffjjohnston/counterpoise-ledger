import { advanceToBusinessDay } from "@/lib/accounting";
import { toDateString } from "@/lib/formatters";

export const MAX_AUTO_CREATE_DAYS_BEFORE = 30;

// Upper bound for the "repeat every N days" interval on daily recurring rules.
// 1461 days = 4 years (including one leap day).
export const MAX_DAILY_INTERVAL_DAYS = 1461;

export function isValidAutoCreateDaysBefore(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_AUTO_CREATE_DAYS_BEFORE
  );
}

export function parseAutoCreateDaysBefore(
  value: unknown,
  fallback = 0
): number | null {
  if (value === undefined) {
    return fallback;
  }

  if (!isValidAutoCreateDaysBefore(value)) {
    return null;
  }

  return value;
}

export function addDaysToDateString(dateString: string, days: number): string {
  const date = new Date(`${dateString}T00:00:00`);
  date.setDate(date.getDate() + days);
  return toDateString(date);
}

/**
 * The date an occurrence is actually observed on.
 *
 * A businessDaysOnly rule shifts a weekend occurrence to the following Monday,
 * and the shift is applied *here* — at the point a scheduled date becomes a
 * transaction date — rather than being written back into the rule. Storing the
 * shifted date in nextDate would make getNextDate() compute the following
 * occurrence from the Monday, so a rule due on the 15th would creep to the 17th
 * and stay there. Everything that turns a rule into dates (processing,
 * projections, the due badge, the calendar) goes through this function so the
 * shift is applied once and identically.
 */
export function getOccurrenceDate(
  scheduledDate: string,
  businessDaysOnly: boolean
): string {
  return businessDaysOnly ? advanceToBusinessDay(scheduledDate) : scheduledDate;
}

export function isRecurringRuleDue(
  nextDate: string,
  today: string,
  autoCreateDaysBefore: number,
  businessDaysOnly = false
): boolean {
  // Compares the *observed* date: a rule whose occurrence falls on Saturday is
  // not due until the Monday it will actually be dated.
  return (
    getOccurrenceDate(nextDate, businessDaysOnly) <=
    addDaysToDateString(today, autoCreateDaysBefore)
  );
}
