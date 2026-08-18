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

export function isRecurringRuleDue(
  nextDate: string,
  today: string,
  autoCreateDaysBefore: number
): boolean {
  return nextDate <= addDaysToDateString(today, autoCreateDaysBefore);
}
