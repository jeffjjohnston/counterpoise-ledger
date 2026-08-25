import type { AppDb } from "@/db";
import {
  accounts,
  investmentSplits,
  payees,
  plaidAccounts,
  plaidTransactionReconciliation,
  transactions,
  transactionSplits,
} from "@/db/schema";
import { and, desc, eq, gte, inArray, isNotNull, lte, ne, or, sql } from "drizzle-orm";
import { toDateString } from "@/lib/formatters";
import { normalizePayeeName } from "@/lib/payees";
import { pickMatchedDate } from "@/lib/plaid-auto-match";
import { effectiveDateSql } from "@/lib/accounting";
import {
  reconcileActionIssue,
  type ReconcileAction,
  type ReconcileInput,
} from "@/lib/schemas/sync";
import type { SyncReconciliationItem, SyncResolveActionPayload } from "@/types";

/**
 * Plaid reconciliation: the queue of staged bank transactions awaiting a
 * decision, and the six decisions that can be made about one.
 *
 * Extracted from app/api/b/[bookId]/sync/accounts/[id]/reconcile/route.ts,
 * unchanged. The route keeps HTTP: path parsing, query and body parsing,
 * mapping the errors below to status codes, and captureEvent — attributing an
 * analytics event to the authenticated user is presentation, the same call
 * lib/plaid-transactions.ts's unlinkPlaidTransaction() leaves to its route.
 *
 * NOTE: nothing here runs inside withAdvisoryLock. The route never used it —
 * resolveReconciliation() mutates one already-staged row by id, so the
 * transaction below is on the pooled connection and Postgres row locking is
 * the whole of the concurrency story. lib/plaid-sync.ts is the file that owns
 * the lock, and CLAUDE.md's reserved-connection warning is about that file,
 * not this one.
 */

/** A refusal the caller can act on. The route answers it with a 400. */
export class ReconcileValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReconcileValidationError";
  }
}

/** A row this book does not have. The route answers it with a 404. */
export class ReconcileNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReconcileNotFoundError";
  }
}

export type ReconcilableLink = {
  linkId: number;
  counterpoiseAccountId: number;
  counterpoiseAccountType: string;
};

type CandidateBase = {
  transactionId: number;
  date: string;
  description: string | null;
  payeeName: string | null;
  checkNumber: string | null;
  linkedSplitAmount: number;
};

/**
 * The Plaid account link, confirmed to belong to this book and to point at an
 * account that can actually be reconciled.
 *
 * The type guard is the same rule syncToken() enforces: a link to an income or
 * expense account is a mapping mistake that would otherwise surface much later.
 * Both handlers ran these two checks back to back; folding them together is
 * what stops a caller running the ownership check and skipping the type check.
 */
export async function getReconcilableLink(
  db: AppDb,
  bookId: number,
  linkId: number
): Promise<ReconcilableLink> {
  const rows = await db
    .select({
      linkId: plaidAccounts.id,
      counterpoiseAccountId: plaidAccounts.counterpoiseAccountId,
      counterpoiseAccountType: accounts.type,
    })
    .from(plaidAccounts)
    .innerJoin(accounts, eq(plaidAccounts.counterpoiseAccountId, accounts.id))
    .where(
      and(
        eq(plaidAccounts.id, linkId),
        eq(plaidAccounts.bookId, bookId),
        eq(accounts.bookId, bookId)
      )
    )
    .limit(1);

  const row = rows[0];
  if (!row || row.counterpoiseAccountId === null) {
    throw new ReconcileNotFoundError("Linked sync account not found");
  }

  if (row.counterpoiseAccountType !== "asset" && row.counterpoiseAccountType !== "liability") {
    throw new ReconcileValidationError(
      "Only asset or liability Counterpoise accounts can be reconciled against Plaid transactions"
    );
  }

  return {
    linkId: row.linkId,
    counterpoiseAccountId: row.counterpoiseAccountId,
    counterpoiseAccountType: row.counterpoiseAccountType,
  };
}

