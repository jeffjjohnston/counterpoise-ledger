/**
 * Phase 1: Account Import
 */

import type { MoneydanceAccount, MoneydanceItem, AccountMapping, ImportOptions, IdMapper } from "../types";
import { isTrue } from "../utils/format";
import { getDb, type AppDb } from "../../../db";
import { accounts, securities, type NewAccount, type NewSecurity } from "../../../db/schema";
import { eq } from "drizzle-orm";

/**
 * Map Moneydance account type to Counterpoise type
 */
export function mapAccountType(mdType: string): AccountMapping | "SECURITY" | "SKIP" {
  switch (mdType) {
    case "a":
      return { type: "asset", subtype: "other" };
    case "b":
      return { type: "asset", subtype: "bank" };
    case "c":
      return { type: "liability", subtype: "credit_card" };
    case "e":
      return { type: "expense" };
    case "i":
      return { type: "income" };
    case "l":
      return { type: "liability", subtype: "loan" };
    case "o":
      return { type: "liability", subtype: "loan" };
    case "v":
      return { type: "asset", subtype: "investment" };
    case "s":
      return "SECURITY"; // Handle separately
    case "r":
      return "SKIP"; // Root account
    default:
      throw new Error(`Unknown account type: ${mdType}`);
  }
}

/**
 * Build full path name for account by traversing parent hierarchy
 * Example: "Automobile:Maintenance" or "Expenses:Household:Utilities"
 */
export function buildAccountFullPath(
  mdAccount: MoneydanceAccount,
  mdAccounts: MoneydanceAccount[]
): string {
  const parents: string[] = [];
  let current = mdAccount;

  // Traverse up the hierarchy
  while (current.parentid) {
    const parent = mdAccounts.find(a => a.id === current.parentid);
    if (!parent || parent.type === 'r') break; // Stop at root
    parents.unshift(parent.name);
    current = parent;
  }

  // Add the current account name
  parents.push(mdAccount.name);
  return parents.join(':');
}

/**
 * Check if account should be imported
 */
export function shouldImportAccount(
  acct: MoneydanceAccount,
  options: ImportOptions
): { import: boolean; reason?: string } {
  // Always skip root account
  if (acct.type === "r") {
    return { import: false, reason: "Root account" };
  }

  // Check inactive flag
  if (!options.importInactive && isTrue(acct.is_inactive)) {
    return { import: false, reason: "Inactive account" };
  }

  // Check hidden flag
  if (!options.importHidden && isTrue(acct.hide)) {
    return { import: false, reason: "Hidden account" };
  }

  return { import: true };
}

/**
 * Import accounts from Moneydance export
 */
export interface AccountWithBalance {
  mdAccountId: string;
  cpAccountId: number;
  accountName: string;
  accountType: "asset" | "liability" | "equity" | "income" | "expense";
  accountSubtype: "bank" | "credit_card" | "loan" | "investment" | "cash" | "other" | null;
  initialBalance: number; // In cents
  creationDate: string;
}

// Legacy type alias for compatibility
export type LoanWithBalance = AccountWithBalance;

