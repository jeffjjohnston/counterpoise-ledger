/**
 * Phase 1.5: Create Opening Balances for Accounts
 */

import type { AccountWithBalance } from "./accounts";
import type { ImportOptions, IdMapper } from "../types";
import { getDb, type AppDb } from "../../../db";
import { accounts, transactions, transactionSplits, type NewAccount, type NewTransaction, type NewTransactionSplit } from "../../../db/schema";
import { toDateString } from "../../../lib/formatters";
import { eq } from "drizzle-orm";

/**
 * Get or create the Imported Balance expense account
 */
async function getOrCreateImportedBalanceAccount(db: AppDb, bookId: number): Promise<number> {
  // Check if Imported Balance account already exists
  const existing = await db.query.accounts.findFirst({
    where: eq(accounts.name, "Imported Balance"),
  });

  if (existing) {
    return existing.id;
  }

  // Create new Imported Balance expense account
  const newAccount: NewAccount = {
    bookId,
    name: "Imported Balance",
    type: "expense",
    subtype: null,
    parentId: null,
    isActive: true,
    isInvestmentCash: false,
  };

  const [inserted] = await db.insert(accounts).values(newAccount).returning();
  return inserted.id;
}

/**
 * Convert Moneydance timestamp (milliseconds) to YYYY-MM-DD date string
 */
function convertTimestampToDate(timestamp: string): string {
  const ms = parseInt(timestamp);
  const date = new Date(ms);
  if (isNaN(date.getTime())) {
    // If parsing fails, use current date
    return toDateString(new Date());
  }
  return toDateString(date);
}

/**
 * Create opening balance transactions for accounts with initial balances
 */
export async function createLoanOpeningBalances(
  accountsWithBalances: AccountWithBalance[],
  idMapper: IdMapper,
  options: ImportOptions,
  dbOverride?: AppDb,
  bookId?: number
): Promise<{
  created: number;
  errors: Array<{ account: string; error: string }>;
}> {
  console.log("\n🏦 Phase 1.5: Creating Opening Balances");
  console.log("=".repeat(60));
  const db = dbOverride ?? getDb();

  const stats = {
    created: 0,
    errors: [] as Array<{ account: string; error: string }>,
  };

  if (accountsWithBalances.length === 0) {
    console.log("No accounts with initial balances found");
    return stats;
  }

  console.log(`Found ${accountsWithBalances.length} account(s) with initial balance`);

  if (options.dryRun) {
    console.log("  [DRY RUN] Would create opening balances for:");
    for (const acct of accountsWithBalances) {
      const amount = (Math.abs(acct.initialBalance) / 100).toFixed(2);
      const date = convertTimestampToDate(acct.creationDate);
      const sign = acct.initialBalance >= 0 ? "+" : "-";
      console.log(`    ${acct.accountName}: ${sign}$${amount} on ${date}`);
    }
    stats.created = accountsWithBalances.length;
    return stats;
  }

  // Get or create Imported Balance account
  const importedBalanceAccountId = await getOrCreateImportedBalanceAccount(db, bookId!);
  console.log(`Using Imported Balance account (ID: ${importedBalanceAccountId})`);

  // Create opening balance transaction for each account
  for (const acct of accountsWithBalances) {
    try {
      const date = convertTimestampToDate(acct.creationDate);
      const amount = (Math.abs(acct.initialBalance) / 100).toFixed(2);

      // Determine target account ID
      // For investment accounts, use their associated cash account
      let targetAccountId = acct.cpAccountId;
      if (acct.accountSubtype === "investment") {
        const cashAccountId = idMapper.getAccount(`${acct.mdAccountId}_CASH`);
        if (cashAccountId) {
          targetAccountId = cashAccountId;
          if (options.verbose) {
            console.log(`  ⓘ Routing balance to cash account for ${acct.accountName}`);
          }
        }
      }

      // Create transaction
      const newTransaction: NewTransaction = {
        bookId: bookId!,
        date,
        description: `Opening Balance - ${acct.accountName}`,
        payeeId: null,
        isReconciled: true,
      };

      await db.transaction(async (tx) => {
        const [insertedTxn] = await tx.insert(transactions).values(newTransaction).returning();

        // Create splits
        // The account split uses the original balance amount
        const accountSplit: NewTransactionSplit = {
          bookId: bookId!,
          transactionId: insertedTxn.id,
          accountId: targetAccountId,
          amount: acct.initialBalance,
        };

        // The Imported Balance offset uses the negative amount
        const importedBalanceSplit: NewTransactionSplit = {
          bookId: bookId!,
          transactionId: insertedTxn.id,
          accountId: importedBalanceAccountId,
          amount: -acct.initialBalance,
        };

        await tx.insert(transactionSplits).values([accountSplit, importedBalanceSplit]);
      });

      if (options.verbose) {
        const sign = acct.initialBalance >= 0 ? "+" : "-";
        console.log(`  ✓ ${acct.accountName}: ${sign}$${amount} on ${date}`);
      }

      stats.created++;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      stats.errors.push({
        account: acct.accountName,
        error: errorMsg,
      });
      console.error(`  ✗ Error creating opening balance for ${acct.accountName}: ${errorMsg}`);
    }
  }

  console.log("\n📊 Opening Balance Summary:");
  console.log(`  Account balances created: ${stats.created}`);
  console.log(`  Errors: ${stats.errors.length}`);

  return stats;
}
