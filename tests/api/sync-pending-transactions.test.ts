import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/b/[bookId]/sync/pending-transactions/route";
import {
  createAccount,
  createPlaidAccount,
  createPlaidToken,
  createPlaidReconciliation,
  resetTestDatabase,
  setupTestDatabase,
} from "@/tests/helpers/db";

vi.mock("@/lib/api-auth", async () => {
  const { mockApiAuth } = await import("@/tests/helpers/db");
  return mockApiAuth();
});

describe("GET /api/b/[bookId]/sync/pending-transactions", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  async function makeRequest(query = "") {
    return GET(new Request(`http://localhost/api${query}`), {
      params: Promise.resolve({ bookId: "1" }),
    });
  }

  async function createLinkedPlaidAccount(
    accountName = "Checking",
    plaidAccountId = "plaid-acc-1"
  ) {
    const account = await createAccount({ name: accountName, type: "asset" });
    const token = await createPlaidToken({
      financialInstitution: "Chase",
      itemId: `item-${plaidAccountId}`,
      accessToken: `access-${plaidAccountId}`,
    });
    const plaidAccount = await createPlaidAccount({
      tokenId: token.id,
      plaidAccountId,
      name: `Chase ${accountName}`,
      type: "depository",
      subtype: "checking",
      counterpoiseAccountId: account.id,
    });
    return { account, plaidAccount };
  }

  it("returns an empty array when there are no pending rows", async () => {
    await createLinkedPlaidAccount();
    const response = await makeRequest();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });

  it("shapes a pending row as a display transaction", async () => {
    const { account, plaidAccount } = await createLinkedPlaidAccount();
    const recon = await createPlaidReconciliation({
      plaidAccountLinkId: plaidAccount.id,
      plaidTransactionId: "txn-1",
      date: "2026-07-10",
      authorizedDate: "2026-07-08",
      amountCents: 2500,
      name: "STARBUCKS #1234",
      merchantName: "Starbucks",
      categoryPrimary: "FOOD_AND_DRINK",
      resolutionStatus: "pending",
    });

    const response = await makeRequest();
    const [tx] = await response.json();

    expect(tx.id).toBe(-(1_000_000_000_000 + recon.id));
    expect(tx.isPlaidPending).toBe(true);
    // Authorized date wins over posted date
    expect(tx.date).toBe("2026-07-08");
    expect(tx.description).toBe("STARBUCKS #1234");
    expect(tx.payee.name).toBe("Starbucks");
    expect(tx.splits).toHaveLength(1);
    // Plaid positive amount = outflow = negative local split
    expect(tx.splits[0].amount).toBe(-2500);
    expect(tx.splits[0].accountId).toBe(account.id);
    expect(tx.splits[0].account.name).toBe("Checking");
    expect(tx.isReconciled).toBe(false);
    expect(tx.investmentSplits).toEqual([]);
    expect(tx.plaidCategory).toBe("Food And Drink");
  });

  it("falls back to the posted date and transaction name", async () => {
    const { plaidAccount } = await createLinkedPlaidAccount();
    await createPlaidReconciliation({
      plaidAccountLinkId: plaidAccount.id,
      plaidTransactionId: "txn-1",
      date: "2026-07-10",
      authorizedDate: null,
      amountCents: 2500,
      name: "ACH DEPOSIT",
      merchantName: null,
      resolutionStatus: "pending",
    });

    const response = await makeRequest();
    const [tx] = await response.json();
    expect(tx.date).toBe("2026-07-10");
    expect(tx.payee.name).toBe("ACH DEPOSIT");
  });

  it("excludes resolved rows, rows needing review, and unmapped accounts", async () => {
    const { plaidAccount } = await createLinkedPlaidAccount();
    await createPlaidReconciliation({
      plaidAccountLinkId: plaidAccount.id,
      plaidTransactionId: "txn-matched",
      date: "2026-07-10",
      amountCents: 1000,
      name: "Matched",
      resolutionStatus: "matched",
    });
    await createPlaidReconciliation({
      plaidAccountLinkId: plaidAccount.id,
      plaidTransactionId: "txn-review",
      date: "2026-07-10",
      amountCents: 1000,
      name: "Needs Review",
      resolutionStatus: "pending",
      reviewReason: "plaid_modified",
    });

    const token = await createPlaidToken({
      financialInstitution: "Chase",
      itemId: "item-unmapped",
      accessToken: "access-unmapped",
    });
    const unmapped = await createPlaidAccount({
      tokenId: token.id,
      plaidAccountId: "plaid-unmapped",
      name: "Unmapped",
      type: "depository",
      counterpoiseAccountId: null,
    });
    await createPlaidReconciliation({
      plaidAccountLinkId: unmapped.id,
      plaidTransactionId: "txn-unmapped",
      date: "2026-07-10",
      amountCents: 1000,
      name: "Unmapped",
      resolutionStatus: "pending",
    });

    const response = await makeRequest();
    expect(await response.json()).toEqual([]);
  });

  it("filters by accountId", async () => {
    const checking = await createLinkedPlaidAccount("Checking", "plaid-checking");
    const savings = await createLinkedPlaidAccount("Savings", "plaid-savings");

    await createPlaidReconciliation({
      plaidAccountLinkId: checking.plaidAccount.id,
      plaidTransactionId: "txn-checking",
      date: "2026-07-10",
      amountCents: 1000,
      name: "On Checking",
      resolutionStatus: "pending",
    });
    await createPlaidReconciliation({
      plaidAccountLinkId: savings.plaidAccount.id,
      plaidTransactionId: "txn-savings",
      date: "2026-07-10",
      amountCents: 2000,
      name: "On Savings",
      resolutionStatus: "pending",
    });

    const response = await makeRequest(`?accountId=${savings.account.id}`);
    const payload = await response.json();
    expect(payload).toHaveLength(1);
    expect(payload[0].description).toBe("On Savings");
  });

  it("rejects a non-numeric accountId", async () => {
    await createLinkedPlaidAccount();
    const response = await makeRequest("?accountId=abc");
    expect(response.status).toBe(400);
  });

  it("sorts by display date descending", async () => {
    const { plaidAccount } = await createLinkedPlaidAccount();
    await createPlaidReconciliation({
      plaidAccountLinkId: plaidAccount.id,
      plaidTransactionId: "txn-older",
      date: "2026-07-05",
      amountCents: 1000,
      name: "Older",
      resolutionStatus: "pending",
    });
    // Posted later but authorized earlier than the row above appears below it
    await createPlaidReconciliation({
      plaidAccountLinkId: plaidAccount.id,
      plaidTransactionId: "txn-newer",
      date: "2026-07-12",
      authorizedDate: "2026-07-09",
      amountCents: 2000,
      name: "Newer",
      resolutionStatus: "pending",
    });

    const response = await makeRequest();
    const payload = await response.json();
    expect(payload.map((tx: { description: string }) => tx.description)).toEqual([
      "Newer",
      "Older",
    ]);
  });
});
