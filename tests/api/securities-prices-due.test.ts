import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/b/[bookId]/securities/prices-due/route";
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

function rp() {
  return { params: Promise.resolve({ bookId: "1" }) };
}

function req() {
  return new Request("http://localhost/api/b/1/securities/prices-due");
}

/** Create an investment account and a buy of `sharesMicros` for the security. */
async function buyShares(securityId: number, sharesMicros: number, date: string) {
  const account = await createAccount({
    name: `Brokerage ${securityId}-${date}`,
    type: "asset",
    subtype: "investment",
  });
  const txn = await createTransactionWithSplits({
    date,
    description: "Buy",
    splits: [
      { accountId: account.id, amount: 100 },
      { accountId: account.id, amount: -100 },
    ],
  });
  await createInvestmentSplit({
    transactionId: txn.id,
    accountId: account.id,
    securityId,
    action: "buy",
    sharesMicros,
    priceMicros: 1_000_000,
  });
  return account;
}

async function sellShares(accountId: number, securityId: number, sharesMicros: number, date: string) {
  const txn = await createTransactionWithSplits({
    date,
    description: "Sell",
    splits: [
      { accountId, amount: 100 },
      { accountId, amount: -100 },
    ],
  });
  await createInvestmentSplit({
    transactionId: txn.id,
    accountId,
    securityId,
    action: "sell",
    sharesMicros,
    priceMicros: 1_000_000,
  });
}

beforeAll(async () => {
  await setupTestDatabase();
});

beforeEach(async () => {
  await resetTestDatabase();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /api/b/[bookId]/securities/prices-due", () => {
  it("returns no securities when the book has no manually-priced securities", async () => {
    const vti = await createSecurity({ name: "VTI", symbol: "VTI", securityType: "etf" });
    await buyShares(vti.id, 100_000_000, "2026-06-01");
    await createSecurityPrice({ securityId: vti.id, priceDate: "2026-07-02", priceMicros: 368_760_000 });

    const response = await GET(req(), rp());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.securities).toEqual([]);
  });

  it("lists a manual security with an open position and a stale price", async () => {
    const vti = await createSecurity({ name: "VTI", symbol: "VTI", securityType: "etf" });
    await createSecurityPrice({ securityId: vti.id, priceDate: "2026-07-02", priceMicros: 368_760_000 });

    // A second fetchable security with a stale price is the cron's problem, not the banner's
    const bnd = await createSecurity({ name: "BND", symbol: "BND", securityType: "etf" });
    await buyShares(bnd.id, 10_000_000, "2026-06-01");
    await createSecurityPrice({ securityId: bnd.id, priceDate: "2026-06-20", priceMicros: 73_000_000 });

    const call = await createSecurity({
      name: "SPY Jul '26 630C",
      symbol: "SPY260731C630",
      securityType: "stock",
      fetchPrices: false,
    });
    await buyShares(call.id, 2_000_000, "2026-06-05");
    await createSecurityPrice({ securityId: call.id, priceDate: "2026-07-01", priceMicros: 4_350_000 });

    const response = await GET(req(), rp());
    const body = await response.json();
    expect(body.dueDate).toBe("2026-07-02");
    expect(body.securities).toEqual([
      {
        securityId: call.id,
        name: "SPY Jul '26 630C",
        symbol: "SPY260731C630",
        lastPriceMicros: 4_350_000,
        lastPriceDate: "2026-07-01",
      },
    ]);
  });

  it("excludes a manual security whose price for the due date already exists", async () => {
    const vti = await createSecurity({ name: "VTI", symbol: "VTI", securityType: "etf" });
    await createSecurityPrice({ securityId: vti.id, priceDate: "2026-07-02", priceMicros: 368_760_000 });

    const call = await createSecurity({
      name: "SPY Jul '26 630C",
      symbol: "SPY260731C630",
      securityType: "stock",
      fetchPrices: false,
    });
    await buyShares(call.id, 2_000_000, "2026-06-05");
    await createSecurityPrice({ securityId: call.id, priceDate: "2026-07-02", priceMicros: 4_500_000 });

    const response = await GET(req(), rp());
    const body = await response.json();
    expect(body.securities).toEqual([]);
  });

  it("excludes a manual security whose position is closed", async () => {
    const vti = await createSecurity({ name: "VTI", symbol: "VTI", securityType: "etf" });
    await createSecurityPrice({ securityId: vti.id, priceDate: "2026-07-02", priceMicros: 368_760_000 });

    const expired = await createSecurity({
      name: "SPY Jun '26 600C",
      symbol: "SPY260630C600",
      securityType: "stock",
      fetchPrices: false,
    });
    const account = await buyShares(expired.id, 2_000_000, "2026-05-01");
    await sellShares(account.id, expired.id, 2_000_000, "2026-06-30");

    const response = await GET(req(), rp());
    const body = await response.json();
    expect(body.securities).toEqual([]);
  });

  it("lists a manual security that has never been priced with null prefill", async () => {
    const vti = await createSecurity({ name: "VTI", symbol: "VTI", securityType: "etf" });
    await createSecurityPrice({ securityId: vti.id, priceDate: "2026-07-02", priceMicros: 368_760_000 });

    const put = await createSecurity({
      name: "SPY Jul '26 560P",
      symbol: "SPY260731P560",
      securityType: "stock",
      fetchPrices: false,
    });
    await buyShares(put.id, 1_000_000, "2026-07-01");

    const response = await GET(req(), rp());
    const body = await response.json();
    expect(body.securities).toEqual([
      {
        securityId: put.id,
        name: "SPY Jul '26 560P",
        symbol: "SPY260731P560",
        lastPriceMicros: null,
        lastPriceDate: null,
      },
    ]);
  });

  it("falls back to the last weekday when no fetchable security has prices", async () => {
    // Saturday, July 4 2026 -> last weekday is Friday, July 3
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-04T12:00:00"));

    const call = await createSecurity({
      name: "SPY Jul '26 630C",
      symbol: "SPY260731C630",
      securityType: "stock",
      fetchPrices: false,
    });
    await buyShares(call.id, 2_000_000, "2026-06-05");
    await createSecurityPrice({ securityId: call.id, priceDate: "2026-07-01", priceMicros: 4_350_000 });

    const response = await GET(req(), rp());
    const body = await response.json();
    expect(body.dueDate).toBe("2026-07-03");
    expect(body.securities).toHaveLength(1);
    expect(body.securities[0].securityId).toBe(call.id);
  });

  it("never lists a fixed-price security, whatever the due date", async () => {
    // A money market fund at a $1.00 NAV is neither fetched nor prompted for.
    // The due date is pinned ahead of today here so the security's synthesized
    // price cannot be what excludes it — the pill must skip it by definition.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-01T12:00:00"));

    const vti = await createSecurity({ name: "VTI", symbol: "VTI", securityType: "etf" });
    await createSecurityPrice({ securityId: vti.id, priceDate: "2026-07-02", priceMicros: 368_760_000 });

    const mmf = await createSecurity({
      name: "Vanguard Federal Money Market",
      symbol: "VMFXX",
      securityType: "mutual_fund",
      fetchPrices: false,
      fixedPriceMicros: 1_000_000,
    });
    await buyShares(mmf.id, 2_500_000_000, "2026-06-05");

    const response = await GET(req(), rp());
    const body = await response.json();

    expect(body.securities).toEqual([]);
  });
});
