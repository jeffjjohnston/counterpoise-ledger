import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createAccount,
  createPlaidAccount,
  createPlaidReconciliation,
  createPlaidToken,
  resetTestDatabase,
  setupTestDatabase,
} from "../helpers/db-utils";
import { sessionHttpClient, startHttpTestServer } from "../helpers/http-parity";

describe("pending sync count HTTP parity", () => {
  let baseUrl: string;
  let stop: () => Promise<void>;
  let client: Awaited<ReturnType<typeof sessionHttpClient>>;

  beforeAll(async () => {
    await setupTestDatabase();
    ({ baseUrl, stop } = await startHttpTestServer());
  }, 120_000);

  beforeEach(async () => {
    await resetTestDatabase();
    client = await sessionHttpClient(baseUrl);
  });

  afterAll(async () => { await stop?.(); });

  it("counts only actionable rows on mapped accounts", async () => {
    const account = await createAccount({ name: "Checking", type: "asset" });
    const token = await createPlaidToken({ financialInstitution: "Bank", itemId: "item-1", accessToken: "access-1" });
    const mapped = await createPlaidAccount({
      tokenId: token.id, plaidAccountId: "mapped", name: "Mapped", type: "depository",
      subtype: "checking", counterpoiseAccountId: account.id,
    });
    const unmapped = await createPlaidAccount({
      tokenId: token.id, plaidAccountId: "unmapped", name: "Unmapped", type: "depository",
      subtype: "checking", counterpoiseAccountId: null,
    });
    for (const [link, status, review, id] of [
      [mapped.id, "pending", null, "pending"],
      [mapped.id, "matched", "plaid_modified", "review"],
      [mapped.id, "matched", null, "resolved"],
      [unmapped.id, "pending", null, "unmapped"],
    ] as const) {
      await createPlaidReconciliation({
        plaidAccountLinkId: link, plaidTransactionId: id, date: "2025-01-01",
        amountCents: 100, name: id, resolutionStatus: status, reviewReason: review,
      });
    }
    const response = await client.request("/api/b/1/sync/pending-count");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ count: 2 });
  });

  it("enforces read membership and rejects invalid book IDs", async () => {
    for (const [path, status, body] of [
      ["/api/b/999999/sync/pending-count", 404, { error: "Book not found" }],
      ["/api/b/invalid/sync/pending-count", 400, { error: "Invalid book ID" }],
    ] as const) {
      const response = await client.request(path);
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual(body);
    }
    expect((await client.anonymous("/api/b/1/sync/pending-count")).status).toBe(401);
  });
});
