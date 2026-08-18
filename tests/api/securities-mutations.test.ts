import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as getSecurities, POST as postSecurity } from "@/app/api/b/[bookId]/securities/route";
import {
  GET as getSecurity,
  DELETE as deleteSecurity,
} from "@/app/api/b/[bookId]/securities/[id]/route";
import { GET as getSecuritySplits } from "@/app/api/b/[bookId]/securities/[id]/splits/route";
import {
  PUT as putSecurityPrice,
  DELETE as deleteSecurityPrice,
} from "@/app/api/b/[bookId]/securities/[id]/prices/[date]/route";
import { GET as getSecurityDetail } from "@/app/api/b/[bookId]/securities/[id]/detail/route";
import {
  createAccount,
  createInvestmentSplit,
  createSecurity,
  createSecurityPrice,
  createTransactionWithSplits,
  resetTestDatabase,
  setupTestDatabase,
} from "@/tests/helpers/db";
import { db } from "@/tests/helpers/db-utils";
import { rebuildLots } from "@/lib/lots-db";
import { getPositions } from "@/lib/investments";
import { createTransaction } from "@/lib/transactions";

vi.mock("@/lib/api-auth", async () => {
  const { mockApiAuth } = await import("@/tests/helpers/db");
  return mockApiAuth();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rpBook() {
  return { params: Promise.resolve({ bookId: "1" }) };
}
function rpId(id: string | number) {
  return { params: Promise.resolve({ bookId: "1", id: String(id) }) };
}
function rpDate(id: string | number, date: string) {
  return { params: Promise.resolve({ bookId: "1", id: String(id), date }) };
}

function postBody(url: string, body: object) {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
function putBody(url: string, body: object) {
  return new Request(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// POST /api/b/[bookId]/securities
// ---------------------------------------------------------------------------

describe("POST /api/b/[bookId]/securities", () => {
  beforeAll(async () => { await setupTestDatabase(); });
  beforeEach(async () => { await resetTestDatabase(); });

  it("creates a security and returns it", async () => {
    const res = await postSecurity(
      postBody("http://localhost/api/securities", {
        name: "Acme Corp",
        symbol: "ACME",
        securityType: "stock",
      }),
      rpBook()
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBeDefined();
    expect(body.name).toBe("Acme Corp");
    expect(body.symbol).toBe("ACME");
    expect(body.securityType).toBe("stock");
    expect(body.fetchPrices).toBe(true); // default
  });

  it("respects the fetchPrices flag when provided", async () => {
    const res = await postSecurity(
      postBody("http://localhost/api/securities", {
        name: "Index Fund",
        symbol: "IXYZ",
        securityType: "etf",
        fetchPrices: false,
      }),
      rpBook()
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.fetchPrices).toBe(false);
  });

  it("stores a fixed price and turns off price fetching", async () => {
    // A fixed-price security has no feed, so leaving fetchPrices on would queue
    // a doomed Tiingo call every morning. The two settings cannot disagree.
    const res = await postSecurity(
      postBody("http://localhost/api/securities", {
        name: "Vanguard Federal Money Market",
        symbol: "VMFXX",
        securityType: "mutual_fund",
        fixedPriceMicros: 1_000_000,
      }),
      rpBook()
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.fixedPriceMicros).toBe(1_000_000);
    expect(body.fetchPrices).toBe(false);
  });

  it("returns 400 when fixedPriceMicros is zero", async () => {
    // Zero would value every share of the position at nothing, silently.
    const res = await postSecurity(
      postBody("http://localhost/api/securities", {
        name: "Broken Fund",
        symbol: "BRKN",
        securityType: "mutual_fund",
        fixedPriceMicros: 0,
      }),
      rpBook()
    );

    expect(res.status).toBe(400);
  });

  it("returns 400 when required fields are missing", async () => {
    const res = await postSecurity(
      postBody("http://localhost/api/securities", { name: "Acme" }),
      rpBook()
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("returns 400 when fetchPrices is not a boolean", async () => {
    const res = await postSecurity(
      postBody("http://localhost/api/securities", {
        name: "Acme Corp",
        symbol: "ACME",
        securityType: "stock",
        fetchPrices: "yes",
      }),
      rpBook()
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("returns 409 when a security with the same symbol already exists (case-insensitive)", async () => {
    // First insert succeeds
    const first = await postSecurity(
      postBody("http://localhost/api/securities", {
        name: "Vanguard Total Stock",
        symbol: "VTI",
        securityType: "etf",
      }),
      rpBook()
    );
    expect(first.status).toBe(200);

    // Second insert with the same symbol (different case) returns 409
    const dup = await postSecurity(
      postBody("http://localhost/api/securities", {
        name: "Vanguard Total Stock Market",
        symbol: "vti",
        securityType: "etf",
      }),
      rpBook()
    );

    expect(dup.status).toBe(409);
    const body = await dup.json();
    expect(body.error).toMatch(/already exists/i);
  });
});

// ---------------------------------------------------------------------------
// GET /api/b/[bookId]/securities/[id]
// ---------------------------------------------------------------------------

describe("GET /api/b/[bookId]/securities/[id]", () => {
  beforeAll(async () => { await setupTestDatabase(); });
  beforeEach(async () => { await resetTestDatabase(); });

  it("returns the security by id", async () => {
    const security = await createSecurity({
      name: "Acme Corp",
      symbol: "ACME",
      securityType: "stock",
    });

    const res = await getSecurity(
      new Request(`http://localhost/api/securities/${security.id}`),
      rpId(security.id)
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(security.id);
    expect(body.symbol).toBe("ACME");
  });

  it("returns 404 for an unknown security id", async () => {
    const res = await getSecurity(
      new Request("http://localhost/api/securities/9999"),
      rpId(9999)
    );

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/b/[bookId]/securities/[id]
// ---------------------------------------------------------------------------

describe("DELETE /api/b/[bookId]/securities/[id]", () => {
  beforeAll(async () => { await setupTestDatabase(); });
  beforeEach(async () => { await resetTestDatabase(); });

  it("deletes the security and returns success", async () => {
    const security = await createSecurity({
      name: "Acme Corp",
      symbol: "ACME",
      securityType: "stock",
    });

    const res = await deleteSecurity(
      new Request(`http://localhost/api/securities/${security.id}`, {
        method: "DELETE",
      }),
      rpId(security.id)
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it("returns 404 for an unknown security id", async () => {
    const res = await deleteSecurity(
      new Request("http://localhost/api/securities/9999", { method: "DELETE" }),
      rpId(9999)
    );

    expect(res.status).toBe(404);
  });

  it("returns 400 and keeps the security when investment splits reference it", async () => {
    const investment = await createAccount({
      name: "Brokerage",
      type: "asset",
      subtype: "investment",
    });
    const cash = await createAccount({
      name: "Brokerage Cash",
      type: "asset",
      subtype: "investment",
      isInvestmentCash: true,
    });
    const security = await createSecurity({
      name: "Acme Corp",
      symbol: "ACME",
      securityType: "stock",
    });

    const transaction = await createTransactionWithSplits({
      date: "2025-01-10",
      description: "Buy ACME",
      splits: [
        { accountId: investment.id, amount: 100000 },
        { accountId: cash.id, amount: -100000 },
      ],
    });
    await createInvestmentSplit({
      transactionId: transaction.id,
      accountId: investment.id,
      securityId: security.id,
      action: "buy",
      sharesMicros: 10_000_000,
      priceMicros: 10_000_000,
    });

    const res = await deleteSecurity(
      new Request(`http://localhost/api/securities/${security.id}`, {
        method: "DELETE",
      }),
      rpId(security.id)
    );

    expect(res.status).toBe(400);

    const stillThere = await getSecurity(
      new Request(`http://localhost/api/securities/${security.id}`),
      rpId(security.id)
    );
    expect(stillThere.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// GET /api/b/[bookId]/securities/[id]/splits
// ---------------------------------------------------------------------------

describe("GET /api/b/[bookId]/securities/[id]/splits", () => {
  beforeAll(async () => { await setupTestDatabase(); });
  beforeEach(async () => { await resetTestDatabase(); });

  it("returns empty results for a security with no investment splits", async () => {
    const security = await createSecurity({
      name: "Acme Corp",
      symbol: "ACME",
      securityType: "stock",
    });

    const res = await getSecuritySplits(
      new Request(`http://localhost/api/securities/${security.id}/splits`),
      rpId(security.id)
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.splits).toEqual([]);
    expect(body.totalCount).toBe(0);
    expect(body.hasMore).toBe(false);
  });

  it("returns investment splits with transaction info, newest first", async () => {
    const investment = await createAccount({
      name: "Brokerage",
      type: "asset",
      subtype: "investment",
    });
    const cash = await createAccount({
      name: "Brokerage Cash",
      type: "asset",
      subtype: "cash",
      parentId: investment.id,
      isInvestmentCash: true,
    });
    const security = await createSecurity({
      name: "Acme Corp",
      symbol: "ACME",
      securityType: "stock",
    });

    const olderTx = await createTransactionWithSplits({
      date: "2025-01-01",
      description: "First buy",
      splits: [
        { accountId: investment.id, amount: 10000 },
        { accountId: cash.id, amount: -10000 },
      ],
    });
    await createInvestmentSplit({
      transactionId: olderTx.id,
      securityId: security.id,
      accountId: investment.id,
      action: "buy",
      sharesMicros: 5_000_000,
      priceMicros: 2_000_000,
    });

    const newerTx = await createTransactionWithSplits({
      date: "2025-02-01",
      description: "Second buy",
      splits: [
        { accountId: investment.id, amount: 20000 },
        { accountId: cash.id, amount: -20000 },
      ],
    });
    await createInvestmentSplit({
      transactionId: newerTx.id,
      securityId: security.id,
      accountId: investment.id,
      action: "buy",
      sharesMicros: 10_000_000,
      priceMicros: 2_000_000,
    });

    const res = await getSecuritySplits(
      new Request(`http://localhost/api/securities/${security.id}/splits`),
      rpId(security.id)
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.splits).toHaveLength(2);
    expect(body.totalCount).toBe(2);
    // Newest first
    expect(body.splits[0].transactionDate).toBe("2025-02-01");
    expect(body.splits[1].transactionDate).toBe("2025-01-01");
  });

  it("includes cashAmountCents for dividend splits", async () => {
    const investment = await createAccount({
      name: "Brokerage",
      type: "asset",
      subtype: "investment",
    });
    const cash = await createAccount({
      name: "Brokerage Cash",
      type: "asset",
      subtype: "cash",
      parentId: investment.id,
      isInvestmentCash: true,
    });
    const dividendIncome = await createAccount({
      name: "Dividend Income",
      type: "income",
    });
    const security = await createSecurity({
      name: "Acme Corp",
      symbol: "ACME",
      securityType: "stock",
    });

    const divTx = await createTransactionWithSplits({
      date: "2025-03-01",
      description: "Dividend",
      splits: [
        { accountId: cash.id, amount: 500 },     // cash received
        { accountId: dividendIncome.id, amount: -500 },
      ],
    });
    await createInvestmentSplit({
      transactionId: divTx.id,
      securityId: security.id,
      accountId: investment.id,
      action: "dividend",
      sharesMicros: 0,
      priceMicros: 0,
    });

    const res = await getSecuritySplits(
      new Request(`http://localhost/api/securities/${security.id}/splits`),
      rpId(security.id)
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.splits).toHaveLength(1);
    expect(body.splits[0].action).toBe("dividend");
    expect(body.splits[0].cashAmountCents).toBe(500);
  });

  it("returns 404 for an unknown security", async () => {
    const res = await getSecuritySplits(
      new Request("http://localhost/api/securities/9999/splits"),
      rpId(9999)
    );

    expect(res.status).toBe(404);
  });

  it("paginates results with limit and offset", async () => {
    const investment = await createAccount({
      name: "Brokerage",
      type: "asset",
      subtype: "investment",
    });
    const cash = await createAccount({
      name: "Brokerage Cash",
      type: "asset",
      subtype: "cash",
      parentId: investment.id,
      isInvestmentCash: true,
    });
    const security = await createSecurity({
      name: "Acme Corp",
      symbol: "ACME",
      securityType: "stock",
    });

    // Create 3 splits
    for (let i = 1; i <= 3; i++) {
      const tx = await createTransactionWithSplits({
        date: `2025-0${i}-01`,
        splits: [
          { accountId: investment.id, amount: 10000 },
          { accountId: cash.id, amount: -10000 },
        ],
      });
      await createInvestmentSplit({
        transactionId: tx.id,
        securityId: security.id,
        accountId: investment.id,
        action: "buy",
        sharesMicros: 1_000_000,
        priceMicros: 10_000_000,
      });
    }

    const res = await getSecuritySplits(
      new Request(
        `http://localhost/api/securities/${security.id}/splits?limit=2&offset=0`
      ),
      rpId(security.id)
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.splits).toHaveLength(2);
    expect(body.totalCount).toBe(3);
    expect(body.hasMore).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PUT /api/b/[bookId]/securities/[id]/prices/[date]
// ---------------------------------------------------------------------------

describe("PUT /api/b/[bookId]/securities/[id]/prices/[date]", () => {
  beforeAll(async () => { await setupTestDatabase(); });
  beforeEach(async () => { await resetTestDatabase(); });

  it("updates priceMicros for an existing price entry", async () => {
    const security = await createSecurity({
      name: "Acme Corp",
      symbol: "ACME",
      securityType: "stock",
    });
    await createSecurityPrice({
      securityId: security.id,
      priceDate: "2025-01-15",
      priceMicros: 5_000_000,
    });

    const res = await putSecurityPrice(
      putBody(
        `http://localhost/api/securities/${security.id}/prices/2025-01-15`,
        { priceDate: "2025-01-15", priceMicros: 6_000_000 }
      ),
      rpDate(security.id, "2025-01-15")
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it("updates source alongside priceMicros", async () => {
    const security = await createSecurity({
      name: "Acme Corp",
      symbol: "ACME",
      securityType: "stock",
    });
    await createSecurityPrice({
      securityId: security.id,
      priceDate: "2025-01-15",
      priceMicros: 5_000_000,
      source: "manual",
    });

    const res = await putSecurityPrice(
      putBody(
        `http://localhost/api/securities/${security.id}/prices/2025-01-15`,
        { priceDate: "2025-01-15", priceMicros: 7_000_000, source: "tiingo" }
      ),
      rpDate(security.id, "2025-01-15")
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it("returns 404 when the price entry does not exist", async () => {
    const security = await createSecurity({
      name: "Acme Corp",
      symbol: "ACME",
      securityType: "stock",
    });

    const res = await putSecurityPrice(
      putBody(
        `http://localhost/api/securities/${security.id}/prices/2025-01-15`,
        { priceDate: "2025-01-15", priceMicros: 5_000_000 }
      ),
      rpDate(security.id, "2025-01-15")
    );

    expect(res.status).toBe(404);
  });

  it("returns 400 when priceMicros is invalid (negative)", async () => {
    const security = await createSecurity({
      name: "Acme Corp",
      symbol: "ACME",
      securityType: "stock",
    });
    await createSecurityPrice({
      securityId: security.id,
      priceDate: "2025-01-15",
      priceMicros: 5_000_000,
    });

    const res = await putSecurityPrice(
      putBody(
        `http://localhost/api/securities/${security.id}/prices/2025-01-15`,
        { priceDate: "2025-01-15", priceMicros: -1000 }
      ),
      rpDate(security.id, "2025-01-15")
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/priceMicros/i);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/b/[bookId]/securities/[id]/prices/[date]
// ---------------------------------------------------------------------------

describe("DELETE /api/b/[bookId]/securities/[id]/prices/[date]", () => {
  beforeAll(async () => { await setupTestDatabase(); });
  beforeEach(async () => { await resetTestDatabase(); });

  it("deletes an existing price entry and returns success", async () => {
    const security = await createSecurity({
      name: "Acme Corp",
      symbol: "ACME",
      securityType: "stock",
    });
    await createSecurityPrice({
      securityId: security.id,
      priceDate: "2025-01-15",
      priceMicros: 5_000_000,
    });

    const res = await deleteSecurityPrice(
      new Request(
        `http://localhost/api/securities/${security.id}/prices/2025-01-15`,
        { method: "DELETE" }
      ),
      rpDate(security.id, "2025-01-15")
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it("returns 404 when the price entry does not exist", async () => {
    const security = await createSecurity({
      name: "Acme Corp",
      symbol: "ACME",
      securityType: "stock",
    });

    const res = await deleteSecurityPrice(
      new Request(
        `http://localhost/api/securities/${security.id}/prices/2025-01-15`,
        { method: "DELETE" }
      ),
      rpDate(security.id, "2025-01-15")
    );

    expect(res.status).toBe(404);
  });

  it("returns 404 when the security does not exist", async () => {
    const res = await deleteSecurityPrice(
      new Request("http://localhost/api/securities/9999/prices/2025-01-15", {
        method: "DELETE",
      }),
      rpDate(9999, "2025-01-15")
    );

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /api/b/[bookId]/securities — list with positions
// ---------------------------------------------------------------------------

describe("GET /api/b/[bookId]/securities", () => {
  beforeAll(async () => { await setupTestDatabase(); });
  beforeEach(async () => { await resetTestDatabase(); });

  it("returns an empty list when no securities exist", async () => {
    const res = await getSecurities(
      new Request("http://localhost/api/securities"),
      rpBook()
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });

  it("returns securities with position and price info", async () => {
    const investment = await createAccount({
      name: "Brokerage",
      type: "asset",
      subtype: "investment",
    });
    const cash = await createAccount({
      name: "Brokerage Cash",
      type: "asset",
      subtype: "cash",
      parentId: investment.id,
      isInvestmentCash: true,
    });
    const security = await createSecurity({
      name: "Acme Corp",
      symbol: "ACME",
      securityType: "stock",
    });
    await createSecurityPrice({
      securityId: security.id,
      priceDate: "2025-02-01",
      priceMicros: 10_000_000,
    });

    const tx = await createTransactionWithSplits({
      date: "2025-01-10",
      splits: [
        { accountId: investment.id, amount: 50000 },
        { accountId: cash.id, amount: -50000 },
      ],
    });
    await createInvestmentSplit({
      transactionId: tx.id,
      securityId: security.id,
      accountId: investment.id,
      action: "buy",
      sharesMicros: 5_000_000,
      priceMicros: 10_000_000,
    });

    const res = await getSecurities(
      new Request("http://localhost/api/securities"),
      rpBook()
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].symbol).toBe("ACME");
    expect(body[0].sharesMicros).toBe(5_000_000);
    expect(body[0].marketValueCents).toBe(5_000); // 5 shares × $10 = $50
  });

  it("processes a same-day buy before its sell regardless of split insert order", async () => {
    const investment = await createAccount({
      name: "Brokerage",
      type: "asset",
      subtype: "investment",
    });
    const cash = await createAccount({
      name: "Brokerage Cash",
      type: "asset",
      subtype: "cash",
      parentId: investment.id,
      isInvestmentCash: true,
    });
    const security = await createSecurity({
      name: "Vanguard Total",
      symbol: "VTI",
      securityType: "etf",
    });

    // Buy is the earlier TRANSACTION, sell the later one — same date.
    const buyTxn = await createTransactionWithSplits({
      date: "2026-06-01",
      description: "Buy VTI",
      splits: [
        { accountId: investment.id, amount: 100000 },
        { accountId: cash.id, amount: -100000 },
      ],
    });
    const sellTxn = await createTransactionWithSplits({
      date: "2026-06-01",
      description: "Sell VTI",
      splits: [
        { accountId: cash.id, amount: 60000 },
        { accountId: investment.id, amount: -60000 },
      ],
    });

    // Insert the BUY's investment split first, so its id is lower and the
    // SELL's is higher.
    //
    // Historical note: this test used to exercise a join-ordering quirk
    // specific to this route's own hand-rolled position query (a
    // leftJoin(accounts) whose hash-join bucket probing returned matches in
    // reverse insertion order). That route-specific query is gone — the
    // route now delegates entirely to getPositions() (lib/investments.ts),
    // the same function tests/lib/investments-ordering.test.ts exercises
    // directly. This test now serves as an integration check that the route
    // wires through to that shared, order-correct implementation rather than
    // reintroducing its own position logic.
    await createInvestmentSplit({
      transactionId: buyTxn.id,
      accountId: investment.id,
      securityId: security.id,
      action: "buy",
      sharesMicros: 10_000_000,
      priceMicros: 100_000_000,
    });
    await createInvestmentSplit({
      transactionId: sellTxn.id,
      accountId: investment.id,
      securityId: security.id,
      action: "sell",
      sharesMicros: 5_000_000,
      priceMicros: 120_000_000,
    });

    // createInvestmentSplit is a low-level helper that bypasses
    // lib/transactions.ts's createTransaction(), which is what normally
    // triggers rebuildLots after a write. Rebuild explicitly so
    // investment_lots reflects this fixture, same as a real write-path call
    // would produce — getSecurities now sources costBasisCents from lots via
    // getPositions().
    await rebuildLots(db, 1, investment.id, security.id);

    const res = await getSecurities(
      new Request("http://localhost/api/securities"),
      rpBook()
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    const vti = body.find((s: { symbol: string }) => s.symbol === "VTI");

    // sharesMicros is order-invariant (buy +10M and sell -5M sum to +5M no
    // matter which is applied first) — asserted only as a sanity check.
    expect(vti?.sharesMicros).toBe(5_000_000);

    // costBasisCents comes from rebuildLots's FIFO replay now. There is a
    // single lot here (one buy, one partial sell), so FIFO and average cost
    // agree: the buy opens a $1,000 lot; the sell draws 5 of its 10 shares
    // from that lot, removing the proportional $500 (50,000 cents), leaving
    // $500 (50,000 cents) of basis for the remaining 5 shares.
    expect(vti?.costBasisCents).toBe(50_000);
  });

  it("reports the same costBasisCents as getPositions and the detail route for a security with two lots at different prices", async () => {
    // Regression test: before this route delegated to getPositions(), it
    // computed its own average-cost approximation, and the security detail
    // route had an entirely separate hand-rolled average-cost replay. All
    // three could report different cost-basis figures for the same security.
    // Two lots at different per-share prices is the scenario where FIFO and
    // average cost diverge, so it's the scenario that would catch this class
    // of regression if any of the three ever computed cost basis
    // independently again.
    const investment = await createAccount({
      name: "Brokerage",
      type: "asset",
      subtype: "investment",
    });
    const cash = await createAccount({ name: "Brokerage Cash", type: "asset", subtype: "cash" });
    const security = await createSecurity({
      name: "Vanguard Total Two-Lot",
      symbol: "VTI2",
      securityType: "etf",
    });

    const M = 1_000_000;
    const trade = (date: string, action: "buy" | "sell", shares: number, price: number) => {
      const amount = Math.round((shares / M) * (price / M) * 100);
      const signed = action === "buy" ? amount : -amount;
      return createTransaction(db, 1, {
        date,
        description: `${action} VTI2`,
        splits: [
          { accountId: investment.id, amount: signed },
          { accountId: cash.id, amount: -signed },
        ],
        investmentSplits: [
          { securityId: security.id, action, sharesMicros: shares, priceMicros: price, feesCents: 0 },
        ],
      });
    };

    // createTransaction() is the real write path, so rebuildLots runs
    // automatically — no manual lot-rebuild needed here.
    await trade("2024-01-01", "buy", 100 * M, 10 * M); // lot A: 100 sh @ $10 = $1000
    await trade("2024-02-01", "buy", 50 * M, 20 * M); // lot B: 50 sh @ $20 = $1000
    await trade("2024-06-01", "sell", 120 * M, 30 * M); // closes lot A, takes 20 sh of lot B

    // Ground truth: FIFO leaves 30 shares of the $20 lot -> $600 (60,000
    // cents). Average cost would instead spread the $2,000 total basis
    // proportionally across 150 total shares bought and report $400
    // (40,000 cents) for the 30 remaining shares.
    const groundTruthPositions = await getPositions(db, 1);
    const groundTruth = groundTruthPositions.find((p) => p.securitySymbol === "VTI2");
    expect(groundTruth?.costBasisCents).toBe(60_000);

    const listRes = await getSecurities(new Request("http://localhost/api/securities"), rpBook());
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json();
    const listEntry = listBody.find((s: { symbol: string }) => s.symbol === "VTI2");
    expect(listEntry?.costBasisCents).toBe(groundTruth?.costBasisCents);

    const detailRes = await getSecurityDetail(
      new Request(`http://localhost/api/securities/${security.id}/detail`),
      { params: Promise.resolve({ bookId: "1", id: String(security.id) }) }
    );
    expect(detailRes.status).toBe(200);
    const detailBody = await detailRes.json();
    expect(detailBody.positionsByAccount).toHaveLength(1);
    expect(detailBody.positionsByAccount[0].costBasisCents).toBe(groundTruth?.costBasisCents);
  });

  it("includes income from an archived account, matching the position scope", async () => {
    // Regression test: shares/basis come from getPositions() (book-wide, no
    // isActive filter), but the income query used to filter to active
    // accounts only. A security held solely in an archived account rendered
    // real shares and basis beside a hardcoded $0 income. Both halves of the
    // row must use the same scope.
    const investment = await createAccount({
      name: "Old Brokerage",
      type: "asset",
      subtype: "investment",
      isActive: false,
    });
    const cash = await createAccount({
      name: "Old Brokerage Cash",
      type: "asset",
      subtype: "cash",
      parentId: investment.id,
      isInvestmentCash: true,
      isActive: false,
    });
    const dividendIncome = await createAccount({ name: "Dividend Income", type: "income" });
    const security = await createSecurity({
      name: "Archived Fund",
      symbol: "ARCH",
      securityType: "stock",
    });

    const buyTx = await createTransactionWithSplits({
      date: "2025-01-10",
      splits: [
        { accountId: investment.id, amount: 50000 },
        { accountId: cash.id, amount: -50000 },
      ],
    });
    await createInvestmentSplit({
      transactionId: buyTx.id,
      securityId: security.id,
      accountId: investment.id,
      action: "buy",
      sharesMicros: 5_000_000,
      priceMicros: 10_000_000,
    });
    await rebuildLots(db, 1, investment.id, security.id);

    const divTx = await createTransactionWithSplits({
      date: "2025-03-01",
      description: "Dividend",
      splits: [
        { accountId: cash.id, amount: 500 },
        { accountId: dividendIncome.id, amount: -500 },
      ],
    });
    await createInvestmentSplit({
      transactionId: divTx.id,
      securityId: security.id,
      accountId: investment.id,
      action: "dividend",
      sharesMicros: 0,
      priceMicros: 0,
    });

    const res = await getSecurities(new Request("http://localhost/api/securities"), rpBook());
    expect(res.status).toBe(200);
    const body = await res.json();
    const arch = body.find((s: { symbol: string }) => s.symbol === "ARCH");

    expect(arch?.sharesMicros).toBe(5_000_000);
    expect(arch?.incomeCents).toBe(500);
  });
});
