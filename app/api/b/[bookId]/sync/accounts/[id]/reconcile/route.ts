import { NextResponse } from "next/server";
import { authenticateBookRequest, isError } from "@/lib/api-auth";
import { captureEvent } from "@/lib/posthog-server";
import {
  accounts,
  investmentSplits,
  payees,
  plaidAccounts,
  plaidTransactionReconciliation,
  transactions,
  transactionSplits,
} from "@/db/schema";
import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { toDateString } from "@/lib/formatters";
import { normalizePayeeName } from "@/lib/payees";
import { effectiveDateSql } from "@/lib/accounting";
import type { SyncReconciliationItem, SyncResolveActionPayload } from "@/types";
import { type AppDb } from "@/db";
import { reconcileListQuery, reconcileSchema } from "@/lib/schemas/sync";

type TransactionDb = Parameters<Parameters<AppDb["transaction"]>[0]>[0];
type DbClient = AppDb | TransactionDb;

type LinkRow = {
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

class SyncResolveError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "SyncResolveError";
    this.status = status;
  }
}

function parseLinkId(value: string): number | null {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
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

async function getLinkedAccountOr404(db: AppDb, linkId: number, bookId: number): Promise<LinkRow | null> {
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
    return null;
  }

  return {
    linkId: row.linkId,
    counterpoiseAccountId: row.counterpoiseAccountId,
    counterpoiseAccountType: row.counterpoiseAccountType,
  };
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

async function loadSingleReconciliationItem(
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

export async function GET(
  request: Request,
  { params }: { params: Promise<{ bookId: string; id: string }> }
) {
  try {
    const { bookId, id } = await params;
    const auth = await authenticateBookRequest(bookId);
    if (isError(auth)) return auth.error;
    const { db, bookId: numericBookId } = auth;

    const linkId = parseLinkId(id);
    if (linkId === null) {
      return NextResponse.json({ error: "Invalid linked account id" }, { status: 400 });
    }

    const link = await getLinkedAccountOr404(db, linkId, numericBookId);
    if (!link) {
      return NextResponse.json({ error: "Linked sync account not found" }, { status: 404 });
    }

    if (
      link.counterpoiseAccountType !== "asset" &&
      link.counterpoiseAccountType !== "liability"
    ) {
      return NextResponse.json(
        {
          error:
            "Only asset or liability Counterpoise accounts can be reconciled against Plaid transactions",
        },
        { status: 400 }
      );
    }

    const { searchParams } = new URL(request.url);
    // reconcileListQuery's limit/offset fields never fail (see
    // lib/schemas/sync.ts) — safeParse here can't return success: false,
    // but it's still safeParse + the standard guard for consistency with
    // every other query wiring in this codebase (same convention
    // securities.ts's price/split routes use for their own .catch()-backed
    // limit/offset).
    const parsedQuery = reconcileListQuery.safeParse({
      limit: searchParams.get("limit") || undefined,
      offset: searchParams.get("offset") || undefined,
    });
    if (!parsedQuery.success) {
      return NextResponse.json({ error: parsedQuery.error.issues[0].message }, { status: 400 });
    }
    const { limit, offset } = parsedQuery.data;

    const whereClause = and(
      eq(plaidTransactionReconciliation.plaidAccountLinkId, linkId),
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
      rows.map((row) => loadSingleReconciliationItem(db, row, link.counterpoiseAccountId, numericBookId))
    );

    const totalCount = countRows[0]?.count ?? 0;

    return NextResponse.json({
      items,
      totalCount,
      offset,
      limit,
      hasMore: offset + items.length < totalCount,
    });
  } catch (error) {
    console.error("Error loading sync reconciliation queue:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load reconciliation queue" },
      { status: 500 }
    );
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ bookId: string; id: string }> }
) {
  try {
    const { bookId, id } = await params;
    const auth = await authenticateBookRequest(bookId);
    if (isError(auth)) return auth.error;
    const { db, bookId: numericBookId } = auth;

    const linkId = parseLinkId(id);
    if (linkId === null) {
      return NextResponse.json({ error: "Invalid linked account id" }, { status: 400 });
    }

    const link = await getLinkedAccountOr404(db, linkId, numericBookId);
    if (!link) {
      return NextResponse.json({ error: "Linked sync account not found" }, { status: 404 });
    }

    if (
      link.counterpoiseAccountType !== "asset" &&
      link.counterpoiseAccountType !== "liability"
    ) {
      return NextResponse.json(
        {
          error:
            "Only asset or liability Counterpoise accounts can be reconciled against Plaid transactions",
        },
        { status: 400 }
      );
    }

    const parsed = reconcileSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
    }
    // reconcileSchema (lib/schemas/sync.ts) validates this shape at runtime
    // — including that transactionId/counterAccountId are the right type
    // for whatever `action` turned out to be — but its own inferred type
    // leaves transactionId/counterAccountId/payeeName as `unknown` (see that
    // file's comments for why). This cast is what gives the rest of this
    // function the same narrowed, per-action typing
    // SyncResolveActionPayload always had, but it also means TypeScript can
    // no longer see that the `typeof body.payeeName === "string"` check
    // below is load-bearing: the schema left payeeName unvalidated on
    // purpose, so a non-string value really can reach here at runtime even
    // though this cast types it as `string | undefined`. Don't remove that
    // check as a "redundant" narrowing — it isn't.
    const body = parsed.data as SyncResolveActionPayload;

    const now = new Date();
    const updatedReconciliationId = await db.transaction(async (tx) => {
      const reconRow = await loadReconciliationRow(
        tx,
        linkId,
        body.reconciliationId,
        numericBookId
      );
      if (!reconRow) {
        throw new SyncResolveError(404, "Reconciliation row not found");
      }

      if (body.action === "match") {
        const splitRows = await tx
          .select({ id: transactionSplits.id })
          .from(transactionSplits)
          .where(
            and(
              eq(transactionSplits.transactionId, body.transactionId),
              eq(transactionSplits.accountId, link.counterpoiseAccountId),
              eq(transactionSplits.bookId, numericBookId)
            )
          )
          .limit(1);

        if (splitRows.length === 0) {
          throw new SyncResolveError(
            400,
            "Selected transaction does not include the linked account"
          );
        }

        const conflictRows = await tx
          .select({ id: plaidTransactionReconciliation.id })
          .from(plaidTransactionReconciliation)
          .where(
            and(
              eq(plaidTransactionReconciliation.plaidAccountLinkId, linkId),
              eq(plaidTransactionReconciliation.matchedTransactionId, body.transactionId),
              ne(plaidTransactionReconciliation.id, reconRow.id)
            )
          )
          .limit(1);

        if (conflictRows.length > 0) {
          throw new SyncResolveError(
            400,
            "This transaction is already linked to a different Plaid transaction for the same account"
          );
        }

        const updatedTransactions = await tx
          .update(transactions)
          .set({ isReconciled: true, updatedAt: now })
          .where(
            and(
              eq(transactions.id, body.transactionId),
              eq(transactions.bookId, numericBookId)
            )
          )
          .returning({ id: transactions.id });

        if (updatedTransactions.length === 0) {
          throw new SyncResolveError(404, "Transaction not found");
        }

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
              eq(plaidTransactionReconciliation.bookId, numericBookId)
            )
          );
      } else if (body.action === "match_update_amount") {
        const splitRows = await tx
          .select({ id: transactionSplits.id, accountId: transactionSplits.accountId })
          .from(transactionSplits)
          .where(
            and(
              eq(transactionSplits.transactionId, body.transactionId),
              eq(transactionSplits.bookId, numericBookId)
            )
          );

        if (!splitRows.some((s) => s.accountId === link.counterpoiseAccountId)) {
          throw new SyncResolveError(
            400,
            "Selected transaction does not include the linked account"
          );
        }

        if (splitRows.length !== 2) {
          throw new SyncResolveError(
            400,
            "Amount update is only supported for transactions with exactly 2 splits"
          );
        }

        const investmentRows = await tx
          .select({ id: investmentSplits.id })
          .from(investmentSplits)
          .where(
            and(
              eq(investmentSplits.transactionId, body.transactionId),
              eq(investmentSplits.bookId, numericBookId)
            )
          )
          .limit(1);

        if (investmentRows.length > 0) {
          throw new SyncResolveError(
            400,
            "Amount update is not supported for investment transactions"
          );
        }

        const conflictRows = await tx
          .select({ id: plaidTransactionReconciliation.id })
          .from(plaidTransactionReconciliation)
          .where(
            and(
              eq(plaidTransactionReconciliation.plaidAccountLinkId, linkId),
              eq(plaidTransactionReconciliation.matchedTransactionId, body.transactionId),
              ne(plaidTransactionReconciliation.id, reconRow.id)
            )
          )
          .limit(1);

        if (conflictRows.length > 0) {
          throw new SyncResolveError(
            400,
            "This transaction is already linked to a different Plaid transaction for the same account"
          );
        }

        const linkedSplit = splitRows.find((s) => s.accountId === link.counterpoiseAccountId)!;
        const counterSplit = splitRows.find((s) => s.accountId !== link.counterpoiseAccountId);

        if (!counterSplit) {
          throw new SyncResolveError(
            400,
            "Transaction has no counterpart split on a different account"
          );
        }

        await tx
          .update(transactionSplits)
          .set({ amount: -reconRow.amountCents })
          .where(
            and(
              eq(transactionSplits.id, linkedSplit.id),
              eq(transactionSplits.bookId, numericBookId)
            )
          );

        await tx
          .update(transactionSplits)
          .set({ amount: reconRow.amountCents })
          .where(
            and(
              eq(transactionSplits.id, counterSplit.id),
              eq(transactionSplits.bookId, numericBookId)
            )
          );

        const updatedTransactions = await tx
          .update(transactions)
          .set({ isReconciled: true, updatedAt: now })
          .where(
            and(
              eq(transactions.id, body.transactionId),
              eq(transactions.bookId, numericBookId)
            )
          )
          .returning({ id: transactions.id });

        if (updatedTransactions.length === 0) {
          throw new SyncResolveError(404, "Transaction not found");
        }

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
              eq(plaidTransactionReconciliation.bookId, numericBookId)
            )
          );
      } else if (body.action === "create") {
        if (body.counterAccountId === link.counterpoiseAccountId) {
          throw new SyncResolveError(
            400,
            "Counter account must be different from linked account"
          );
        }

        const accountRows = await tx
          .select({ id: accounts.id })
          .from(accounts)
          .where(
            and(
              eq(accounts.id, body.counterAccountId),
              eq(accounts.bookId, numericBookId)
            )
          )
          .limit(1);

        if (accountRows.length === 0) {
          throw new SyncResolveError(400, "Counter account not found");
        }

        const payeeSource =
          typeof body.payeeName === "string"
            ? body.payeeName
            : reconRow.merchantName ?? reconRow.name;
        const payeeId = await resolvePayeeId(tx, payeeSource, numericBookId);
        const [createdTransaction] = await tx
          .insert(transactions)
          .values({
            date: reconRow.authorizedDate ?? reconRow.date,
            description: reconRow.name,
            payeeId,
            isReconciled: true,
            updatedAt: now,
            bookId: numericBookId,
          })
          .returning({ id: transactions.id });

        if (!createdTransaction) {
          throw new SyncResolveError(500, "Failed to create transaction");
        }

        await tx.insert(transactionSplits).values([
          {
            transactionId: createdTransaction.id,
            accountId: link.counterpoiseAccountId,
            amount: -reconRow.amountCents,
            bookId: numericBookId,
          },
          {
            transactionId: createdTransaction.id,
            accountId: body.counterAccountId,
            amount: reconRow.amountCents,
            bookId: numericBookId,
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
              eq(plaidTransactionReconciliation.bookId, numericBookId)
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
              eq(plaidTransactionReconciliation.bookId, numericBookId)
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
              eq(plaidTransactionReconciliation.bookId, numericBookId)
            )
          );
      } else if (body.action === "unlink") {
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
              eq(plaidTransactionReconciliation.bookId, numericBookId)
            )
          );
      } else {
        // Unreachable today: reconcileSchema's z.enum(reconcileActionValues)
        // already rejects anything outside these six literals before this
        // handler runs. Kept as a safety net against drift — this switch,
        // reconcileActionValues, and SyncResolveActionPayload (types.ts) are
        // three lists kept in sync by hand, and a 7th action added to the
        // first two without a branch here would otherwise fall through
        // silently: 200 response, unchanged row, no analytics event
        // (eventNameMap[body.action] below would be undefined).
        throw new SyncResolveError(400, "Invalid action");
      }

      return reconRow.id;
    });

    const eventNameMap: Record<string, string> = {
      match: "sync_transaction_matched",
      match_update_amount: "sync_transaction_amount_updated",
      create: "sync_transaction_created",
      ignore: "sync_transaction_ignored",
      keep_local: "sync_transaction_kept_local",
      unlink: "sync_transaction_unlinked",
    };
    const eventName = eventNameMap[body.action];
    if (eventName) {
      captureEvent(auth.userId, eventName, { bookId: numericBookId });
    }

    const updated = await loadReconciliationRow(
      db,
      linkId,
      updatedReconciliationId,
      numericBookId
    );
    if (!updated) {
      return NextResponse.json({ error: "Updated row not found" }, { status: 404 });
    }

    const item = await loadSingleReconciliationItem(db, updated, link.counterpoiseAccountId, numericBookId);
    return NextResponse.json(item);
  } catch (error) {
    if (error instanceof SyncResolveError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("Error resolving sync reconciliation action:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to resolve reconciliation" },
      { status: 500 }
    );
  }
}
