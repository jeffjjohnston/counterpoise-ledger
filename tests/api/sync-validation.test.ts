import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as POSTTokens } from "@/app/api/b/[bookId]/sync/tokens/route";
import { PUT as PUTToken } from "@/app/api/b/[bookId]/sync/tokens/[id]/route";
import { PUT as PUTAccounts } from "@/app/api/b/[bookId]/sync/tokens/[id]/accounts/route";
import {
  GET as GETReconcile,
  POST as POSTReconcile,
} from "@/app/api/b/[bookId]/sync/accounts/[id]/reconcile/route";
import { GET as GETPendingTransactions } from "@/app/api/b/[bookId]/sync/pending-transactions/route";
import {
  createAccount,
  createPlaidAccount,
  createPlaidReconciliation,
  createPlaidToken,
  resetTestDatabase,
  setupTestDatabase,
} from "@/tests/helpers/db";

vi.mock("@/lib/api-auth", async () => {
  const { mockApiAuth } = await import("@/tests/helpers/db");
  return mockApiAuth();
});

function rp() {
  return { params: Promise.resolve({ bookId: "1" }) };
}

// Regression guards for the createTokenSchema / updateTokenSchema /
// assignAccountsSchema / reconcileSchema / pendingTransactionsQuery wiring
// across all five sync routes. If a future edit hands a route raw,
// unparsed input again, these are the tests that catch it.

describe("POST /api/b/[bookId]/sync/tokens schema wiring", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("rejects a missing accessToken with the ported combined message", async () => {
    const res = await POSTTokens(
      new Request("http://localhost/api/b/1/sync/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          financialInstitution: "Chase",
          itemId: "item-123",
        }),
      }),
      rp()
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(
      "financialInstitution, itemId, and accessToken are required"
    );
  });
});

describe("PUT /api/b/[bookId]/sync/tokens/[id] schema wiring", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("rejects a missing itemId with the ported combined message", async () => {
    const token = await createPlaidToken({
      financialInstitution: "Chase",
      itemId: "item-existing",
      accessToken: "access-token",
    });

    const res = await PUTToken(
      new Request(`http://localhost/api/b/1/sync/tokens/${token.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ financialInstitution: "New Bank" }),
      }),
      { params: Promise.resolve({ bookId: "1", id: String(token.id) }) }
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("financialInstitution and itemId are required");
  });
});

describe("PUT /api/b/[bookId]/sync/tokens/[id]/accounts schema wiring", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("rejects a non-array assignments with the ported message, not a silent write", async () => {
    const token = await createPlaidToken({
      financialInstitution: "Chase",
      itemId: "item-assign",
      accessToken: "access-token",
    });

    const res = await PUTAccounts(
      new Request(`http://localhost/api/b/1/sync/tokens/${token.id}/accounts`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignments: "not-an-array" }),
      }),
      { params: Promise.resolve({ bookId: "1", id: String(token.id) }) }
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("assignments must be an array");
  });

  it("rejects a duplicate plaidAccountId with the ported array-level message", async () => {
    const token = await createPlaidToken({
      financialInstitution: "Chase",
      itemId: "item-dup",
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

    const res = await PUTAccounts(
      new Request(`http://localhost/api/b/1/sync/tokens/${token.id}/accounts`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assignments: [
            { plaidAccountId: "plaid-account-1", counterpoiseAccountId: checking.id },
            { plaidAccountId: "plaid-account-1", counterpoiseAccountId: null },
          ],
        }),
      }),
      { params: Promise.resolve({ bookId: "1", id: String(token.id) }) }
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Duplicate plaidAccountId in assignments");
  });
});

