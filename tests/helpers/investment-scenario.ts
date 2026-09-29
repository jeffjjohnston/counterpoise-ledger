import { toDateString } from "../../lib/formatters";
import { backfillLots } from "../../scripts/rebuild-lots";
import {
  createAccount, createInvestmentSplit, createSecurity, createSecurityPrice,
  createTransactionWithSplits, db,
} from "./db-utils";

type SplitInput = Omit<Parameters<typeof createInvestmentSplit>[0], "transactionId">;

/**
 * One book with the cases the investment routes treat differently: fees, a
 * same-date tie, a stock split with no account, a sell across lots, a sell
 * larger than its lots, sales on each side of the one-year boundary, a floating buy, a
 * fixed-price security, and a dividend that withholds tax. Lots come from the
 * TypeScript rebuild that the Docker entrypoint also runs.
 */
export async function createInvestmentScenario() {
  const brokerage = await createAccount({ name: "Brokerage", type: "asset", subtype: "investment" });
  const ira = await createAccount({ name: "IRA", type: "asset", subtype: "investment" });
  const closed = await createAccount({ name: "Closed Brokerage", type: "asset", subtype: "investment", isActive: false });
  const cash = await createAccount({ name: "Cash", type: "asset", subtype: "cash" });
  const dividends = await createAccount({ name: "Dividends", type: "income" });
  const withheld = await createAccount({ name: "Tax Withheld", type: "expense" });
  const vti = await createSecurity({ name: "Vanguard Total", symbol: "VTI", securityType: "etf" });
  const bnd = await createSecurity({ name: "Bond Fund", symbol: "BND", securityType: "mutual_fund", fixedPriceMicros: 1_000_000 });
  const idle = await createSecurity({ name: "Idle Stock", symbol: "IDLE", securityType: "stock", fetchPrices: false });
  await createSecurityPrice({ securityId: vti.id, priceDate: "2025-01-02", priceMicros: 101_250_000 });
  await createSecurityPrice({ securityId: vti.id, priceDate: "2025-06-02", priceMicros: 120_333_333 });
  // Recorded before BND was fixed-price; the fixed price must replace it.
  await createSecurityPrice({ securityId: bnd.id, priceDate: "2025-06-03", priceMicros: 9_990_000 });

  async function trade(date: string, split: SplitInput, options: { isFloating?: boolean; description?: string } = {}) {
    const transaction = await createTransactionWithSplits({
      date, isFloating: options.isFloating, description: options.description ?? `${split.action} ${date}`,
      splits: [{ accountId: cash.id, amount: -1 }, { accountId: cash.id, amount: 1 }],
    });
    return createInvestmentSplit({ ...split, transactionId: transaction.id });
  }

  await trade("2024-01-02", { accountId: brokerage.id, securityId: vti.id, action: "buy", sharesMicros: 10_000_000, priceMicros: 200_000_000, feesCents: 5 });
  await trade("2024-01-02", { accountId: brokerage.id, securityId: vti.id, action: "buy", sharesMicros: 5_000_000, priceMicros: 210_000_000 });
  await trade("2024-02-15", { accountId: ira.id, securityId: vti.id, action: "buy", sharesMicros: 3_000_000, priceMicros: 205_000_000 });
  await trade("2024-02-20", { accountId: closed.id, securityId: vti.id, action: "buy", sharesMicros: 1_000_000, priceMicros: 199_000_000 });
  await trade("2024-03-01", { securityId: vti.id, action: "split", sharesMicros: 0, priceMicros: 0, splitNumerator: 2, splitDenominator: 1 });
  await trade("2025-03-05", { accountId: brokerage.id, securityId: vti.id, action: "sell", sharesMicros: 24_000_000, priceMicros: 110_000_000, feesCents: 3 });
  await trade("2024-09-10", { accountId: brokerage.id, securityId: vti.id, action: "sell", sharesMicros: 1_000_000, priceMicros: 105_000_000 });
  await trade("2025-04-01", { accountId: ira.id, securityId: vti.id, action: "sell", sharesMicros: 10_000_000, priceMicros: 115_000_000, feesCents: 1 });
  // Holding-period boundaries: exactly one year is short-term, and a lot
  // bought on 29 February reaches one year on 1 March, as JavaScript dates do.
  await trade("2024-02-29", { accountId: closed.id, securityId: vti.id, action: "buy", sharesMicros: 2_000_000, priceMicros: 201_000_000 });
  for (const date of ["2025-02-20", "2025-02-21", "2025-03-01", "2025-03-02"]) {
    await trade(date, { accountId: closed.id, securityId: vti.id, action: "sell", sharesMicros: 1_000_000, priceMicros: 112_000_000 });
  }
  await trade("2020-01-01", { accountId: brokerage.id, securityId: bnd.id, action: "buy", sharesMicros: 2_500_000, priceMicros: 1_000_000 }, { isFloating: true });

  const dividend = await createTransactionWithSplits({
    date: "2025-05-01", description: "VTI dividend",
    splits: [
      { accountId: cash.id, amount: 950 }, { accountId: withheld.id, amount: 50 },
      { accountId: dividends.id, amount: -1000 },
    ],
  });
  await createInvestmentSplit({
    transactionId: dividend.id, accountId: brokerage.id, securityId: vti.id,
    action: "dividend", sharesMicros: 0, priceMicros: 0,
  });

  await backfillLots(db, { force: true });
  return { brokerage, ira, closed, cash, vti, bnd, idle };
}

/**
 * Replace values that change between runs: today's date (a floating
 * transaction and a fixed price use it) and creation timestamps.
 */
export function stable(body: unknown): unknown {
  const today = toDateString(new Date());
  return JSON.parse(
    JSON.stringify(body)
      .replaceAll(today, "<today>")
      .replace(/"createdAt":"[^"]+"/g, '"createdAt":"<timestamp>"')
  );
}
