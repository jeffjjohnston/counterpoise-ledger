/**
 * Phase 7: Recurring Reminder Import
 */

import type { MoneydanceReminder, ImportOptions } from "../types";
import { IdMapper } from "../types";
import { getNextDate, type RecurrenceConfig } from "../../../lib/accounting";
import { toDateString } from "../../../lib/formatters";
import { convertDate, normalizeName } from "../utils/format";
import { getDb, type AppDb } from "../../../db";
import { recurringRules, recurringTemplateSplits } from "../../../db/schema";

const MAX_AUTO_CREATE_DAYS = 30;
const MAX_NEXT_DATE_ADVANCE_STEPS = 10_000;

/**
 * Parse Moneydance reminder frequency flags into a Counterpoise RecurrenceConfig.
 * Returns null if the frequency pattern is unrecognizable.
 */
export function parseReminderFrequency(
  reminder: MoneydanceReminder
): RecurrenceConfig | null {
  const yearly = parseInt(reminder.yearly ?? "0") || 0;
  const monthlydays = parseInt(reminder.monthlydays ?? "0") || 0;
  const monthlymod = parseInt(reminder.monthlymod ?? "0") || 0;
  const daily = parseInt(reminder.daily ?? "0") || 0;
  const weeklymod = parseInt(reminder.weeklymod ?? "0") || 0;

  // Yearly
  if (yearly === 1) {
    return { frequency: "yearly", interval: 1 };
  }

  // Monthly (with optional multi-month interval)
  if (monthlydays > 0) {
    const interval = monthlymod > 1 ? monthlymod : 1;
    return { frequency: "monthly", interval, daysOfMonth: [monthlydays] };
  }

  // Daily-based frequencies
  if (daily > 0) {
    // If weeklymod is set, it's an every-N-weeks pattern
    if (weeklymod > 0) {
      return { frequency: "weekly", interval: weeklymod };
    }
    // If divisible by 7, convert to weekly for better semantics
    if (daily % 7 === 0) {
      return { frequency: "weekly", interval: daily / 7 };
    }
    // Pure daily interval
    return { frequency: "daily", interval: daily };
  }

  return null;
}

/**
 * Extract template splits from a reminder's embedded txn.* fields.
 *
 * The parent account gets its amount computed as the sum of all child pamt values
 * (parent amount = -sum of child samts). Each child split uses its samt value.
 *
 * Returns null if the reminder has no valid template transaction.
 */
export function extractTemplateSplits(reminder: MoneydanceReminder): {
  parentAccountId: string;
  templateDescription: string | null;
  splits: Array<{ acctid: string; amount: number }>;
} | null {
  const parentAcctId = reminder["txn.acctid"] as string | undefined;
  if (!parentAcctId) return null;

  const templateDescription = (reminder["txn.desc"] as string) || null;

  // Collect child split indexes
  const indexes = new Set<number>();
  for (const key of Object.keys(reminder)) {
    const match = key.match(/^txn\.(\d+)\./);
    if (match) {
      indexes.add(parseInt(match[1]));
    }
  }

  // Extract child splits
  const childSplits: Array<{ acctid: string; amount: number }> = [];
  let parentAmount = 0;

  for (const index of Array.from(indexes).sort((a, b) => a - b)) {
    const acctid = reminder[`txn.${index}.acctid`] as string | undefined;
    const samtStr = reminder[`txn.${index}.samt`] as string | undefined;
    const pamtStr = reminder[`txn.${index}.pamt`] as string | undefined;

    if (!acctid || !samtStr) continue;

    const samt = parseInt(samtStr);
    if (isNaN(samt)) continue;

    childSplits.push({ acctid, amount: samt });

    // Accumulate pamt for parent amount calculation
    if (pamtStr) {
      const pamt = parseInt(pamtStr);
      if (!isNaN(pamt)) {
        parentAmount += pamt;
      }
    }
  }

  if (childSplits.length === 0) return null;

  return {
    parentAccountId: parentAcctId,
    templateDescription,
    splits: [
      { acctid: parentAcctId, amount: parentAmount },
      ...childSplits,
    ],
  };
}

/**
 * Moneydance reminder ack dates can be stale (already in the past).
 * Advance to the first recurrence date on or after today so imported
 * reminders start from the upcoming occurrence.
 */
export function normalizeReminderNextDate(
  startDate: string,
  ackDate: string,
  recurrence: RecurrenceConfig,
  today: string = toDateString(new Date())
): string {
  let nextDate = ackDate < startDate ? startDate : ackDate;
  let steps = 0;

  while (nextDate < today && steps < MAX_NEXT_DATE_ADVANCE_STEPS) {
    const candidate = getNextDate(nextDate, recurrence);
    if (candidate <= nextDate) break;
    nextDate = candidate;
    steps++;
  }

  return nextDate;
}

/**
 * Import Moneydance reminders as Counterpoise recurring rules.
 */
