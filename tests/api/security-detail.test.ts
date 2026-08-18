import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/b/[bookId]/securities/[id]/detail/route";
import { db } from "@/tests/helpers/db-utils";
import {
  createAccount,
  createInvestmentSplit,
  createSecurity,
  createSecurityPrice,
  createTransactionWithSplits,
  resetTestDatabase,
  setupTestDatabase,
} from "@/tests/helpers/db";
import { rebuildLots } from "@/lib/lots-db";

vi.mock("@/lib/api-auth", async () => {
  const { mockApiAuth } = await import("@/tests/helpers/db");
  return mockApiAuth();
});

describe("GET /api/securities/:id/detail", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("returns positions by account, latest price, and ordered splits", async () => {
    const brokerageA = await createAccount({
      name: "Brokerage A",
      type: "asset",
      subtype: "investment",
    });
    const brokerageB = await createAccount({
      name: "Brokerage B",
      type: "asset",
      subtype: "investment",
      isActive: false,
    });
    const cash = await createAccount({
      name: "Brokerage Cash",
      type: "asset",
      subtype: "cash",
    });
    const equity = await createAccount({
      name: "Opening Balance",
      type: "equity",
    });
    const security = await createSecurity({
      name: "Acme Corp",
      symbol: "ACME",
      securityType: "stock",
    });

    const buyA = await createTransactionWithSplits({
      date: "2024-01-10",
      description: "Buy in A",
      splits: [
        { accountId: brokerageA.id, amount: 10000 },
        { accountId: cash.id, amount: -10000 },
      ],
    });
    await createInvestmentSplit({
      transactionId: buyA.id,
      accountId: brokerageA.id,
      securityId: security.id,
      action: "buy",
      sharesMicros: 10_000_000,
      priceMicros: 10_000_000,
    });

    const buyB = await createTransactionWithSplits({
      date: "2024-01-20",
      description: "Buy in B",
      splits: [
        { accountId: brokerageB.id, amount: 8000 },
        { accountId: equity.id, amount: -8000 },
      ],
    });
    await createInvestmentSplit({
      transactionId: buyB.id,
      accountId: brokerageB.id,
      securityId: security.id,
      action: "buy",
      sharesMicros: 4_000_000,
      priceMicros: 20_000_000,
    });

    const splitTx = await createTransactionWithSplits({
      date: "2024-02-01",
      description: "2-for-1 split",
      splits: [
        { accountId: cash.id, amount: 0 },
        { accountId: equity.id, amount: 0 },
      ],
    });
    await createInvestmentSplit({
      transactionId: splitTx.id,
      securityId: security.id,
      action: "split",
      sharesMicros: 0,
      priceMicros: 0,
      splitNumerator: 2,
      splitDenominator: 1,
    });

    const sellA = await createTransactionWithSplits({
      date: "2024-03-01",
      description: "Sell from A",
      splits: [
        { accountId: cash.id, amount: 2400 },
        { accountId: brokerageA.id, amount: -2400 },
      ],
    });
    await createInvestmentSplit({
      transactionId: sellA.id,
      accountId: brokerageA.id,
      securityId: security.id,
      action: "sell",
      sharesMicros: 2_000_000,
      priceMicros: 12_000_000,
    });

    await createSecurityPrice({
      securityId: security.id,
      priceDate: "2024-02-28",
      priceMicros: 14_000_000,
      source: "manual",
    });
    await createSecurityPrice({
      securityId: security.id,
      priceDate: "2024-03-15",
      priceMicros: 15_000_000,
      source: "manual",
    });

    // createInvestmentSplit is a low-level helper that bypasses
    // lib/transactions.ts's createTransaction(), which is what normally
    // triggers rebuildLots after a write. Rebuild explicitly for both
    // accounts so investment_lots reflects this fixture, same as a real
    // write-path call would produce — the detail route now sources
    // costBasisCents from lots.
    await rebuildLots(db, 1, brokerageA.id, security.id);
    await rebuildLots(db, 1, brokerageB.id, security.id);

    const response = await GET(
      new Request(`http://localhost/api/securities/${security.id}/detail`),
      { params: Promise.resolve({ bookId: "1", id: String(security.id) }) }
    );

    expect(response.status).toBe(200);
    const payload = await response.json();

    expect(payload.security).toMatchObject({
      id: security.id,
      symbol: "ACME",
      latestPriceMicros: 15_000_000,
      latestPriceDate: "2024-03-15",
    });

    expect(payload.positionsByAccount).toEqual([
      expect.objectContaining({
        accountId: brokerageA.id,
        accountName: "Brokerage A",
        isActive: true,
        sharesMicros: 18_000_000,
        costBasisCents: 9000,
        marketValueCents: 27000,
      }),
      expect.objectContaining({
        accountId: brokerageB.id,
        accountName: "Brokerage B",
        isActive: false,
        sharesMicros: 8_000_000,
        costBasisCents: 8000,
        marketValueCents: 12000,
      }),
    ]);

    expect(payload.splits.map((split: { action: string }) => split.action)).toEqual([
      "sell",
      "split",
      "buy",
      "buy",
    ]);
    expect(
      payload.splits.find((split: { action: string }) => split.action === "split")
    ).toMatchObject({
      accountId: null,
      accountName: "All Accounts",
      splitNumerator: 2,
      splitDenominator: 1,
    });
  });

  it("values a fixed-price security at its fixed price, not its stored prices", async () => {
    const brokerage = await createAccount({
      name: "Brokerage",
      type: "asset",
      subtype: "investment",
    });
    const mmf = await createSecurity({
      name: "Vanguard Federal Money Market",
      symbol: "VMFXX",
      securityType: "mutual_fund",
      fetchPrices: false,
      fixedPriceMicros: 1_000_000,
    });
    // A price recorded before the security was marked fixed-price. It stays on
    // the books as a record but must not value the position.
    await createSecurityPrice({
      securityId: mmf.id,
      priceDate: "2026-06-30",
      priceMicros: 980_000,
    });

    const txn = await createTransactionWithSplits({
      date: "2026-06-01",
      description: "Buy",
      splits: [
        { accountId: brokerage.id, amount: 250_000 },
        { accountId: brokerage.id, amount: -250_000 },
      ],
    });
    await createInvestmentSplit({
      transactionId: txn.id,
      accountId: brokerage.id,
      securityId: mmf.id,
      action: "buy",
      sharesMicros: 2_500_000_000,
      priceMicros: 1_000_000,
    });

    const response = await GET(
      new Request(`http://localhost/api/securities/${mmf.id}/detail`),
      { params: Promise.resolve({ bookId: "1", id: String(mmf.id) }) }
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.security.latestPriceMicros).toBe(1_000_000);
    expect(body.positionsByAccount[0].marketValueCents).toBe(250_000);
  });
});
