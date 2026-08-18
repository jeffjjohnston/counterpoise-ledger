#!/usr/bin/env node
/**
 * Moneydance Import Script
 *
 * Imports data from Moneydance JSON export into a Counterpoise book database.
 * Performs an import flow of: Accounts, Opening Balances, Payees,
 * Transactions, Investment Transactions, Security Prices, Stock Splits,
 * Lot Rebuild, and Recurring Reminders. The lot rebuild runs after Stock
 * Splits — not inside Investment Transactions — so FIFO replay sees every
 * split (including corporate-action splits) before it runs.
 *
 * Usage:
 *   tsx scripts/import-moneydance/index.ts <path-to-json> [options]
 *
 * Options:
 *   --book-id <id>         Book ID to import into (required)
 *   --dry-run              Parse and validate without writing to database
 *   --overwrite            Remove existing data in the target book before import
 *   --no-inactive          Skip inactive accounts
 *   --no-hidden            Skip hidden accounts
 *   --verbose              Show detailed progress
 */

import { readFile } from "fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type { MoneydanceExport, MoneydanceAccount, MoneydanceTransaction, MoneydanceReminder, ImportOptions } from "./types";
import { IdMapper } from "./types";
import { importAccounts } from "./parsers/accounts";
import { createLoanOpeningBalances } from "./parsers/opening-balances";
import { importPayees } from "./parsers/payees";
import { importTransactions } from "./parsers/transactions";
import { importInvestmentTransactions } from "./parsers/investment-transactions";
import { importSecurityPrices } from "./parsers/security-prices";
import { importStockSplits } from "./parsers/stock-splits";
import { importReminders } from "./parsers/reminders";
import { getDb, closeDb, type AppDb } from "../../db";
import { overwriteBookDataForImport } from "./overwrite";
import { parseImportArgs, shouldShowHelp } from "./args";
import { findAllLotPairs, rebuildLots } from "../../lib/lots-db";

/**
 * Print help text
 */
function printHelp(): void {
  console.log(`
Moneydance Import Script

Usage:
  tsx scripts/import-moneydance/index.ts <path-to-json> --book-id <id> [options]

Options:
  --book-id <id>         Book ID to import into (required)
  --dry-run              Parse and validate without writing to database
  --overwrite            Remove existing data in the target book before import
  --no-inactive          Skip inactive accounts
  --no-hidden            Skip hidden accounts
  --verbose              Show detailed progress
  --help, -h             Show this help message

Examples:
  # Dry run to validate
  tsx scripts/import-moneydance/index.ts path/to/export.json --book-id <existing-book-id> --dry-run --verbose

  # Import all data including inactive accounts
  tsx scripts/import-moneydance/index.ts path/to/export.json --book-id <existing-book-id>

  # Import only active accounts
  tsx scripts/import-moneydance/index.ts path/to/export.json --book-id <existing-book-id> --no-inactive --no-hidden
  `);
}

/**
 * Load and parse Moneydance JSON file
 */
async function loadMoneydanceFile(filePath: string): Promise<MoneydanceExport> {
  console.log(`\n📂 Loading ${filePath}...`);
  const startTime = Date.now();

  try {
    const content = await readFile(filePath, "utf-8");
    const data = JSON.parse(content) as MoneydanceExport;

    const loadTime = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`✓ Loaded in ${loadTime}s`);

    return data;
  } catch (error) {
    console.error(`✗ Failed to load file: ${error}`);
    process.exit(1);
  }
}

/**
 * Validate Moneydance export structure
 */
function validateExport(data: MoneydanceExport): void {
  if (!data.metadata) {
    throw new Error("Invalid export: missing metadata");
  }

  if (!data.all_items || !Array.isArray(data.all_items)) {
    throw new Error("Invalid export: missing or invalid all_items array");
  }

  console.log("\n📋 Export Metadata:");
  console.log(`  Exporter: ${data.metadata.exporter}`);
  console.log(`  Export Date: ${data.metadata.export_date}`);
  console.log(`  Total Items: ${data.all_items.length.toLocaleString()}`);
}

/**
 * Analyze export contents
 */
function analyzeExport(data: MoneydanceExport): {
  accounts: MoneydanceAccount[];
  transactions: MoneydanceTransaction[];
  reminders: MoneydanceReminder[];
} {
  const accounts: MoneydanceAccount[] = [];
  const transactions: MoneydanceTransaction[] = [];
  const reminders: MoneydanceReminder[] = [];
  const objectTypes = new Map<string, number>();

  for (const item of data.all_items) {
    const type = item.obj_type;
    objectTypes.set(type, (objectTypes.get(type) || 0) + 1);

    if (type === "acct") {
      accounts.push(item as MoneydanceAccount);
    } else if (type === "txn") {
      transactions.push(item as MoneydanceTransaction);
    } else if (type === "reminder") {
      reminders.push(item as MoneydanceReminder);
    }
  }

  console.log("\n📊 Content Analysis:");
  const sortedTypes = Array.from(objectTypes.entries()).sort((a, b) => b[1] - a[1]);
  for (const [type, count] of sortedTypes) {
    console.log(`  ${type.padEnd(10)} ${count.toLocaleString()}`);
  }

  return { accounts, transactions, reminders };
}