export async function importReminders(
  reminders: MoneydanceReminder[],
  idMapper: IdMapper,
  options: ImportOptions,
  dbOverride?: AppDb,
  bookId?: number
): Promise<{
  imported: number;
  skipped: number;
  errors: Array<{ reminder: string; error: string }>;
}> {
  console.log("\n🔄 Phase 7: Importing Recurring Reminders");
  console.log("=".repeat(60));
  const db = dbOverride ?? getDb();

  const stats = {
    imported: 0,
    skipped: 0,
    errors: [] as Array<{ reminder: string; error: string }>,
  };

  console.log(`Found ${reminders.length} reminders`);

  if (!options.dryRun) {
    for (const reminder of reminders) {
      try {
        // 1. Parse frequency
        const recurrence = parseReminderFrequency(reminder);
        if (!recurrence) {
          if (options.verbose) {
            console.log(`  ⊗ Skipping ${reminder.desc}: Unrecognizable frequency pattern`);
          }
          stats.skipped++;
          continue;
        }

        // 2. Extract template splits
        const template = extractTemplateSplits(reminder);
        if (!template) {
          if (options.verbose) {
            console.log(`  ⊗ Skipping ${reminder.desc}: No valid template transaction`);
          }
          stats.skipped++;
          continue;
        }

        // 3. Map all account IDs — check for _CASH suffix for investment accounts
        const mappedSplits: Array<{ accountId: number; amount: number }> = [];
        let allAccountsMapped = true;

        for (const split of template.splits) {
          let accountId = idMapper.getAccount(split.acctid);
          if (!accountId) {
            // Try the _CASH suffix for investment accounts
            accountId = idMapper.getAccount(`${split.acctid}_CASH`);
          }
          if (!accountId) {
            allAccountsMapped = false;
            break;
          }
          mappedSplits.push({ accountId, amount: split.amount });
        }

        if (!allAccountsMapped) {
          if (options.verbose) {
            console.log(`  ⊗ Skipping ${reminder.desc}: Referenced accounts not imported`);
          }
          stats.skipped++;
          continue;
        }

        // 4. Compute autoCreateDaysBefore (clamp to [0, 30])
        const rawAcdays = parseInt(reminder.acdays ?? "0") || 0;
        const autoCreateDaysBefore = Math.min(Math.max(rawAcdays, 0), MAX_AUTO_CREATE_DAYS);

        // 5. Look up payee
        const payeeName = template.templateDescription
          ? normalizeName(template.templateDescription)
          : null;
        const payeeId = payeeName ? idMapper.getPayee(payeeName) ?? null : null;

        // 6. Convert dates
        const startDate = convertDate(reminder.sdt);
        const ackDate = convertDate(reminder.ackdt);
        const nextDate = normalizeReminderNextDate(startDate, ackDate, recurrence);

        // 7. Insert recurring rule + template splits atomically — a failure
        // between the two would leave a rule with too few splits, which is
        // exactly the malformed-rule shape the recurring-processing guard
        // exists to handle. Don't manufacture one on the way in.
        await db.transaction(async (tx) => {
          const [rule] = await tx
            .insert(recurringRules)
            .values({
              bookId: bookId!,
              name: reminder.desc,
              frequency: recurrence.frequency,
              interval: recurrence.interval,
              daysOfMonth: recurrence.daysOfMonth
                ? JSON.stringify(recurrence.daysOfMonth)
                : null,
              daysOfWeek: recurrence.daysOfWeek
                ? JSON.stringify(recurrence.daysOfWeek)
                : null,
              weekOfMonth: null,
              startDate,
              nextDate,
              autoCreateDaysBefore,
              templateDescription: template.templateDescription,
              payeeId,
              isActive: true,
            })
            .returning();

          // 8. Insert template splits
          await tx.insert(recurringTemplateSplits).values(
            mappedSplits.map((split) => ({
              bookId: bookId!,
              recurringRuleId: rule.id,
              accountId: split.accountId,
              amount: split.amount,
            }))
          );
        });

        if (options.verbose) {
          console.log(
            `  ✓ ${reminder.desc} (${recurrence.frequency}, interval ${recurrence.interval}, ${mappedSplits.length} splits)`
          );
        }

        stats.imported++;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        stats.errors.push({ reminder: reminder.id, error: errorMsg });
        console.error(`  ✗ Error importing reminder ${reminder.desc}: ${errorMsg}`);
      }
    }
  } else {
    console.log("  [DRY RUN] Would import reminders:");
    for (const reminder of reminders.slice(0, 5)) {
      const freq = parseReminderFrequency(reminder);
      console.log(`    ${reminder.desc} (${freq?.frequency ?? "unknown"}, interval ${freq?.interval ?? "?"})`);
    }
    if (reminders.length > 5) {
      console.log(`    ... and ${reminders.length - 5} more`);
    }
    stats.imported = reminders.length;
  }

  console.log("\n📊 Recurring Reminder Import Summary:");
  console.log(`  Imported: ${stats.imported}`);
  console.log(`  Skipped: ${stats.skipped}`);
  console.log(`  Errors: ${stats.errors.length}`);

  return stats;
}
