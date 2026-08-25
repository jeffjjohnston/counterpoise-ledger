import { NextResponse } from "next/server";
import { authenticateBookRequest, isError } from "@/lib/api-auth";
import { assignAccountsSchema } from "@/lib/schemas/sync";
import {
  listTokenAccounts,
  parseTokenId,
  PlaidRefreshError,
  PlaidTokenNotFoundError,
  PlaidTokenValidationError,
  setTokenAccounts,
} from "@/lib/plaid-tokens";

function isPlaidConfigurationError(message: string): boolean {
  return message.includes("PLAID_CLIENT_ID") ||
    message.includes("PLAID_SECRET") ||
    message.includes("PLAID_ENV");
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

    const tokenId = parseTokenId(id);

    if (tokenId === null) {
      return NextResponse.json({ error: "Invalid token id" }, { status: 400 });
    }

    // Deliberately left unvalidated by lib/schemas/sync.ts: `=== "true"` is
    // a total function over every possible input, including `null` (the
    // param absent) — there is no string value, valid or malformed, that
    // this expression can fail on, so there's no failure mode for a schema
    // to move out of the route. A schema here would only be
    // `z.string().optional().transform((v) => v === "true")`, which can
    // never reject anything either — it would just relocate the same
    // one-line comparison, not add validation.
    const refresh = new URL(request.url).searchParams.get("refresh") === "true";

    try {
      const rows = await listTokenAccounts(db, numericBookId, tokenId, { refresh });
      return NextResponse.json(rows);
    } catch (error) {
      if (error instanceof PlaidTokenNotFoundError) {
        return NextResponse.json({ error: "Token not found" }, { status: 404 });
      }
      // Only a genuine refresh failure (a Plaid call, or the write
      // reconciling its response) gets the message-passthrough 502/500
      // treatment below. A database failure during the token lookup or the
      // final read is not this connection's fault, so it is rethrown to
      // the outer catch's generic 500 instead of being reported as a Plaid
      // outage — matching this route's behavior before refresh was folded
      // into one listTokenAccounts call.
      if (!(error instanceof PlaidRefreshError)) {
        throw error;
      }
      const status = isPlaidConfigurationError(error.message) ? 500 : 502;
      return NextResponse.json({ error: error.message }, { status });
    }
  } catch (error) {
    console.error("Error fetching token Plaid accounts:", error);
    return NextResponse.json(
      { error: "Failed to fetch token Plaid accounts" },
      { status: 500 }
    );
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ bookId: string; id: string }> }
) {
  try {
    const { bookId, id } = await params;
    const auth = await authenticateBookRequest(bookId);
    if (isError(auth)) return auth.error;
    const { db, bookId: numericBookId } = auth;

    const tokenId = parseTokenId(id);

    if (tokenId === null) {
      return NextResponse.json({ error: "Invalid token id" }, { status: 400 });
    }

    const parsed = assignAccountsSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
    }

    try {
      const rows = await setTokenAccounts(db, numericBookId, tokenId, parsed.data.assignments);
      return NextResponse.json(rows);
    } catch (error) {
      if (error instanceof PlaidTokenNotFoundError) {
        return NextResponse.json({ error: "Token not found" }, { status: 404 });
      }
      if (error instanceof PlaidTokenValidationError) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
      throw error;
    }
  } catch (error) {
    console.error("Error saving Plaid account assignments:", error);
    return NextResponse.json(
      { error: "Failed to save Plaid account assignments" },
      { status: 500 }
    );
  }
}
