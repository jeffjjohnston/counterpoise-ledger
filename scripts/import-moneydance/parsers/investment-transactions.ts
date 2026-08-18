/**
 * Phase 4: Investment Transactions Import
 * Two-pass approach:
 * 1. Create transactions and lots for buys
 * 2. Match sells to lots using FIFO
 */

import type {
  MoneydanceItem,
  MoneydanceTransaction,
  ImportOptions,
  IdMapper,
  TransactionSplit,
  InvestmentLot,
} from "../types";
import {
  convertDate,
  convertAmount,
  calculatePriceFromTransaction,
  normalizeName,
  normalizeOptionalText,
  isTransactionReconciled,
} from "../utils/format";
import { validateTransaction } from "../utils/validation";
import { getDb, type AppDb } from "../../../db";
import { eq } from "drizzle-orm";
import {
  accounts,
  transactions,
  transactionSplits,
  investmentSplits,
  investmentLots,
  type NewTransaction,
  type NewTransactionSplit,
  type InvestmentSplit,
  type NewInvestmentSplit,
  type NewInvestmentLot,
} from "../../../db/schema";

/**
 * Check if transaction is an investment transaction
 */
export function isInvestmentTransaction(txn: MoneydanceTransaction): boolean {
  if (!txn.xfer_type) return false;

  return (
    txn.xfer_type === "xfrtp_buysell" ||
    txn.xfer_type === "xfrtp_buysellxfr" ||
    txn.xfer_type === "xfrtp_dividend" ||
    txn.xfer_type === "xfrtp_capgain" ||
    txn.xfer_type === "xfrtp_miscincexp"
  );
}

/**
 * Build a map of security account ID to decimal precision
 */
function buildSecurityPrecisionMap(items: MoneydanceItem[]): Map<string, number> {
  const precisionMap = new Map<string, number>();

  // Build map of curr old_id to dec value
  const currencyMap = new Map<string, number>();
  for (const item of items) {
    if (item.obj_type === "curr" && item.old_id && item.dec) {
      currencyMap.set(item.old_id as string, parseInt(item.dec as string));
    }
  }

  // Map security accounts to their precision
  for (const item of items) {
    if (item.obj_type === "acct" && item.type === "s" && item.curr) {
      const dec = currencyMap.get(item.curr as string) || 5; // Default to 5 if not found
      precisionMap.set(item.id, dec);
    }
  }

  return precisionMap;
}

/**
 * Extract splits from transaction by parsing numbered properties
 */
function extractInvestmentSplits(txn: MoneydanceTransaction): TransactionSplit[] {
  const splits: TransactionSplit[] = [];
  const indexes = new Set<number>();

  // Find all split indexes
  for (const key in txn) {
    if (key.match(/^\d+\./)) {
      const index = parseInt(key.split(".")[0]);
      indexes.add(index);
    }
  }

  // Extract data for each split
  for (const index of Array.from(indexes).sort()) {
    const splitType = txn[`${index}.invest.splittype`] as string | undefined;
    const samt = txn[`${index}.samt`] as string | number | undefined;
    const pamt = txn[`${index}.pamt`] as string | number | undefined;
    const acctid = txn[`${index}.acctid`] as string | undefined;
    const secid = txn[`${index}.secid`] as string | undefined;

    splits.push({
      splitType: splitType || "unknown",
      // Don't convert shares here - will be converted based on security precision later
      samt: samt ? (typeof samt === "string" ? parseInt(samt) : samt) : undefined,
      pamt: pamt ? convertAmount(pamt) : undefined,
      acctid: acctid || undefined,
      secid: secid || undefined,
    });
  }

  return splits;
}

/**
 * Determine investment action from transaction type and splits
 */
function determineAction(
  txn: MoneydanceTransaction,
  secSplit: TransactionSplit
): "buy" | "sell" | "dividend" | "capGain" | "fee" {
  if (txn.xfer_type === "xfrtp_dividend") {
    return "dividend";
  }

  if (txn.xfer_type === "xfrtp_capgain") {
    return "capGain";
  }

  // For buy/sell transactions, check share direction
  if (secSplit.samt) {
    return secSplit.samt > 0 ? "buy" : "sell";
  }

  // Default to buy
  return "buy";
}

