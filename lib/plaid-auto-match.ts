import { and, asc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import {
  books,
  plaidAccounts,
  plaidTransactionReconciliation,
  transactions,
  transactionSplits,
} from "@/db/schema";
import { normalizePayeeName } from "@/lib/payees";
import { effectiveDateSql } from "@/lib/accounting";
import { captureEvent } from "@/lib/posthog-server";
import { type AppDb } from "@/db";

/**
 * Build a map of normalized Plaid names to sets of Counterpoise payee IDs
 * by querying previously matched reconciliation rows.
 */
export async function buildPayeeMap(
  db: AppDb,
  bookId: number
): Promise<Map<string, Set<number>>> {
  const rows = await db
    .select({
      plaidMerchantName: plaidTransactionReconciliation.merchantName,
      plaidName: plaidTransactionReconciliation.name,
      payeeId: transactions.payeeId,
    })
    .from(plaidTransactionReconciliation)
    .innerJoin(
      transactions,
      eq(plaidTransactionReconciliation.matchedTransactionId, transactions.id)
    )
    .where(
      and(
        eq(plaidTransactionReconciliation.bookId, bookId),
        eq(plaidTransactionReconciliation.resolutionStatus, "matched"),
        isNotNull(transactions.payeeId)
      )
    );

  const map = new Map<string, Set<number>>();

  for (const row of rows) {
    if (!row.payeeId) continue;
    const sourceName = row.plaidMerchantName ?? row.plaidName;
    const key = normalizePayeeName(sourceName).toLowerCase();
    if (!key) continue;

    const existing = map.get(key) ?? new Set<number>();
    existing.add(row.payeeId);
    map.set(key, existing);
  }

  return map;
}

function dayDelta(from: string, to: string): number {
  const start = new Date(`${from}T00:00:00`).getTime();
  const end = new Date(`${to}T00:00:00`).getTime();
  return Math.round((end - start) / 86_400_000);
}

/**
 * Choose the date to stamp on a transaction matched to a Plaid item. Prefer the
 * authorization date (closest to when the user actually entered the
 * transaction), but fall back to the posted date when it lands 7+ days after
 * authorization — a gap that large means the posted date is the meaningful
 * settlement date worth reflecting. Falls back to the posted date when Plaid
 * provides no authorization date.
 *
 * Exported, not inlined, so the auto-matcher and any backfill share one
 * definition of this rule.
 */
export function pickMatchedDate(
  authorizedDate: string | null,
  postedDate: string
): string {
  if (authorizedDate && dayDelta(authorizedDate, postedDate) < 7) {
    return authorizedDate;
  }
  return postedDate;
}

/**
 * Auto-match pending reconciliation rows against existing transactions.
 * Returns the number of successful matches.
 */
export async function autoMatchPendingTransactions(
  db: AppDb,
  bookId: number,
  linkIds: number[]
): Promise<number> {
  if (linkIds.length === 0) return 0;

  const payeeMap = await buildPayeeMap(db, bookId);
  if (payeeMap.size === 0) return 0;

  // Get all pending rows without reviewReason for the given links
  const pendingRows = await db
    .select()
    .from(plaidTransactionReconciliation)
    .where(
      and(
        eq(plaidTransactionReconciliation.bookId, bookId),
        inArray(plaidTransactionReconciliation.plaidAccountLinkId, linkIds),
        eq(plaidTransactionReconciliation.resolutionStatus, "pending"),
        isNull(plaidTransactionReconciliation.reviewReason)
      )
    );

  if (pendingRows.length === 0) return 0;

  // Get counterpoiseAccountId for each link
  const linkRows = await db
    .select({
      linkId: plaidAccounts.id,
      counterpoiseAccountId: plaidAccounts.counterpoiseAccountId,
    })
    .from(plaidAccounts)
    .where(inArray(plaidAccounts.id, linkIds));

  const linkToAccountId = new Map<number, number>();
  for (const row of linkRows) {
    if (row.counterpoiseAccountId) {
      linkToAccountId.set(row.linkId, row.counterpoiseAccountId);
    }
  }

  // Build per-link sets of already-linked transaction IDs.
  // Scoped per-link so a transfer transaction can legitimately match on
  // both linked accounts (manual reconcile enforces uniqueness per link).
  const alreadyLinkedByLink = new Map<number, Set<number>>();
  for (const linkId of linkIds) {
    const rows = await db
      .select({
        matchedTransactionId:
          plaidTransactionReconciliation.matchedTransactionId,
      })
      .from(plaidTransactionReconciliation)
      .where(
        and(
          eq(plaidTransactionReconciliation.plaidAccountLinkId, linkId),
          isNotNull(plaidTransactionReconciliation.matchedTransactionId)
        )
      );

    alreadyLinkedByLink.set(
      linkId,
      new Set(
        rows
          .map((r) => r.matchedTransactionId)
          .filter((id): id is number => id !== null)
      )
    );
  }

  const now = new Date();
  let matchCount = 0;

  // Track matched transaction IDs per link in this run to avoid double-matching
  const matchedInThisRunByLink = new Map<number, Set<number>>();

  for (const reconRow of pendingRows) {
    const mappedAccountId = linkToAccountId.get(reconRow.plaidAccountLinkId);
    if (!mappedAccountId) continue;

    // Look up Plaid name in the learned payee map
    const sourceName = reconRow.merchantName ?? reconRow.name;
    const key = normalizePayeeName(sourceName).toLowerCase();
    if (!key) continue;

    const knownPayeeIds = payeeMap.get(key);
    if (!knownPayeeIds || knownPayeeIds.size === 0) continue;

    const expectedAmount = -reconRow.amountCents;
    // Accept a candidate within ±1 day of either the posted date or the
    // authorization date. Anchoring to the auth date alone misses delayed
    // settlements (posted 7+ days later) that the user entered on the posted
    // date; the union keeps both plausible entry dates in range without
    // widening to the whole gap between them.
    const matchDates = [reconRow.date];
    if (reconRow.authorizedDate) matchDates.push(reconRow.authorizedDate);

    const alreadyLinked =
      alreadyLinkedByLink.get(reconRow.plaidAccountLinkId) ?? new Set();
    const matchedInThisRun =
      matchedInThisRunByLink.get(reconRow.plaidAccountLinkId) ?? new Set();

    // Find candidate transactions: exact amount, matching payee, on mapped account.
    // Ordered by date then id for deterministic first-candidate selection.
    const candidates = await db
      .select({
        transactionId: transactions.id,
        date: effectiveDateSql.as("date"),
      })
      .from(transactionSplits)
      .innerJoin(
        transactions,
        eq(transactionSplits.transactionId, transactions.id)
      )
      .where(
        and(
          eq(transactionSplits.accountId, mappedAccountId),
          eq(transactionSplits.amount, expectedAmount),
          eq(transactions.bookId, bookId),
          inArray(transactions.payeeId, [...knownPayeeIds])
        )
      )
      .orderBy(asc(effectiveDateSql), asc(transactions.id));

    // Filter by date (±1 day) and not already linked on this specific link
    const validCandidates = candidates.filter((c) => {
      if (alreadyLinked.has(c.transactionId)) return false;
      if (matchedInThisRun.has(c.transactionId)) return false;
      return matchDates.some((d) => Math.abs(dayDelta(d, c.date)) <= 1);
    });

    // Skip if no candidates
    if (validCandidates.length === 0) continue;

    const matchedDate = pickMatchedDate(reconRow.authorizedDate, reconRow.date);

    // Pick the candidate closest to the date we'll actually stamp. On a delayed
    // settlement the widened window can make both an auth-date and a posted-date
    // transaction valid; attaching to the one nearest the stamped date avoids
    // re-dating an earlier transaction and stranding the real posted-date one.
    // validCandidates is already ordered by (date, id), and the strict
    // comparison keeps that as the tiebreak when distances are equal.
    const matchedTxnId = validCandidates.reduce((best, candidate) =>
      Math.abs(dayDelta(matchedDate, candidate.date)) <
      Math.abs(dayDelta(matchedDate, best.date))
        ? candidate
        : best
    ).transactionId;

    // Apply the match atomically, but only if the row is still pending as of
    // the write — claim it rather than blindly overwriting it.
    let claimedRow = false;
    await db.transaction(async (tx) => {
      const claimed = await tx
        .update(plaidTransactionReconciliation)
        .set({
          resolutionStatus: "matched",
          matchedTransactionId: matchedTxnId,
          resolvedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(plaidTransactionReconciliation.id, reconRow.id),
            // The claim: only an unresolved row may be auto-matched. A human who
            // matched this row between our read and this write wins, and we must
            // not then mark our candidate reconciled against a match that did not
            // happen. reviewReason is included because a concurrent sync can flag
            // this row for human review (plaid_modified/plaid_removed) without
            // changing resolutionStatus off "pending" — the same race, one column
            // over.
            eq(plaidTransactionReconciliation.resolutionStatus, "pending"),
            isNull(plaidTransactionReconciliation.reviewReason)
          )
        )
        .returning({ id: plaidTransactionReconciliation.id });

      if (claimed.length === 0) return;
      claimedRow = true;

      await tx
        .update(transactions)
        .set({
          isReconciled: true,
          isFloating: false,
          date: matchedDate,
          updatedAt: now,
        })
        .where(eq(transactions.id, matchedTxnId));
    });

    if (!claimedRow) continue;

    alreadyLinked.add(matchedTxnId);
    matchedInThisRun.add(matchedTxnId);
    matchedInThisRunByLink.set(reconRow.plaidAccountLinkId, matchedInThisRun);
    matchCount += 1;
  }

  if (matchCount > 0) {
    // Auto-match runs in sync/cron context with no session user, so attribute
    // events to the book owner (mirrors the manual sync_transaction_* events).
    const [book] = await db
      .select({ userId: books.userId })
      .from(books)
      .where(eq(books.id, bookId));

    if (book) {
      for (let i = 0; i < matchCount; i++) {
        captureEvent(book.userId, "sync_transaction_auto_matched", { bookId });
      }
    }
  }

  return matchCount;
}
