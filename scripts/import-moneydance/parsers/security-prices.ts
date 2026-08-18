/**
 * Phase 5: Security Prices Import
 */

import type { MoneydanceItem, MoneydanceSecurityPrice, ImportOptions, IdMapper } from "../types";
import { convertDate, convertPriceToMicros } from "../utils/format";
import { getDb, type AppDb } from "../../../db";
import { securityPrices, type NewSecurityPrice } from "../../../db/schema";

/**
 * Import security price snapshots
 */
export async function importSecurityPrices(
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
  console.log("\n💰 Phase 5: Importing Security Prices");
  console.log("=".repeat(60));
  const db = dbOverride ?? getDb();

  const stats = {
    total: 0,
    imported: 0,
    skipped: 0,
    errors: [] as Array<{ securityId: string; date: string; error: string }>,
  };

  // Filter to security price snapshots
  const priceSnapshots = items.filter(
    (item): item is MoneydanceSecurityPrice => item.obj_type === "csnap"
  );

  stats.total = priceSnapshots.length;
  console.log(`Found ${stats.total} security price snapshots`);

  if (stats.total === 0) {
    console.log("No security prices to import");
    return stats;
  }

  if (!options.dryRun) {
    const BATCH_SIZE = 1000;
    const batch: NewSecurityPrice[] = [];

    for (const snapshot of priceSnapshots) {
      try {
        // Map security ID
        const securityId = idMapper.getSecurity(snapshot.curr);
        if (!securityId) {
          stats.skipped++;
          if (options.verbose) {
            console.log(`  ⊘ Skipped: Security not found for ID ${snapshot.curr}`);
          }
          continue;
        }

        // Convert date
        const priceDate = convertDate(snapshot.dt);

        // Convert price from decimal string to micros
        const priceMicros = convertPriceToMicros(snapshot.relrt);

        // Add to batch
        batch.push({
          bookId: bookId!,
          securityId,
          priceDate,
          priceMicros,
          source: "moneydance_import",
        });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        stats.errors.push({
          securityId: snapshot.curr,
          date: snapshot.dt,
          error: errorMsg,
        });
        if (options.verbose) {
          console.error(`  ✗ Error converting price for ${snapshot.curr} on ${snapshot.dt}: ${errorMsg}`);
        }
      }
    }

    // Insert all valid prices in batches
    for (let i = 0; i < batch.length; i += BATCH_SIZE) {
      const chunk = batch.slice(i, i + BATCH_SIZE);
      try {
        await db
          .insert(securityPrices)
          .values(chunk)
          .onConflictDoNothing();

        stats.imported += chunk.length;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error(`  ✗ Batch insert failed (rows ${i}-${i + chunk.length}): ${errorMsg}`);
        for (const row of chunk) {
          stats.errors.push({
            securityId: String(row.securityId),
            date: row.priceDate,
            error: errorMsg,
          });
        }
      }

      const processed = Math.min(i + BATCH_SIZE, batch.length);
      console.log(`  Progress: ${processed}/${batch.length} prices inserted...`);
    }
  } else {
    console.log("  [DRY RUN] Would import prices:");
    const sample = priceSnapshots.slice(0, 5);
    for (const snap of sample) {
      const securityId = idMapper.getSecurity(snap.curr);
      console.log(`    Security ${securityId || snap.curr}: ${snap.dt} = ${snap.relrt}`);
    }
    if (priceSnapshots.length > 5) {
      console.log(`    ... and ${priceSnapshots.length - 5} more`);
    }
    stats.imported = priceSnapshots.length;
  }

  console.log("\n📊 Security Prices Import Summary:");
  console.log(`  Total snapshots: ${stats.total}`);
  console.log(`  Imported: ${stats.imported}`);
  console.log(`  Skipped: ${stats.skipped}`);
  console.log(`  Errors: ${stats.errors.length}`);

  return stats;
}