describe("POST /api/b/[bookId]/sync/accounts/[id]/reconcile schema wiring", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("rejects an unknown action with the ported message, not a silent no-op", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const token = await createPlaidToken({
      financialInstitution: "Chase",
      itemId: "item-recon",
      accessToken: "access-token",
    });
    const link = await createPlaidAccount({
      tokenId: token.id,
      plaidAccountId: "plaid-checking",
      name: "Plaid Checking",
      type: "depository",
      subtype: "checking",
      counterpoiseAccountId: checking.id,
    });
    const recon = await createPlaidReconciliation({
      plaidAccountLinkId: link.id,
      plaidTransactionId: "txn-1",
      date: "2026-02-08",
      amountCents: 1500,
      name: "Coffee",
    });

    const res = await POSTReconcile(
      new Request(`http://localhost/api/b/1/sync/accounts/${link.id}/reconcile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reconciliationId: recon.id, action: "bogus" }),
      }),
      { params: Promise.resolve({ bookId: "1", id: String(link.id) }) }
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid action");
  });

  it("rejects a match action missing transactionId with the ported action-specific message", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const token = await createPlaidToken({
      financialInstitution: "Chase",
      itemId: "item-recon-2",
      accessToken: "access-token",
    });
    const link = await createPlaidAccount({
      tokenId: token.id,
      plaidAccountId: "plaid-checking-2",
      name: "Plaid Checking",
      type: "depository",
      subtype: "checking",
      counterpoiseAccountId: checking.id,
    });
    const recon = await createPlaidReconciliation({
      plaidAccountLinkId: link.id,
      plaidTransactionId: "txn-2",
      date: "2026-02-08",
      amountCents: 1500,
      name: "Coffee",
    });

    const res = await POSTReconcile(
      new Request(`http://localhost/api/b/1/sync/accounts/${link.id}/reconcile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reconciliationId: recon.id, action: "match" }),
      }),
      { params: Promise.resolve({ bookId: "1", id: String(link.id) }) }
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("transactionId is required for match");
  });
});

describe("GET /api/b/[bookId]/sync/pending-transactions schema wiring", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("rejects a non-numeric accountId with the ported message", async () => {
    const res = await GETPendingTransactions(
      new Request("http://localhost/api/b/1/sync/pending-transactions?accountId=abc"),
      rp()
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid accountId");
  });
});

// Fix round 1: the brief's header counts 4 query params for this cluster;
// only pending-transactions's accountId was wired initially. limit/offset
// on the reconcile GET route were still hand-parsed with a silent-fallback
// default (never 400s) — these tests pin that the schema wiring preserves
// exactly that behavior rather than turning a route the reconcile UI polls
// into one that can newly 400 on a malformed query string.
describe("GET /api/b/[bookId]/sync/accounts/[id]/reconcile query-param wiring", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });
  beforeEach(async () => {
    await resetTestDatabase();
  });

  async function makeLink() {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const token = await createPlaidToken({
      financialInstitution: "Chase",
      itemId: "item-limit-offset",
      accessToken: "access-token",
    });
    return createPlaidAccount({
      tokenId: token.id,
      plaidAccountId: "plaid-checking-limit",
      name: "Plaid Checking",
      type: "depository",
      subtype: "checking",
      counterpoiseAccountId: checking.id,
    });
  }

  it("defaults to limit=25, offset=0 when both are absent", async () => {
    const link = await makeLink();

    const res = await GETReconcile(
      new Request(`http://localhost/api/b/1/sync/accounts/${link.id}/reconcile`),
      { params: Promise.resolve({ bookId: "1", id: String(link.id) }) }
    );

    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.limit).toBe(25);
    expect(payload.offset).toBe(0);
  });

  it("honors valid limit and offset", async () => {
    const link = await makeLink();

    const res = await GETReconcile(
      new Request(
        `http://localhost/api/b/1/sync/accounts/${link.id}/reconcile?limit=5&offset=2`
      ),
      { params: Promise.resolve({ bookId: "1", id: String(link.id) }) }
    );

    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.limit).toBe(5);
    expect(payload.offset).toBe(2);
  });

  it("falls back to the default limit/offset for malformed values instead of 400ing", async () => {
    const link = await makeLink();

    const res = await GETReconcile(
      new Request(
        `http://localhost/api/b/1/sync/accounts/${link.id}/reconcile?limit=not-a-number&offset=-5`
      ),
      { params: Promise.resolve({ bookId: "1", id: String(link.id) }) }
    );

    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.limit).toBe(25);
    expect(payload.offset).toBe(0);
  });
});
