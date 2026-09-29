import { describe, expect, it } from "vitest";
import {
  buildBuySplits,
  evaluateExpression,
  flattenAccounts,
  getInvestmentGrossAmountCents,
  formatCurrency,
  getEffectiveDate,
  getNextDate,
  accountHierarchyNames,
  descendantAccountIds,
  ACCOUNT_TYPE_LABELS,
  ACCOUNT_SUBTYPE_LABELS,
  validateSplits,
} from "@/lib/wasm-client";
import { getInvestmentGrossAmountCents as originalGrossAmount, ACCOUNT_TYPE_LABELS as originalTypes, ACCOUNT_SUBTYPE_LABELS as originalSubtypes } from "@/lib/accounting";
import { formatCurrency as originalFormatCurrency, toDateString } from "@/lib/formatters";

describe("browser WASM core in Node", () => {
  it("validates whole-cent balanced splits synchronously", () => {
    expect(validateSplits([{ amount: 125 }, { amount: -125 }])).toBe(true);
    expect(validateSplits([{ amount: 3.5 }, { amount: -3.5 }])).toBe(false);
    expect(validateSplits([{ amount: 125 }, { amount: -124 }])).toBe(false);
  });

  it("keeps investment cents, recurrence, and expression behavior", () => {
    expect(buildBuySplits({ securityAccountId: 1, cashAccountId: 2,
      sharesMicros: 1_000_000, priceMicros: 2_500_000 })).toEqual([
      { accountId: 1, amount: 250 }, { accountId: 2, amount: -250 },
    ]);
    expect(getNextDate("2026-01-31", { frequency: "monthly", interval: 1 })).toBe("2026-02-28");
    expect(evaluateExpression("2 * (3 + 4)")).toBe(14);
    expect(formatCurrency(-125)).toBe("−$1.25");
  });

  it("preserves account data and settled dates", () => {
    const accounts = [{ id: 1, name: "Cash", type: "asset", balance: 10, children: [] }];
    expect(flattenAccounts(accounts as unknown as Parameters<typeof flattenAccounts>[0])).toEqual(accounts);
    expect(getEffectiveDate({ date: "2026-01-02", isFloating: false })).toBe("2026-01-02");
    expect(getEffectiveDate({ date: "2026-01-02", isFloating: true }))
      .toBe(toDateString(new Date()));
  });

  it("keeps editable and out-of-range amounts renderable", () => {
    for (const value of [1.5, 1e19, NaN, undefined]) {
      expect(formatCurrency(value as number)).toBe(originalFormatCurrency(value as number));
    }
    expect(getInvestmentGrossAmountCents(1_000_000, 1e19))
      .toBe(originalGrossAmount(1_000_000, 1e19));
    expect(getInvestmentGrossAmountCents(1.5, 2_500_000))
      .toBe(originalGrossAmount(1.5, 2_500_000));
    expect(getInvestmentGrossAmountCents(NaN, 1_000_000)).toBe(0);
    expect(formatCurrency(getInvestmentGrossAmountCents(9e15, 9e15)))
      .toBe(originalFormatCurrency(originalGrossAmount(9e15, 9e15)));
  });

  it("batches account lookups and derives every label from Rust tables", () => {
    const accounts = [
      { id: 1, name: "Assets", parentId: null },
      { id: 2, name: "Assets:Checking", parentId: 1 },
      { id: 3, name: "Assets:Checking:Cash", parentId: 2 },
    ];
    expect(accountHierarchyNames(accounts).get(3)).toBe("Assets : Checking : Cash");
    expect(descendantAccountIds(1, accounts)).toEqual(new Set([2, 3]));
    expect(ACCOUNT_TYPE_LABELS).toEqual(originalTypes);
    expect(ACCOUNT_SUBTYPE_LABELS).toEqual(originalSubtypes);
  });
});