/**
 * The unresolved queue for one link: rows still pending, plus resolved rows
 * Plaid has since modified or removed (reviewReason is not null), with rows
 * needing review sorted first. Each item carries its own ranked match
 * candidates and a suggested counter account.
 *
 * Cost note for callers: every item runs findMatchCandidates() and
 * suggestCounterAccountId(), each several queries. A large `limit` is a large
 * number of round trips, which is why the MCP tool caps it.
 */
export async function listReconciliationQueue(
  db: AppDb,
  bookId: number,
  link: ReconcilableLink,
  opts: { limit: number; offset: number }
): Promise<{
  items: SyncReconciliationItem[];
  totalCount: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}> {
  const { limit, offset } = opts;

  const whereClause = and(
    eq(plaidTransactionReconciliation.plaidAccountLinkId, link.linkId),
    or(
      eq(plaidTransactionReconciliation.resolutionStatus, "pending"),
      isNotNull(plaidTransactionReconciliation.reviewReason)
    )
  );

  const rows = await db
    .select()
    .from(plaidTransactionReconciliation)
    .where(whereClause)
    .orderBy(
      desc(sql`case when ${plaidTransactionReconciliation.reviewReason} is not null then 1 else 0 end`),
      desc(plaidTransactionReconciliation.lastSeenAt),
      desc(plaidTransactionReconciliation.id)
    )
    .limit(limit)
    .offset(offset);

  const countRows = await db
    .select({ count: sql<number>`cast(count(*) as integer)`.as("count") })
    .from(plaidTransactionReconciliation)
    .where(whereClause);

  const items = await Promise.all(
    rows.map((row) => loadReconciliationItem(db, row, link.counterpoiseAccountId, bookId))
  );

  const totalCount = countRows[0]?.count ?? 0;

  return {
    items,
    totalCount,
    offset,
    limit,
    hasMore: offset + items.length < totalCount,
  };
}

// Not exported: both callers are in this module (listReconciliationQueue and
// resolveReconciliation), and neither MCP tool needs it.
async function loadReconciliationItem(
  db: AppDb,
  reconRow: typeof plaidTransactionReconciliation.$inferSelect,
  mappedAccountId: number,
  bookId: number
): Promise<SyncReconciliationItem> {
  const candidates = await findMatchCandidates(db, reconRow, mappedAccountId);
  const suggestedCounterAccountId = await suggestCounterAccountId(db, reconRow, mappedAccountId, bookId);

  return {
    id: reconRow.id,
    plaidAccountLinkId: reconRow.plaidAccountLinkId,
    plaidTransactionId: reconRow.plaidTransactionId,
    date: reconRow.date,
    authorizedDate: reconRow.authorizedDate,
    amountCents: reconRow.amountCents,
    name: reconRow.name,
    merchantName: reconRow.merchantName,
    originalDescription: reconRow.originalDescription,
    resolutionStatus: reconRow.resolutionStatus,
    reviewReason: reconRow.reviewReason,
    matchedTransactionId: reconRow.matchedTransactionId,
    pending: reconRow.pending,
    firstSeenAt: toIsoString(reconRow.firstSeenAt),
    lastSeenAt: toIsoString(reconRow.lastSeenAt),
    candidates,
    suggestedCounterAccountId,
  };
}

/**
 * Marks a matched transaction reconciled, and settles it if it was floating.
 *
 * A floating transaction's stored `date` holds its original entry date while
 * its effective date advances to today, so clearing `isFloating` alone would
 * snap it backwards in the register — it has to be stamped with a real date in
 * the same write. The rule is `pickMatchedDate`, shared with the auto-matcher
 * rather than reimplemented, so the two paths cannot drift.
 *
 * A transaction that is NOT floating keeps its date untouched. That is
 * deliberate and is what CLAUDE.md's auto-match date rule records about manual
 * matching: the user picked this transaction, and its date is the one they
 * entered.
 */
