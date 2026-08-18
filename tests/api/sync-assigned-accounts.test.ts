import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/b/[bookId]/sync/assigned-accounts/route";
import {
  createAccount,
  createPlaidAccount,
  createPlaidToken,
  resetTestDatabase,
  setupTestDatabase,
} from "@/tests/helpers/db";

vi.mock("@/lib/api-auth", async () => {
  const { mockApiAuth } = await import("@/tests/helpers/db");
  return mockApiAuth();
});

describe("GET /api/sync/assigned-accounts", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("returns only mapped rows with institution and account names", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const savings = await createAccount({ name: "Savings", type: "asset" });

    const chaseToken = await createPlaidToken({
      financialInstitution: "Chase",
      itemId: "item-chase",
      accessToken: "access-token-chase",
    });
    const bofaToken = await createPlaidToken({
      financialInstitution: "Bank of America",
      itemId: "item-bofa",
      accessToken: "access-token-bofa",
    });

    await createPlaidAccount({
      tokenId: chaseToken.id,
      plaidAccountId: "plaid-chase-checking",
      name: "Chase Checking",
      type: "depository",
      subtype: "checking",
      counterpoiseAccountId: checking.id,
    });
    await createPlaidAccount({
      tokenId: bofaToken.id,
      plaidAccountId: "plaid-bofa-savings",
      name: "BoA Savings",
      type: "depository",
      subtype: "savings",
      counterpoiseAccountId: savings.id,
    });
    await createPlaidAccount({
      tokenId: chaseToken.id,
      plaidAccountId: "plaid-unmapped",
      name: "Unmapped Account",
      type: "depository",
      subtype: "savings",
      counterpoiseAccountId: null,
    });

    const response = await GET(new Request("http://localhost"), { params: Promise.resolve({ bookId: "1" }) });
    expect(response.status).toBe(200);

    const payload = await response.json();
    expect(payload).toHaveLength(2);
    expect(
      payload.map((row: { financialInstitution: string }) => row.financialInstitution)
    ).toEqual(["Bank of America", "Chase"]);

    expect(payload[0].counterpoiseAccountName).toBe("Savings");
    expect(payload[1].counterpoiseAccountName).toBe("Checking");
    expect(typeof payload[0].plaidLinkId).toBe("number");
    expect(typeof payload[0].tokenId).toBe("number");
    expect(payload[0]).toHaveProperty("lastSyncedAt");
    expect(payload[0]).toHaveProperty("lastError");
    expect(payload[0]).toHaveProperty("pendingCount");
    expect(payload[0]).toHaveProperty("reviewCount");
    expect(
      payload.find((row: { plaidAccountId: string }) => row.plaidAccountId === "plaid-unmapped")
    ).toBeUndefined();
  });
});
