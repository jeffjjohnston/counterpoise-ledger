import { NextResponse } from "next/server";
import { authenticateBookRequest, isError } from "@/lib/api-auth";
import { accounts, transactions, transactionSplits } from "@/db/schema";
import { and, eq, inArray, lt, or, sql } from "drizzle-orm";
import { captureEvent } from "@/lib/posthog-server";
import { type AppDb } from "@/db";
import { createTransaction as createTransactionShared, TransactionValidationError } from "@/lib/transactions";
import { effectiveDateSql } from "@/lib/accounting";
import {
  countTransactionsBefore,
  selectTransactionPage,
  type TransactionFilters,
} from "@/lib/transactions-query";
import {
  createTransactionBodySchema,
  listTransactionsQuery,
} from "@/lib/schemas/transactions";

const FIND_MANY_ID_CHUNK_SIZE = 900;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ bookId: string }> }
) {
  try {
    const { bookId } = await params;
    const auth = await authenticateBookRequest(bookId);
    if (isError(auth)) return auth.error;
    const { db, bookId: numericBookId } = auth;

    const { searchParams } = new URL(request.url);
    // searchParams.get() returns null for an absent key, not undefined, so
    // every param is mapped before parsing. Which mapping matters:
    //   `?? undefined` — an empty value is an error, as it is today
    //     (`?accountId=` parsed to NaN and 400'd). Feeding "" to a coercing
    //     schema would silently turn "no filter" into "filter by 0".
    //   `|| undefined` — an empty value means "not provided", as it does
    //     today (these were all read behind a truthiness check).
    const limitParam = searchParams.get("limit");
    const parsedQuery = listTransactionsQuery.safeParse({
      accountId: searchParams.get("accountId") ?? undefined,
      accountIds: searchParams.get("accountIds") ?? undefined,
      balanceAccountId: searchParams.get("balanceAccountId") ?? undefined,
      payeeId: searchParams.get("payeeId") ?? undefined,
      startDate: searchParams.get("startDate") || undefined,
      endDate: searchParams.get("endDate") || undefined,
      includeMeta: searchParams.get("includeMeta") ?? undefined,
      limit: limitParam || undefined,
      offset: searchParams.get("offset") || undefined,
      ensureId: searchParams.get("ensureId") || undefined,
    });
    if (!parsedQuery.success) {
      return NextResponse.json(
        { error: parsedQuery.error.issues[0].message },
        { status: 400 }
      );
    }

    const {
      accountId: accountIdQuery,
      accountIds: accountIdsQuery,
      balanceAccountId: balanceAccountIdQuery,
      payeeId: payeeIdQuery,
      startDate,
      endDate,
    } = parsedQuery.data;
    const accountIdNumber = accountIdQuery ?? null;
    const accountIds = accountIdsQuery ?? null;
    const balanceAccountIdNumber = balanceAccountIdQuery ?? null;
    const payeeIdNumber = payeeIdQuery ?? null;
    const includeMeta = parsedQuery.data.includeMeta === "true";
    let limit = parsedQuery.data.limit ?? 100;
    const offset = parsedQuery.data.offset ?? 0;
    const ensureId = parsedQuery.data.ensureId ?? null;

    let pageRows: Array<{ id: number; date: string }> = [];
    let totalCount = 0;

    // balanceAccountId only ever reaches a query that is already book-scoped,
    // but this route rejects an out-of-book id outright rather than silently
    // answering about nothing. accountId(s) and payeeId get the same
    // treatment, inside selectTransactionPage below.
    if (balanceAccountIdNumber !== null) {
      const [account] = await db
        .select({ id: accounts.id })
        .from(accounts)
        .where(
          and(
            eq(accounts.id, balanceAccountIdNumber),
            eq(accounts.bookId, numericBookId)
          )
        );
      if (!account) {
        return NextResponse.json(
          { error: "Invalid balanceAccountId" },
          { status: 400 }
        );
      }
    }

    const filteredAccountIds =
      accountIds ?? (accountIdNumber !== null ? [accountIdNumber] : null);

    const filters: TransactionFilters = {
      accountIds: filteredAccountIds,
      payeeId: payeeIdNumber,
      startDate: startDate ?? null,
      endDate: endDate ?? null,
    };

    // When ensureId is set, extend the limit so the target transaction is included
    if (ensureId !== null && offset === 0 && limitParam !== "0") {
      const [targetTxn] = await db
        .select({ date: effectiveDateSql.as("date"), id: transactions.id })
        .from(transactions)
        .where(and(eq(transactions.id, ensureId), eq(transactions.bookId, numericBookId)));

      if (targetTxn) {
        const positionCount = await countTransactionsBefore(
          db,
          numericBookId,
          filters,
          { date: targetTxn.date, id: targetTxn.id }
        );

        // Extend limit to include the target transaction (position is 0-indexed)
        limit = Math.max(limit, positionCount + 1);
      }
    }

    const page = await selectTransactionPage(db, numericBookId, {
      ...filters,
      // "0" is this route's long-standing sentinel for "return everything";
      // the library expresses that as a null limit.
      limit: limitParam === "0" ? null : limit,
      offset,
      withCount: includeMeta,
    });
    pageRows = page.rows;
    totalCount = page.totalCount ?? 0;

    const ids = pageRows.map((row) => row.id);
    type TransactionRow = Awaited<
      ReturnType<AppDb["query"]["transactions"]["findMany"]>
    >[number];
    let allTransactions: TransactionRow[] = [];

    if (ids.length > 0) {
      const queryConfig = {
        with: {
          payee: true,
          splits: {
            with: {
              account: true,
            },
          },
          investmentSplits: {
            with: {
              security: true,
              account: true,
            },
          },
        },
      } as const;

      if (ids.length <= FIND_MANY_ID_CHUNK_SIZE) {
        allTransactions = await db.query.transactions.findMany({
          where: inArray(transactions.id, ids),
          ...queryConfig,
        });
      } else {
        const chunks: number[][] = [];
        for (let i = 0; i < ids.length; i += FIND_MANY_ID_CHUNK_SIZE) {
          chunks.push(ids.slice(i, i + FIND_MANY_ID_CHUNK_SIZE));
        }

        const chunkedResults = await Promise.all(
          chunks.map((chunk) =>
            db.query.transactions.findMany({
              where: inArray(transactions.id, chunk),
              ...queryConfig,
            })
          )
        );
        allTransactions = chunkedResults.flat();
      }

      const orderMap = new Map(ids.map((id, index) => [id, index]));
      allTransactions.sort(
        (a, b) => (orderMap.get(a.id) ?? 0) - (orderMap.get(b.id) ?? 0)
      );
    }

    let startingBalance = 0;
    if (includeMeta && filteredAccountIds && pageRows.length > 0) {
      const balanceAccountId =
        balanceAccountIdNumber ?? filteredAccountIds[0];
      const oldest = pageRows[pageRows.length - 1];
      const olderThanOldest = or(
        lt(effectiveDateSql, oldest.date),
        and(sql`${effectiveDateSql} = ${oldest.date}`, lt(transactions.id, oldest.id))
      );
      const balanceFilters = [
        eq(transactions.bookId, numericBookId),
        eq(transactionSplits.accountId, balanceAccountId),
        olderThanOldest,
        ...(payeeIdNumber !== null ? [eq(transactions.payeeId, payeeIdNumber)] : []),
      ];

      const balanceResult = await db
        .select({
          total: sql<number>`cast(coalesce(sum(${transactionSplits.amount}), 0) as integer)`.as(
            "total"
          ),
        })
        .from(transactionSplits)
        .innerJoin(
          transactions,
          eq(transactions.id, transactionSplits.transactionId)
        )
        .where(and(...balanceFilters));

      startingBalance = balanceResult[0]?.total ?? 0;
    }

    if (includeMeta) {
      return NextResponse.json({
        transactions: allTransactions,
        startingBalance,
        totalCount,
      });
    }

    return NextResponse.json(allTransactions);
  } catch (error) {
    if (error instanceof TransactionValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("Error fetching transactions:", error);
    return NextResponse.json(
      { error: "Failed to fetch transactions" },
      { status: 500 }
    );
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ bookId: string }> }
) {
  try {
    const { bookId } = await params;
    const auth = await authenticateBookRequest(bookId);
    if (isError(auth)) return auth.error;
    const { db, bookId: numericBookId } = auth;

    const parsed = createTransactionBodySchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
    }
    const body = parsed.data;
    const result = await createTransactionShared(db, numericBookId, body);

    captureEvent(auth.userId, "transaction_created", {
      bookId: numericBookId,
      hasInvestmentSplits: Boolean(body.investmentSplits?.length),
      splitCount: body.splits.length,
    });

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof TransactionValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("Error creating transaction:", error);
    return NextResponse.json(
      { error: "Failed to create transaction" },
      { status: 500 }
    );
  }
}
