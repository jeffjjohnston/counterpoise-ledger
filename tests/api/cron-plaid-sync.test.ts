import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/plaid-sync", async () => {
  // The route branches on `instanceof SyncTokenError` and on its status, so
  // the mock has to supply the real class, not a stub.
  const actual = await vi.importActual<typeof import("@/lib/plaid-sync")>(
    "@/lib/plaid-sync"
  );
  return {
    syncToken: vi.fn(),
    isPlaidConfigured: vi.fn(),
    SyncTokenError: actual.SyncTokenError,
  };
});

vi.mock("@/db", () => ({
  getDb: vi.fn(),
}));

import { GET } from "@/app/api/cron/plaid-sync/route";
import { isPlaidConfigured, syncToken, SyncTokenError } from "@/lib/plaid-sync";
import { getDb } from "@/db";

describe("GET /api/cron/plaid-sync", () => {
  const originalCronSecret = process.env.CRON_SECRET;

  beforeEach(() => {
    vi.resetAllMocks();
    process.env.CRON_SECRET = "test-secret";
  });

  afterEach(() => {
    if (originalCronSecret === undefined) {
      delete process.env.CRON_SECRET;
    } else {
      process.env.CRON_SECRET = originalCronSecret;
    }
  });

  it("returns 401 without valid auth header", async () => {
    const request = new Request("http://localhost/api/cron/plaid-sync");
    const response = await GET(request);
    expect(response.status).toBe(401);
  });

  it("returns 401 with wrong auth header", async () => {
    const request = new Request("http://localhost/api/cron/plaid-sync", {
      headers: { authorization: "Bearer wrong" },
    });
    const response = await GET(request);
    expect(response.status).toBe(401);
  });

  it("returns 200 with skip message when Plaid is not configured", async () => {
    vi.mocked(isPlaidConfigured).mockReturnValue(false);
    const request = new Request("http://localhost/api/cron/plaid-sync", {
      headers: { authorization: "Bearer test-secret" },
    });
    const response = await GET(request);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.skipped).toBe(true);
  });

  it("returns 200 with summary when no tokens found", async () => {
    vi.mocked(isPlaidConfigured).mockReturnValue(true);
    // Mock the chained query to return empty array
    const mockChain = { selectDistinct: vi.fn().mockReturnThis(), from: vi.fn().mockReturnThis(), innerJoin: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) };
    vi.mocked(getDb).mockReturnValue(mockChain as never);

    const request = new Request("http://localhost/api/cron/plaid-sync", {
      headers: { authorization: "Bearer test-secret" },
    });
    const response = await GET(request);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.tokensFound).toBe(0);
    expect(body.tokensSynced).toBe(0);
  });

  // A token already syncing (a manual click overlapping the cron) is a normal
  // outcome, not a failure. Counting it as one puts a red error on the sync
  // page and buries a genuine failure in the same run.
  it("reports a token that is already syncing as skipped, not failed", async () => {
    vi.mocked(isPlaidConfigured).mockReturnValue(true);
    const mockChain = {
      selectDistinct: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([
        { tokenId: 1, bookId: 1 },
        { tokenId: 2, bookId: 1 },
      ]),
    };
    vi.mocked(getDb).mockReturnValue(mockChain as never);

    vi.mocked(syncToken)
      .mockRejectedValueOnce(new SyncTokenError(409, "A sync is already running"))
      .mockResolvedValueOnce({
        synced: { added: 0, modified: 0, removed: 0 },
        autoMatched: 0,
        lastSyncedAt: new Date(),
        pendingCount: 0,
        reviewCount: 0,
      });

    const request = new Request("http://localhost/api/cron/plaid-sync", {
      headers: { authorization: "Bearer test-secret" },
    });
    const response = await GET(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.tokensSkipped).toBe(1);
    expect(body.tokensSynced).toBe(1);
    expect(body.tokensFailed).toBe(0);
    expect(body.errors).toBeUndefined();
  });

  it("still reports a real sync failure as failed", async () => {
    vi.mocked(isPlaidConfigured).mockReturnValue(true);
    const mockChain = {
      selectDistinct: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([{ tokenId: 1, bookId: 1 }]),
    };
    vi.mocked(getDb).mockReturnValue(mockChain as never);

    vi.mocked(syncToken).mockRejectedValueOnce(new Error("ITEM_LOGIN_REQUIRED"));

    const request = new Request("http://localhost/api/cron/plaid-sync", {
      headers: { authorization: "Bearer test-secret" },
    });
    const response = await GET(request);

    const body = await response.json();
    expect(body.tokensFailed).toBe(1);
    expect(body.errors).toHaveLength(1);
  });
});
