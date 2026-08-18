import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as getPositions } from "@/app/api/b/[bookId]/investments/positions/route";
import { GET as getAccountValues } from "@/app/api/b/[bookId]/investments/account-values/route";
import {
  createAccount,
  createInvestmentSplit,
  createSecurity,
  createSecurityPrice,
  createTransactionWithSplits,
  resetTestDatabase,
  setupTestDatabase,
} from "@/tests/helpers/db";

vi.mock("@/lib/api-auth", async () => {
  const { mockApiAuth } = await import("@/tests/helpers/db");
  return mockApiAuth();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rp() {
  return { params: Promise.resolve({ bookId: "1" }) };
}

// ---------------------------------------------------------------------------
// GET /investments/positions
// ---------------------------------------------------------------------------

describe("GET /api/b/[bookId]/investments/positions", () => {
  beforeAll(async () => { await setupTestDatabase(); });
  beforeEach(async () => { await resetTestDatabase(); });

  it("returns an empty array when there are no investment transactions", async () => {
    const res = await getPositions(
      new Request("http://localhost/api/investments/positions"),
      rp()
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });

  it("returns current positions after a buy transaction", async () => {
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
      sharesMicros: 10_000_000,
      priceMicros: 5_000_000,
    });

    const res = await getPositions(
      new Request("http://localhost/api/investments/positions"),
      rp()
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].securitySymbol).toBe("ACME");
    expect(body[0].sharesMicros).toBe(10_000_000);
  });

  it("subtracts sold shares from the position", async () => {
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
      sharesMicros: 10_000_000, // buy 10 shares
      priceMicros: 5_000_000,
    });

    const sellTx = await createTransactionWithSplits({
      date: "2025-01-20",
      splits: [
        { accountId: investment.id, amount: -25000 },
        { accountId: cash.id, amount: 25000 },
      ],
    });
    await createInvestmentSplit({
      transactionId: sellTx.id,
      securityId: security.id,
      accountId: investment.id,
      action: "sell",
      sharesMicros: 5_000_000, // sell 5 shares
      priceMicros: 5_000_000,
    });

    const res = await getPositions(
      new Request("http://localhost/api/investments/positions"),
      rp()
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].sharesMicros).toBe(5_000_000); // 10 - 5 = 5 shares
  });

  it("filters positions by accountId", async () => {
    const brokerageA = await createAccount({
      name: "Brokerage A",
      type: "asset",
      subtype: "investment",
    });
    const cashA = await createAccount({
      name: "Brokerage A Cash",
      type: "asset",
      subtype: "cash",
      parentId: brokerageA.id,
      isInvestmentCash: true,
    });
    const brokerageB = await createAccount({
      name: "Brokerage B",
      type: "asset",
      subtype: "investment",
    });
    const cashB = await createAccount({
      name: "Brokerage B Cash",
      type: "asset",
      subtype: "cash",
      parentId: brokerageB.id,
      isInvestmentCash: true,
    });
    const secA = await createSecurity({
      name: "Security A",
      symbol: "SECA",
      securityType: "stock",
    });
    const secB = await createSecurity({
      name: "Security B",
      symbol: "SECB",
      securityType: "stock",
    });

    const txA = await createTransactionWithSplits({
      date: "2025-01-10",
      splits: [
        { accountId: brokerageA.id, amount: 10000 },
        { accountId: cashA.id, amount: -10000 },
      ],
    });
    await createInvestmentSplit({
      transactionId: txA.id,
      securityId: secA.id,
      accountId: brokerageA.id,
      action: "buy",
      sharesMicros: 5_000_000,
      priceMicros: 2_000_000,
    });

    const txB = await createTransactionWithSplits({
      date: "2025-01-11",
      splits: [
        { accountId: brokerageB.id, amount: 10000 },
        { accountId: cashB.id, amount: -10000 },
      ],
    });
    await createInvestmentSplit({
      transactionId: txB.id,
      securityId: secB.id,
      accountId: brokerageB.id,
      action: "buy",
      sharesMicros: 5_000_000,
      priceMicros: 2_000_000,
    });

    const res = await getPositions(
      new Request(
        `http://localhost/api/investments/positions?accountId=${brokerageA.id}`
      ),
      rp()
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].securitySymbol).toBe("SECA");
  });

  it("returns 400 for an invalid (non-numeric) accountId", async () => {
    const res = await getPositions(
      new Request("http://localhost/api/investments/positions?accountId=abc"),
      rp()
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// GET /investments/account-values
// ---------------------------------------------------------------------------

describe("GET /api/b/[bookId]/investments/account-values", () => {
  beforeAll(async () => { await setupTestDatabase(); });
  beforeEach(async () => { await resetTestDatabase(); });

  it("returns an empty array when there are no investments", async () => {
    const res = await getAccountValues(
      new Request("http://localhost/api/investments/account-values"),
      rp()
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });

  it("returns market value for an account that has positions and prices", async () => {
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
    // Latest price: $10.00
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
      sharesMicros: 10_000_000, // 10 shares at $5
      priceMicros: 5_000_000,
    });

    const res = await getAccountValues(
      new Request("http://localhost/api/investments/account-values"),
      rp()
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.length).toBeGreaterThan(0);
    const acct = body.find(
      (a: { accountId: number }) => a.accountId === investment.id
    );
    expect(acct).toBeDefined();
    // 10 shares × $10 = $100 market value = 10_000 cents
    expect(acct.marketValueCents).toBe(10_000);
  });

  it("excludes transactions after asOfDate from position calculations", async () => {
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
      priceMicros: 5_000_000, // $5.00
    });

    // Buy 10 shares on Jan 1
    const buyTx = await createTransactionWithSplits({
      date: "2025-01-01",
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
      sharesMicros: 10_000_000,
      priceMicros: 5_000_000,
    });

    // Sell 5 shares on Jan 20 (after the asOfDate)
    const sellTx = await createTransactionWithSplits({
      date: "2025-01-20",
      splits: [
        { accountId: investment.id, amount: -25000 },
        { accountId: cash.id, amount: 25000 },
      ],
    });
    await createInvestmentSplit({
      transactionId: sellTx.id,
      securityId: security.id,
      accountId: investment.id,
      action: "sell",
      sharesMicros: 5_000_000,
      priceMicros: 5_000_000,
    });

    // asOfDate=2025-01-10 → sell on Jan 20 is excluded → position is 10 shares
    // 10 shares × $5 = $50 = 5_000 cents
    const res = await getAccountValues(
      new Request(
        "http://localhost/api/investments/account-values?asOfDate=2025-01-10"
      ),
      rp()
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    const acct = body.find(
      (a: { accountId: number }) => a.accountId === investment.id
    );
    expect(acct).toBeDefined();
    expect(acct.marketValueCents).toBe(5_000);
  });
});
