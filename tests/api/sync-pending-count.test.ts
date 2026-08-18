import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/b/[bookId]/sync/pending-count/route";
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

describe("GET /api/b/[bookId]/sync/pending-count", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  async function makeRequest() {
    return GET(new Request("http://localhost"), {
      params: Promise.resolve({ bookId: "1" }),
    });
  }

  it("returns count 0 when there are no reconciliation records", async () => {
    const response = await makeRequest();
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toEqual({ count: 0 });
  });

  it("counts pending records with no reviewReason", async () => {
    const account = await createAccount({ name: "Checking", type: "asset" });
    const token = await createPlaidToken({
      financialInstitution: "Chase",
      itemId: "item-1",
      accessToken: "access-1",
    });
    const plaidAccount = await createPlaidAccount({
      tokenId: token.id,
      plaidAccountId: "plaid-acc-1",
      name: "Chase Checking",
      type: "depository",
      subtype: "checking",
      counterpoiseAccountId: account.id,
    });

    await createPlaidReconciliation({
      plaidAccountLinkId: plaidAccount.id,
      plaidTransactionId: "txn-1",
      date: "2025-01-01",
      amountCents: 5000,
      name: "Coffee Shop",
      resolutionStatus: "pending",
      reviewReason: null,
    });

    const response = await makeRequest();
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toEqual({ count: 1 });
  });

  it("counts records with a reviewReason regardless of resolutionStatus", async () => {
    const account = await createAccount({ name: "Checking", type: "asset" });
    const token = await createPlaidToken({
      financialInstitution: "Chase",
      itemId: "item-1",
      accessToken: "access-1",
    });
    const plaidAccount = await createPlaidAccount({
      tokenId: token.id,
      plaidAccountId: "plaid-acc-1",
      name: "Chase Checking",
      type: "depository",
      subtype: "checking",
      counterpoiseAccountId: account.id,
    });

    await createPlaidReconciliation({
      plaidAccountLinkId: plaidAccount.id,
      plaidTransactionId: "txn-review",
      date: "2025-01-02",
      amountCents: 1000,
      name: "Modified Transaction",
      resolutionStatus: "matched",
      reviewReason: "plaid_modified",
    });

    const response = await makeRequest();
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toEqual({ count: 1 });
  });

  it("does not count resolved records with no reviewReason", async () => {
    const account = await createAccount({ name: "Checking", type: "asset" });
    const token = await createPlaidToken({
      financialInstitution: "Chase",
      itemId: "item-1",
      accessToken: "access-1",
    });
    const plaidAccount = await createPlaidAccount({
      tokenId: token.id,
      plaidAccountId: "plaid-acc-1",
      name: "Chase Checking",
      type: "depository",
      subtype: "checking",
      counterpoiseAccountId: account.id,
    });

    await createPlaidReconciliation({
      plaidAccountLinkId: plaidAccount.id,
      plaidTransactionId: "txn-matched",
      date: "2025-01-03",
      amountCents: 2000,
      name: "Already Matched",
      resolutionStatus: "matched",
      reviewReason: null,
    });

    const response = await makeRequest();
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toEqual({ count: 0 });
  });

  it("does not count records for unmapped plaid accounts", async () => {
    const token = await createPlaidToken({
      financialInstitution: "Chase",
      itemId: "item-1",
      accessToken: "access-1",
    });
    const unmappedPlaidAccount = await createPlaidAccount({
      tokenId: token.id,
      plaidAccountId: "plaid-unmapped",
      name: "Unmapped Account",
      type: "depository",
      subtype: "checking",
      counterpoiseAccountId: null,
    });

    await createPlaidReconciliation({
      plaidAccountLinkId: unmappedPlaidAccount.id,
      plaidTransactionId: "txn-unmapped",
      date: "2025-01-04",
      amountCents: 3000,
      name: "Unmapped Transaction",
      resolutionStatus: "pending",
      reviewReason: null,
    });

    const response = await makeRequest();
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toEqual({ count: 0 });
  });

  it("returns correct total count across multiple accounts and record types", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const savings = await createAccount({ name: "Savings", type: "asset" });
    const token = await createPlaidToken({
      financialInstitution: "Chase",
      itemId: "item-1",
      accessToken: "access-1",
    });

    const checkingPlaid = await createPlaidAccount({
      tokenId: token.id,
      plaidAccountId: "plaid-checking",
      name: "Chase Checking",
      type: "depository",
      subtype: "checking",
      counterpoiseAccountId: checking.id,
    });
    const savingsPlaid = await createPlaidAccount({
      tokenId: token.id,
      plaidAccountId: "plaid-savings",
      name: "Chase Savings",
      type: "depository",
      subtype: "savings",
      counterpoiseAccountId: savings.id,
    });

    // Should count: pending with no review reason
    await createPlaidReconciliation({
      plaidAccountLinkId: checkingPlaid.id,
      plaidTransactionId: "txn-1",
      date: "2025-01-01",
      amountCents: 1000,
      name: "Pending 1",
      resolutionStatus: "pending",
      reviewReason: null,
    });
    // Should count: has reviewReason
    await createPlaidReconciliation({
      plaidAccountLinkId: checkingPlaid.id,
      plaidTransactionId: "txn-2",
      date: "2025-01-02",
      amountCents: 2000,
      name: "Review 1",
      resolutionStatus: "matched",
      reviewReason: "plaid_modified",
    });
    // Should count: pending on savings account
    await createPlaidReconciliation({
      plaidAccountLinkId: savingsPlaid.id,
      plaidTransactionId: "txn-3",
      date: "2025-01-03",
      amountCents: 3000,
      name: "Pending 2",
      resolutionStatus: "pending",
      reviewReason: null,
    });
    // Should NOT count: matched with no review reason
    await createPlaidReconciliation({
      plaidAccountLinkId: savingsPlaid.id,
      plaidTransactionId: "txn-4",
      date: "2025-01-04",
      amountCents: 4000,
      name: "Already Resolved",
      resolutionStatus: "matched",
      reviewReason: null,
    });

    const response = await makeRequest();
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toEqual({ count: 3 });
  });
});
