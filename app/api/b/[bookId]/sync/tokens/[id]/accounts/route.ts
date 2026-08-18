import { NextResponse } from "next/server";
import { authenticateBookRequest, isError } from "@/lib/api-auth";
import { accounts, plaidAccounts, plaidTokens } from "@/db/schema";
import {
  and,
  asc,
  eq,
  inArray,
  notInArray,
  sql,
} from "drizzle-orm";
import { fetchPlaidAccounts } from "@/lib/plaid";
import { type AppDb } from "@/db";
import { assignAccountsSchema } from "@/lib/schemas/sync";

const toPlaidAccountPayload = (record: typeof plaidAccounts.$inferSelect) => ({
  plaidAccountId: record.plaidAccountId,
  name: record.name,
  officialName: record.officialName,
  mask: record.mask,
  type: record.type,
  subtype: record.subtype,
  counterpoiseAccountId: record.counterpoiseAccountId,
});

async function getTokenOr404(db: AppDb, tokenId: number, bookId: number) {
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

async function refreshPlaidAccounts(db: AppDb, tokenId: number, bookId: number, accessToken: string) {
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

function parseTokenId(value: string): number | null {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

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

    const token = await getTokenOr404(db, tokenId, numericBookId);
    if (!token) {
      return NextResponse.json({ error: "Token not found" }, { status: 404 });
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
    if (refresh) {
      try {
        await refreshPlaidAccounts(db, tokenId, numericBookId, token.accessToken);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to refresh Plaid accounts";
        const status = isPlaidConfigurationError(message) ? 500 : 502;
        return NextResponse.json({ error: message }, { status });
      }
    }

    const tokenAccounts = await getTokenAccounts(db, tokenId);
    return NextResponse.json(tokenAccounts.map(toPlaidAccountPayload));
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

    const token = await getTokenOr404(db, tokenId, numericBookId);
    if (!token) {
      return NextResponse.json({ error: "Token not found" }, { status: 404 });
    }

    const parsed = assignAccountsSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
    }
    const parsedAssignments = parsed.data.assignments;

    const tokenAccounts = await getTokenAccounts(db, tokenId);
    const validPlaidAccountIds = new Set(
      tokenAccounts.map((record) => record.plaidAccountId)
    );

    for (const assignment of parsedAssignments) {
      if (!validPlaidAccountIds.has(assignment.plaidAccountId)) {
        return NextResponse.json(
          {
            error: `Unknown plaidAccountId for token: ${assignment.plaidAccountId}`,
          },
          { status: 400 }
        );
      }
    }

    const requestedCounterpoiseIds = parsedAssignments
      .map((assignment) => assignment.counterpoiseAccountId)
      .filter((value): value is number => value !== null);

    // Uniqueness among non-null counterpoiseAccountId values is guaranteed
    // by assignAccountsSchema's second refine (lib/schemas/sync.ts) — a
    // request with a duplicate can't reach this point. This Set only sizes
    // the DB-dependent check below, not re-detect duplicates.
    const uniqueRequestedCounterpoiseIds = new Set(requestedCounterpoiseIds);

    if (requestedCounterpoiseIds.length > 0) {
      const existingAccounts = await db
        .select({ id: accounts.id })
        .from(accounts)
        .where(and(eq(accounts.bookId, numericBookId), inArray(accounts.id, requestedCounterpoiseIds)));

      if (existingAccounts.length !== uniqueRequestedCounterpoiseIds.size) {
        return NextResponse.json(
          { error: "One or more counterpoiseAccountId values are invalid" },
          { status: 400 }
        );
      }

      const assignmentPlaidIds = parsedAssignments.map(
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
        return NextResponse.json(
          {
            error:
              "One or more Counterpoise accounts are already mapped to another Plaid account",
          },
          { status: 400 }
        );
      }
    }

    await db.transaction(async (tx) => {
      for (const assignment of parsedAssignments) {
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

    const updated = await getTokenAccounts(db, tokenId);
    return NextResponse.json(updated.map(toPlaidAccountPayload));
  } catch (error) {
    console.error("Error saving Plaid account assignments:", error);
    return NextResponse.json(
      { error: "Failed to save Plaid account assignments" },
      { status: 500 }
    );
  }
}
