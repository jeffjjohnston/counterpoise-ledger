import type { AppDb } from "@/db";
import {
  accounts,
  plaidAccounts,
  plaidTokens,
  plaidTransactionReconciliation,
  transactions,
  transactionSplits,
} from "@/db/schema";
import {
  and,
  asc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  notExists,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { toDateString } from "@/lib/formatters";
import { fetchPlaidAccounts } from "@/lib/plaid";
import type { AssignAccountsInput } from "@/lib/schemas/sync";

// Extracted from app/api/b/[bookId]/sync/tokens/route.ts GET, unchanged.
export const maskAccessToken = (accessToken: string): string => {
  if (accessToken.length <= 8) {
    return "*".repeat(accessToken.length);
  }

  const prefix = accessToken.slice(0, 4);
  const suffix = accessToken.slice(-4);
  const middle = "*".repeat(Math.max(8, accessToken.length - 8));
  return `${prefix}${middle}${suffix}`;
};

// Exported so app/api/b/[bookId]/sync/tokens/route.ts's POST can mask its
// inserted row the same way every other caller-facing read does, instead of
// keeping its own byte-identical copy — two copies of the function that
// applies the access-token mask is exactly the drift this module exists to
// remove.
export const toTokenListItem = (token: typeof plaidTokens.$inferSelect) => ({
  id: token.id,
  financialInstitution: token.financialInstitution,
  itemId: token.itemId,
  accessTokenMasked: maskAccessToken(token.accessToken),
  createdAt: token.createdAt,
  updatedAt: token.updatedAt,
});

export async function listTokens(db: AppDb, bookId: number) {
  const [tokens, counts] = await Promise.all([
    db
      .select()
      .from(plaidTokens)
      .where(eq(plaidTokens.bookId, bookId))
      .orderBy(asc(plaidTokens.financialInstitution), asc(plaidTokens.itemId)),
    // count(col) counts non-null values, so counting counterpoiseAccountId is
    // exactly "how many of this connection's accounts are mapped". Both are cast
    // because postgres.js serialises bigint aggregates as strings.
    db
      .select({
        tokenId: plaidAccounts.tokenId,
        totalAccountCount: sql<number>`cast(count(*) as integer)`.as("totalAccountCount"),
        mappedAccountCount:
          sql<number>`cast(count(${plaidAccounts.counterpoiseAccountId}) as integer)`.as(
            "mappedAccountCount"
          ),
      })
      .from(plaidAccounts)
      .where(eq(plaidAccounts.bookId, bookId))
      .groupBy(plaidAccounts.tokenId),
  ]);

  const countsByToken = new Map(counts.map((row) => [row.tokenId, row]));

  return tokens.map((token) => ({
    ...toTokenListItem(token),
    // A connection with no Plaid accounts yet has no row in the aggregate.
    totalAccountCount: countsByToken.get(token.id)?.totalAccountCount ?? 0,
    mappedAccountCount: countsByToken.get(token.id)?.mappedAccountCount ?? 0,
  }));
}

// Extracted from app/api/b/[bookId]/sync/pending-count/route.ts GET, unchanged.
export async function getPendingCount(db: AppDb, bookId: number): Promise<number> {
  const rows = await db
    .select({
      count: sql<number>`cast(count(*) as integer)`.as("count"),
    })
    .from(plaidTransactionReconciliation)
    .innerJoin(
      plaidAccounts,
      eq(plaidTransactionReconciliation.plaidAccountLinkId, plaidAccounts.id)
    )
    .where(
      and(
        eq(plaidTransactionReconciliation.bookId, bookId),
        isNotNull(plaidAccounts.counterpoiseAccountId),
        or(
          and(
            eq(plaidTransactionReconciliation.resolutionStatus, "pending"),
            isNull(plaidTransactionReconciliation.reviewReason)
          ),
          isNotNull(plaidTransactionReconciliation.reviewReason)
        )
      )
    );

  return rows[0]?.count ?? 0;
}

/** Unmatched local transactions older than this many days are flagged. */
const STALE_AGE_DAYS = 9;
/** Transactions older than this many days are ignored entirely. */
const LOOKBACK_DAYS = 60;

const daysAgo = (days: number) => {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return toDateString(d);
};

/**
 * Finds manually entered transactions on Plaid-synced accounts that no bank
 * transaction has matched — the local entry is either a mistake or its
 * posting is unusually delayed, so the user should take a look.
 *
 * Extracted from app/api/b/[bookId]/sync/stale-unmatched/route.ts GET, unchanged.
 */
export async function getStaleUnmatched(db: AppDb, bookId: number) {
  const staleCutoff = daysAgo(STALE_AGE_DAYS);
  const lookbackCutoff = daysAgo(LOOKBACK_DAYS);

  // The stored date is used deliberately instead of effectiveDateSql: a
  // floating transaction's effective date advances to today, which would
  // permanently exempt exactly the never-posted entries this flags.
  const rows = await db
    .select({
      accountId: accounts.id,
      accountName: accounts.name,
      count: sql<number>`cast(count(distinct ${transactions.id}) as integer)`.as(
        "count"
      ),
      oldestDate: sql<string>`min(${transactions.date})`.as("oldest_date"),
    })
    .from(transactions)
    .innerJoin(
      transactionSplits,
      and(
        eq(transactionSplits.transactionId, transactions.id),
        eq(transactionSplits.bookId, bookId)
      )
    )
    .innerJoin(
      accounts,
      and(
        eq(transactionSplits.accountId, accounts.id),
        eq(accounts.bookId, bookId)
      )
    )
    .innerJoin(
      plaidAccounts,
      and(
        eq(plaidAccounts.counterpoiseAccountId, accounts.id),
        eq(plaidAccounts.bookId, bookId)
      )
    )
    .where(
      and(
        eq(transactions.bookId, bookId),
        eq(transactions.isReconciled, false),
        lt(transactions.date, staleCutoff),
        gte(transactions.date, lookbackCutoff),
        notExists(
          db
            .select({ one: sql`1` })
            .from(plaidTransactionReconciliation)
            .where(
              and(
                eq(plaidTransactionReconciliation.bookId, bookId),
                eq(
                  plaidTransactionReconciliation.plaidAccountLinkId,
                  plaidAccounts.id
                ),
                eq(
                  plaidTransactionReconciliation.matchedTransactionId,
                  transactions.id
                )
              )
            )
        )
      )
    )
    .groupBy(accounts.id, accounts.name)
    .orderBy(asc(accounts.name));

  const totalCount = rows.reduce((sum, row) => sum + row.count, 0);
  return { totalCount, accounts: rows };
}

// Extracted from app/api/b/[bookId]/sync/assigned-accounts/route.ts GET, unchanged.
export async function getAssignedAccounts(db: AppDb, bookId: number) {
  const rows = await db
    .select({
      plaidLinkId: plaidAccounts.id,
      financialInstitution: plaidTokens.financialInstitution,
      tokenId: plaidTokens.id,
      itemId: plaidTokens.itemId,
      plaidAccountId: plaidAccounts.plaidAccountId,
      plaidAccountName: plaidAccounts.name,
      plaidAccountMask: plaidAccounts.mask,
      counterpoiseAccountId: plaidAccounts.counterpoiseAccountId,
      counterpoiseAccountName: accounts.name,
      lastSyncedAt: plaidTokens.lastSyncedAt,
      lastError: plaidTokens.lastError,
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
    .from(plaidAccounts)
    .innerJoin(plaidTokens, eq(plaidAccounts.tokenId, plaidTokens.id))
    .innerJoin(accounts, eq(plaidAccounts.counterpoiseAccountId, accounts.id))
    .leftJoin(
      plaidTransactionReconciliation,
      eq(plaidTransactionReconciliation.plaidAccountLinkId, plaidAccounts.id)
    )
    .where(and(eq(plaidTokens.bookId, bookId), isNotNull(plaidAccounts.counterpoiseAccountId)))
    .groupBy(
      plaidAccounts.id,
      plaidTokens.financialInstitution,
      plaidTokens.itemId,
      plaidAccounts.plaidAccountId,
      plaidAccounts.name,
      plaidAccounts.mask,
      plaidAccounts.counterpoiseAccountId,
      accounts.name,
      plaidTokens.id,
      plaidTokens.lastSyncedAt,
      plaidTokens.lastError
    )
    .orderBy(
      asc(plaidTokens.financialInstitution),
      asc(plaidTokens.itemId),
      asc(plaidAccounts.name)
    );

  return rows;
}

export interface PlaidStatus {
  tokens: Awaited<ReturnType<typeof listTokens>>;
  pendingCount: number;
  staleUnmatched: Awaited<ReturnType<typeof getStaleUnmatched>>;
  assignedAccounts: Awaited<ReturnType<typeof getAssignedAccounts>>;
}

/**
 * Everything the Sync page polls, in one call.
 *
 * The four reads are separate routes because the UI refreshes each on its own
 * cadence. An assistant answering "how is bank sync doing?" needs all four at
 * once, and issuing them concurrently costs no more than the slowest.
 *
 * Access tokens are masked here, not at the tool boundary: this is the only
 * place that decides what a caller may see of a credential, and every caller
 * downstream inherits it.
 */
export async function getPlaidStatus(
  db: AppDb,
  bookId: number,
): Promise<PlaidStatus> {
  const [tokens, pendingCount, staleUnmatched, assignedAccounts] =
    await Promise.all([
      listTokens(db, bookId),
      getPendingCount(db, bookId),
      getStaleUnmatched(db, bookId),
      getAssignedAccounts(db, bookId),
    ]);

  return { tokens, pendingCount, staleUnmatched, assignedAccounts };
}

export class PlaidTokenNotFoundError extends Error {
  constructor(tokenId: number) {
    super(`Plaid token ${tokenId} not found`);
    this.name = "PlaidTokenNotFoundError";
  }
}

// Extracted from app/api/b/[bookId]/sync/tokens/[id]/route.ts PUT, unchanged.
export class PlaidTokenValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlaidTokenValidationError";
  }
}

/**
 * A refresh's call to Plaid, or the write reconciling its response, failed.
 * listTokenAccounts throws this instead of the raw error so a caller can
 * tell it apart from a database failure during the token lookup or the
 * final read — the sync/tokens/[id]/accounts route's GET handler narrows
 * its 502/500 handling to exactly this case, matching how the route
 * behaved before a refresh was folded into one library call: a lookup or
 * read failure falls through to the route's generic 500 instead of being
 * reported as a Plaid outage.
 */
export class PlaidRefreshError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlaidRefreshError";
  }
}