export async function importAccounts(
  mdAccounts: MoneydanceAccount[],
  idMapper: IdMapper,
  options: ImportOptions,
  allItems?: MoneydanceItem[],
  dbOverride?: AppDb,
  bookId?: number
): Promise<{
  imported: number;
  skipped: number;
  securities: number;
  errors: Array<{ account: string; error: string }>;
  accountsWithBalances: AccountWithBalance[];
  loansWithBalances: LoanWithBalance[]; // Legacy compatibility
}> {
  console.log("\n📁 Phase 1: Importing Accounts");
  console.log("=".repeat(60));
  const db = dbOverride ?? getDb();

  const stats = {
    imported: 0,
    skipped: 0,
    securities: 0,
    errors: [] as Array<{ account: string; error: string }>,
    accountsWithBalances: [] as AccountWithBalance[],
    loansWithBalances: [] as LoanWithBalance[], // Legacy compatibility
  };

  // First pass: Import accounts without parent relationships
  // We'll set up parent relationships in a second pass
  const accountsToImport: Array<{
    mdAccount: MoneydanceAccount;
    mapping: AccountMapping;
  }> = [];

  const securitiesToImport: MoneydanceAccount[] = [];

  for (const mdAccount of mdAccounts) {
    try {
      const shouldImport = shouldImportAccount(mdAccount, options);

      if (!shouldImport.import) {
        if (options.verbose) {
          console.log(`  ⊗ Skipping: ${mdAccount.name} (${shouldImport.reason})`);
        }
        stats.skipped++;
        continue;
      }

      const mapping = mapAccountType(mdAccount.type);

      if (mapping === "SKIP") {
        stats.skipped++;
        continue;
      }

      if (mapping === "SECURITY") {
        securitiesToImport.push(mdAccount);
        continue;
      }

      accountsToImport.push({ mdAccount, mapping });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      stats.errors.push({
        account: mdAccount.name,
        error: errorMsg,
      });
      console.error(`  ✗ Error processing ${mdAccount.name}: ${errorMsg}`);
    }
  }

  // Import regular accounts
  console.log(`\nImporting ${accountsToImport.length} accounts...`);

  if (!options.dryRun) {
    for (const { mdAccount, mapping } of accountsToImport) {
      try {
        // Build full path name to avoid conflicts with duplicate names
        const fullPathName = buildAccountFullPath(mdAccount, mdAccounts);

        const newAccount: NewAccount = {
          bookId: bookId!,
          name: fullPathName,
          type: mapping.type,
          subtype: mapping.subtype || null,
          parentId: null, // Will set in second pass
          isActive: !isTrue(mdAccount.is_inactive),
          isInvestmentCash: false,
        };

        // Insert or update existing account (handles duplicates from re-imports)
        const [inserted] = await db
          .insert(accounts)
          .values(newAccount)
          .onConflictDoUpdate({
            target: [accounts.name, accounts.bookId],
            set: {
              type: mapping.type,
              subtype: mapping.subtype || null,
              isActive: !isTrue(mdAccount.is_inactive),
            },
          })
          .returning();
        idMapper.setAccount(mdAccount.id, inserted.id);

        // Track accounts with initial balance (sbal field)
        if (mdAccount.sbal) {
          const initialBalance = parseInt(mdAccount.sbal);
          if (initialBalance !== 0) {
            stats.accountsWithBalances.push({
              mdAccountId: mdAccount.id,
              cpAccountId: inserted.id,
              accountName: fullPathName,
              accountType: mapping.type,
              accountSubtype: mapping.subtype || null,
              initialBalance,
              creationDate: mdAccount.creation_date || new Date().toISOString(),
            });

            if (options.verbose) {
              console.log(`  ⓘ Has initial balance: $${(initialBalance / 100).toFixed(2)}`);
            }
          }
        }

        // Track loan accounts with init_principal for legacy compatibility
        if (mapping.subtype === "loan" && mdAccount.init_principal) {
          const initPrincipal = parseInt(mdAccount.init_principal);
          if (initPrincipal > 0) {
            stats.loansWithBalances.push({
              mdAccountId: mdAccount.id,
              cpAccountId: inserted.id,
              accountName: fullPathName,
              accountType: mapping.type,
              accountSubtype: mapping.subtype || null,
              initialBalance: initPrincipal,
              creationDate: mdAccount.creation_date || new Date().toISOString(),
            });

            if (options.verbose) {
              console.log(`  ⓘ Loan has initial principal: $${(initPrincipal / 100).toFixed(2)}`);
            }
          }
        }

        // For investment accounts, create a cash sub-account
        if (mapping.subtype === "investment") {
          const cashAccount: NewAccount = {
            bookId: bookId!,
            name: `${fullPathName} - Cash`,
            type: "asset",
            subtype: "cash",
            parentId: inserted.id,
            isActive: !isTrue(mdAccount.is_inactive),
            isInvestmentCash: true,
          };

          // Insert or update existing cash account
          const [cashInserted] = await db
            .insert(accounts)
            .values(cashAccount)
            .onConflictDoUpdate({
              target: [accounts.name, accounts.bookId],
              set: {
                parentId: inserted.id,
                isActive: !isTrue(mdAccount.is_inactive),
              },
            })
            .returning();
          // Map with special suffix so we can find it later for xfrtp_bank transactions
          idMapper.setAccount(`${mdAccount.id}_CASH`, cashInserted.id);

          if (options.verbose) {
            console.log(`  ✓ ${fullPathName} (${mapping.type}/${mapping.subtype || "none"}) + cash account`);
          }
        } else if (options.verbose) {
          console.log(`  ✓ ${fullPathName} (${mapping.type}/${mapping.subtype || "none"})`);
        }

        stats.imported++;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        const fullPathName = buildAccountFullPath(mdAccount, mdAccounts);
        stats.errors.push({
          account: fullPathName,
          error: errorMsg,
        });
        console.error(`  ✗ Error importing ${fullPathName}: ${errorMsg}`);
      }
    }

    // Second pass: Set up parent relationships
    console.log("\nSetting up account hierarchy...");
    for (const { mdAccount } of accountsToImport) {
      if (mdAccount.parentid) {
        const childId = idMapper.getAccount(mdAccount.id);
        const parentId = idMapper.getAccount(mdAccount.parentid);

        if (childId && parentId) {
          try {
            await db
              .update(accounts)
              .set({ parentId })
              .where(eq(accounts.id, childId));

            if (options.verbose) {
              const fullPathName = buildAccountFullPath(mdAccount, mdAccounts);
              console.log(`  ↳ ${fullPathName} → parent set`);
            }
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            const fullPathName = buildAccountFullPath(mdAccount, mdAccounts);
            console.error(`  ✗ Error setting parent for ${fullPathName}: ${errorMsg}`);
          }
        }
      }
    }
  } else {
    console.log("  [DRY RUN] Would import accounts:");
    for (const { mdAccount, mapping } of accountsToImport) {
      const fullPathName = buildAccountFullPath(mdAccount, mdAccounts);
      console.log(`    ${fullPathName} (${mapping.type}/${mapping.subtype || "none"})`);

      // Track accounts with initial balance even in dry run
      if (mdAccount.sbal) {
        const initialBalance = parseInt(mdAccount.sbal);
        if (initialBalance !== 0) {
          const placeholderId = -(stats.accountsWithBalances.length + 1);
          stats.accountsWithBalances.push({
            mdAccountId: mdAccount.id,
            cpAccountId: placeholderId,
            accountName: fullPathName,
            accountType: mapping.type,
            accountSubtype: mapping.subtype || null,
            initialBalance,
            creationDate: mdAccount.creation_date || new Date().toISOString(),
          });

          if (options.verbose) {
            console.log(`      ⓘ Has initial balance: $${(initialBalance / 100).toFixed(2)}`);
          }
        }
      }

      // Track loan accounts with init_principal for legacy compatibility
      if (mapping.subtype === "loan" && mdAccount.init_principal) {
        const initPrincipal = parseInt(mdAccount.init_principal);
        if (initPrincipal > 0) {
          // Use a placeholder ID for dry run (negative to avoid conflicts)
          const placeholderId = -(stats.loansWithBalances.length + 1);
          stats.loansWithBalances.push({
            mdAccountId: mdAccount.id,
            cpAccountId: placeholderId,
            accountName: fullPathName,
            accountType: mapping.type,
            accountSubtype: mapping.subtype || null,
            initialBalance: initPrincipal,
            creationDate: mdAccount.creation_date || new Date().toISOString(),
          });

          if (options.verbose) {
            console.log(`      ⓘ Has initial principal: $${(initPrincipal / 100).toFixed(2)}`);
          }
        }
      }
    }
    stats.imported = accountsToImport.length;
  }

  // Import securities
  if (securitiesToImport.length > 0) {
    // Build a map of currency records to look up tickers
    const currencyMap = new Map<string, MoneydanceItem>();
    const itemsToSearch = allItems || mdAccounts;
    for (const item of itemsToSearch) {
      // Currency records have obj_type "curr"
      if (item.obj_type === "curr") {
        currencyMap.set(item.id, item);
        // Also map by currid if it exists
        const currid = item.currid as string | undefined;
        if (currid) {
          currencyMap.set(currid, item);
        }
      }
    }

    if (options.verbose) {
      console.log(`  Found ${currencyMap.size} currency record(s) for ticker lookup`);
    }

    // Group securities by their underlying security reference (curr field)
    // Multiple security accounts can reference the same security
    const securityGroups = new Map<string, MoneydanceAccount[]>();

    for (const mdAccount of securitiesToImport) {
      const securityRef = mdAccount.curr || mdAccount.currid || mdAccount.id;
      if (!securityGroups.has(securityRef)) {
        securityGroups.set(securityRef, []);
      }
      securityGroups.get(securityRef)!.push(mdAccount);
    }

    console.log(`\nImporting ${securityGroups.size} unique securities (${securitiesToImport.length} total references)...`);

    if (!options.dryRun) {
      for (const accounts of securityGroups.values()) {
        try {
          // Use the first account as the primary reference
          const primaryAccount = accounts[0];

          // Look up the currency record to get the ticker
          const currencyId = primaryAccount.currid || primaryAccount.curr;
          const currencyRecord = currencyId ? currencyMap.get(currencyId) : null;
          const ticker = (currencyRecord?.ticker as string | undefined) || primaryAccount.ticker;

          // Warn if we couldn't find a proper ticker
          if (!ticker || ticker === primaryAccount.name) {
            if (options.verbose) {
              console.log(`  ⚠ Security "${primaryAccount.name}" has no distinct ticker symbol${currencyId ? ` (currency ID: ${currencyId})` : ''}`);
            }
          }

          // Determine security type
          const secType = primaryAccount.sec_type;
          let securityType: "stock" | "etf" | "mutual_fund" = "stock";

          if (secType === "2") {
            securityType = "mutual_fund";
          } else if (secType === "1") {
            securityType = "etf";
          }

          const newSecurity: NewSecurity = {
            bookId: bookId!,
            name: primaryAccount.name,
            symbol: ticker || primaryAccount.name,
            securityType,
          };

          // Insert or get existing security (handles duplicates from re-imports)
          const [inserted] = await db
            .insert(securities)
            .values(newSecurity)
            .onConflictDoUpdate({
              target: [securities.name, securities.symbol, securities.bookId],
              set: {
                securityType,
              },
            })
            .returning();

          // Map all account IDs that reference this security to the same Counterpoise security
          for (const account of accounts) {
            idMapper.setSecurity(account.id, inserted.id);
          }

          // Also map the currency ID (currid) so stock splits can find the security
          // The currid field is what stock splits reference via their "curr" field
          if (accounts[0].currid) {
            idMapper.setSecurity(accounts[0].currid, inserted.id);
          }

          if (options.verbose) {
            const tickerInfo = ticker && ticker !== primaryAccount.name ? ` [${ticker}]` : '';
            console.log(`  ✓ ${primaryAccount.name}${tickerInfo} (${securityType}) - ${accounts.length} reference(s)`);
          }

          stats.securities++;
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          stats.errors.push({
            account: accounts[0].name,
            error: errorMsg,
          });
          console.error(`  ✗ Error importing security ${accounts[0].name}: ${errorMsg}`);
        }
      }
    } else {
      console.log("  [DRY RUN] Would import securities:");
      const itemsToSearch = allItems || mdAccounts;
      const currencyMap = new Map<string, MoneydanceItem>();
      for (const item of itemsToSearch) {
        if (item.obj_type === "curr") {
          currencyMap.set(item.id, item);
          const currid = item.currid as string | undefined;
          if (currid) {
            currencyMap.set(currid, item);
          }
        }
      }

      for (const accounts of securityGroups.values()) {
        const primary = accounts[0];
        const currencyId = primary.currid || primary.curr;
        const currencyRecord = currencyId ? currencyMap.get(currencyId) : null;
        const ticker = (currencyRecord?.ticker as string | undefined) || primary.ticker;

        if (!ticker || ticker === primary.name) {
          console.log(`    ⚠ ${primary.name} (no distinct ticker${currencyId ? `, currency ID: ${currencyId}` : ''}) - ${accounts.length} reference(s)`);
        } else {
          console.log(`    ${primary.name} [${ticker}] - ${accounts.length} reference(s)`);
        }
      }
      stats.securities = securityGroups.size;
    }
  }

  console.log("\n📊 Account Import Summary:");
  console.log(`  Accounts imported: ${stats.imported}`);
  console.log(`  Securities imported: ${stats.securities}`);
  console.log(`  Skipped: ${stats.skipped}`);
  console.log(`  Errors: ${stats.errors.length}`);

  return stats;
}
