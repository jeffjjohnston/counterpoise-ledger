import { NextResponse } from "next/server";
import { authenticateBookRequest, isError } from "@/lib/api-auth";
import { payees, transactions } from "@/db/schema";
import { and, asc, eq, sql } from "drizzle-orm";
import { normalizePayeeName } from "@/lib/payees";
import { effectiveDateSql } from "@/lib/accounting";
import { createPayeeSchema, listPayeesQuery } from "@/lib/schemas/payees";

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
    const parsedQuery = listPayeesQuery.safeParse({
      search: searchParams.get("search") || undefined,
      limit: searchParams.get("limit") || undefined,
    });
    if (!parsedQuery.success) {
      return NextResponse.json({ error: parsedQuery.error.issues[0].message }, { status: 400 });
    }
    const { search, limit } = parsedQuery.data;

    const normalizedSearch = search ? normalizePayeeName(search) : "";
    const bookFilter = eq(payees.bookId, numericBookId);
    const whereClause = normalizedSearch
      ? and(bookFilter, sql`lower(${payees.name}) like ${`%${normalizedSearch.toLowerCase()}%`}`)
      : bookFilter;

    const baseQuery = db
      .select({
        id: payees.id,
        name: payees.name,
        lastTransactionDate: sql<string | null>`max(${effectiveDateSql})`.as(
          "lastTransactionDate"
        ),
        transactionCount: sql<number>`cast(count(${transactions.id}) as integer)`.as(
          "transactionCount"
        ),
      })
      .from(payees)
      .leftJoin(transactions, eq(transactions.payeeId, payees.id))
      .groupBy(payees.id)
      .orderBy(asc(payees.name));

    const filteredQuery = baseQuery.where(whereClause);
    const payeeRows = limit ? await filteredQuery.limit(limit) : await filteredQuery;

    return NextResponse.json(payeeRows);
  } catch (error) {
    console.error("Error fetching payees:", error);
    return NextResponse.json({ error: "Failed to fetch payees" }, { status: 500 });
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

    const body = await request.json();
    const parsed = createPayeeSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
    }

    const normalizedName = normalizePayeeName(parsed.data.name);

    const existingPayee = await db
      .select()
      .from(payees)
      .where(and(eq(payees.bookId, numericBookId), sql`lower(${payees.name}) = ${normalizedName.toLowerCase()}`))
      .limit(1);

    if (existingPayee.length > 0) {
      return NextResponse.json(existingPayee[0]);
    }

    const [newPayee] = await db
      .insert(payees)
      .values({ name: normalizedName, bookId: numericBookId })
      .returning();

    return NextResponse.json(newPayee);
  } catch (error) {
    console.error("Error creating payee:", error);
    return NextResponse.json({ error: "Failed to create payee" }, { status: 500 });
  }
}