export type ImportResult = {
  accounts: Awaited<ReturnType<typeof importAccounts>>;
  openingBalances: Awaited<ReturnType<typeof createLoanOpeningBalances>>;
  payees: Awaited<ReturnType<typeof importPayees>>;
  transactions: Awaited<ReturnType<typeof importTransactions>>;
  investments: Awaited<ReturnType<typeof importInvestmentTransactions>>;
  prices: Awaited<ReturnType<typeof importSecurityPrices>>;
  stockSplits: Awaited<ReturnType<typeof importStockSplits>>;
  lotRebuild: { pairs: number };
  reminders: Awaited<ReturnType<typeof importReminders>>;
  idMapper: IdMapper;
};

/**
 * Run every import phase against an already-parsed export.
 *
 * Split out of `main()` so the phase ORDER is observable from a test. The lot
 * rebuild has to run after stock splits, and a test that re-implemented this
 * sequence itself would keep passing if the sequence here changed.
 */
export async function runImport(
  data: MoneydanceExport,
  bookId: number,
  options: ImportOptions,
  dbOverride?: AppDb
): Promise<ImportResult> {
  const db = dbOverride ?? getDb();

  validateExport(data);
  const { accounts, transactions, reminders } = analyzeExport(data);
  const idMapper = new IdMapper();

  // Phase 1: Import accounts
  const accountStats = await importAccounts(accounts, idMapper, options, data.all_items, db, bookId);

  // Phase 1.5: Create opening balances for all accounts with initial balances
  const openingBalanceStats = await createLoanOpeningBalances(accountStats.accountsWithBalances, idMapper, options, db, bookId);

  // Phase 2: Import payees
  const payeeStats = await importPayees(transactions, idMapper, options, db, bookId);

  // Phase 3: Import standard transactions
  const transactionStats = await importTransactions(transactions, idMapper, options, db, bookId);

  // Phase 4: Import investment transactions
  const investmentStats = await importInvestmentTransactions(transactions, data.all_items, idMapper, options, db, bookId);

  // Phase 5: Import security prices
  const priceStats = await importSecurityPrices(data.all_items, idMapper, options, db, bookId);

  // Phase 6: Import stock splits
  const splitStats = await importStockSplits(data.all_items, idMapper, options, db, bookId);

  // Phase 6.5: Rebuild investment lots
  //
  // Must run after stock splits (Phase 6), not inside the investment
  // transactions phase (Phase 4): findAllLotPairs scans the whole book, and
  // the FIFO replay engine needs every split — including "split" action rows
  // from Phase 6 — already written before it replays a pair, or a sell that
  // follows a pre-import stock split would be matched against pre-split share
  // counts and corrupt cost basis, realized gains, and holding term for every
  // downstream reader.
  console.log("\n🔁 Phase 6.5: Rebuilding Investment Lots");
  console.log("=".repeat(60));
  let lotRebuildStats = { pairs: 0 };
  if (!options.dryRun) {
    const affectedPairs = await findAllLotPairs(db, bookId);
    for (const pair of affectedPairs) {
      await db.transaction(async (tx) => {
        await rebuildLots(tx, bookId, pair.accountId, pair.securityId);
      });
    }
    lotRebuildStats = { pairs: affectedPairs.length };
    console.log(`  Rebuilt ${affectedPairs.length} (account, security) pair(s)`);
  } else {
    console.log("  [DRY RUN] Would rebuild investment lots for all (account, security) pairs");
  }

  // Phase 7: Import recurring reminders
  const reminderStats = await importReminders(reminders, idMapper, options, db, bookId);

  return {
    accounts: accountStats,
    openingBalances: openingBalanceStats,
    payees: payeeStats,
    transactions: transactionStats,
    investments: investmentStats,
    prices: priceStats,
    stockSplits: splitStats,
    lotRebuild: lotRebuildStats,
    reminders: reminderStats,
    idMapper,
  };
}

/**
 * Main import function
 */
