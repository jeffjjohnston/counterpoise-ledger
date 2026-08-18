import { eq } from "drizzle-orm";
import type { AppDb } from "../../db";
import {
  accounts,
  investmentLots,
  investmentSplits,
  payees,
  plaidAccounts,
  plaidTokens,
  plaidTransactionReconciliation,
  recurringRules,
  recurringTemplateSplits,
  securities,
  securityPrices,
  transactions,
  transactionSplits,
} from "../../db/schema";

/**
 * Delete all data for a given book from the unified database.
 * Deletes in reverse FK dependency order to avoid constraint violations.
 */
export async function overwriteBookDataForImport(db: AppDb, bookId: number): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(plaidTransactionReconciliation).where(eq(plaidTransactionReconciliation.bookId, bookId));
    await tx.delete(plaidAccounts).where(eq(plaidAccounts.bookId, bookId));
    await tx.delete(plaidTokens).where(eq(plaidTokens.bookId, bookId));
    await tx.delete(investmentSplits).where(eq(investmentSplits.bookId, bookId));
    await tx.delete(investmentLots).where(eq(investmentLots.bookId, bookId));
    await tx.delete(securityPrices).where(eq(securityPrices.bookId, bookId));
    await tx.delete(transactionSplits).where(eq(transactionSplits.bookId, bookId));
    await tx.delete(transactions).where(eq(transactions.bookId, bookId));
    await tx.delete(recurringTemplateSplits).where(eq(recurringTemplateSplits.bookId, bookId));
    await tx.delete(recurringRules).where(eq(recurringRules.bookId, bookId));
    await tx.delete(securities).where(eq(securities.bookId, bookId));
    await tx.delete(payees).where(eq(payees.bookId, bookId));
    await tx.delete(accounts).where(eq(accounts.bookId, bookId));
  });
}