// Extracted from app/api/b/[bookId]/sync/tokens/[id]/accounts/route.ts, unchanged.
export function parseTokenId(value: string): number | null {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

// Not exported: the row it returns carries the unmasked accessToken, and
// the type is inferred rather than declared, so nothing marks a caller that
// leaks it. Every caller-facing read must go through toTokenListItem (or
// toPlaidAccountPayload for account rows), never this row directly. Keep
// the (db, bookId, tokenId) parameter order matching every other exported
// function in this module — a swapped pair of `number` arguments compiles
// silently, and this function's raw row is exactly what a transposed call
// would leak into another book's response.
async function getTokenOr404(db: AppDb, bookId: number, tokenId: number) {
  const tokenRows = await db
    .select()
    .from(plaidTokens)
    .where(and(eq(plaidTokens.id, tokenId), eq(plaidTokens.bookId, bookId)));

  if (tokenRows.length === 0) {
    return null;
  }

  return tokenRows[0];
}

async function getTokenAccounts(db: AppDb, tokenId: number) {
  return await db
    .select()
    .from(plaidAccounts)
    .where(eq(plaidAccounts.tokenId, tokenId))
    .orderBy(asc(plaidAccounts.name), asc(plaidAccounts.plaidAccountId));
}

const toPlaidAccountPayload = (record: typeof plaidAccounts.$inferSelect) => ({
  plaidAccountId: record.plaidAccountId,
  name: record.name,
  officialName: record.officialName,
  mask: record.mask,
  type: record.type,
  subtype: record.subtype,
  counterpoiseAccountId: record.counterpoiseAccountId,
});

export type SetTokenAccountsAssignment = AssignAccountsInput["assignments"][number];

/**
 * Maps a connection's bank accounts to Counterpoise accounts. Every
 * plaidAccountId in `assignments` gets set to the counterpoiseAccountId (or
 * null) it is given; a plaidAccountId that belongs to this connection but is
 * missing from `assignments` is left alone.
 *
 * Refuses the whole batch, before writing anything, when: an assignment
 * names a plaidAccountId that is not one of this connection's accounts; a
 * counterpoiseAccountId is not an account in this book; or a
 * counterpoiseAccountId is already mapped to a different Plaid account.
 * (Uniqueness of plaidAccountId and of non-null counterpoiseAccountId
 * within `assignments` itself is enforced earlier, by
 * assignAccountsSchema's two array-level refinements.)
 *
 * Extracted from app/api/b/[bookId]/sync/tokens/[id]/accounts/route.ts PUT,
 * unchanged apart from each refusal now being a thrown error instead of a
 * NextResponse.
 */
export async function setTokenAccounts(
  db: AppDb,
  bookId: number,
  tokenId: number,
  assignments: SetTokenAccountsAssignment[],
) {
  const token = await getTokenOr404(db, bookId, tokenId);
  if (!token) throw new PlaidTokenNotFoundError(tokenId);

  const tokenAccounts = await getTokenAccounts(db, tokenId);
  const validPlaidAccountIds = new Set(
    tokenAccounts.map((record) => record.plaidAccountId)
  );

  for (const assignment of assignments) {
    if (!validPlaidAccountIds.has(assignment.plaidAccountId)) {
      throw new PlaidTokenValidationError(
        `Unknown plaidAccountId for token: ${assignment.plaidAccountId}`
      );
    }
  }

  const requestedCounterpoiseIds = assignments
    .map((assignment) => assignment.counterpoiseAccountId)
    .filter((value): value is number => value !== null);

  // Uniqueness among non-null counterpoiseAccountId values is guaranteed
  // by assignAccountsSchema's second refine (lib/schemas/sync.ts) — a
  // request with a duplicate can't reach this point. This Set only sizes
  // the DB-dependent check below, not re-detect duplicates.
  const uniqueRequestedCounterpoiseIds = new Set(requestedCounterpoiseIds);

  if (requestedCounterpoiseIds.length > 0) {
    const existingAccounts = await db
      .select({ id: accounts.id, type: accounts.type })
      .from(accounts)
      .where(and(eq(accounts.bookId, bookId), inArray(accounts.id, requestedCounterpoiseIds)));

    if (existingAccounts.length !== uniqueRequestedCounterpoiseIds.size) {
      throw new PlaidTokenValidationError(
        "One or more counterpoiseAccountId values are invalid"
      );
    }

    // Being in this book is not enough to be mappable. syncToken() refuses any
    // link whose Counterpoise account is not an asset or a liability, so a
    // mapping to an income or expense account saves happily here and then
    // breaks every subsequent sync — with the error surfacing on the Sync page,
    // far from the call that caused it.
    //
    // The web UI never produces this: its dropdown is filtered to bank and
    // credit-card subtypes (app/b/[bookId]/sync/tokens/page.tsx). MCP takes a
    // bare integer, so the rule has to be enforced rather than assumed. The
    // message is syncToken's own, verbatim — one rule, one wording, checked at
    // the point of the mistake instead of at the next sync.
    const unsyncable = existingAccounts.filter(
      (account) => account.type !== "asset" && account.type !== "liability"
    );

    if (unsyncable.length > 0) {
      throw new PlaidTokenValidationError(
        "Only asset or liability Counterpoise accounts can be synchronized with Plaid"
      );
    }

    const assignmentPlaidIds = assignments.map(
      (assignment) => assignment.plaidAccountId
    );

    const conflicts = assignmentPlaidIds.length > 0
      ? await db
          .select({
            plaidAccountId: plaidAccounts.plaidAccountId,
            counterpoiseAccountId: plaidAccounts.counterpoiseAccountId,
          })
          .from(plaidAccounts)
          .where(
            and(
              inArray(
                plaidAccounts.counterpoiseAccountId,
                requestedCounterpoiseIds
              ),
              notInArray(plaidAccounts.plaidAccountId, assignmentPlaidIds)
            )
          )
      : [];

    if (conflicts.length > 0) {
      throw new PlaidTokenValidationError(
        "One or more Counterpoise accounts are already mapped to another Plaid account"
      );
    }
  }

  await db.transaction(async (tx) => {
    // Null every mapping this request touches before applying any of it.
    // counterpoiseAccountId carries a global unique index, so applying the
    // assignments in order can collide with a mapping that a later assignment
    // is about to move away — swapping two accounts is the smallest case, and
    // it failed with a raw Postgres error rather than a validation message.
    // The pre-checks above cannot catch it: the conflict query deliberately
    // excludes the plaidAccountIds in this request, because those are exactly
    // the rows being rewritten.
    const assignmentPlaidIds = assignments.map((assignment) => assignment.plaidAccountId);

    if (assignmentPlaidIds.length > 0) {
      await tx
        .update(plaidAccounts)
        .set({ counterpoiseAccountId: null, updatedAt: new Date() })
        .where(
          and(
            eq(plaidAccounts.tokenId, tokenId),
            inArray(plaidAccounts.plaidAccountId, assignmentPlaidIds)
          )
        );
    }

    for (const assignment of assignments) {
      await tx
        .update(plaidAccounts)
        .set({
          counterpoiseAccountId: assignment.counterpoiseAccountId,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(plaidAccounts.tokenId, tokenId),
            eq(plaidAccounts.plaidAccountId, assignment.plaidAccountId)
          )
        );
    }
  });

  return (await getTokenAccounts(db, tokenId)).map(toPlaidAccountPayload);
}

/**
 * Re-pulls a connection's account list from Plaid and reconciles it against
 * `plaidAccounts`: upserts every account Plaid still reports, and deletes any
 * local row for an account Plaid no longer reports (a closed account).
 *
 * Throws on a Plaid or configuration failure — the caller decides what HTTP
 * status that becomes, since that choice is presentation, not library logic.
 *
 * Not exported: listTokenAccounts is the only caller, and it wraps this call
 * in its own try/catch to tag a refresh failure as PlaidRefreshError before
 * it reaches anything outside this module.
 */
async function refreshPlaidAccounts(
  db: AppDb,
  bookId: number,
  tokenId: number,
  accessToken: string,
) {
  const plaidRows = await fetchPlaidAccounts(accessToken);
  const now = new Date();
  const incomingIds = plaidRows.map((account) => account.account_id);

  await db.transaction(async (tx) => {
    if (plaidRows.length > 0) {
      await tx
        .insert(plaidAccounts)
        .values(
          plaidRows.map((account) => ({
            bookId,
            tokenId,
            plaidAccountId: account.account_id,
            name: account.name,
            officialName: account.official_name ?? null,
            mask: account.mask ?? null,
            type: account.type,
            subtype: account.subtype ?? null,
            updatedAt: now,
          }))
        )
        .onConflictDoUpdate({
          target: plaidAccounts.plaidAccountId,
          set: {
            tokenId,
            name: sql`excluded.name`,
            officialName: sql`excluded.official_name`,
            mask: sql`excluded.mask`,
            type: sql`excluded.type`,
            subtype: sql`excluded.subtype`,
            updatedAt: now,
          },
        });
    }

    if (incomingIds.length === 0) {
      await tx
        .delete(plaidAccounts)
        .where(eq(plaidAccounts.tokenId, tokenId));
      return;
    }

    await tx
      .delete(plaidAccounts)
      .where(
        and(
          eq(plaidAccounts.tokenId, tokenId),
            notInArray(plaidAccounts.plaidAccountId, incomingIds)
        )
      );
  });
}

export interface ListTokenAccountsOptions {
  /**
   * Re-pull the account list from Plaid before returning it. This is the
   * only reason this read is not folded into getPlaidStatus: it can leave
   * the process, and a status poll should not have to advertise that.
   */
  refresh?: boolean;
}

export async function listTokenAccounts(
  db: AppDb,
  bookId: number,
  tokenId: number,
  options: ListTokenAccountsOptions = {},
) {
  const token = await getTokenOr404(db, bookId, tokenId);
  if (!token) throw new PlaidTokenNotFoundError(tokenId);

  if (options.refresh) {
    try {
      await refreshPlaidAccounts(db, bookId, tokenId, token.accessToken);
    } catch (err) {
      // Tagged so a caller can tell "Plaid (or the write reconciling its
      // response) failed" apart from a plain database failure elsewhere in
      // this function — see PlaidRefreshError's own comment.
      throw new PlaidRefreshError(
        err instanceof Error ? err.message : "Failed to refresh Plaid accounts"
      );
    }
  }

  return (await getTokenAccounts(db, tokenId)).map(toPlaidAccountPayload);
}

export interface UpdatePlaidTokenInput {
  financialInstitution: string;
  itemId: string;
  /** Omit to keep the access token already on file. */
  accessToken?: string;
}

/**
 * Full replace of a connection's institution name and item id, and
 * optionally its access token — never a partial patch. Omitting
 * accessToken keeps the stored one; the caller decides that by leaving
 * the field out, not by passing it as empty.
 *
 * Returns the masked list-item shape (accessTokenMasked, no raw
 * accessToken) — the same shape listTokens returns, so a caller of this
 * function never sees the live credential.
 *
 * Extracted from app/api/b/[bookId]/sync/tokens/[id]/route.ts PUT, unchanged.
 */
export async function updatePlaidToken(
  db: AppDb,
  bookId: number,
  tokenId: number,
  input: UpdatePlaidTokenInput,
) {
  const existing = await getTokenOr404(db, bookId, tokenId);
  if (!existing) throw new PlaidTokenNotFoundError(tokenId);

  const { financialInstitution, itemId, accessToken } = input;

  const duplicateItemRows = await db
    .select({ id: plaidTokens.id })
    .from(plaidTokens)
    .where(
      and(
        eq(plaidTokens.bookId, bookId),
        eq(plaidTokens.itemId, itemId),
        ne(plaidTokens.id, tokenId)
      )
    )
    .limit(1);

  if (duplicateItemRows.length > 0) {
    throw new PlaidTokenValidationError("A token with this itemId already exists");
  }

  const [updatedToken] = await db
    .update(plaidTokens)
    .set({
      financialInstitution,
      itemId,
      ...(accessToken ? { accessToken } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(plaidTokens.id, tokenId), eq(plaidTokens.bookId, bookId)))
    .returning();

  return toTokenListItem(updatedToken);
}

/**
 * Deletes a connection. FK cascades in db/schema.ts remove its account
 * mappings (plaidAccounts) and staged reconciliation rows
 * (plaidTransactionReconciliation) along with it.
 *
 * Extracted from app/api/b/[bookId]/sync/tokens/[id]/route.ts DELETE, unchanged.
 */
export async function deletePlaidToken(db: AppDb, bookId: number, tokenId: number) {
  const deleted = await db
    .delete(plaidTokens)
    .where(and(eq(plaidTokens.id, tokenId), eq(plaidTokens.bookId, bookId)))
    .returning();

  if (deleted.length === 0) {
    throw new PlaidTokenNotFoundError(tokenId);
  }
}

/**
 * Discards a connection's staged, not-yet-reconciled transactions and resets
 * its sync cursor, so the next sync re-fetches from the beginning. Local
 * transactions already reconciled are untouched — only pending
 * `plaidTransactionReconciliation` rows are removed.
 *
 * The delete and the cursor reset run in one transaction: a crash between
 * the two must not leave staged rows on a cursor that has already moved past
 * them, which would make those rows unrecoverable by any future sync.
 *
 * Extracted from app/api/b/[bookId]/sync/tokens/[id]/sync/route.ts DELETE,
 * unchanged apart from the 404 now being a thrown error instead of a
 * NextResponse.
 */
export async function clearSyncData(db: AppDb, bookId: number, tokenId: number) {
  const token = await getTokenOr404(db, bookId, tokenId);
  if (!token) throw new PlaidTokenNotFoundError(tokenId);

  const linkedAccounts = await db
    .select({ linkId: plaidAccounts.id })
    .from(plaidAccounts)
    .where(eq(plaidAccounts.tokenId, tokenId));

  const linkIds = linkedAccounts.map((a) => a.linkId);

  await db.transaction(async (tx) => {
    if (linkIds.length > 0) {
      await tx
        .delete(plaidTransactionReconciliation)
        .where(
          and(
            inArray(plaidTransactionReconciliation.plaidAccountLinkId, linkIds),
            eq(plaidTransactionReconciliation.resolutionStatus, "pending")
          )
        );
    }

    await tx
      .update(plaidTokens)
      .set({
        syncCursor: null,
        lastSyncedAt: null,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(plaidTokens.id, tokenId));
  });
}