async function markMatchedTransaction(
  tx: DbClient,
  bookId: number,
  transactionId: number,
  reconRow: typeof plaidTransactionReconciliation.$inferSelect,
  now: Date
): Promise<void> {
  const [existing] = await tx
    .select({ isFloating: transactions.isFloating })
    .from(transactions)
    .where(and(eq(transactions.id, transactionId), eq(transactions.bookId, bookId)))
    .limit(1);

  const settle = existing?.isFloating
    ? {
        isFloating: false,
        date: pickMatchedDate(reconRow.authorizedDate, reconRow.date),
      }
    : {};

  // The update stays the not-found detector, exactly as it was before this
  // helper existed: a missing row makes the select above empty AND the update
  // affect nothing, so the 404 fires in the same place with the same message.
  const updated = await tx
    .update(transactions)
    .set({ isReconciled: true, updatedAt: now, ...settle })
    .where(and(eq(transactions.id, transactionId), eq(transactions.bookId, bookId)))
    .returning({ id: transactions.id });

  if (updated.length === 0) {
    throw new ReconcileNotFoundError("Transaction not found");
  }
}

/** Which analytics event each action produces. The route and the tool both read this. */
export const RECONCILE_EVENT_NAMES: Record<ReconcileAction, string> = {
  match: "sync_transaction_matched",
  match_update_amount: "sync_transaction_amount_updated",
  create: "sync_transaction_created",
  ignore: "sync_transaction_ignored",
  keep_local: "sync_transaction_kept_local",
  unlink: "sync_transaction_unlinked",
};

/**
 * Applies one of the six reconciliation decisions and returns the row as it
 * now stands.
 *
 * The action-requirement check is the FIRST statement, before the transaction
 * opens, and that ordering is load-bearing: the HTTP route reports
 * "transactionId is required for match" (400) ahead of "Reconciliation row not
 * found" (404), because its schema parsed the body before any row was read.
 * Checking after the row load would silently swap those two answers.
 *
 * The guard is tests/lib/plaid-reconcile.test.ts's "checks the action
 * requirement before it looks up the row", which calls this function directly.
 * It has to be that test and not the route's own "reports a missing
 * transactionId before it reports a missing reconciliation row": reconcileSchema's
 * superRefine calls reconcileActionIssue too, and the route returns that 400 from
 * safeParse before it ever reaches this function — so the route test stays green
 * even if the check below moves inside the transaction or is deleted outright.
 */
