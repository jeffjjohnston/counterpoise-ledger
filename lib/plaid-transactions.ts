import type { AppDb } from "@/db";
import {
  accounts,
  plaidAccounts,
  plaidTransactionReconciliation,
  transactions,
} from "@/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import type { DisplayTransaction } from "@/types";
import type { PendingTransactionsQuery } from "@/lib/schemas/sync";

/**
 * Offset keeping synthesized IDs clear of the negative IDs the projected
 * recurring endpoint generates (-(ruleId * 10000 + occurrence)) — a collision
 * would need a rule ID of 100 million. Still well within safe integer range.
 */
const PLAID_PENDING_ID_OFFSET = 1_000_000_000_000;

/** "FOOD_AND_DRINK" → "Food And Drink" */
const formatCategory = (category: string | null) =>
  category
    ? category
        .toLowerCase()
        .split("_")
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ")
    : null;

/**
 * Unmatched Plaid transactions shaped as display transactions, so the
 * transaction list can interleave them with real ones. Shown at their
 * authorized date (when the user actually spent) rather than the posted date.
 *
 * Extracted from app/api/b/[bookId]/sync/pending-transactions/route.ts GET,
 * unchanged. `query` is pendingTransactionsQuery's already-parsed shape —
 * parsing the raw query string, and its 400 on failure, stays in the route.
 */
export async function listPendingPlaidTransactions(
  db: AppDb,
  bookId: number,
  query: PendingTransactionsQuery
): Promise<DisplayTransaction[]> {
  const filterAccountId = query.accountId ?? null;

  const rows = await db
    .select({
      recon: plaidTransactionReconciliation,
      account: accounts,
    })
    .from(plaidTransactionReconciliation)
    .innerJoin(
      plaidAccounts,
      and(
        eq(plaidTransactionReconciliation.plaidAccountLinkId, plaidAccounts.id),
        eq(plaidAccounts.bookId, bookId)
      )
    )
    .innerJoin(
      accounts,
      and(
        eq(plaidAccounts.counterpoiseAccountId, accounts.id),
        eq(accounts.bookId, bookId)
      )
    )
    .where(
      and(
        eq(plaidTransactionReconciliation.bookId, bookId),
        eq(plaidTransactionReconciliation.resolutionStatus, "pending"),
        isNull(plaidTransactionReconciliation.reviewReason),
        ...(filterAccountId !== null ? [eq(accounts.id, filterAccountId)] : [])
      )
    );

  const epoch = new Date(0);
  const pending: DisplayTransaction[] = rows.map(({ recon, account }) => {
    const txId = -(PLAID_PENDING_ID_OFFSET + recon.id);
    const payeeName = recon.merchantName ?? recon.name;
    return {
      id: txId,
      bookId,
      date: recon.authorizedDate ?? recon.date,
      description: recon.name,
      checkNumber: null,
      notes: null,
      payeeId: null,
      isReconciled: false,
      isFloating: false,
      recurringRuleId: null,
      createdAt: epoch,
      updatedAt: epoch,
      payee: { id: txId, bookId, name: payeeName, createdAt: epoch },
      splits: [
        {
          id: txId,
          bookId,
          transactionId: txId,
          accountId: account.id,
          // Plaid amounts are positive for outflows; local asset splits
          // are the negation
          amount: -recon.amountCents,
          account,
        },
      ],
      investmentSplits: [],
      isPlaidPending: true,
      plaidCategory: formatCategory(recon.categoryPrimary),
    };
  });

  pending.sort((a, b) => b.date.localeCompare(a.date));

  return pending;
}

export class PlaidLinkNotFoundError extends Error {
  constructor() {
    super("No Plaid link found");
    this.name = "PlaidLinkNotFoundError";
  }
}

/**
 * The staged Plaid row a transaction is matched to, or null when the
 * transaction was entered by hand rather than matched to a bank transaction.
 *
 * Extracted from app/api/b/[bookId]/transactions/[id]/plaid/route.ts GET,
 * unchanged. The route's own guard against an unparseable :id path segment
 * stays there, same precedent as parseTokenId in lib/plaid-tokens.ts.
 */
export async function getTransactionPlaidLink(
  db: AppDb,
  bookId: number,
  transactionId: number
) {
  const [row] = await db
    .select({
      id: plaidTransactionReconciliation.id,
      plaidTransactionId: plaidTransactionReconciliation.plaidTransactionId,
      date: plaidTransactionReconciliation.date,
      authorizedDate: plaidTransactionReconciliation.authorizedDate,
      amountCents: plaidTransactionReconciliation.amountCents,
      name: plaidTransactionReconciliation.name,
      merchantName: plaidTransactionReconciliation.merchantName,
      originalDescription: plaidTransactionReconciliation.originalDescription,
      pending: plaidTransactionReconciliation.pending,
      isoCurrencyCode: plaidTransactionReconciliation.isoCurrencyCode,
      categoryPrimary: plaidTransactionReconciliation.categoryPrimary,
      categoryDetailed: plaidTransactionReconciliation.categoryDetailed,
      rawJson: plaidTransactionReconciliation.rawJson,
    })
    .from(plaidTransactionReconciliation)
    .where(
      and(
        eq(plaidTransactionReconciliation.matchedTransactionId, transactionId),
        eq(plaidTransactionReconciliation.bookId, bookId)
      )
    )
    .limit(1);

  return row ?? null;
}

/**
 * Removes a transaction's Plaid link: every staged row matched to it goes
 * back to `pending` (so the next sync poll offers it again), and the local
 * transaction stops being reconciled — this does not delete anything.
 *
 * Extracted from app/api/b/[bookId]/transactions/[id]/plaid/unlink/route.ts
 * POST. The captureEvent("sync_transaction_unlinked", ...) call stays in the
 * route: attributing it to the authenticated userId is presentation, not
 * something this library has any business knowing.
 */
export async function unlinkPlaidTransaction(
  db: AppDb,
  bookId: number,
  transactionId: number
) {
  const rows = await db
    .select({ id: plaidTransactionReconciliation.id })
    .from(plaidTransactionReconciliation)
    .where(
      and(
        eq(plaidTransactionReconciliation.matchedTransactionId, transactionId),
        eq(plaidTransactionReconciliation.bookId, bookId)
      )
    );

  if (rows.length === 0) {
    throw new PlaidLinkNotFoundError();
  }

  await db.transaction(async (tx) => {
    for (const row of rows) {
      await tx
        .update(plaidTransactionReconciliation)
        .set({
          resolutionStatus: "pending",
          matchedTransactionId: null,
          reviewReason: null,
          reviewMetadataJson: null,
          resolvedAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(plaidTransactionReconciliation.id, row.id),
            eq(plaidTransactionReconciliation.bookId, bookId)
          )
        );
    }

    await tx
      .update(transactions)
      .set({ isReconciled: false, updatedAt: new Date() })
      .where(and(eq(transactions.id, transactionId), eq(transactions.bookId, bookId)));
  });
}