async function main() {
  const startTime = Date.now();

  console.log("╔═══════════════════════════════════════════════════════════╗");
  console.log("║         Moneydance to Counterpoise Import Tool           ║");
  console.log("╚═══════════════════════════════════════════════════════════╝");

  // Parse arguments
  const rawArgs = process.argv.slice(2);
  if (shouldShowHelp(rawArgs)) {
    printHelp();
    process.exit(0);
  }

  let parsedArgs: ReturnType<typeof parseImportArgs>;
  try {
    parsedArgs = parseImportArgs(rawArgs);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  const { filePath, bookId, overwrite, options } = parsedArgs;

  console.log("\n⚙️  Import Options:");
  console.log(`  Book ID: ${bookId}`);
  console.log(`  Dry Run: ${options.dryRun ? "Yes (no data will be written)" : "No"}`);
  console.log(`  Overwrite Existing Data: ${overwrite}`);
  console.log(`  Import Inactive: ${options.importInactive}`);
  console.log(`  Import Hidden: ${options.importHidden}`);
  console.log(`  Verbose: ${options.verbose}`);

  if (options.dryRun) {
    console.log("\n⚠️  DRY RUN MODE - No data will be written to database");
  }

  if (overwrite && options.dryRun) {
    console.log("⚠️  --overwrite ignored in dry-run mode");
  } else if (overwrite) {
    console.log("\n🧹 --overwrite enabled: clearing existing book data...");
    const db = getDb();
    await overwriteBookDataForImport(db, bookId);
    console.log("✓ Cleared existing book data");
  }

  const data = await loadMoneydanceFile(filePath);

  const {
    accounts: accountStats,
    openingBalances: openingBalanceStats,
    payees: payeeStats,
    transactions: transactionStats,
    investments: investmentStats,
    prices: priceStats,
    stockSplits: splitStats,
    lotRebuild: lotRebuildStats,
    reminders: reminderStats,
    idMapper,
  } = await runImport(data, bookId, options);

  // Final summary
  const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);

  console.log("\n╔═══════════════════════════════════════════════════════════╗");
  console.log("║                    Import Complete!                       ║");
  console.log("╚═══════════════════════════════════════════════════════════╝");

  console.log("\n📈 Final Statistics:");
  console.log("  Accounts:");
  console.log(`    Imported: ${accountStats.imported}`);
  console.log(`    Securities: ${accountStats.securities}`);
  console.log(`    Skipped: ${accountStats.skipped}`);
  console.log(`    With initial balances: ${accountStats.accountsWithBalances.length}`);
  console.log(`    Errors: ${accountStats.errors.length}`);

  console.log("  Opening Balances:");
  console.log(`    Created: ${openingBalanceStats.created}`);
  console.log(`    Errors: ${openingBalanceStats.errors.length}`);

  console.log("  Payees:");
  console.log(`    Imported: ${payeeStats.imported}`);
  console.log(`    Errors: ${payeeStats.errors.length}`);

  console.log("  Transactions:");
  console.log(`    Imported: ${transactionStats.imported}`);
  console.log(`    Splits: ${transactionStats.splits}`);
  console.log(`    Skipped: ${transactionStats.skipped}`);
  console.log(`    Errors: ${transactionStats.errors.length}`);

  console.log("  Investment Transactions:");
  console.log(`    Imported: ${investmentStats.imported}`);
  console.log(`    Buys: ${investmentStats.buys}`);
  console.log(`    Sells: ${investmentStats.sells}`);
  console.log(`    Dividends: ${investmentStats.dividends}`);
  console.log(`    Lots: ${investmentStats.lots}`);
  console.log(`    Orphaned Sells: ${investmentStats.orphanedSells}`);
  console.log(`    Errors: ${investmentStats.errors.length}`);

  console.log("  Security Prices:");
  console.log(`    Imported: ${priceStats.imported}`);
  console.log(`    Skipped: ${priceStats.skipped}`);
  console.log(`    Errors: ${priceStats.errors.length}`);

  console.log("  Stock Splits:");
  console.log(`    Imported: ${splitStats.imported}`);
  console.log(`    Skipped: ${splitStats.skipped}`);
  console.log(`    Errors: ${splitStats.errors.length}`);

  console.log("  Lot Rebuild:");
  console.log(`    Pairs rebuilt: ${lotRebuildStats.pairs}`);

  console.log("  Recurring Reminders:");
  console.log(`    Imported: ${reminderStats.imported}`);
  console.log(`    Skipped: ${reminderStats.skipped}`);
  console.log(`    Errors: ${reminderStats.errors.length}`);

  const mapperStats = idMapper.getStats();
  console.log("\n  ID Mappings:");
  console.log(`    Accounts: ${mapperStats.accounts}`);
  console.log(`    Securities: ${mapperStats.securities}`);
  console.log(`    Payees: ${mapperStats.payees}`);

  console.log(`\n⏱️  Total Time: ${totalTime}s`);

  // Show errors if any
  const totalErrors =
    accountStats.errors.length +
    openingBalanceStats.errors.length +
    payeeStats.errors.length +
    transactionStats.errors.length +
    investmentStats.errors.length +
    priceStats.errors.length +
    splitStats.errors.length +
    reminderStats.errors.length;
  if (totalErrors > 0) {
    console.log(`\n⚠️  ${totalErrors} errors occurred during import`);
    console.log("See details above for specific error messages");
  }

  if (options.dryRun) {
    console.log("\n✓ Dry run completed successfully");
    console.log("  Run without --dry-run to perform actual import");
  } else {
    console.log("\n✓ Import completed successfully");
  }

  await closeDb();
}

// Run main function only when invoked as the CLI entry point. Importing this
// module (a test importing `runImport`) must not parse the importer's argv or
// call process.exit.
const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error("\n❌ Fatal error:", error);
    process.exit(1);
  });
}