export async function resolveReconciliation(
  db: AppDb,
  bookId: number,
  link: ReconcilableLink,
  input: ReconcileInput
): Promise<SyncReconciliationItem> {
  const issue = reconcileActionIssue(input);
  if (issue) {
    throw new ReconcileValidationError(issue.message);
  }

  // reconcileSchema validates this shape at runtime — including that
  // transactionId/counterAccountId are the right type for whatever `action`
  // turned out to be — but its inferred type leaves them `unknown` (see
  // lib/schemas/sync.ts for why). This cast gives the rest of this function
  // the per-action narrowing SyncResolveActionPayload always had. It also
  // means TypeScript can no longer see that the `typeof body.payeeName ===
  // "string"` check below is load-bearing: payeeName is deliberately
  // unvalidated, so a non-string really can arrive here even though this cast
  // types it as `string | undefined`. Don't remove that check as a redundant
  // narrowing — it isn't.
  const body = input as SyncResolveActionPayload;

  const now = new Date();
  const updatedReconciliationId = await db.transaction(async (tx) => {
    const reconRow = await loadReconciliationRow(
      tx,
      link.linkId,
      body.reconciliationId,
      bookId
    );
    if (!reconRow) {
      throw new ReconcileNotFoundError("Reconciliation row not found");
    }

    // A bank row that is already linked cannot be linked somewhere else.
    // Without this, a repeated `create` inserts a SECOND transaction and
    // repoints matchedTransactionId at it, leaving the first in the ledger
    // marked reconciled, attached to nothing, and invisible to
    // getStaleUnmatched() (lib/plaid-tokens.ts filters isReconciled = false).
    // `match` and `match_update_amount` have the same shape without the
    // duplicate insert.
    //
    // The `reviewReason === null` half is load-bearing, not defensive. The
    // queue is "pending OR reviewReason is not null", and ReconciliationModal
    // renders match/match_update_amount/create for anything in it
    // (components/sync/ReconciliationModal.tsx gates on exactly that pair) —
    // so a row Plaid has since modified is BOTH already-linked and legitimately
    // re-linkable from the UI. Guarding on already-linked alone would turn
    // those buttons into a 400. What this leaves closed is the case the UI
    // cannot reach at all: loadReconciliationRow above matches on id, link and
    // book but not on queue membership, so MCP can address a fully-resolved row
    // long after it left the queue. That asymmetry is the whole defect.
    if (
      (body.action === "match" ||
        body.action === "match_update_amount" ||
        body.action === "create") &&
      reconRow.matchedTransactionId !== null &&
      reconRow.reviewReason === null
    ) {
      throw new ReconcileValidationError(
        `This bank transaction is already linked to transaction #${reconRow.matchedTransactionId} — unlink it first`
      );
    }

    if (body.action === "match") {
      const splitRows = await tx
        .select({ id: transactionSplits.id })
        .from(transactionSplits)
        .where(
          and(
            eq(transactionSplits.transactionId, body.transactionId),
            eq(transactionSplits.accountId, link.counterpoiseAccountId),
            eq(transactionSplits.bookId, bookId)
          )
        )
        .limit(1);

      if (splitRows.length === 0) {
        throw new ReconcileValidationError("Selected transaction does not include the linked account");
      }

      const conflictRows = await tx
        .select({ id: plaidTransactionReconciliation.id })
        .from(plaidTransactionReconciliation)
        .where(
          and(
            eq(plaidTransactionReconciliation.plaidAccountLinkId, link.linkId),
            eq(plaidTransactionReconciliation.matchedTransactionId, body.transactionId),
            ne(plaidTransactionReconciliation.id, reconRow.id)
          )
        )
        .limit(1);

      if (conflictRows.length > 0) {
        throw new ReconcileValidationError("This transaction is already linked to a different Plaid transaction for the same account");
      }

      await markMatchedTransaction(tx, bookId, body.transactionId, reconRow, now);

      await tx
        .update(plaidTransactionReconciliation)
        .set({
          resolutionStatus: "matched",
          matchedTransactionId: body.transactionId,
          reviewReason: null,
          reviewMetadataJson: null,
          resolvedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(plaidTransactionReconciliation.id, reconRow.id),
            eq(plaidTransactionReconciliation.bookId, bookId)
          )
        );
    } else if (body.action === "match_update_amount") {
      const splitRows = await tx
        .select({ id: transactionSplits.id, accountId: transactionSplits.accountId })
        .from(transactionSplits)
        .where(
          and(
            eq(transactionSplits.transactionId, body.transactionId),
            eq(transactionSplits.bookId, bookId)
          )
        );

      if (!splitRows.some((s) => s.accountId === link.counterpoiseAccountId)) {
        throw new ReconcileValidationError("Selected transaction does not include the linked account");
      }

      if (splitRows.length !== 2) {
        throw new ReconcileValidationError("Amount update is only supported for transactions with exactly 2 splits");
      }

      const investmentRows = await tx
        .select({ id: investmentSplits.id })
        .from(investmentSplits)
        .where(
          and(
            eq(investmentSplits.transactionId, body.transactionId),
            eq(investmentSplits.bookId, bookId)
          )
        )
        .limit(1);

      if (investmentRows.length > 0) {
        throw new ReconcileValidationError("Amount update is not supported for investment transactions");
      }

      const conflictRows = await tx
        .select({ id: plaidTransactionReconciliation.id })
        .from(plaidTransactionReconciliation)
        .where(
          and(
            eq(plaidTransactionReconciliation.plaidAccountLinkId, link.linkId),
            eq(plaidTransactionReconciliation.matchedTransactionId, body.transactionId),
            ne(plaidTransactionReconciliation.id, reconRow.id)
          )
        )
        .limit(1);

      if (conflictRows.length > 0) {
        throw new ReconcileValidationError("This transaction is already linked to a different Plaid transaction for the same account");
      }

      const linkedSplit = splitRows.find((s) => s.accountId === link.counterpoiseAccountId)!;
      const counterSplit = splitRows.find((s) => s.accountId !== link.counterpoiseAccountId);

      if (!counterSplit) {
        throw new ReconcileValidationError("Transaction has no counterpart split on a different account");
      }

      await tx
        .update(transactionSplits)
        .set({ amount: -reconRow.amountCents })
        .where(
          and(
            eq(transactionSplits.id, linkedSplit.id),
            eq(transactionSplits.bookId, bookId)
          )
        );

      await tx
        .update(transactionSplits)
        .set({ amount: reconRow.amountCents })
        .where(
          and(
            eq(transactionSplits.id, counterSplit.id),
            eq(transactionSplits.bookId, bookId)
          )
        );

      await markMatchedTransaction(tx, bookId, body.transactionId, reconRow, now);

      await tx
        .update(plaidTransactionReconciliation)
        .set({
          resolutionStatus: "matched",
          matchedTransactionId: body.transactionId,
          reviewReason: null,
          reviewMetadataJson: null,
          resolvedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(plaidTransactionReconciliation.id, reconRow.id),
            eq(plaidTransactionReconciliation.bookId, bookId)
          )
        );
    } else if (body.action === "create") {
      if (body.counterAccountId === link.counterpoiseAccountId) {
        throw new ReconcileValidationError("Counter account must be different from linked account");
      }

      const accountRows = await tx
        .select({ id: accounts.id })
        .from(accounts)
        .where(
          and(
            eq(accounts.id, body.counterAccountId),
            eq(accounts.bookId, bookId)
          )
        )
        .limit(1);

      if (accountRows.length === 0) {
        throw new ReconcileValidationError("Counter account not found");
      }

      const payeeSource =
        typeof body.payeeName === "string"
          ? body.payeeName
          : reconRow.merchantName ?? reconRow.name;
      const payeeId = await resolvePayeeId(tx, payeeSource, bookId);
      const [createdTransaction] = await tx
        .insert(transactions)
        .values({
          date: reconRow.authorizedDate ?? reconRow.date,
          description: reconRow.name,
          payeeId,
          isReconciled: true,
          updatedAt: now,
          bookId: bookId,
        })
        .returning({ id: transactions.id });

      if (!createdTransaction) {
        throw new Error("Failed to create transaction");
      }

      await tx.insert(transactionSplits).values([
        {
          transactionId: createdTransaction.id,
          accountId: link.counterpoiseAccountId,
          amount: -reconRow.amountCents,
          bookId: bookId,
        },
        {
          transactionId: createdTransaction.id,
          accountId: body.counterAccountId,
          amount: reconRow.amountCents,
          bookId: bookId,
        },
      ]);

      await tx
        .update(plaidTransactionReconciliation)
        .set({
          resolutionStatus: "created",
          matchedTransactionId: createdTransaction.id,
          reviewReason: null,
          reviewMetadataJson: null,
          resolvedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(plaidTransactionReconciliation.id, reconRow.id),
            eq(plaidTransactionReconciliation.bookId, bookId)
          )
        );
    } else if (body.action === "ignore") {
      await tx
        .update(plaidTransactionReconciliation)
        .set({
          resolutionStatus: "ignored",
          matchedTransactionId: null,
          reviewReason: null,
          reviewMetadataJson: null,
          resolvedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(plaidTransactionReconciliation.id, reconRow.id),
            eq(plaidTransactionReconciliation.bookId, bookId)
          )
        );
    } else if (body.action === "keep_local") {
      await tx
        .update(plaidTransactionReconciliation)
        .set({
          reviewReason: null,
          reviewMetadataJson: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(plaidTransactionReconciliation.id, reconRow.id),
            eq(plaidTransactionReconciliation.bookId, bookId)
          )
        );
    } else if (body.action === "unlink") {
      // Detaching the staged row has to un-reconcile the transaction it was
      // matched to, or that transaction goes on asserting a bank match nothing
      // links to — and getStaleUnmatched() filters on isReconciled = false
      // (lib/plaid-tokens.ts), so it could never resurface there either. This
      // is the same defect the transaction-level unlink route carried until
      // the MCP-parity Plaid work fixed it; see CLAUDE.md's Transaction Unlink
      // section.
      //
      // But NOT unconditionally. Per-link uniqueness is enforced per link (see
      // the match branch's conflict check, which filters on
      // plaidAccountLinkId), so one transaction can be matched on two links at
      // once — which is exactly how a transfer reconciles against both sides.
      // Clearing the flag while the other side is still matched would turn a
      // correctly-reconciled transfer into a false positive in the health
      // check. So: clear it only when nothing else still points at it.
      const previouslyMatched = reconRow.matchedTransactionId;

      await tx
        .update(plaidTransactionReconciliation)
        .set({
          resolutionStatus: "pending",
          matchedTransactionId: null,
          reviewReason: null,
          reviewMetadataJson: null,
          resolvedAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(plaidTransactionReconciliation.id, reconRow.id),
            eq(plaidTransactionReconciliation.bookId, bookId)
          )
        );

      if (previouslyMatched !== null) {
        const stillLinked = await tx
          .select({ id: plaidTransactionReconciliation.id })
          .from(plaidTransactionReconciliation)
          .where(
            and(
              eq(plaidTransactionReconciliation.matchedTransactionId, previouslyMatched),
              eq(plaidTransactionReconciliation.bookId, bookId),
              ne(plaidTransactionReconciliation.id, reconRow.id)
            )
          )
          .limit(1);

        if (stillLinked.length === 0) {
          await tx
            .update(transactions)
            .set({ isReconciled: false, updatedAt: now })
            .where(
              and(
                eq(transactions.id, previouslyMatched),
                eq(transactions.bookId, bookId)
              )
            );
        }
      }
    } else {
      // Unreachable today: reconcileSchema's z.enum(reconcileActionValues)
      // already rejects anything outside these six literals before this
      // handler runs. Kept as a safety net against drift — this switch,
      // reconcileActionValues, and SyncResolveActionPayload (types/index.ts)
      // are three lists kept in sync by hand, and a 7th action added to the
      // first two without a branch here would otherwise fall through
      // silently: 200 response, unchanged row. Analytics is no longer part of
      // that risk — RECONCILE_EVENT_NAMES above is Record<ReconcileAction,
      // string>, so a 7th action is a compile error there, not a silently
      // undefined event name at runtime.
      throw new ReconcileValidationError("Invalid action");
    }

    return reconRow.id;
  });

  const updated = await loadReconciliationRow(db, link.linkId, updatedReconciliationId, bookId);
  if (!updated) {
    throw new ReconcileNotFoundError("Updated row not found");
  }

  // loadReconciliationItem() applies two book scopes that nothing cross-checks:
  // findMatchCandidates() filters on the row's own bookId, suggestCounterAccountId()
  // on the bookId passed here. They agree because loadReconciliationRow() above
  // already required updated.bookId === bookId. Keep that true for any new caller.
  return loadReconciliationItem(db, updated, link.counterpoiseAccountId, bookId);
}

