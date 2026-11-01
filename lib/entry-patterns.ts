import { getAccountShortName } from "@/lib/wasm-client";
import type { EntryPattern } from "@/lib/typesafe/types";
import type { AccountWithBalance, SplitInput } from "@/types";

export type PatternFill =
  | { mode: "simple"; fromAccountId: number; toAccountId: number; amount: string }
  | { mode: "journal"; splits: SplitInput[] };

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** The form fields of a pattern. The amount is filled only when it repeats. */
export function fillFromPattern(pattern: EntryPattern, accountId: number): PatternFill {
  const others = pattern.splits.filter((split) => split.accountId !== accountId);
  const net = pattern.splits
    .filter((split) => split.accountId === accountId)
    .reduce((sum, split) => sum + split.amount, 0);
  if (others.length === 1) {
    const other = others[0].accountId;
    const amount = pattern.stable ? (Math.abs(net) / 100).toFixed(2) : "";
    return net <= 0
      ? { mode: "simple", fromAccountId: accountId, toAccountId: other, amount }
      : { mode: "simple", fromAccountId: other, toAccountId: accountId, amount };
  }
  // The pattern's splits. Their amounts give the direction of each line; they
  // are the amounts to fill only when the pattern is stable.
  return {
    mode: "journal",
    splits: pattern.splits.map((split) => ({ accountId: split.accountId, amount: split.amount })),
  };
}

/** "usually $31.20–$42.10" for an amount that does not repeat. */
export function rangeHint(pattern: EntryPattern): string | null {
  if (pattern.stable) return null;
  const { min, max } = pattern.range;
  return min === max ? `usually ${dollars(min)}` : `usually ${dollars(min)}–${dollars(max)}`;
}

/** "Groceries, Sales Tax": the other accounts of a pattern. */
export function patternAccounts(pattern: EntryPattern, accounts: AccountWithBalance[], accountId: number): string {
  return pattern.splits
    .filter((split) => split.accountId !== accountId)
    .map((split) => {
      const account = accounts.find((candidate) => candidate.id === split.accountId);
      return account ? getAccountShortName(account.name) : "Account";
    })
    .join(", ");
}

/** "Groceries · $42.10": the other accounts, then the amount or the range. */
export function patternLabel(pattern: EntryPattern, accounts: AccountWithBalance[], accountId: number): string {
  const { min, max } = pattern.range;
  // A stable pattern fills its latest amount, which can differ from the range.
  const latest = Math.abs(
    pattern.splits.filter((split) => split.accountId === accountId).reduce((sum, split) => sum + split.amount, 0),
  );
  const amount = pattern.stable ? dollars(latest) : min === max ? dollars(max) : `${dollars(min)}–${dollars(max)}`;
  return `${patternAccounts(pattern, accounts, accountId)} · ${amount}`;
}

/**
 * The accounts and the direction of the net amount on each: a refund is not
 * the same entry. An account whose lines sum to 0 has no direction.
 */
const key = (splits: SplitInput[]) => {
  const net = new Map<number, number>();
  for (const split of splits) net.set(split.accountId, (net.get(split.accountId) ?? 0) + split.amount);
  return [...net]
    .map(([accountId, amount]) => `${accountId}:${amount < 0 ? "out" : amount > 0 ? "in" : "none"}`)
    .sort()
    .join(",");
};
const amounts = (splits: SplitInput[]) =>
  [...splits].sort((a, b) => a.accountId - b.accountId || a.amount - b.amount).map((split) => `${split.accountId}:${split.amount}`).join(",");

/** What the user did with the fill, from the splits that were saved. */
export function outcomeOf(
  fill: PatternFill,
  saved: SplitInput[],
  amountFilled: boolean,
  pickedFromChip: boolean,
): "kept" | "changed_amount" | "picked_other" | "changed_accounts" {
  // A simple fill without an amount still has a direction: To gains, From
  // loses. 1 cent stands for the amount in the direction check.
  let filled: SplitInput[];
  if (fill.mode === "simple") {
    const cents = Math.round(Number(fill.amount || 0) * 100) || 1;
    filled = [
      { accountId: fill.toAccountId, amount: cents },
      { accountId: fill.fromAccountId, amount: -cents },
    ];
  } else {
    filled = fill.splits;
  }
  if (key(filled) !== key(saved)) return "changed_accounts";
  if (pickedFromChip) return "picked_other";
  if (amountFilled && amounts(filled) !== amounts(saved)) return "changed_amount";
  return "kept";
}
