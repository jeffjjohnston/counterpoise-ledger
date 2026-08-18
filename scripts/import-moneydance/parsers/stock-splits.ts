/**
 * Phase 6: Stock Splits Import
 */

import type { MoneydanceItem, MoneydanceStockSplit, ImportOptions, IdMapper } from "../types";
import { convertDate, parseStockSplitRatio } from "../utils/format";
import { getDb, type AppDb } from "../../../db";
import { transactions, investmentSplits, type NewTransaction, type NewInvestmentSplit } from "../../../db/schema";

/**
 * Import stock split transactions
 */
export async function importStockSplits(
  items: MoneydanceItem[],
  idMapper: IdMapper,
  options: ImportOptions,
  dbOverride?: AppDb,
  bookId?: number
): Promise<{
  total: number;
  imported: number;
  skipped: number;
  errors: Array<{ securityId: string; date: string; error: string }>;
}> {
  console.log("\n📊 Phase 6: Importing Stock Splits");
  console.log("=".repeat(60));
  const db = dbOverride ?? getDb();

  const stats = {
    total: 0,
    imported: 0,
    skipped: 0,
    errors: [] as Array<{ securityId: string; date: string; error: string }>,
  };

  // Filter to stock splits
  const stockSplits = items.filter(
    (item): item is MoneydanceStockSplit => item.obj_type === "csplit"
  );

  stats.total = stockSplits.length;
  console.log(`Found ${stats.total} stock splits`);

  if (stats.total === 0) {
    console.log("No stock splits to import");
    return stats;
  }

  if (!options.dryRun) {
    let count = 0;

    for (const split of stockSplits) {
      count++;

      try {
        // Map security ID
        const securityId = idMapper.getSecurity(split.curr);
        if (!securityId) {
          stats.skipped++;
          if (options.verbose) {
            console.log(`  ⊘ Skipped: Security not found for ID ${split.curr}`);
          }
          continue;
        }

        // Convert date
        const date = convertDate(split.dt);

        // Parse split ratio (pass ratio field for cases where oldshrs=newshrs)
        const { numerator, denominator } = parseStockSplitRatio(split.oldshrs, split.newshrs, split.ratio);

        // Create transaction
        const newTransaction: NewTransaction = {
          bookId: bookId!,
          date,
          description: `Stock split ${numerator}-for-${denominator}`,
          payeeId: null,
          isReconciled: false,
          recurringRuleId: null,
        };

        await db.transaction(async (tx) => {
          const [txn] = await tx.insert(transactions).values(newTransaction).returning();

          // Create investment split for the split action
          const newInvestmentSplit: NewInvestmentSplit = {
            bookId: bookId!,
            transactionId: txn.id,
            accountId: null, // Stock splits apply to all accounts holding the security
            securityId,
            lotId: null, // Splits don't apply to specific lots
            action: "split",
            sharesMicros: 0, // No shares traded in a split
            priceMicros: 0, // No price for splits
            feesCents: 0,
            splitNumerator: numerator,
            splitDenominator: denominator,
          };

          await tx.insert(investmentSplits).values(newInvestmentSplit);
        });

        stats.imported++;

        if (options.verbose) {
          console.log(`  ✓ ${date}: ${numerator}-for-${denominator} split for security ${securityId}`);
        } else if (count % 10 === 0) {
          console.log(`  Progress: ${count}/${stats.total}...`);
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        stats.errors.push({
          securityId: split.curr,
          date: split.dt,
          error: errorMsg,
        });
        if (options.verbose) {
          console.error(`  ✗ Error importing split for ${split.curr} on ${split.dt}: ${errorMsg}`);
        }
      }
    }
  } else {
    console.log("  [DRY RUN] Would import stock splits:");
    const sample = stockSplits.slice(0, 5);
    for (const split of sample) {
      const securityId = idMapper.getSecurity(split.curr);
      const { numerator, denominator } = parseStockSplitRatio(split.oldshrs, split.newshrs, split.ratio);
      console.log(
        `    Security ${securityId || split.curr}: ${split.dt} - ${numerator}-for-${denominator} (${split.oldshrs}:${split.newshrs}, ratio=${split.ratio})`
      );
    }
    if (stockSplits.length > 5) {
      console.log(`    ... and ${stockSplits.length - 5} more`);
    }
    stats.imported = stockSplits.length;
  }

  console.log("\n📊 Stock Splits Import Summary:");
  console.log(`  Total splits: ${stats.total}`);
  console.log(`  Imported: ${stats.imported}`);
  console.log(`  Skipped: ${stats.skipped}`);
  console.log(`  Errors: ${stats.errors.length}`);

  return stats;
}