type TransactionDb = Parameters<Parameters<AppDb["transaction"]>[0]>[0];
type DbClient = AppDb | TransactionDb;

async function resolvePayeeId(
  db: DbClient,
  payeeName: string | null,
  bookId: number
): Promise<number | null> {
  if (!payeeName) {
    return null;
  }

  const normalized = normalizePayeeName(payeeName);
  if (!normalized) {
    return null;
  }

  const existing = await db
    .select({ id: payees.id })
    .from(payees)
    .where(and(eq(payees.bookId, bookId), sql`lower(${payees.name}) = ${normalized.toLowerCase()}`))
    .limit(1);

  if (existing.length > 0) {
    return existing[0].id;
  }

  const [created] = await db.insert(payees).values({ name: normalized, bookId }).returning();
  return created?.id ?? null;
}

async function loadReconciliationRow(
  db: DbClient,
  linkId: number,
  reconciliationId: number,
  bookId: number
): Promise<typeof plaidTransactionReconciliation.$inferSelect | null> {
  const rows = await db
    .select()
    .from(plaidTransactionReconciliation)
    .where(
      and(
        eq(plaidTransactionReconciliation.id, reconciliationId),
        eq(plaidTransactionReconciliation.plaidAccountLinkId, linkId),
        eq(plaidTransactionReconciliation.bookId, bookId)
      )
    )
    .limit(1);

  return rows[0] ?? null;
}

