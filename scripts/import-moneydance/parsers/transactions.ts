/**
 * Phase 3: Standard Transaction Import
 */

import type { MoneydanceTransaction, ImportOptions, IdMapper } from "../types";
import { convertDate, normalizeName, normalizeOptionalText, isTransactionReconciled } from "../utils/format";
import { validateTransaction, extractSplits } from "../utils/validation";
import { getDb, type AppDb } from "../../../db";
import { transactions, transactionSplits, type NewTransaction, type NewTransactionSplit } from "../../../db/schema";

/**
 * Check if transaction is a standard (non-investment) transaction
 */
export function isStandardTransaction(txn: MoneydanceTransaction): boolean {
  // Allow xfrtp_bank - these are cash transfers in investment accounts
  if (txn.xfer_type === "xfrtp_bank") {
    return true;
  }

  // Skip other investment transactions (buy/sell/dividend/etc)
  if (txn.xfer_type) {
    return false;
  }

  // Skip if any split references a security account
  // (Security accounts would not be in our account mapper, only in security mapper)
  return true;
}

/**
 * Check if all accounts in transaction exist in our mapping
 */
export function hasValidAccounts(txn: MoneydanceTransaction, idMapper: IdMapper): boolean {
  // Check parent account (or cash account for xfrtp_bank)
  let hasParent = idMapper.hasAccount(txn.acctid);
  if (!hasParent && txn.xfer_type === "xfrtp_bank") {
    // For investment cash transactions, check if cash account exists
    hasParent = idMapper.hasAccount(`${txn.acctid}_CASH`);
  }

  if (!hasParent) {
    return false;
  }

  // Check all split accounts
  const splits = extractSplits(txn);
  for (const split of splits) {
    if (!idMapper.hasAccount(split.acctid)) {
      return false;
    }
  }

  return true;
}

/**
 * Import standard transactions
 */
export async function importTransactions(
  mdTransactions: MoneydanceTransaction[],
  idMapper: IdMapper,
  options: ImportOptions,
  dbOverride?: AppDb,
  bookId?: number
): Promise<{
  imported: number;
  skipped: number;
  splits: number;
  errors: Array<{ transaction: string; error: string }>;
}> {
  console.log("\n💸 Phase 3: Importing Standard Transactions");
  console.log("=".repeat(60));
  const db = dbOverride ?? getDb();

  const stats = {
    imported: 0,
    skipped: 0,
    splits: 0,
    errors: [] as Array<{ transaction: string; error: string }>,
  };

  // Filter to standard transactions only
  const standardTransactions = mdTransactions.filter(isStandardTransaction);
  console.log(`Found ${standardTransactions.length} standard transactions (${mdTransactions.length - standardTransactions.length} investment transactions skipped)`);

  if (!options.dryRun) {
    let count = 0;
    const total = standardTransactions.length;

    for (const txn of standardTransactions) {
      count++;
      try {
        // Validate transaction
        const validation = validateTransaction(txn);
        if (!validation.valid) {
          stats.errors.push({
            transaction: txn.id,
            error: validation.errors.join(", "),
          });
          stats.skipped++;
          continue;
        }

        // Check if all accounts exist
        if (!hasValidAccounts(txn, idMapper)) {
          if (options.verbose) {
            console.log(`  ⊗ Skipping ${txn.desc || txn.id}: Referenced accounts not imported`);
          }
          stats.skipped++;
          continue;
        }

        // Extract splits
        const splits = extractSplits(txn);
        if (splits.length === 0) {
          stats.errors.push({
            transaction: txn.id,
            error: "No valid splits found",
          });
          stats.skipped++;
          continue;
        }

        // Create transaction
        const payeeName = txn.desc ? normalizeName(txn.desc) : null;
        const payeeId = payeeName ? idMapper.getPayee(payeeName) : null;

        const newTransaction: NewTransaction = {
          bookId: bookId!,
          date: convertDate(txn.dt),
          description: txn.desc || null,
          checkNumber: normalizeOptionalText(txn.chk),
          payeeId: payeeId || null,
          isReconciled: isTransactionReconciled(txn),
        };

        // Counted locally and added to stats only after the transaction
        // commits. Incrementing stats inside the callback survives a rollback,
        // so a failed import would report splits that were never written.
        let splitsWritten = 0;

        await db.transaction(async (tx) => {
          splitsWritten = 0;
          const [insertedTxn] = await tx.insert(transactions).values(newTransaction).returning();

          // Create split for parent account
          // Check if parent account has a cash sub-account (for investment accounts)
          let parentAccountId = idMapper.getAccount(txn.acctid);
          const parentCashAccountId = idMapper.getAccount(`${txn.acctid}_CASH`);
          if (parentCashAccountId) {
            parentAccountId = parentCashAccountId;
          }

          if (!parentAccountId) {
            throw new Error(`Parent account mapping not found for ${txn.acctid}`);
          }

          // Calculate parent amount from pamt values
          let parentAmount = 0;
          for (const split of splits) {
            const pamt = txn[`${split.index}.pamt`] as string | undefined;
            if (pamt) {
              parentAmount += parseInt(pamt);
            }
          }

          // Create parent split
          const parentSplit: NewTransactionSplit = {
            bookId: bookId!,
            transactionId: insertedTxn.id,
            accountId: parentAccountId,
            amount: parentAmount,
          };
          await tx.insert(transactionSplits).values(parentSplit);
          splitsWritten++;

          // Create splits for each numbered split (using samt)
          for (const split of splits) {
            let accountId = idMapper.getAccount(split.acctid);

            // Check if split account has a cash sub-account (for investment accounts)
            const splitCashAccountId = idMapper.getAccount(`${split.acctid}_CASH`);
            if (splitCashAccountId) {
              accountId = splitCashAccountId;
            }

            if (!accountId) {
              throw new Error(`Account mapping not found for ${split.acctid}`);
            }

            const newSplit: NewTransactionSplit = {
              bookId: bookId!,
              transactionId: insertedTxn.id,
              accountId,
              amount: split.amount, // This is now samt
            };

            await tx.insert(transactionSplits).values(newSplit);
            splitsWritten++;
          }
        });

        stats.splits += splitsWritten;

        if (options.verbose) {
          console.log(`  ✓ ${convertDate(txn.dt)} - ${txn.desc || "(no description)"} (${splits.length + 1} splits)`);
        } else if (count % 500 === 0) {
          const percent = ((count / total) * 100).toFixed(1);
          console.log(`  Progress: ${count}/${total} (${percent}%) transactions...`);
        }

        stats.imported++;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        stats.errors.push({
          transaction: txn.id,
          error: errorMsg,
        });
        console.error(`  ✗ Error importing transaction ${txn.id}: ${errorMsg}`);
      }
    }
  } else {
    console.log("  [DRY RUN] Would import transactions:");
    const sample = standardTransactions.slice(0, 5);
    for (const txn of sample) {
      const splits = extractSplits(txn);
      console.log(`    ${txn.dt} - ${txn.desc || "(no description)"} (${splits.length} splits)`);
    }
    if (standardTransactions.length > 5) {
      console.log(`    ... and ${standardTransactions.length - 5} more`);
    }
    stats.imported = standardTransactions.length;
  }

  console.log("\n📊 Transaction Import Summary:");
  console.log(`  Transactions imported: ${stats.imported}`);
  console.log(`  Splits created: ${stats.splits}`);
  console.log(`  Skipped: ${stats.skipped}`);
  console.log(`  Errors: ${stats.errors.length}`);

  return stats;
}
