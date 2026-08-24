import { NextResponse } from "next/server";
import { authenticateBookRequest, isError } from "@/lib/api-auth";
import {
  getAccountsWithBalances,
  createAccount,
  AccountValidationError,
  type AccountBalanceRow,
} from "@/lib/accounts";
import { captureEvent } from "@/lib/posthog-server";
import { createAccountSchema, listAccountsQuery } from "@/lib/schemas/accounts";

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
    // searchParams.get() returns null for an absent key, not undefined —
    // map null to undefined before parsing, or an absent optional param
    // fails the schema's undefined-only optional check instead of being
    // treated as "not provided" (e.g. z.coerce.* would turn a missing date
    // into a real, wrong value rather than leaving the filter off).
    const parsedQuery = listAccountsQuery.safeParse({
      type: searchParams.get("type") ?? undefined,
      includeInactive: searchParams.get("includeInactive") ?? undefined,
      asOfDate: searchParams.get("asOfDate") ?? undefined,
    });
    if (!parsedQuery.success) {
      return NextResponse.json({ error: parsedQuery.error.issues[0].message }, { status: 400 });
    }
    const { type, includeInactive: includeInactiveParam, asOfDate } = parsedQuery.data;
    const includeInactive = includeInactiveParam === "true";

    const rows = await getAccountsWithBalances(db, numericBookId, {
      type,
      includeInactive,
      asOfDate,
    });

    type AccountNode = Omit<AccountBalanceRow, "balanceCents" | "hasTransactions"> & {
      balance: number;
      hasTransactions: boolean;
      children: AccountNode[];
    };

    const toNode = (row: AccountBalanceRow): AccountNode => {
      const { balanceCents, hasTransactions, ...rest } = row;
      return { ...rest, balance: balanceCents, hasTransactions, children: [] };
    };

    // Two levels only, and roots are strictly parentId === null — an account
    // whose parent was filtered out is dropped, which is what this endpoint has
    // always returned. Order stays as the lib returned it (type, then name);
    // buildAccountTree() would re-sort alphabetically and change the response.
    const nodes = rows.map(toNode);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    for (const node of nodes) {
      if (node.parentId !== null) {
        byId.get(node.parentId)?.children.push(node);
      }
    }
    const rootAccounts = nodes.filter((n) => n.parentId === null);

    return NextResponse.json(rootAccounts);
  } catch (error) {
    console.error("Error fetching accounts:", error);
    return NextResponse.json(
      { error: "Failed to fetch accounts" },
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

    const parsed = createAccountSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
    }

    let createdAccount;
    try {
      createdAccount = await createAccount(db, numericBookId, parsed.data);
    } catch (error) {
      if (error instanceof AccountValidationError) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
      throw error;
    }

    captureEvent(auth.userId, "account_created", {
      bookId: numericBookId,
      type: createdAccount.type,
      subtype: createdAccount.subtype,
    });

    return NextResponse.json({ ...createdAccount, balance: 0, hasTransactions: false, children: [] });
  } catch (error) {
    console.error("Error creating account:", error);
    return NextResponse.json(
      { error: "Failed to create account" },
      { status: 500 }
    );
  }
}
