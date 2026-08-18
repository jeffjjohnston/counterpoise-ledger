import {
  accounts,
  plaidAccounts,
  plaidTokens,
  plaidTransactionReconciliation,
} from "@/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  fetchPlaidTransactionsSync,
  type PlaidTransactionSyncItem,
} from "@/lib/plaid";
import { type AppDb } from "@/db";
import { autoMatchPendingTransactions } from "@/lib/plaid-auto-match";
import {
  withAdvisoryLock,
  PLAID_SYNC_LOCK_NAMESPACE,
} from "@/lib/advisory-lock";
import { toDateString } from "@/lib/formatters";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SyncPageResult = {
  added: PlaidTransactionSyncItem[];
  modified: PlaidTransactionSyncItem[];
  removed: Array<{ transaction_id: string }>;
  nextCursor: string | null;
};

type LinkedAccount = {
  linkId: number;
  plaidAccountId: string;
  counterpoiseAccountId: number;
  counterpoiseAccountType: string;
};

export type SyncTokenResult = {
  synced: {
    added: number;
    modified: number;
    removed: number;
  };
  autoMatched: number;
  lastSyncedAt: Date;
  pendingCount: number;
  reviewCount: number;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_SYNC_RETRIES = 2;
const SYNC_PAGE_SIZE = 250;
const INITIAL_SYNC_DAYS = 7;

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class SyncTokenError extends Error {
  public readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "SyncTokenError";
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function isPlaidConfigured(): boolean {
  return !!(
    process.env.PLAID_CLIENT_ID &&
    process.env.PLAID_SECRET &&
    process.env.PLAID_ENV
  );
}

export function isPlaidConfigurationError(message: string): boolean {
  return (
    message.includes("PLAID_CLIENT_ID") ||
    message.includes("PLAID_SECRET") ||
    message.includes("PLAID_ENV")
  );
}

function isPaginationMutationError(message: string): boolean {
  return message.includes("TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION");
}

// ---------------------------------------------------------------------------
// Plaid sync page fetching (with retry on pagination mutation)
// ---------------------------------------------------------------------------

async function fetchAllSyncPages(
  accessToken: string,
  syncCursor: string | null
): Promise<SyncPageResult> {
  for (let attempt = 0; attempt <= MAX_SYNC_RETRIES; attempt += 1) {
    try {
      let cursor = syncCursor;
      let shouldRequestBootstrapWindow = !syncCursor;

      const allAdded: PlaidTransactionSyncItem[] = [];
      const allModified: PlaidTransactionSyncItem[] = [];
      const allRemoved: Array<{ transaction_id: string }> = [];

      while (true) {
        const page = await fetchPlaidTransactionsSync({
          accessToken,
          cursor,
          count: SYNC_PAGE_SIZE,
          ...(shouldRequestBootstrapWindow
            ? { daysRequested: INITIAL_SYNC_DAYS }
            : {}),
        });

        shouldRequestBootstrapWindow = false;
        allAdded.push(...page.added);
        allModified.push(...page.modified);
        allRemoved.push(...page.removed);

        cursor = page.nextCursor;
        if (!page.hasMore) {
          return {
            added: allAdded,
            modified: allModified,
            removed: allRemoved,
            nextCursor: cursor,
          };
        }
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to fetch Plaid sync pages";
      const canRetry = isPaginationMutationError(message) && attempt < MAX_SYNC_RETRIES;

      if (!canRetry) {
        throw error;
      }
    }
  }

  throw new Error("Failed to synchronize Plaid transactions after retrying");
}

// ---------------------------------------------------------------------------
// Reconciliation staging helpers
// ---------------------------------------------------------------------------

function toReconciliationValues(
  linkId: number,
  bookId: number,
  item: PlaidTransactionSyncItem,
  now: Date
) {
  return {
    bookId,
    plaidAccountLinkId: linkId,
    plaidTransactionId: item.transaction_id,
    date: item.date,
    authorizedDate: item.authorized_date,
    amountCents: Math.round(item.amount * 100),
    name: item.name,
    merchantName: item.merchant_name,
    originalDescription: item.original_description,
    pending: item.pending,
    pendingTransactionId: item.pending_transaction_id,
    isoCurrencyCode: item.iso_currency_code,
    unofficialCurrencyCode: item.unofficial_currency_code,
    categoryPrimary:
      item.personal_finance_category?.primary ?? item.category?.[0] ?? null,
    categoryDetailed:
      item.personal_finance_category?.detailed ?? item.category?.[1] ?? null,
    rawJson: JSON.stringify(item),
    firstSeenAt: now,
    lastSeenAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

async function stageAddedTransactions(
  db: AppDb,
  linkId: number,
  bookId: number,
  added: PlaidTransactionSyncItem[],
  now: Date
) {
  for (const item of added) {
    if (item.pending) {
      continue;
    }

    const values = toReconciliationValues(linkId, bookId, item, now);
    await db
      .insert(plaidTransactionReconciliation)
      .values({
        ...values,
        resolutionStatus: "pending",
      })
      .onConflictDoUpdate({
        target: [
          plaidTransactionReconciliation.plaidAccountLinkId,
          plaidTransactionReconciliation.plaidTransactionId,
        ],
        set: {
          date: values.date,
          authorizedDate: values.authorizedDate,
          amountCents: values.amountCents,
          name: values.name,
          merchantName: values.merchantName,
          originalDescription: values.originalDescription,
          pending: values.pending,
          pendingTransactionId: values.pendingTransactionId,
          isoCurrencyCode: values.isoCurrencyCode,
          unofficialCurrencyCode: values.unofficialCurrencyCode,
          categoryPrimary: values.categoryPrimary,
          categoryDetailed: values.categoryDetailed,
          rawJson: values.rawJson,
          reviewReason: null,
          reviewMetadataJson: null,
          resolutionStatus: sql`
            case
              when ${plaidTransactionReconciliation.resolutionStatus} in ('matched', 'created', 'ignored')
              then ${plaidTransactionReconciliation.resolutionStatus}
              else 'pending'
            end
          `,
          resolvedAt: sql`
            case
              when ${plaidTransactionReconciliation.resolutionStatus} in ('matched', 'created', 'ignored')
              then ${plaidTransactionReconciliation.resolvedAt}
              else null
            end
          `,
          lastSeenAt: now,
          updatedAt: now,
        },
      });
  }
}

async function stageModifiedTransactions(
  db: AppDb,
  linkId: number,
  bookId: number,
  modified: PlaidTransactionSyncItem[],
  now: Date
) {
  for (const item of modified) {
    if (item.pending) {
      continue;
    }

    const values = toReconciliationValues(linkId, bookId, item, now);
    const existingRows = await db
      .select()
      .from(plaidTransactionReconciliation)
      .where(
        and(
          eq(plaidTransactionReconciliation.plaidAccountLinkId, linkId),
          eq(plaidTransactionReconciliation.plaidTransactionId, item.transaction_id)
        )
      )
      .limit(1);

    const existing = existingRows[0];

    if (!existing) {
      await db.insert(plaidTransactionReconciliation).values({
        ...values,
        resolutionStatus: "pending",
      });
      continue;
    }

    const shouldFlagReview =
      existing.resolutionStatus === "matched" ||
      existing.resolutionStatus === "created";

    const reviewMetadata = shouldFlagReview
      ? JSON.stringify({
          event: "modified",
          previous: {
            date: existing.date,
            amountCents: existing.amountCents,
            name: existing.name,
            merchantName: existing.merchantName,
            originalDescription: existing.originalDescription,
            categoryPrimary: existing.categoryPrimary,
            categoryDetailed: existing.categoryDetailed,
          },
          incoming: {
            date: values.date,
            amountCents: values.amountCents,
            name: values.name,
            merchantName: values.merchantName,
            originalDescription: values.originalDescription,
            categoryPrimary: values.categoryPrimary,
            categoryDetailed: values.categoryDetailed,
          },
        })
      : null;

    await db
      .update(plaidTransactionReconciliation)
      .set({
        date: values.date,
        authorizedDate: values.authorizedDate,
        amountCents: values.amountCents,
        name: values.name,
        merchantName: values.merchantName,
        originalDescription: values.originalDescription,
        pending: values.pending,
        pendingTransactionId: values.pendingTransactionId,
        isoCurrencyCode: values.isoCurrencyCode,
        unofficialCurrencyCode: values.unofficialCurrencyCode,
        categoryPrimary: values.categoryPrimary,
        categoryDetailed: values.categoryDetailed,
        rawJson: values.rawJson,
        reviewReason: shouldFlagReview
          ? "plaid_modified"
          : existing.resolutionStatus === "pending"
            ? null
            : existing.reviewReason,
        reviewMetadataJson: shouldFlagReview ? reviewMetadata : existing.reviewMetadataJson,
        lastSeenAt: now,
        updatedAt: now,
      })
      .where(eq(plaidTransactionReconciliation.id, existing.id));
  }
}

async function stageRemovedTransactions(
  db: AppDb,
  linkId: number,
  removed: Array<{ transaction_id: string }>,
  now: Date
) {
  for (const item of removed) {
    const rows = await db
      .select()
      .from(plaidTransactionReconciliation)
      .where(
        and(
          eq(plaidTransactionReconciliation.plaidAccountLinkId, linkId),
          eq(plaidTransactionReconciliation.plaidTransactionId, item.transaction_id)
        )
      )
      .limit(1);

    const existing = rows[0];
    if (!existing) {
      continue;
    }

    const needsReview =
      existing.resolutionStatus === "pending" ||
      existing.resolutionStatus === "matched" ||
      existing.resolutionStatus === "created";

    if (!needsReview) {
      continue;
    }

    await db
      .update(plaidTransactionReconciliation)
      .set({
        reviewReason: "plaid_removed",
        reviewMetadataJson: JSON.stringify({
          event: "removed",
          removedTransactionId: item.transaction_id,
        }),
        lastSeenAt: now,
        updatedAt: now,
      })
      .where(eq(plaidTransactionReconciliation.id, existing.id));
  }
}

async function getQueueSummary(db: AppDb, linkIds: number[]) {
  if (linkIds.length === 0) {
    return { pendingCount: 0, reviewCount: 0 };
  }

  const rows = await db
    .select({
      pendingCount: sql<number>`
        cast(coalesce(
          sum(
            case
              when ${plaidTransactionReconciliation.resolutionStatus} = 'pending'
                and ${plaidTransactionReconciliation.reviewReason} is null
              then 1
              else 0
            end
          ),
          0
        ) as integer)
      `.as("pendingCount"),
      reviewCount: sql<number>`
        cast(coalesce(
          sum(
            case
              when ${plaidTransactionReconciliation.reviewReason} is not null
              then 1
              else 0
            end
          ),
          0
        ) as integer)
      `.as("reviewCount"),
    })
    .from(plaidTransactionReconciliation)
    .where(inArray(plaidTransactionReconciliation.plaidAccountLinkId, linkIds));

  return {
    pendingCount: rows[0]?.pendingCount ?? 0,
    reviewCount: rows[0]?.reviewCount ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Main sync function
// ---------------------------------------------------------------------------

/**
 * Sync a single Plaid token: fetch new transactions from Plaid and stage them
 * in the reconciliation table for review.
 *
 * Serialised per token, so the hourly cron and a manual "Sync" click cannot pay
 * for the same Plaid pages twice. A caller that finds a sync already running
 * gets `SyncTokenError` 409 rather than waiting for it: by the time the running
 * sync commits its cursor there is nothing left for the second one to fetch.
 *
 * Throws `SyncTokenError` for expected failures (token not found, no linked
 * accounts, invalid account types, sync already running). Other errors (Plaid
 * API failures) propagate as-is.
 */
export async function syncToken(
  db: AppDb,
  bookId: number,
  tokenId: number
): Promise<SyncTokenResult> {
  // lockedDb, not db: the lock pins a pooled connection for the whole sync, so
  // running the sync's own queries through the pool would need a second
  // connection per concurrent sync and deadlock once enough of them are in
  // flight. The `db` argument is still what callers hand in and what the
  // reserved connection is drawn from; it is deliberately not used for the work.
  const result = await withAdvisoryLock(PLAID_SYNC_LOCK_NAMESPACE, tokenId, (lockedDb) =>
    syncTokenUnlocked(lockedDb, bookId, tokenId)
  );

  if (!result.acquired) {
    throw new SyncTokenError(
      409,
      "A sync is already running for this connection"
    );
  }

  return result.value;
}

/**
 * The sync itself. Separated from `syncToken` only so the lock wraps every exit
 * path, including the `lastError` bookkeeping in the catch below.
 */
async function syncTokenUnlocked(
  db: AppDb,
  bookId: number,
  tokenId: number
): Promise<SyncTokenResult> {
  // Look up the token
  const tokenRows = await db
    .select()
    .from(plaidTokens)
    .where(and(eq(plaidTokens.id, tokenId), eq(plaidTokens.bookId, bookId)))
    .limit(1);

  if (tokenRows.length === 0) {
    throw new SyncTokenError(404, "Token not found");
  }

  const token = tokenRows[0];

  // Refused above the try block on purpose: that block's catch writes the
  // error to `lastError`, which the Sync page renders as "Last sync failed".
  // A demo connection is not a failed connection and must not be recorded as
  // one. The scheduled cron filters these rows out before they ever reach
  // here; this guard covers the manual "Sync now" button.
  if (token.isDemo) {
    throw new SyncTokenError(400, "This is a demo connection and cannot sync with Plaid");
  }

  try {
    // Look up all mapped plaidAccounts under this token
    const linkedRows = await db
      .select({
        linkId: plaidAccounts.id,
        plaidAccountId: plaidAccounts.plaidAccountId,
        counterpoiseAccountId: plaidAccounts.counterpoiseAccountId,
        counterpoiseAccountType: accounts.type,
      })
      .from(plaidAccounts)
      .innerJoin(accounts, eq(plaidAccounts.counterpoiseAccountId, accounts.id))
      .where(eq(plaidAccounts.tokenId, tokenId));

    if (linkedRows.length === 0) {
      throw new SyncTokenError(400, "No linked accounts found for this token");
    }

    // Validate all linked accounts are asset or liability
    const invalidAccount = linkedRows.find(
      (r) => r.counterpoiseAccountType !== "asset" && r.counterpoiseAccountType !== "liability"
    );
    if (invalidAccount) {
      throw new SyncTokenError(
        400,
        "Only asset or liability Counterpoise accounts can be synchronized with Plaid"
      );
    }

    // Build map of plaidAccountId -> linked account info
    const accountMap = new Map<string, LinkedAccount>();
    for (const row of linkedRows) {
      accountMap.set(row.plaidAccountId, {
        linkId: row.linkId,
        plaidAccountId: row.plaidAccountId,
        counterpoiseAccountId: row.counterpoiseAccountId!,
        counterpoiseAccountType: row.counterpoiseAccountType,
      });
    }

    const isInitialSync = !token.syncCursor;
    const syncResult = await fetchAllSyncPages(token.accessToken, token.syncCursor);
    const now = new Date();

    // Apply initial sync date cutoff
    let addedItems = syncResult.added;
    if (isInitialSync) {
      const cutoffDate = new Date(now);
      cutoffDate.setDate(cutoffDate.getDate() - INITIAL_SYNC_DAYS);
      const cutoff = toDateString(cutoffDate);
      addedItems = addedItems.filter((item) => item.date >= cutoff);
    }

    // Partition and stage added items by account_id
    const addedByAccount = new Map<string, PlaidTransactionSyncItem[]>();
    for (const item of addedItems) {
      const link = accountMap.get(item.account_id);
      if (!link) continue;
      const existing = addedByAccount.get(item.account_id) ?? [];
      existing.push(item);
      addedByAccount.set(item.account_id, existing);
    }

    for (const [plaidAccountId, items] of addedByAccount) {
      const link = accountMap.get(plaidAccountId)!;
      await stageAddedTransactions(db, link.linkId, bookId, items, now);
    }

    // Partition and stage modified items by account_id
    const modifiedByAccount = new Map<string, PlaidTransactionSyncItem[]>();
    for (const item of syncResult.modified) {
      const link = accountMap.get(item.account_id);
      if (!link) continue;
      const existing = modifiedByAccount.get(item.account_id) ?? [];
      existing.push(item);
      modifiedByAccount.set(item.account_id, existing);
    }

    for (const [plaidAccountId, items] of modifiedByAccount) {
      const link = accountMap.get(plaidAccountId)!;
      await stageModifiedTransactions(db, link.linkId, bookId, items, now);
    }

    // Stage removed items — removed items only have transaction_id, so prefetch
    // the subset that can actually match across linked accounts and only stage
    // removals for those links.
    const linkIds = linkedRows.map((r) => r.linkId);
    const removedTransactionIds = syncResult.removed.map((r) => r.transaction_id);

    if (linkIds.length > 0 && removedTransactionIds.length > 0) {
      const removedByTransactionId = new Map(
        syncResult.removed.map((item) => [item.transaction_id, item])
      );

      const removalMatches = await db
        .select({
          linkId: plaidTransactionReconciliation.plaidAccountLinkId,
          plaidTransactionId: plaidTransactionReconciliation.plaidTransactionId,
        })
        .from(plaidTransactionReconciliation)
        .where(
          and(
            inArray(plaidTransactionReconciliation.plaidAccountLinkId, linkIds),
            inArray(
              plaidTransactionReconciliation.plaidTransactionId,
              removedTransactionIds
            )
          )
        );

      const removedByLinkId = new Map<number, typeof syncResult.removed>();
      for (const match of removalMatches) {
        const removedItem = removedByTransactionId.get(match.plaidTransactionId);
        if (!removedItem) continue;
        const existing = removedByLinkId.get(match.linkId) ?? [];
        existing.push(removedItem);
        removedByLinkId.set(match.linkId, existing);
      }

      for (const [linkId, items] of removedByLinkId) {
        await stageRemovedTransactions(db, linkId, items, now);
      }
    }

    // Update token with new cursor
    await db
      .update(plaidTokens)
      .set({
        syncCursor: syncResult.nextCursor,
        lastSyncedAt: now,
        lastError: null,
        updatedAt: now,
      })
      .where(eq(plaidTokens.id, tokenId));

    // Auto-match pending transactions using learned payee map
    const autoMatched = await autoMatchPendingTransactions(db, bookId, linkIds);

    // Aggregate summary across all linked accounts
    const summary = await getQueueSummary(db, linkIds);

    // Count non-pending staged items
    let totalAdded = 0;
    for (const items of addedByAccount.values()) {
      totalAdded += items.filter((row) => !row.pending).length;
    }
    let totalModified = 0;
    for (const items of modifiedByAccount.values()) {
      totalModified += items.filter((row) => !row.pending).length;
    }

    return {
      synced: {
        added: totalAdded,
        modified: totalModified,
        removed: syncResult.removed.length,
      },
      autoMatched,
      lastSyncedAt: now,
      ...summary,
    };
  } catch (error) {
    await db
      .update(plaidTokens)
      .set({
        lastError: error instanceof Error ? error.message : String(error),
        updatedAt: new Date(),
      })
      .where(eq(plaidTokens.id, tokenId));
    throw error;
  }
}
