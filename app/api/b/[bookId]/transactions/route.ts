import { NextResponse } from "next/server";
import { authenticateBookRequest, isError } from "@/lib/api-auth";
import { accounts, payees, transactions, transactionSplits } from "@/db/schema";
import { and, desc, eq, gte, inArray, lt, lte, or, sql, type SQL } from "drizzle-orm";
import { captureEvent } from "@/lib/posthog-server";
import { type AppDb } from "@/db";
import { createTransaction as createTransactionShared, TransactionValidationError } from "@/lib/transactions";
import { effectiveDateSql } from "@/lib/accounting";
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

    const dateFilters: SQL[] = [];
    if (startDate) {
      dateFilters.push(gte(effectiveDateSql, startDate));
    }
    if (endDate) {
      dateFilters.push(lte(effectiveDateSql, endDate));
    }

    let pageRows: Array<{ id: number; date: string }> = [];
    let totalCount = 0;

    // These two only ever reach queries that are already book-scoped, but reject
    // out-of-book ids outright rather than silently answering about nothing.
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

    if (payeeIdNumber !== null) {
      const [payee] = await db
        .select({ id: payees.id })
        .from(payees)
        .where(and(eq(payees.id, payeeIdNumber), eq(payees.bookId, numericBookId)));
      if (!payee) {
        return NextResponse.json({ error: "Invalid payeeId" }, { status: 400 });
      }
    }

    const payeeFilter =
      payeeIdNumber !== null ? eq(transactions.payeeId, payeeIdNumber) : null;

    const filteredAccountIds =
      accountIds ?? (accountIdNumber !== null ? [accountIdNumber] : null);

    // When ensureId is set, extend the limit so the target transaction is included
    if (ensureId !== null && offset === 0 && limitParam !== "0") {
      const [targetTxn] = await db
        .select({ date: effectiveDateSql.as("date"), id: transactions.id })
        .from(transactions)
        .where(and(eq(transactions.id, ensureId), eq(transactions.bookId, numericBookId)));

      if (targetTxn) {
        // Count how many transactions come before this one in desc date, desc id order
        const positionFilter = or(
          sql`${effectiveDateSql} > ${targetTxn.date}`,
          and(
            sql`${effectiveDateSql} = ${targetTxn.date}`,
            sql`${transactions.id} > ${targetTxn.id}`
          )
        );

        let positionCount: number;
        if (filteredAccountIds) {
          const [result] = await db
            .select({
              count: sql<number>`cast(count(distinct ${transactions.id}) as integer)`.as("count"),
            })
            .from(transactions)
            .innerJoin(
              transactionSplits,
              eq(transactionSplits.transactionId, transactions.id)
            )
            .where(
              and(
                eq(transactions.bookId, numericBookId),
                inArray(transactionSplits.accountId, filteredAccountIds),
                ...dateFilters,
                ...(payeeFilter ? [payeeFilter] : []),
                positionFilter
              )
            );
          positionCount = result?.count ?? 0;
        } else {
          const filters = [
            eq(transactions.bookId, numericBookId),
            ...dateFilters,
            ...(payeeFilter ? [payeeFilter] : []),
            positionFilter,
          ];
          const [result] = await db
            .select({
              count: sql<number>`cast(count(*) as integer)`.as("count"),
            })
            .from(transactions)
            .where(and(...filters));
          positionCount = result?.count ?? 0;
        }

        // Extend limit to include the target transaction (position is 0-indexed)
        limit = Math.max(limit, positionCount + 1);
      }
    }

    if (filteredAccountIds) {
      const accountFilters = [
        eq(transactions.bookId, numericBookId),
        inArray(transactionSplits.accountId, filteredAccountIds),
        ...dateFilters,
        ...(payeeFilter ? [payeeFilter] : []),
      ];
      const accountWhere = and(...accountFilters);

      const baseQuery = db
        .select({ id: transactions.id, date: effectiveDateSql.as("date") })
        .from(transactions)
        .innerJoin(
          transactionSplits,
          eq(transactionSplits.transactionId, transactions.id)
        )
        .where(accountWhere)
        .groupBy(transactions.id, transactions.date)
        .orderBy(desc(effectiveDateSql), desc(transactions.id));

      const pageQuery =
        limitParam !== "0" ? baseQuery.limit(limit).offset(offset) : baseQuery;

      pageRows = await pageQuery;

      if (includeMeta) {
        const countResult = await db
          .select({
            count: sql<number>`cast(count(distinct ${transactions.id}) as integer)`.as("count"),
          })
          .from(transactions)
          .innerJoin(
            transactionSplits,
            eq(transactionSplits.transactionId, transactions.id)
          )
          .where(accountWhere);

        totalCount = countResult[0]?.count ?? 0;
      }
    } else {
      const whereClause = (() => {
        const filters = [eq(transactions.bookId, numericBookId), ...dateFilters, ...(payeeFilter ? [payeeFilter] : [])];
        return and(...filters);
      })();

      const baseQuery = db
        .select({ id: transactions.id, date: effectiveDateSql.as("date") })
        .from(transactions)
        .where(whereClause)
        .orderBy(desc(effectiveDateSql), desc(transactions.id));

      const pageQuery =
        limitParam !== "0" ? baseQuery.limit(limit).offset(offset) : baseQuery;

      pageRows = await pageQuery;

      if (includeMeta) {
        const countResult = await db
          .select({ count: sql<number>`cast(count(*) as integer)`.as("count") })
          .from(transactions)
          .where(whereClause);

        totalCount = countResult[0]?.count ?? 0;
      }
    }

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
        ...(payeeFilter ? [payeeFilter] : []),
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
