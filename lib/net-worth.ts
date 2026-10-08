import type { AccountMarketValue } from "@/lib/investments";
import { getDisplayBalance } from "@/lib/wasm-client";
import type { AccountWithBalance } from "@/types";

/**
 * The balance that the dashboard uses for an account. An investment account
 * uses its market value plus the balance of its cash child.
 */
export function effectiveBalance(
  account: AccountWithBalance,
  accounts: AccountWithBalance[],
  marketValues: Map<number, number>,
): number {
  if (account.subtype !== "investment") return account.balance;
  const cashChild = accounts.find((a) => a.parentId === account.id && a.isInvestmentCash);
  return (marketValues.get(account.id) ?? 0) + (cashChild?.balance ?? 0);
}

/**
 * The Net Worth card: active asset accounts less active liability accounts.
 * A cash child is not counted alone, because its parent includes it.
 * `accounts` is the flat list of all accounts.
 */
export function computeNetWorth(
  accounts: AccountWithBalance[],
  marketValues: AccountMarketValue[],
): { assets: number; liabilities: number; netWorth: number } {
  const values = new Map(marketValues.map((mv) => [mv.accountId, mv.marketValueCents]));
  let assets = 0;
  let liabilities = 0;
  for (const account of accounts) {
    if (!account.isActive || account.isInvestmentCash) continue;
    const balance = effectiveBalance(account, accounts, values);
    if (account.type === "asset") assets += getDisplayBalance(balance, "asset");
    if (account.type === "liability") liabilities += getDisplayBalance(balance, "liability");
  }
  return { assets, liabilities, netWorth: assets - liabilities };
}
