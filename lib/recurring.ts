/**
 * The types of the ledger-core recurrence functions.
 *
 * This module has no code. rust-api/core/src/recurring.rs is the only copy of
 * these functions, and lib/wasm-client.ts calls it as WASM. `RecurringCore`
 * gives the signature of each function that lib/wasm-client.ts exports.
 */
import type { RecurrenceConfig } from "@/lib/accounting";

export interface RecurringCore {
  /**
   * The stored columns of a rule row as a RecurrenceConfig. A day list that
   * is not a JSON array becomes "no day list", so a bad row does not stop a
   * page.
   */
  buildRuleRecurrenceConfig(rule: {
    frequency: string;
    interval?: number | null;
    daysOfWeek: string | null;
    weekOfMonth: string | null;
    daysOfMonth: string | null;
  }): RecurrenceConfig;
  /** The largest "repeat every N" value for the frequency. */
  maxIntervalFor(frequency: RecurrenceConfig["frequency"]): number;
  /**
   * True when the observed date of `nextDate` is not after today plus the
   * lead days. A business-days-only rule observes a weekend date on the
   * Monday after it.
   */
  isRecurringRuleDue(
    nextDate: string,
    today: string,
    autoCreateDaysBefore: number,
    businessDaysOnly?: boolean
  ): boolean;
  /**
   * A canonical string for the fields that `getNextDate()` reads for the
   * frequency, so that two spellings of one schedule give the same key.
   */
  scheduleKey(config: {
    frequency: string;
    interval: number;
    daysOfWeek?: number[] | null;
    weekOfMonth?: string | null;
    daysOfMonth?: number[] | null;
  }): string;
  /**
   * The next observed dates of a schedule, derived as a save derives them:
   * from `seed` when it is given, else from the start date.
   */
  previewOccurrences(input: {
    config: RecurrenceConfig;
    startDate: string;
    businessDaysOnly?: boolean;
    seed?: string;
    count?: number;
    today?: string;
  }): string[];
}
