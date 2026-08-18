import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { plaidAccounts } from "@/db/schema";
import { GET, POST } from "@/app/api/b/[bookId]/sync/tokens/route";
import { DELETE, PUT } from "@/app/api/b/[bookId]/sync/tokens/[id]/route";
import {
  createPlaidAccount,
  createPlaidToken,
  resetTestDatabase,
  setupTestDatabase,
} from "@/tests/helpers/db";
import { eq } from "drizzle-orm";

vi.mock("@/lib/api-auth", async () => {
  const { mockApiAuth } = await import("@/tests/helpers/db");
  return mockApiAuth();
});

describe("Sync tokens API", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("creates and lists tokens with masked access tokens", async () => {
    const response = await POST(
      new Request("http://localhost/api/sync/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          financialInstitution: "Chase",
          itemId: "item-123",
          accessToken: "access-sandbox-123456789",
        }),
      }),
      { params: Promise.resolve({ bookId: "1" }) }
    );

    expect(response.status).toBe(200);
    const created = await response.json();
    expect(created.itemId).toBe("item-123");
    expect(created.accessTokenMasked).toContain("*");
    expect(created.accessTokenMasked).not.toContain("sandbox-123456789");

    const listResponse = await GET(new Request("http://localhost"), { params: Promise.resolve({ bookId: "1" }) });
    expect(listResponse.status).toBe(200);
    const listPayload = await listResponse.json();
    expect(listPayload).toHaveLength(1);
    expect(listPayload[0].financialInstitution).toBe("Chase");
    expect(listPayload[0].accessTokenMasked).toContain("*");
  });

  it("rejects missing required fields", async () => {
    const response = await POST(
      new Request("http://localhost/api/sync/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          financialInstitution: "",
          itemId: "item-123",
          accessToken: "token",
        }),
      }),
      { params: Promise.resolve({ bookId: "1" }) }
    );

    expect(response.status).toBe(400);
  });

  it("rejects duplicate item ids", async () => {
    await createPlaidToken({
      financialInstitution: "Chase",
      itemId: "item-123",
      accessToken: "access-token-1",
    });

    const response = await POST(
      new Request("http://localhost/api/sync/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          financialInstitution: "Chase",
          itemId: "item-123",
          accessToken: "access-token-2",
        }),
      }),
      { params: Promise.resolve({ bookId: "1" }) }
    );

    expect(response.status).toBe(409);
  });

  it("deletes tokens and cascades related plaid accounts", async () => {
    const token = await createPlaidToken({
      financialInstitution: "AmEx",
      itemId: "item-456",
      accessToken: "access-token",
    });
    await createPlaidAccount({
      tokenId: token.id,
      plaidAccountId: "plaid-account-1",
      name: "Checking",
      type: "depository",
      subtype: "checking",
    });

    const response = await DELETE(
      new Request(`http://localhost/api/sync/tokens/${token.id}`, {
        method: "DELETE",
      }),
      { params: Promise.resolve({ bookId: "1", id: String(token.id) }) }
    );

    expect(response.status).toBe(200);

    const db = getDb();
    const remainingAccounts = await db
      .select()
      .from(plaidAccounts)
      .where(eq(plaidAccounts.tokenId, token.id));
    expect(remainingAccounts).toHaveLength(0);
  });

  it("updates token fields and optionally replaces access token", async () => {
    const token = await createPlaidToken({
      financialInstitution: "Old Bank",
      itemId: "item-old",
      accessToken: "old-access-token",
    });

    const response = await PUT(
      new Request(`http://localhost/api/sync/tokens/${token.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          financialInstitution: "New Bank",
          itemId: "item-new",
          accessToken: "new-access-token",
        }),
      }),
      { params: Promise.resolve({ bookId: "1", id: String(token.id) }) }
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.financialInstitution).toBe("New Bank");
    expect(payload.itemId).toBe("item-new");
    expect(payload.accessTokenMasked).toContain("*");
  });

  it("rejects duplicate item ids on update", async () => {
    const tokenA = await createPlaidToken({
      financialInstitution: "A",
      itemId: "item-a",
      accessToken: "token-a",
    });
    await createPlaidToken({
      financialInstitution: "B",
      itemId: "item-b",
      accessToken: "token-b",
    });

    const response = await PUT(
      new Request(`http://localhost/api/sync/tokens/${tokenA.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          financialInstitution: "A",
          itemId: "item-b",
          accessToken: "",
        }),
      }),
      { params: Promise.resolve({ bookId: "1", id: String(tokenA.id) }) }
    );

    expect(response.status).toBe(409);
  });
});
