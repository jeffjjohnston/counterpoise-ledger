/**
 * Phase 2: Payee Import
 */

import type { MoneydanceTransaction, ImportOptions, IdMapper } from "../types";
import { normalizeName } from "../utils/format";
import { getDb, type AppDb } from "../../../db";
import { payees, type NewPayee } from "../../../db/schema";

/**
 * Extract unique payee names from transactions
 */
export function extractPayeeNames(transactions: MoneydanceTransaction[]): Set<string> {
  const payeeNames = new Set<string>();

  for (const txn of transactions) {
    if (txn.desc) {
      const normalized = normalizeName(txn.desc);
      if (normalized) {
        payeeNames.add(normalized);
      }
    }
  }

  return payeeNames;
}

/**
 * Import payees from transaction descriptions
 */
export async function importPayees(
  transactions: MoneydanceTransaction[],
  idMapper: IdMapper,
  options: ImportOptions,
  dbOverride?: AppDb,
  bookId?: number
): Promise<{
  imported: number;
  errors: Array<{ payee: string; error: string }>;
}> {
  console.log("\n👤 Phase 2: Importing Payees");
  console.log("=".repeat(60));
  const db = dbOverride ?? getDb();

  const stats = {
    imported: 0,
    errors: [] as Array<{ payee: string; error: string }>,
  };

  // Extract unique payee names
  const payeeNames = extractPayeeNames(transactions);
  console.log(`Found ${payeeNames.size} unique payees`);

  if (!options.dryRun) {
    let count = 0;
    const total = payeeNames.size;

    for (const name of payeeNames) {
      count++;
      try {
        const newPayee: NewPayee = {
          bookId: bookId!,
          name,
        };

        const [inserted] = await db.insert(payees).values(newPayee).returning();
        idMapper.setPayee(name, inserted.id);

        if (options.verbose) {
          console.log(`  ✓ ${name}`);
        } else if (count % 100 === 0) {
          console.log(`  Progress: ${count}/${total} payees...`);
        }

        stats.imported++;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        stats.errors.push({
          payee: name,
          error: errorMsg,
        });
        console.error(`  ✗ Error importing payee "${name}": ${errorMsg}`);
      }
    }
  } else {
    console.log("  [DRY RUN] Would import payees:");
    const sample = Array.from(payeeNames).slice(0, 10);
    for (const name of sample) {
      console.log(`    ${name}`);
    }
    if (payeeNames.size > 10) {
      console.log(`    ... and ${payeeNames.size - 10} more`);
    }
    stats.imported = payeeNames.size;
  }

  console.log("\n📊 Payee Import Summary:");
  console.log(`  Payees imported: ${stats.imported}`);
  console.log(`  Errors: ${stats.errors.length}`);

  return stats;
}
