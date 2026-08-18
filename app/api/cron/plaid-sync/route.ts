import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { plaidTokens, plaidAccounts, accounts } from "@/db/schema";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { syncToken, isPlaidConfigured, SyncTokenError } from "@/lib/plaid-sync";
import { verifyCronSecret } from "@/lib/cron-auth";

export async function GET(request: Request) {
  try {
    if (!verifyCronSecret(request)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (!isPlaidConfigured()) {
      return NextResponse.json({ success: true, skipped: true, reason: "Plaid not configured" });
    }

    const db = getDb();

    // Find all tokens that have at least one linked account.
    //
    // Demo tokens are excluded here rather than left to fail inside the loop
    // below. A demo book's connection is linked to a liability account exactly
    // like a real one, so it qualifies on every other condition, but its access
    // token is synthetic and Plaid will always reject it. Letting it through
    // would count a failure per demo book on every run and write that error to
    // the demo book's own Sync page.
    const tokenRows = await db
      .selectDistinct({ tokenId: plaidTokens.id, bookId: plaidTokens.bookId })
      .from(plaidTokens)
      .innerJoin(plaidAccounts, eq(plaidAccounts.tokenId, plaidTokens.id))
      .innerJoin(accounts, eq(plaidAccounts.counterpoiseAccountId, accounts.id))
      .where(
        and(
          eq(plaidTokens.isDemo, false),
          isNotNull(plaidAccounts.counterpoiseAccountId),
          inArray(accounts.type, ["asset", "liability"])
        )
      );

    let tokensSynced = 0;
    let tokensSkipped = 0;
    let tokensFailed = 0;
    const errors: Array<{ tokenId: number; bookId: number; error: string }> = [];

    for (const { tokenId, bookId } of tokenRows) {
      try {
        await syncToken(db, bookId, tokenId);
        tokensSynced += 1;
      } catch (error) {
        // 409 means a manual sync of this token was already running, which is
        // a normal overlap rather than a fault: that sync is fetching exactly
        // what this one would have. Counting it as a failure would raise the
        // error indicator on the sync page for a healthy connection.
        if (error instanceof SyncTokenError && error.status === 409) {
          tokensSkipped += 1;
          continue;
        }
        tokensFailed += 1;
        const message = error instanceof Error ? error.message : "Unknown error";
        errors.push({ tokenId, bookId, error: message });
        console.error(`Error syncing Plaid token ${tokenId} for book ${bookId}:`, message);
      }
    }

    return NextResponse.json({
      success: true,
      tokensFound: tokenRows.length,
      tokensSynced,
      tokensSkipped,
      tokensFailed,
      ...(errors.length > 0 ? { errors } : {}),
    });
  } catch (error) {
    console.error("Error in Plaid sync cron:", error);
    return NextResponse.json(
      { error: "Failed to run Plaid sync cron" },
      { status: 500 }
    );
  }
}