async function findMatchCandidates(
  db: AppDb,
  reconRow: typeof plaidTransactionReconciliation.$inferSelect,
  mappedAccountId: number
) {
  const expectedAmount = -reconRow.amountCents;
  const reconDate = reconRow.authorizedDate ?? reconRow.date;
  const startDate = addDays(reconDate, -7);
  const endDate = addDays(reconDate, 7);

  // No bookId filter on this query, deliberately. mappedAccountId came from a
  // link lookup already scoped to the book and account ids are unique across
  // books, so a split on that account is necessarily this book's. The detail
  // query below does filter transactions.bookId and drops anything that got
  // through. Adding a filter here would be a behavior change, not a fix.
  const candidateRows = await db
    .select({
      transactionId: transactions.id,
      date: effectiveDateSql.as("date"),
      description: transactions.description,
      payeeName: payees.name,
      checkNumber: transactions.checkNumber,
      linkedSplitAmount: transactionSplits.amount,
    })
    .from(transactionSplits)
    .innerJoin(transactions, eq(transactionSplits.transactionId, transactions.id))
    .leftJoin(payees, eq(transactions.payeeId, payees.id))
    .where(
      and(
        eq(transactionSplits.accountId, mappedAccountId),
        gte(effectiveDateSql, startDate),
        lte(effectiveDateSql, endDate)
      )
    )
    .orderBy(desc(effectiveDateSql), desc(transactions.id))
    .limit(200);

  const deduped = new Map<number, CandidateBase>();
  for (const row of candidateRows) {
    if (!deduped.has(row.transactionId)) {
      deduped.set(row.transactionId, row);
    }
  }

  const uniqueRows = [...deduped.values()];
  if (uniqueRows.length === 0) {
    return [];
  }

  const ids = uniqueRows.map((row) => row.transactionId);
  const detailRows = await db.query.transactions.findMany({
    where: and(eq(transactions.bookId, reconRow.bookId), inArray(transactions.id, ids)),
    with: {
      splits: {
        with: {
          account: true,
        },
      },
    },
  });

  const txById = new Map(detailRows.map((row) => [row.id, row]));

  const linkedRows = await db
    .select({ matchedTransactionId: plaidTransactionReconciliation.matchedTransactionId })
    .from(plaidTransactionReconciliation)
    .where(
      and(
        eq(plaidTransactionReconciliation.plaidAccountLinkId, reconRow.plaidAccountLinkId),
        isNotNull(plaidTransactionReconciliation.matchedTransactionId),
        inArray(plaidTransactionReconciliation.matchedTransactionId, ids),
        ne(plaidTransactionReconciliation.id, reconRow.id)
      )
    );
  const linkedIdSet = new Set(
    linkedRows
      .map((row) => row.matchedTransactionId)
      .filter((value): value is number => value !== null)
  );

  const plaidTargetName = reconRow.merchantName ?? reconRow.name;

  return uniqueRows
    .map((row) => {
      const txDetail = txById.get(row.transactionId);
      if (!txDetail) {
        return null;
      }

      const counterparts = txDetail.splits
        .filter((split) => split.accountId !== mappedAccountId)
        .map((split) => split.account.name);
      const amountDelta = Math.abs(row.linkedSplitAmount - expectedAmount);
      const reconDate = reconRow.authorizedDate ?? reconRow.date;
      const currentDayDelta = dayDelta(reconDate, row.date);
      const scoreValues = buildScoreTagsAndValue({
        amountDelta,
        dayDeltaAbs: Math.abs(currentDayDelta),
        plaidTarget: plaidTargetName,
        payeeName: row.payeeName,
        description: row.description,
        alreadyLinked: linkedIdSet.has(row.transactionId),
      });

      return {
        transactionId: row.transactionId,
        date: row.date,
        description: row.description,
        payeeName: row.payeeName,
        checkNumber: row.checkNumber,
        linkedSplitAmount: row.linkedSplitAmount,
        expectedAmount,
        amountDelta,
        dayDelta: currentDayDelta,
        counterpartAccountNames: counterparts,
        splitCount: txDetail.splits.length,
        score: scoreValues.score,
        scoreTags: scoreValues.tags,
        alreadyLinked: linkedIdSet.has(row.transactionId),
      };
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> => !!candidate)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.amountDelta !== b.amountDelta) return a.amountDelta - b.amountDelta;
      return Math.abs(a.dayDelta) - Math.abs(b.dayDelta);
    })
    .slice(0, 5);
}

