import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";

// Only the Plaid client is mocked here. The sibling cron-plaid-sync.test.ts
// mocks @/db as well, which means it exercises the route's branching but never
// its WHERE clause — a query that selects the wrong rows passes there. This
// file runs the real query against the test database for that reason.
vi.mock("@/lib/plaid-sync", async () => {
  const actual = await vi.importActual<typeof import("@/lib/plaid-sync")>(
    "@/lib/plaid-sync"
  );
  return {
    syncToken: vi.fn(),
    isPlaidConfigured: vi.fn(() => true),
    SyncTokenError: actual.SyncTokenError,
  };
});

import { GET } from "@/app/api/cron/plaid-sync/route";
import { syncToken } from "@/lib/plaid-sync";
import { getDb } from "@/db";
import { accounts, plaidAccounts, plaidTokens } from "@/db/schema";
import { resetTestDatabase, setupTestDatabase } from "@/tests/helpers/db-utils";

const db = getDb();

async function createLinkedToken(options: { itemId: string; isDemo: boolean }) {
  const [account] = await db
    .insert(accounts)
    .values({
      bookId: 1,
      name: `Card ${options.itemId}`,
      type: "liability",
      subtype: "credit_card",
    })
    .returning();

  const [token] = await db
    .insert(plaidTokens)
    .values({
      bookId: 1,
      financialInstitution: "Chase Bank",
      itemId: options.itemId,
      accessToken: `access_${options.itemId}`,
      isDemo: options.isDemo,
    })
    .returning();

  await db.insert(plaidAccounts).values({
    bookId: 1,
    tokenId: token.id,
    plaidAccountId: `acct_${options.itemId}`,
    name: `Card ${options.itemId}`,
    type: "credit",
    counterpoiseAccountId: account.id,
  });

  return token;
}

function cronRequest() {
  return new Request("http://localhost/api/cron/plaid-sync", {
    headers: { authorization: "Bearer test-secret" },
  });
}

describe("GET /api/cron/plaid-sync — demo connections", () => {
  const originalCronSecret = process.env.CRON_SECRET;

  beforeAll(async () => {
    await setupTestDatabase();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    await resetTestDatabase();
    process.env.CRON_SECRET = "test-secret";
    vi.mocked(syncToken).mockResolvedValue({
      synced: { added: 0, modified: 0, removed: 0 },
      autoMatched: 0,
      lastSyncedAt: new Date(),
      pendingCount: 0,
      reviewCount: 0,
    });
  });

  afterEach(() => {
    if (originalCronSecret === undefined) {
      delete process.env.CRON_SECRET;
    } else {
      process.env.CRON_SECRET = originalCronSecret;
    }
  });

  it("syncs a real linked token", async () => {
    const real = await createLinkedToken({ itemId: "real_item", isDemo: false });

    const response = await GET(cronRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ tokensFound: 1, tokensSynced: 1 });
    expect(syncToken).toHaveBeenCalledWith(expect.anything(), 1, real.id);
  });

  it("skips a demo token even though its account link qualifies", async () => {
    // The demo token is linked to a liability account exactly like a real one,
    // so nothing but is_demo distinguishes it. Its access token is synthetic:
    // syncing it means a guaranteed-failing call to Plaid every six hours, and
    // a "Last sync failed" banner on the demo book's own Sync page.
    await createLinkedToken({ itemId: "demo_item_chase_2", isDemo: true });

    const response = await GET(cronRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      tokensFound: 0,
      tokensSynced: 0,
      tokensFailed: 0,
    });
    expect(syncToken).not.toHaveBeenCalled();
  });

  it("syncs the real token and leaves the demo one alone when both exist", async () => {
    const real = await createLinkedToken({ itemId: "real_item", isDemo: false });
    await createLinkedToken({ itemId: "demo_item_chase_2", isDemo: true });

    const response = await GET(cronRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ tokensFound: 1, tokensSynced: 1 });
    expect(syncToken).toHaveBeenCalledTimes(1);
    expect(syncToken).toHaveBeenCalledWith(expect.anything(), 1, real.id);
  });
});
