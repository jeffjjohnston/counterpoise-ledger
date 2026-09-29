import {
  advanceNextDateToFuture,
  advanceToBusinessDay,
  getInitialNextDate,
  getNextDate,
  type RecurrenceConfig,
} from "@/lib/accounting";
import { toDateString } from "@/lib/formatters";

export const MAX_AUTO_CREATE_DAYS_BEFORE = 30;

// Upper bounds for the shared "repeat every N <unit>" interval, one per
// frequency. Each is a round span of roughly the same order — four to ten
// years — chosen so the control refuses nonsense without ever refusing a
// schedule someone might really keep.
// 1461 days = 4 years (including one leap day).
export const MAX_DAILY_INTERVAL_DAYS = 1461;
export const MAX_WEEKLY_INTERVAL_WEEKS = 260; // 5 years
export const MAX_MONTHLY_INTERVAL_MONTHS = 120; // 10 years
export const MAX_YEARLY_INTERVAL_YEARS = 20;

/**
 * The stored columns of a rule row as a RecurrenceConfig.
 *
 * Deliberately not the server's recurrence parser, which lets a malformed
 * daysOfWeek/daysOfMonth fail the request. This one is rendered by client pages against whatever the database
 * holds, so a bad JSON string degrades to "no day list" instead of blanking
 * the page.
 */
export function buildRuleRecurrenceConfig(rule: {
  frequency: string;
  interval?: number | null;
  daysOfWeek: string | null;
  weekOfMonth: string | null;
  daysOfMonth: string | null;
}): RecurrenceConfig {
  const parseDays = (value: string | null): number[] | undefined => {
    if (!value) return undefined;
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  };

  return {
    frequency: rule.frequency as RecurrenceConfig["frequency"],
    interval: Math.max(1, rule.interval ?? 1),
    daysOfWeek: parseDays(rule.daysOfWeek),
    weekOfMonth: rule.weekOfMonth || undefined,
    daysOfMonth: parseDays(rule.daysOfMonth),
  };
}

export function maxIntervalFor(
  frequency: RecurrenceConfig["frequency"]
): number {
  switch (frequency) {
    case "daily":
      return MAX_DAILY_INTERVAL_DAYS;
    case "weekly":
      return MAX_WEEKLY_INTERVAL_WEEKS;
    case "monthly":
      return MAX_MONTHLY_INTERVAL_MONTHS;
    case "yearly":
      return MAX_YEARLY_INTERVAL_YEARS;
  }
}

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

/**
 * A canonical string for everything getNextDate() reads out of a rule, so two
 * schedules can be compared for sameness rather than for byte equality.
 *
 * Normalization matters because the edit form and the stored row spell the
 * same schedule differently. The form sends weekOfMonth "every" where the
 * column holds null, and an empty day list where the column holds null.
 * getNextDate() already treats those pairs as one value — it reads
 * `config.weekOfMonth || "every"` and falls back to the current weekday for an
 * empty daysOfWeek — so a comparison that told them apart would report a
 * change on every save.
 *
 * The same reasoning is why the key is built per frequency. getNextDate()
 * switches on frequency and each branch reads a different subset: daily and
 * yearly read interval alone, weekly reads daysOfWeek and weekOfMonth (and
 * interval only under "every"), monthly reads daysOfMonth. A field outside
 * the branch cannot move a single occurrence, so carrying it here reports a
 * change that is not one.
 *
 * That is reachable, not theoretical. updateRecurringRule writes only the
 * columns its input names, so a partial update — an MCP update_recurring_rule
 * or a raw PUT — can switch a rule to monthly and leave the daysOfWeek its
 * weekly schedule used sitting in the row. The edit form posts null for every
 * field the current frequency does not use, so the very next save looked like
 * a schedule change and re-derived nextDate from the anchor date, dropping a
 * cadence the user had set by hand.
 *
 * startDate is deliberately absent: it is not part of the recurrence config
 * and is compared separately by the one caller.
 */
export function scheduleKey(config: {
  frequency: string;
  interval?: number | null;
  daysOfWeek?: number[] | null;
  weekOfMonth?: string | null;
  daysOfMonth?: number[] | null;
}): string {
  const days = (value: number[] | null | undefined) =>
    value && value.length > 0 ? [...value].sort((a, b) => a - b).join(",") : "";

  const isWeekly = config.frequency === "weekly";
  const weekOfMonth = isWeekly ? config.weekOfMonth || "every" : "every";

  return JSON.stringify({
    frequency: config.frequency,
    // Weekly reads interval only in its "every" branch; an nth-week pattern
    // steps month to month and ignores it. This is the field the form
    // disables under such a pattern for the same reason.
    interval: isWeekly && weekOfMonth !== "every" ? 1 : config.interval || 1,
    daysOfWeek: isWeekly ? days(config.daysOfWeek) : "",
    weekOfMonth,
    daysOfMonth: config.frequency === "monthly" ? days(config.daysOfMonth) : "",
  });
}

// Upper bound on the preview walk. getNextDate is expected to advance every
// step; the `next <= current` guard below breaks out long before this, and
// this only stops a pathological config spinning in the browser.
const MAX_PREVIEW_ITERATIONS = 200;

/**
 * The next few dates a schedule will actually produce, for showing the user
 * what the controls they are setting add up to.
 *
 * The derivation deliberately mirrors updateRecurringRule's: same
 * getInitialNextDate + advanceNextDateToFuture pair, same observe transform.
 * A preview that computed dates its own way could agree with the form and
 * disagree with the save, which is the failure mode this whole feature exists
 * to remove.
 *
 * Dates come back **observed**, not scheduled — a businessDaysOnly rule's
 * Saturday occurrence previews as the Monday it will be dated, because that is
 * the date the user will see in the register.
 */
export function previewOccurrences({
  config,
  startDate,
  businessDaysOnly = false,
  seed,
  count = 3,
  today,
}: {
  config: RecurrenceConfig;
  startDate: string;
  businessDaysOnly?: boolean;
  /**
   * An existing nextDate to walk from. An edit that leaves the schedule alone
   * keeps the rule's stored nextDate, so a preview that always re-derived from
   * startDate would show a cadence the save will not produce.
   */
  seed?: string;
  count?: number;
  today?: string;
}): string[] {
  const observe = (date: string) => getOccurrenceDate(date, businessDaysOnly);

  let current =
    seed ??
    advanceNextDateToFuture(
      getInitialNextDate(startDate, config),
      config,
      today,
      observe
    );

  const dates: string[] = [];
  for (let i = 0; i < count && i < MAX_PREVIEW_ITERATIONS; i++) {
    dates.push(observe(current));
    const next = getNextDate(current, config);
    if (next <= current) break;
    current = next;
  }

  return dates;
}