async function suggestCounterAccountId(
  db: AppDb,
  reconRow: typeof plaidTransactionReconciliation.$inferSelect,
  mappedAccountId: number,
  bookId: number
): Promise<number | null> {
  const sourceName = normalizePayeeName(reconRow.merchantName ?? reconRow.name);

  if (!sourceName) {
    return null;
  }

  const payeeRows = await db
    .select({ id: payees.id })
    .from(payees)
    .where(and(eq(payees.bookId, bookId), sql`lower(${payees.name}) = ${sourceName.toLowerCase()}`))
    .limit(1);

  const payeeId = payeeRows[0]?.id;
  if (!payeeId) {
    return null;
  }

  const txnRows = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(and(eq(transactions.bookId, bookId), eq(transactions.payeeId, payeeId)))
    .orderBy(desc(effectiveDateSql), desc(transactions.id))
    .limit(25);

  if (txnRows.length === 0) {
    return null;
  }

  const txIds = txnRows.map((row) => row.id);
  const desiredCounterAmount = reconRow.amountCents;

  const counterpartRows = await db
    .select({
      accountId: transactionSplits.accountId,
      amount: transactionSplits.amount,
      transactionId: transactionSplits.transactionId,
    })
    .from(transactionSplits)
    .where(
      and(
        eq(transactionSplits.bookId, bookId),
        inArray(transactionSplits.transactionId, txIds),
        ne(transactionSplits.accountId, mappedAccountId)
      )
    )
    .orderBy(desc(transactionSplits.transactionId));

  const exact = counterpartRows.find((row) => row.amount === desiredCounterAmount);
  if (exact) {
    return exact.accountId;
  }

  return counterpartRows[0]?.accountId ?? null;
}

