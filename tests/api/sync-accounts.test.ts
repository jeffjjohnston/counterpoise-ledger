import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { plaidAccounts } from "@/db/schema";
import { GET, PUT } from "@/app/api/b/[bookId]/sync/tokens/[id]/accounts/route";
import {
  createAccount,
  createPlaidAccount,
  createPlaidToken,
  resetTestDatabase,
  setupTestDatabase,
} from "@/tests/helpers/db";
import { and, eq } from "drizzle-orm";

vi.mock("@/lib/api-auth", async () => {
  const { mockApiAuth } = await import("@/tests/helpers/db");
  return mockApiAuth();
});

describe("Sync token accounts API", () => {
  const originalEnv = {
    PLAID_CLIENT_ID: process.env.PLAID_CLIENT_ID,
    PLAID_SECRET: process.env.PLAID_SECRET,
    PLAID_ENV: process.env.PLAID_ENV,
  };

  beforeAll(async () => {
    await setupTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
    process.env.PLAID_CLIENT_ID = "client-id";
    process.env.PLAID_SECRET = "secret";
    process.env.PLAID_ENV = "sandbox";
    vi.restoreAllMocks();
  });

  it("refreshes Plaid accounts via /accounts/get and returns cached records", async () => {
    const token = await createPlaidToken({
      financialInstitution: "Chase",
      itemId: "item-123",
      accessToken: "access-token",
    });

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        accounts: [
          {
            account_id: "plaid-account-1",
            name: "Plaid Checking",
            official_name: "Plaid Personal Checking",
            mask: "0001",
            type: "depository",
            subtype: "checking",
          },
        ],
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(
      new Request(`http://localhost/api/sync/tokens/${token.id}/accounts?refresh=true`),
      { params: Promise.resolve({ bookId: "1", id: String(token.id) }) }
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toHaveLength(1);
    expect(payload[0].plaidAccountId).toBe("plaid-account-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls as unknown as [string, ...unknown[]][])[0][0]).toContain("https://sandbox.plaid.com/accounts/get");

    const cachedResponse = await GET(
      new Request(`http://localhost/api/sync/tokens/${token.id}/accounts?refresh=false`),
      { params: Promise.resolve({ bookId: "1", id: String(token.id) }) }
    );
    expect(cachedResponse.status).toBe(200);
    const cachedPayload = await cachedResponse.json();
    expect(cachedPayload).toHaveLength(1);
  });

  it("prunes stale plaid accounts during refresh", async () => {
    const token = await createPlaidToken({
      financialInstitution: "Chase",
      itemId: "item-prune",
      accessToken: "access-token",
    });

    await createPlaidAccount({
      tokenId: token.id,
      plaidAccountId: "keep-me",
      name: "Checking",
      type: "depository",
      subtype: "checking",
    });
    await createPlaidAccount({
      tokenId: token.id,
      plaidAccountId: "remove-me",
      name: "Savings",
      type: "depository",
      subtype: "savings",
    });

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        accounts: [
          {
            account_id: "keep-me",
            name: "Checking Updated",
            official_name: null,
            mask: "1111",
            type: "depository",
            subtype: "checking",
          },
        ],
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(
      new Request(`http://localhost/api/sync/tokens/${token.id}/accounts?refresh=true`),
      { params: Promise.resolve({ bookId: "1", id: String(token.id) }) }
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toHaveLength(1);
    expect(payload[0].plaidAccountId).toBe("keep-me");
    expect(payload[0].name).toBe("Checking Updated");
  });

  it("saves account assignments", async () => {
    const token = await createPlaidToken({
      financialInstitution: "Chase",
      itemId: "item-assign",
      accessToken: "access-token",
    });
    await createPlaidAccount({
      tokenId: token.id,
      plaidAccountId: "plaid-account-1",
      name: "Checking",
      type: "depository",
      subtype: "checking",
    });
    const checking = await createAccount({ name: "Checking", type: "asset" });

    const response = await PUT(
      new Request(`http://localhost/api/sync/tokens/${token.id}/accounts`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assignments: [
            {
              plaidAccountId: "plaid-account-1",
              counterpoiseAccountId: checking.id,
            },
          ],
        }),
      }),
      { params: Promise.resolve({ bookId: "1", id: String(token.id) }) }
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload[0].counterpoiseAccountId).toBe(checking.id);
  });

  it("enforces one-to-one counterpoise account mapping", async () => {
    const tokenA = await createPlaidToken({
      financialInstitution: "Bank A",
      itemId: "item-a",
      accessToken: "access-token-a",
    });
    const tokenB = await createPlaidToken({
      financialInstitution: "Bank B",
      itemId: "item-b",
      accessToken: "access-token-b",
    });

    const sharedAccount = await createAccount({ name: "Joint Checking", type: "asset" });

    await createPlaidAccount({
      tokenId: tokenA.id,
      plaidAccountId: "plaid-account-a",
      name: "A Checking",
      type: "depository",
      subtype: "checking",
      counterpoiseAccountId: sharedAccount.id,
    });
    await createPlaidAccount({
      tokenId: tokenB.id,
      plaidAccountId: "plaid-account-b",
      name: "B Checking",
      type: "depository",
      subtype: "checking",
    });

    const response = await PUT(
      new Request(`http://localhost/api/sync/tokens/${tokenB.id}/accounts`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assignments: [
            {
              plaidAccountId: "plaid-account-b",
              counterpoiseAccountId: sharedAccount.id,
            },
          ],
        }),
      }),
      { params: Promise.resolve({ bookId: "1", id: String(tokenB.id) }) }
    );

    expect(response.status).toBe(400);
  });

  it("returns Plaid API errors for refresh failures", async () => {
    const token = await createPlaidToken({
      financialInstitution: "Chase",
      itemId: "item-fail",
      accessToken: "access-token",
    });

    const fetchMock = vi.fn(async () => ({
      ok: false,
      json: async () => ({
        error_message: "invalid access token",
        error_code: "INVALID_ACCESS_TOKEN",
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(
      new Request(`http://localhost/api/sync/tokens/${token.id}/accounts?refresh=true`),
      { params: Promise.resolve({ bookId: "1", id: String(token.id) }) }
    );

    expect(response.status).toBe(502);
    const payload = await response.json();
    expect(payload.error).toContain("invalid access token");
  });

  it("rejects assignment payloads with unknown plaid account ids", async () => {
    const token = await createPlaidToken({
      financialInstitution: "Chase",
      itemId: "item-unknown",
      accessToken: "access-token",
    });
    const checking = await createAccount({ name: "Checking", type: "asset" });

    const response = await PUT(
      new Request(`http://localhost/api/sync/tokens/${token.id}/accounts`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assignments: [
            {
              plaidAccountId: "missing-plaid-id",
              counterpoiseAccountId: checking.id,
            },
          ],
        }),
      }),
      { params: Promise.resolve({ bookId: "1", id: String(token.id) }) }
    );

    expect(response.status).toBe(400);
  });

  it("persists assignment changes in the database", async () => {
    const token = await createPlaidToken({
      financialInstitution: "Chase",
      itemId: "item-persist",
      accessToken: "access-token",
    });
    await createPlaidAccount({
      tokenId: token.id,
      plaidAccountId: "plaid-account-1",
      name: "Checking",
      type: "depository",
      subtype: "checking",
    });
    const checking = await createAccount({ name: "Checking", type: "asset" });

    await PUT(
      new Request(`http://localhost/api/sync/tokens/${token.id}/accounts`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assignments: [
            {
              plaidAccountId: "plaid-account-1",
              counterpoiseAccountId: checking.id,
            },
          ],
        }),
      }),
      { params: Promise.resolve({ bookId: "1", id: String(token.id) }) }
    );

    const db = getDb();
    const rows = await db
      .select()
      .from(plaidAccounts)
      .where(
        and(
          eq(plaidAccounts.tokenId, token.id),
          eq(plaidAccounts.plaidAccountId, "plaid-account-1")
        )
      );

    expect(rows).toHaveLength(1);
    expect(rows[0].counterpoiseAccountId).toBe(checking.id);
  });

  afterAll(() => {
    process.env.PLAID_CLIENT_ID = originalEnv.PLAID_CLIENT_ID;
    process.env.PLAID_SECRET = originalEnv.PLAID_SECRET;
    process.env.PLAID_ENV = originalEnv.PLAID_ENV;
  });
});