/**
 * Check if this is a dividend reinvestment (dividend with shares purchased)
 */
function isDividendReinvestment(action: string, secSplit: TransactionSplit): boolean {
  return action === "dividend" && !!secSplit.samt && Math.abs(secSplit.samt) > 0;
}

/**
 * Pass 1: Import investment transactions and create lots for buys
 */
export async function importInvestmentTransactions(
  mdTransactions: MoneydanceTransaction[],
  allItems: MoneydanceItem[],
  idMapper: IdMapper,
  options: ImportOptions,
  dbOverride?: AppDb,
  bookId?: number
): Promise<{
  total: number;
  imported: number;
  skipped: number;
  buys: number;
  sells: number;
  dividends: number;
  lots: number;
  orphanedSells: number;
  errors: Array<{ transaction: string; error: string }>;
}> {
  console.log("\n📈 Phase 4: Importing Investment Transactions");
  console.log("=".repeat(60));
  const db = dbOverride ?? getDb();

  const stats = {
    total: 0,
    imported: 0,
    skipped: 0,
    buys: 0,
    sells: 0,
    dividends: 0,
    lots: 0,
    orphanedSells: 0,
    errors: [] as Array<{ transaction: string; error: string }>,
  };

  // Build security precision map
  const precisionMap = buildSecurityPrecisionMap(allItems);

  // Filter to investment transactions
  const investmentTxns = mdTransactions.filter(isInvestmentTransaction);
  stats.total = investmentTxns.length;
  console.log(`Found ${stats.total} investment transactions`);

  if (stats.total === 0) {
    console.log("No investment transactions to import");
    return stats;
  }

  // Sort by date for FIFO lot matching
  investmentTxns.sort((a, b) => a.dt.localeCompare(b.dt));

  // Track created lots for Pass 2
  const lotsBySecurityAccount = new Map<string, InvestmentLot[]>();

  if (!options.dryRun) {
    console.log("\nPass 1: Creating transactions and lots...");

    let count = 0;
    const total = investmentTxns.length;

    for (const txn of investmentTxns) {
      count++;

      try {
        // Validate transaction
        const validation = validateTransaction(txn);
        if (!validation.valid) {
          const errorMsg = validation.errors.join(", ");
          stats.errors.push({
            transaction: txn.id,
            error: errorMsg,
          });
          stats.skipped++;
          if (options.verbose) {
            console.log(`  ⊗ Skipped ${txn.id}: ${errorMsg}`);
          }
          continue;
        }

        // Extract splits
        const splits = extractInvestmentSplits(txn);
        if (splits.length === 0) {
          const errorMsg = "No valid splits found";
          stats.errors.push({
            transaction: txn.id,
            error: errorMsg,
          });
          stats.skipped++;
          if (options.verbose) {
            console.log(`  ⊗ Skipped ${txn.id}: ${errorMsg}`);
          }
          continue;
        }

        // Find security split (splitType = "sec")
        const secSplit = splits.find((s) => s.splitType === "sec");
        if (!secSplit) {
          const errorMsg = `No security split found (splits: ${splits.length}, types: ${splits.map(s => s.splitType).join(", ")})`;
          stats.errors.push({
            transaction: txn.id,
            error: errorMsg,
          });
          stats.skipped++;
          if (options.verbose) {
            console.log(`  ⊗ Skipped ${txn.id}: ${errorMsg}`);
          }
          continue;
        }

        // Map security ID (for "sec" splits, the security is referenced by acctid)
        const securityAccountId = secSplit.secid || secSplit.acctid;
        if (!securityAccountId) {
          const errorMsg = "Security split has no account/security ID";
          stats.errors.push({
            transaction: txn.id,
            error: errorMsg,
          });
          stats.skipped++;
          if (options.verbose) {
            console.log(`  ⊗ Skipped ${txn.id}: ${errorMsg}`);
          }
          continue;
        }

        const securityId = idMapper.getSecurity(securityAccountId);
        if (!securityId) {
          const errorMsg = `Security not found: ${securityAccountId}`;
          stats.errors.push({
            transaction: txn.id,
            error: errorMsg,
          });
          stats.skipped++;
          if (options.verbose) {
            console.log(`  ⊗ Skipped ${txn.id}: ${errorMsg}`);
          }
          continue;
        }

        // Map account ID (investment account)
        const accountId = idMapper.getAccount(txn.acctid);
        if (!accountId) {
          const errorMsg = `Account not found: ${txn.acctid}`;
          stats.errors.push({
            transaction: txn.id,
            error: errorMsg,
          });
          stats.skipped++;
          if (options.verbose) {
            console.log(`  ⊗ Skipped ${txn.id}: ${errorMsg}`);
          }
          continue;
        }

        // Determine action
        const action = determineAction(txn, secSplit);

        // Check if this is a dividend reinvestment (needs to be split into two transactions)
        const isReinvestment = isDividendReinvestment(action, secSplit);

        // Create transaction(s)
        const payeeName = txn.desc ? normalizeName(txn.desc) : null;
        const payeeId = payeeName ? idMapper.getPayee(payeeName) : null;

        if (isReinvestment) {
          // Dividend reinvestment: Create TWO transactions
          // 1. Cash dividend transaction
          // 2. Buy transaction with shares

          // Convert shares from Moneydance format to Counterpoise micros
          const securityPrecision = precisionMap.get(securityAccountId) || 5;
          const conversionFactor = Math.pow(10, 6 - securityPrecision);
          const samtMicros = Math.round((secSplit.samt || 0) * conversionFactor);

          // Calculate price from pamt and samt (in micros)
          const pamt = Math.abs(secSplit.pamt || 0);
          const samt = Math.abs(samtMicros);
          const priceMicros = samt > 0 ? calculatePriceFromTransaction(pamt, samt) : 0;

          // Find income split for dividend amount
          const incomeSplit = splits.find((s) => s.splitType === "inc");
          const dividendAmountCents = incomeSplit?.samt ? Math.abs(incomeSplit.samt) : pamt;

          // Captured inside the transaction below, applied to the FIFO map only
          // after the transaction commits (a rollback must not leave a lot
          // reference for a row that no longer exists).
          let newLotForPass2: InvestmentLot | undefined;
          // Counted locally and applied only after the transaction commits, for
          // the same reason as the lot reference above: an increment survives a
          // rollback, so the summary would report rows that were never written.
          const counted = { dividends: 0, buys: 0, lots: 0, imported: 0 };

          await db.transaction(async (tx) => {
            // Transaction 1: Cash dividend
            const dividendTransaction: NewTransaction = {
              bookId: bookId!,
              date: convertDate(txn.dt),
              description: `${txn.desc || ""} (Dividend)`.trim(),
              checkNumber: normalizeOptionalText(txn.chk),
              payeeId: payeeId || null,
              isReconciled: isTransactionReconciled(txn),
              recurringRuleId: null,
            };

            const [dividendTxn] = await tx.insert(transactions).values(dividendTransaction).returning();

            // Create investment split for dividend (0 shares)
            const dividendInvestmentSplit: NewInvestmentSplit = {
              bookId: bookId!,
              transactionId: dividendTxn.id,
              accountId,
              securityId,
              lotId: null,
              action: "dividend",
              sharesMicros: 0,
              priceMicros: 0,
              feesCents: 0,
              splitNumerator: null,
              splitDenominator: null,
            };
            await tx.insert(investmentSplits).values(dividendInvestmentSplit);

            // Create transaction splits for dividend
            const investmentCashAccountId = idMapper.getAccount(`${txn.acctid}_CASH`);

            // Cash account receives dividend
            if (investmentCashAccountId) {
              const cashSplit: NewTransactionSplit = {
                bookId: bookId!,
                transactionId: dividendTxn.id,
                accountId: investmentCashAccountId,
                amount: dividendAmountCents,
              };
              await tx.insert(transactionSplits).values(cashSplit);
            }

            // Income account (credit)
            if (incomeSplit?.acctid) {
              const incomeAccountId = idMapper.getAccount(incomeSplit.acctid);
              if (incomeAccountId) {
                const incomeSplitRecord: NewTransactionSplit = {
                  bookId: bookId!,
                  transactionId: dividendTxn.id,
                  accountId: incomeAccountId,
                  amount: -dividendAmountCents,
                };
                await tx.insert(transactionSplits).values(incomeSplitRecord);
              }
            }

            counted.dividends++;

            // Transaction 2: Buy with shares
            const buyTransaction: NewTransaction = {
              bookId: bookId!,
              date: convertDate(txn.dt),
              description: `${txn.desc || ""} (Reinvestment)`.trim(),
              checkNumber: normalizeOptionalText(txn.chk),
              payeeId: payeeId || null,
              isReconciled: isTransactionReconciled(txn),
              recurringRuleId: null,
            };

            const [buyTxn] = await tx.insert(transactions).values(buyTransaction).returning();

            // Find fee split
            const feeSplit = splits.find((s) => s.splitType === "fee");
            const feesCents = feeSplit?.pamt ? Math.abs(feeSplit.pamt) : 0;

            // Create investment split for buy
            const buyInvestmentSplit: NewInvestmentSplit = {
              bookId: bookId!,
              transactionId: buyTxn.id,
              accountId,
              securityId,
              lotId: null,
              action: "buy",
              sharesMicros: Math.abs(samtMicros),
              priceMicros,
              feesCents,
              splitNumerator: null,
              splitDenominator: null,
            };
            const [insertedBuySplit] = await tx
              .insert(investmentSplits)
              .values(buyInvestmentSplit)
              .returning();

            // Create lot for the buy. Computed once and reused below for the
            // investment account's own transaction split, so the lot's basis and
            // the ledger amount can never drift apart. (This synthetic reinvestment
            // buy is never a BuyXfr, so there's no transfer-amount branch to
            // reconcile against here, unlike the normal buy path below.)
            const buyBasisCents = pamt + feesCents;
            const newLot: NewInvestmentLot = {
              bookId: bookId!,
              accountId,
              securityId,
              acquiredDate: convertDate(txn.dt),
              openedSplitId: insertedBuySplit.id,
              openedTransactionId: buyTxn.id,
              closedTransactionId: null,
              originalSharesMicros: Math.abs(samtMicros),
              originalBasisCents: buyBasisCents,
              remainingSharesMicros: Math.abs(samtMicros),
              remainingBasisCents: buyBasisCents,
            };

            const [lot] = await tx.insert(investmentLots).values(newLot).returning();

            // Track lot for Pass 2 (applied to the map after this transaction commits)
            newLotForPass2 = {
              ...lot,
              securityId,
              accountId,
              remainingShares: samt,
            };

            // Create transaction splits for buy
            // Investment account increases
            const buyInvestmentSplit2: NewTransactionSplit = {
              bookId: bookId!,
              transactionId: buyTxn.id,
              accountId,
              amount: buyBasisCents,
            };
            await tx.insert(transactionSplits).values(buyInvestmentSplit2);

            // Cash account decreases
            if (investmentCashAccountId) {
              const buyCashSplit: NewTransactionSplit = {
                bookId: bookId!,
                transactionId: buyTxn.id,
                accountId: investmentCashAccountId,
                amount: -buyBasisCents,
              };
              await tx.insert(transactionSplits).values(buyCashSplit);
            }

            counted.buys++;
            counted.lots++;
            counted.imported += 2; // Two transactions created
          });

          stats.dividends += counted.dividends;
          stats.buys += counted.buys;
          stats.lots += counted.lots;
          stats.imported += counted.imported;

          // Track lot for Pass 2 now that the transaction has committed
          const key = `${securityId}-${accountId}`;
          if (!lotsBySecurityAccount.has(key)) {
            lotsBySecurityAccount.set(key, []);
          }
          lotsBySecurityAccount.get(key)!.push(newLotForPass2!);

          if (options.verbose) {
            console.log(
              `  ✓ ${convertDate(txn.dt)} - DIVIDEND REINVESTMENT ${txn.desc || "(no description)"} (split into 2 txns)`
            );
          }

          continue; // Skip the normal transaction creation logic
        }

        // Normal transaction (not a reinvestment)
        const newTransaction: NewTransaction = {
          bookId: bookId!,
          date: convertDate(txn.dt),
          description: txn.desc || null,
          checkNumber: normalizeOptionalText(txn.chk),
          payeeId: payeeId || null,
          isReconciled: isTransactionReconciled(txn),
          recurringRuleId: null,
        };

        // Convert shares from Moneydance format to Counterpoise micros
        // Moneydance: shares * 10^dec (where dec varies by security)
        // Counterpoise: shares * 10^6
        const securityPrecision = precisionMap.get(securityAccountId) || 5;
        const conversionFactor = Math.pow(10, 6 - securityPrecision);
        const samtMicros = Math.round((secSplit.samt || 0) * conversionFactor);

        // Calculate price from pamt and samt (in micros)
        const pamt = Math.abs(secSplit.pamt || 0);
        const samt = Math.abs(samtMicros);
        const priceMicros = samt > 0 ? calculatePriceFromTransaction(pamt, samt) : 0;

        // Find fee split
        const feeSplit = splits.find((s) => s.splitType === "fee");
        const feesCents = feeSplit?.pamt ? Math.abs(feeSplit.pamt) : 0;

        // Captured inside the transaction below, applied to the FIFO map only
        // after the transaction commits (a rollback must not leave a lot
        // reference for a row that no longer exists).
        let newLotForPass2: InvestmentLot | undefined;
        // Counted locally and applied only after the transaction commits, for
        // the same reason as the lot reference above: an increment survives a
        // rollback, so the summary would report rows that were never written.
        const counted = { lots: 0, buys: 0, sells: 0, dividends: 0 };

        await db.transaction(async (tx) => {
          const [insertedTxn] = await tx.insert(transactions).values(newTransaction).returning();

          // Create investment split (shares belong to investment account, not cash sub-account)
          const newInvestmentSplit: NewInvestmentSplit = {
            bookId: bookId!,
            transactionId: insertedTxn.id,
            accountId, // Investment account ID
            securityId,
            lotId: null, // Will be set in Pass 2 for sells
            action,
            sharesMicros: Math.abs(samtMicros),
            priceMicros,
            feesCents,
            splitNumerator: null,
            splitDenominator: null,
          };

          const [insertedInvestmentSplit] = await tx
            .insert(investmentSplits)
            .values(newInvestmentSplit)
            .returning();

          // Create transaction splits for cash movements
          // In Moneydance: pamt = from parent's perspective, samt = from split account's perspective

          // Calculate parent (investment cash) amount: sum of all pamt values
          let investmentCashAmount = 0;
          for (const split of splits) {
            if (split.pamt !== undefined) {
              investmentCashAmount += split.pamt;
            }
          }

          // Calculate investment account value change (for buy/sell/dividend actions).
          // This is the offsetting split needed for double-entry accounting, and — for
          // buys — it is also the lot's cost basis below, computed once and reused so
          // the two can never drift apart.

          // Check if this is a transfer transaction (BuyXfr/SellXfr)
          const xfrSplit = splits.find((s) => s.splitType === "xfr");
          const isTransferTransaction = xfrSplit !== undefined;

          let investmentAccountAmount = 0;
          if (action === "buy" || action === "sell") {
            if (isTransferTransaction) {
              // For BuyXfr/SellXfr: cash is transferred to/from another account
              // Use the security split's pamt (which represents the transaction value)
              // For sells: pamt is positive (proceeds), investment decreases (negative)
              // For buys: pamt is negative (cost), investment increases (positive)
              // NOTE: unlike the non-transfer branch, this does NOT include feesCents —
              // Moneydance doesn't fold a separate fee split into the transfer amount.
              investmentAccountAmount = -(secSplit.pamt ?? 0);
            } else {
              // Normal buy/sell: offset the cash movement (this sum already includes
              // any fee split's pamt)
              investmentAccountAmount = -investmentCashAmount;
            }
          } else if (action === "dividend" && secSplit.samt && Math.abs(secSplit.samt) > 0) {
            // For reinvested dividends (shares purchased), investment value increases
            // The amount should offset the income split
            // If pamt is negative, shares were purchased with dividend (reinvestment)
            investmentAccountAmount = -(secSplit.pamt ?? 0);
          }
          // For cash dividends (no shares), the offset is just the income account (handled below with "inc" splits)

          // For buys, create investment lot. Basis is investmentAccountAmount — the
          // same figure recorded a few lines below to the investment account's own
          // transaction split — not a separately recomputed pamt + feesCents, so the
          // lot and the ledger can never disagree (this matters for BuyXfr, where the
          // transfer amount excludes fees; see the branch above).
          if (action === "buy" && samt > 0) {
            const buyBasisCents = investmentAccountAmount;
            const newLot: NewInvestmentLot = {
              bookId: bookId!,
              accountId,
              securityId,
              acquiredDate: convertDate(txn.dt),
              openedSplitId: insertedInvestmentSplit.id,
              openedTransactionId: insertedTxn.id,
              closedTransactionId: null,
              originalSharesMicros: samt,
              originalBasisCents: buyBasisCents,
              remainingSharesMicros: samt,
              remainingBasisCents: buyBasisCents,
            };

            const [lot] = await tx.insert(investmentLots).values(newLot).returning();

            // Track lot for Pass 2 (applied to the map after this transaction commits)
            newLotForPass2 = {
              ...lot,
              securityId,
              accountId,
              remainingShares: samt, // Already converted to micros
            };

            counted.lots++;
            counted.buys++;
          } else if (action === "sell") {
            counted.sells++;
          } else if (action === "dividend") {
            counted.dividends++;
          }

          // Create split for investment account itself (not the cash sub-account)
          // This represents the change in investment value
          if (investmentAccountAmount !== 0) {
            const newSplit: NewTransactionSplit = {
              bookId: bookId!,
              transactionId: insertedTxn.id,
              accountId, // Investment account ID (not cash)
              amount: investmentAccountAmount,
            };
            await tx.insert(transactionSplits).values(newSplit);
          }

          // Create split for investment account's cash sub-account
          const investmentCashAccountId = idMapper.getAccount(`${txn.acctid}_CASH`);

          // Special handling for cash dividends (not reinvested):
          // If investmentCashAmount is 0 but there's an inc split and NO shares are acquired,
          // this is a cash dividend where the cash flow is obscured by Moneydance's internal representation
          const incomeSplit = splits.find((s) => s.splitType === "inc");
          let actualCashAmount = investmentCashAmount;
          if (action === "dividend" && investmentCashAmount === 0 && incomeSplit && incomeSplit.pamt) {
            // Check if this is a cash dividend (no shares) or reinvested dividend (has shares)
            const hasShares = secSplit.samt && Math.abs(secSplit.samt) > 0;
            if (!hasShares) {
              // Cash dividend: use the sec split's negative pamt (which represents cash into the account)
              actualCashAmount = -(secSplit.pamt ?? 0);
            }
            // For reinvested dividends, actualCashAmount stays 0 (no cash movement)
          }

          if (investmentCashAccountId && actualCashAmount !== 0) {
            const newSplit: NewTransactionSplit = {
              bookId: bookId!,
              transactionId: insertedTxn.id,
              accountId: investmentCashAccountId,
              amount: actualCashAmount,
            };
            await tx.insert(transactionSplits).values(newSplit);
          }

          // Create splits for external accounts (xfr, inc) using samt values
          for (const split of splits) {
            if ((split.splitType === "xfr" || split.splitType === "inc") && split.acctid && split.samt !== undefined) {
              let externalAccountId = idMapper.getAccount(split.acctid);

              // For xfr splits going to investment accounts, route to their cash sub-account
              if (split.splitType === "xfr") {
                const cashAccountId = idMapper.getAccount(`${split.acctid}_CASH`);
                if (cashAccountId) {
                  externalAccountId = cashAccountId;
                }
              }

              if (externalAccountId) {
                const newSplit: NewTransactionSplit = {
                  bookId: bookId!,
                  transactionId: insertedTxn.id,
                  accountId: externalAccountId,
                  amount: split.samt,
                };
                await tx.insert(transactionSplits).values(newSplit);
              }
            }
          }

          // Handle dividend reinvestment (has both "inc" and "sec" splits)
          const incSplit = splits.find((s) => s.splitType === "inc");
          if (action === "buy" && incSplit && txn.reinvest === "true") {
            // Create additional dividend split for income tracking
            const dividendSplit: NewInvestmentSplit = {
              bookId: bookId!,
              transactionId: insertedTxn.id,
              accountId, // Investment account ID
              securityId,
              lotId: null,
              action: "dividend",
              sharesMicros: 0,
              priceMicros: 0,
              feesCents: 0,
              splitNumerator: null,
              splitDenominator: null,
            };
            await tx.insert(investmentSplits).values(dividendSplit);
            counted.dividends++;
          }
        });

        stats.lots += counted.lots;
        stats.buys += counted.buys;
        stats.sells += counted.sells;
        stats.dividends += counted.dividends;

        // Track lot for Pass 2 now that the transaction has committed
        if (newLotForPass2) {
          const key = `${securityId}-${accountId}`;
          if (!lotsBySecurityAccount.has(key)) {
            lotsBySecurityAccount.set(key, []);
          }
          lotsBySecurityAccount.get(key)!.push(newLotForPass2);
        }

        stats.imported++;

        if (options.verbose) {
          console.log(
            `  ✓ ${convertDate(txn.dt)} - ${action.toUpperCase()} ${txn.desc || "(no description)"}`
          );
        } else if (count % 200 === 0) {
          const percent = ((count / total) * 100).toFixed(1);
          console.log(`  Progress: ${count}/${total} (${percent}%)...`);
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        stats.errors.push({
          transaction: txn.id,
          error: errorMsg,
        });
        if (options.verbose) {
          console.error(`  ✗ Error importing transaction ${txn.id}: ${errorMsg}`);
        }
      }
    }

    // Pass 2: Match sells to lots using FIFO
    console.log("\nPass 2: Matching sells to lots (FIFO)...");

    // Get all sell transactions with their account info from transaction_splits
    const sellTransactionsQuery = await db
      .select({
        sellSplit: investmentSplits,
        txnSplit: transactionSplits,
        account: accounts,
      })
      .from(investmentSplits)
      .where(eq(investmentSplits.action, "sell"))
      .innerJoin(transactions, eq(transactions.id, investmentSplits.transactionId))
      .innerJoin(transactionSplits, eq(transactionSplits.transactionId, transactions.id))
      .innerJoin(accounts, eq(accounts.id, transactionSplits.accountId));

    // Group by transaction to handle multiple splits per transaction
    const sellsByTransaction = new Map<number, { sellSplit: InvestmentSplit; accountId: number }>();

    for (const { sellSplit, account } of sellTransactionsQuery) {
      // Get the parent investment account (cash account's parent)
      const investmentAccountId = account.parentId || account.id;

      if (!sellsByTransaction.has(sellSplit.transactionId)) {
        sellsByTransaction.set(sellSplit.transactionId, {
          sellSplit,
          accountId: investmentAccountId,
        });
      }
    }

    for (const { sellSplit, accountId } of sellsByTransaction.values()) {
      const key = `${sellSplit.securityId}-${accountId}`;
      const lots = lotsBySecurityAccount.get(key);

      if (!lots || lots.length === 0) {
        stats.orphanedSells++;
        if (options.verbose) {
          console.log(`  ⚠ Orphaned sell: No lots available for security ${sellSplit.securityId}`);
        }
        continue;
      }

      let remainingShares = Math.abs(sellSplit.sharesMicros);

      // Match to lots in FIFO order
      for (const lot of lots) {
        if (remainingShares === 0) break;
        if (lot.remainingShares === 0) continue;

        const sharesToClose = Math.min(lot.remainingShares, remainingShares);

        // Update investment split with lot reference
        await db
          .update(investmentSplits)
          .set({ lotId: lot.id })
          .where(eq(investmentSplits.id, sellSplit.id));

        // Update lot
        lot.remainingShares -= sharesToClose;
        remainingShares -= sharesToClose;

        if (lot.remainingShares === 0) {
          // Lot fully closed
          await db
            .update(investmentLots)
            .set({ closedTransactionId: sellSplit.transactionId })
            .where(eq(investmentLots.id, lot.id));
        }
      }

      if (remainingShares > 0) {
        stats.orphanedSells++;
        if (options.verbose) {
          console.log(
            `  ⚠ Partial match: ${remainingShares} shares could not be matched to lots`
          );
        }
      }
    }

    // Pass 1's hand-written lot inserts (above) and Pass 2's hand-written FIFO
    // matching (above) are both superseded later in the import run: after
    // stock splits are imported, index.ts rebuilds every (account, security)
    // pair touched by this import via the real FIFO replay engine
    // (lib/lots-db.ts), from the investment splits just written, so the final
    // lot/allocation state is engine-derived regardless of what Pass 1/2
    // produced. That rebuild must run after stock splits are imported — this
    // phase runs before them, so it cannot do the rebuild itself; running it
    // here would replay every sell against pre-split share counts and corrupt
    // every downstream number for a book with any stock split. Pass 1 and
    // Pass 2 are slated for deletion, along with investmentSplits.lotId, in a
    // later release — left in place for now since this importer has no test
    // coverage and a full refactor is out of scope here.
  } else {
    console.log("  [DRY RUN] Would import investment transactions:");
    const sample = investmentTxns.slice(0, 5);
    for (const txn of sample) {
      const splits = extractInvestmentSplits(txn);
      const secSplit = splits.find((s) => s.splitType === "sec");
      const action = secSplit ? determineAction(txn, secSplit) : "unknown";
      console.log(`    ${txn.dt} - ${action.toUpperCase()} ${txn.desc || "(no description)"}`);

      // Update stats for dry run
      if (action === "buy" && secSplit?.samt && secSplit.samt > 0) {
        stats.buys++;
        stats.lots++;
      } else if (action === "sell") {
        stats.sells++;
      } else if (action === "dividend") {
        stats.dividends++;
      }
    }

    // Count remaining transactions
    for (let i = 5; i < investmentTxns.length; i++) {
      const txn = investmentTxns[i];
      const splits = extractInvestmentSplits(txn);
      const secSplit = splits.find((s) => s.splitType === "sec");
      const action = secSplit ? determineAction(txn, secSplit) : "unknown";

      if (action === "buy" && secSplit?.samt && secSplit.samt > 0) {
        stats.buys++;
        stats.lots++;
      } else if (action === "sell") {
        stats.sells++;
      } else if (action === "dividend") {
        stats.dividends++;
      }
    }

    if (investmentTxns.length > 5) {
      console.log(`    ... and ${investmentTxns.length - 5} more`);
    }
    stats.imported = investmentTxns.length;
  }

  console.log("\n📊 Investment Transactions Import Summary:");
  console.log(`  Total transactions: ${stats.total}`);
  console.log(`  Imported: ${stats.imported}`);
  console.log(`  Buys: ${stats.buys}`);
  console.log(`  Sells: ${stats.sells}`);
  console.log(`  Dividends: ${stats.dividends}`);
  console.log(`  Lots created: ${stats.lots}`);
  console.log(`  Orphaned sells: ${stats.orphanedSells}`);
  console.log(`  Skipped: ${stats.skipped}`);
  console.log(`  Errors: ${stats.errors.length}`);

  // Show sample errors
  if (stats.errors.length > 0) {
    console.log("\n  Sample errors:");
    const errorSummary = new Map<string, number>();
    for (const err of stats.errors) {
      const key = err.error.split(":")[0]; // Group by error type
      errorSummary.set(key, (errorSummary.get(key) || 0) + 1);
    }
    for (const [error, count] of errorSummary) {
      console.log(`    ${error}: ${count} occurrences`);
    }
    console.log("\n  First few errors:");
    for (let i = 0; i < Math.min(5, stats.errors.length); i++) {
      console.log(`    ${stats.errors[i].transaction}: ${stats.errors[i].error}`);
    }
  }

  return stats;
}