function toIsoString(value: string | Date | null): string {
  if (value instanceof Date) {
    return value.toISOString();
  }

  return new Date(value ?? Date.now()).toISOString();
}

function addDays(dateString: string, delta: number): string {
  const d = new Date(`${dateString}T00:00:00`);
  d.setDate(d.getDate() + delta);
  return toDateString(d);
}

function dayDelta(from: string, to: string): number {
  const start = new Date(`${from}T00:00:00`).getTime();
  const end = new Date(`${to}T00:00:00`).getTime();
  return Math.round((end - start) / 86_400_000);
}

function normalizeMatchText(value: string | null | undefined): string {
  if (!value) return "";
  return normalizePayeeName(value).toLowerCase();
}

function buildScoreTagsAndValue(input: {
  amountDelta: number;
  dayDeltaAbs: number;
  plaidTarget: string;
  payeeName: string | null;
  description: string | null;
  alreadyLinked: boolean;
}) {
  let score = 0;
  const tags: string[] = [];

  if (input.amountDelta === 0) {
    score += 100;
    tags.push("exact_amount");
  } else {
    score += Math.max(0, 50 - input.amountDelta);
    tags.push("amount_close");
  }

  if (input.dayDeltaAbs === 0) {
    score += 30;
    tags.push("same_day");
  } else {
    score += Math.max(0, 30 - input.dayDeltaAbs * 3);
    tags.push("date_close");
  }

  const normalizedPayee = normalizeMatchText(input.payeeName);
  const normalizedDescription = normalizeMatchText(input.description);
  const target = normalizeMatchText(input.plaidTarget);

  if (target && (target === normalizedPayee || target === normalizedDescription)) {
    score += 25;
    tags.push("name_exact");
  } else if (
    target &&
    ((normalizedPayee && normalizedPayee.includes(target)) ||
      (normalizedDescription && normalizedDescription.includes(target)) ||
      target.includes(normalizedPayee) ||
      target.includes(normalizedDescription))
  ) {
    score += 10;
    tags.push("name_similar");
  }

  if (input.alreadyLinked) {
    score -= 80;
    tags.push("already_linked");
  }

  return { score, tags };
}
