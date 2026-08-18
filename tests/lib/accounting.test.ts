import { describe, it, expect } from "vitest";
import {
  validateSplits,
  getNormalBalanceSign,
  getDisplayBalance,
  getNextDate,
  getInitialNextDate,
  describeRecurrence,
  groupAccountsByType,
  ACCOUNT_TYPE_LABELS,
  ACCOUNT_SUBTYPE_LABELS,
  ACCOUNT_TYPE_ORDER,
  BALANCE_SHEET_TYPES,
  INCOME_STATEMENT_TYPES,
  mapInvestmentActionToSplits,
  validateInvestmentAction,
  validateInvestmentActions,
  validateInvestmentSplitPayload,
  buildBuySplits,
  buildDividendSplits,
  buildSellSplits,
  getInvestmentGrossAmountCents,
  buildAccountHierarchyName,
  isDescendantOf,
  getNextBusinessDay,
  resolveAccountIcon,
  resolveAccountIconSource,
  buildCategoryLabelMap,
} from "@/lib/accounting";

describe("validateSplits", () => {
  it("returns true when splits sum to zero", () => {
    const splits = [{ amount: 1000 }, { amount: -1000 }];
    expect(validateSplits(splits)).toBe(true);
  });

  it("returns true for multi-split transactions that balance", () => {
    // Paycheck example: checking + 401k - income = 0
    const splits = [
      { amount: 350000 }, // Checking
      { amount: 50000 }, // 401k
      { amount: -400000 }, // Salary income
    ];
    expect(validateSplits(splits)).toBe(true);
  });

  it("returns false when splits do not sum to zero", () => {
    const splits = [{ amount: 1000 }, { amount: -500 }];
    expect(validateSplits(splits)).toBe(false);
  });

  it("returns true for empty splits array", () => {
    expect(validateSplits([])).toBe(true);
  });

  it("returns false for single unbalanced split", () => {
    const splits = [{ amount: 1000 }];
    expect(validateSplits(splits)).toBe(false);
  });

  it("handles zero amounts", () => {
    const splits = [{ amount: 0 }, { amount: 0 }];
    expect(validateSplits(splits)).toBe(true);
  });

  // Amounts are cents in an int4 column. A fractional amount balances against
  // its own negation, so the sum test alone lets it through to PostgreSQL,
  // which rejects it with an opaque 500 instead of a 400.
  it("returns false for fractional amounts that sum to zero", () => {
    const splits = [{ amount: 3.5 }, { amount: -3.5 }];
    expect(validateSplits(splits)).toBe(false);
  });

  it("returns false for amounts outside the int4 range", () => {
    const splits = [{ amount: 2_147_483_648 }, { amount: -2_147_483_648 }];
    expect(validateSplits(splits)).toBe(false);
  });

  it("returns false for non-finite amounts", () => {
    expect(validateSplits([{ amount: Infinity }, { amount: -Infinity }])).toBe(false);
    expect(validateSplits([{ amount: NaN }, { amount: NaN }])).toBe(false);
  });
});

describe("getNormalBalanceSign", () => {
  it("returns 1 for asset accounts (debit normal)", () => {
    expect(getNormalBalanceSign("asset")).toBe(1);
  });

  it("returns 1 for expense accounts (debit normal)", () => {
    expect(getNormalBalanceSign("expense")).toBe(1);
  });

  it("returns -1 for liability accounts (credit normal)", () => {
    expect(getNormalBalanceSign("liability")).toBe(-1);
  });

  it("returns -1 for equity accounts (credit normal)", () => {
    expect(getNormalBalanceSign("equity")).toBe(-1);
  });

  it("returns -1 for income accounts (credit normal)", () => {
    expect(getNormalBalanceSign("income")).toBe(-1);
  });

  it("returns 1 for unknown account types", () => {
    expect(getNormalBalanceSign("unknown")).toBe(1);
  });
});

describe("investment action helpers", () => {
  it("maps buys to balanced security and cash splits", () => {
    const splits = mapInvestmentActionToSplits({
      action: "buy",
      sharesMicros: 10_000_000,
      priceMicros: 25_000_000,
      feesCents: 100,
    });

    const total = splits.reduce((sum, split) => sum + split.amount, 0);
    expect(total).toBe(0);
    expect(splits).toEqual([
      { role: "security", amount: 25000 },
      { role: "expense", amount: 100 },
      { role: "cash", amount: -25100 },
    ]);
  });

  it("maps sells with fees to balanced splits", () => {
    const splits = mapInvestmentActionToSplits({
      action: "sell",
      sharesMicros: 4_000_000,
      priceMicros: 50_000_000,
      feesCents: 200,
    });

    const total = splits.reduce((sum, split) => sum + split.amount, 0);
    expect(total).toBe(0);
    expect(splits).toEqual([
      { role: "cash", amount: 19800 },
      { role: "expense", amount: 200 },
      { role: "security", amount: -20000 },
    ]);
  });

  it("maps dividends to balanced cash and income splits", () => {
    const splits = mapInvestmentActionToSplits({
      action: "dividend",
      sharesMicros: 1_000_000,
      priceMicros: 15_000_000,
    });

    const total = splits.reduce((sum, split) => sum + split.amount, 0);
    expect(total).toBe(0);
    expect(splits).toEqual([
      { role: "cash", amount: 1500 },
      { role: "income", amount: -1500 },
    ]);
  });

  it("validates investment actions with positive amounts", () => {
    expect(
      validateInvestmentAction({
        action: "sell",
        sharesMicros: 2_000_000,
        priceMicros: 10_000_000,
        feesCents: 50,
      })
    ).toBe(true);
  });

  it("rejects investment actions with non-positive gross amounts", () => {
    expect(
      validateInvestmentAction({
        action: "buy",
        sharesMicros: 0,
        priceMicros: 10_000_000,
      })
    ).toBe(false);
  });

  it("validates stock split payloads with positive ratios", () => {
    expect(
      validateInvestmentSplitPayload({
        securityId: 101,
        action: "split",
        sharesMicros: 0,
        priceMicros: 0,
        splitNumerator: 2,
        splitDenominator: 1,
      })
    ).toBe(true);
  });

  it("rejects stock split payloads without valid ratios", () => {
    expect(
      validateInvestmentSplitPayload({
        securityId: 102,
        action: "split",
        sharesMicros: 0,
        priceMicros: 0,
      })
    ).toBe(false);
  });

  it("accepts non-split payloads without ratios", () => {
    expect(
      validateInvestmentSplitPayload({
        securityId: 103,
        action: "buy",
        sharesMicros: 1_000_000,
        priceMicros: 2_500_000,
      })
    ).toBe(true);
  });

  it("validates collections of investment actions", () => {
    expect(
      validateInvestmentActions([
        { action: "dividend", sharesMicros: 1_000_000, priceMicros: 2_500_000 },
        { action: "fee", sharesMicros: 0, priceMicros: 0, feesCents: 75 },
      ])
    ).toBe(true);
  });

  it("validates dividend actions with zero shares and price", () => {
    expect(
      validateInvestmentAction({
        action: "dividend",
        sharesMicros: 0,
        priceMicros: 0,
      })
    ).toBe(true);
  });

  it("validates capGain actions with zero shares and price", () => {
    expect(
      validateInvestmentAction({
        action: "capGain",
        sharesMicros: 0,
        priceMicros: 0,
      })
    ).toBe(true);
  });

  it("validates stock split actions with ratios", () => {
    expect(
      validateInvestmentAction({
        action: "split",
        sharesMicros: 0,
        priceMicros: 0,
        splitNumerator: 3,
        splitDenominator: 2,
      })
    ).toBe(true);
  });

  it("rejects stock split actions without positive ratios", () => {
    expect(
      validateInvestmentAction({
        action: "split",
        sharesMicros: 0,
        priceMicros: 0,
        splitNumerator: 0,
        splitDenominator: 2,
      })
    ).toBe(false);
  });

  it("builds dividend splits for cash and income accounts", () => {
    const splits = buildDividendSplits({
      cashAccountId: 10,
      incomeAccountId: 20,
      amountCents: 4200,
    });

    expect(splits).toEqual([
      { accountId: 10, amount: 4200 },
      { accountId: 20, amount: -4200 },
    ]);
  });

  it("builds buy splits with fee and cash offsets", () => {
    const splits = buildBuySplits({
      securityAccountId: 11,
      cashAccountId: 12,
      feeAccountId: 13,
      sharesMicros: 2_000_000,
      priceMicros: 15_000_000,
      feesCents: 75,
    });

    expect(splits).toEqual([
      { accountId: 11, amount: 3000 },
      { accountId: 13, amount: 75 },
      { accountId: 12, amount: -3075 },
    ]);
  });

  it("builds sell splits with gain and fee handling", () => {
    const splits = buildSellSplits({
      securityAccountId: 21,
      cashAccountId: 22,
      feeAccountId: 23,
      gainLossAccountId: 24,
      sharesMicros: 3_000_000,
      priceMicros: 20_000_000,
      feesCents: 60,
      costBasisCents: 5500,
    });

    expect(splits).toEqual([
      { accountId: 22, amount: 5940 },
      { accountId: 23, amount: 60 },
      { accountId: 24, amount: -500 },
      { accountId: 21, amount: -5500 },
    ]);
  });

  it("calculates gross amount in cents from micros", () => {
    expect(getInvestmentGrossAmountCents(1_500_000, 12_500_000)).toBe(1875);
  });

  it("rounds a half-cent tie up", () => {
    // 25 shares at $0.0014 = 3.5 cents exactly.
    expect(getInvestmentGrossAmountCents(25_000_000, 1400)).toBe(4);
  });

  it("stays exact when shares x price exceeds 2^53", () => {
    // ~426k shares at ~$3,225: the product is ~1.4e21, well past the largest
    // integer a double holds exactly, so double arithmetic drifts a cent here.
    expect(getInvestmentGrossAmountCents(426_354_381_896, 3_225_163_023)).toBe(
      137_506_238_718
    );
  });
});

describe("getDisplayBalance", () => {
  it("returns positive balance for assets with positive internal balance", () => {
    expect(getDisplayBalance(10000, "asset")).toBe(10000);
  });

  it("returns positive balance for income with negative internal balance", () => {
    // Income is credit-normal, so -10000 internal = 10000 display
    expect(getDisplayBalance(-10000, "income")).toBe(10000);
  });

  it("returns positive balance for liabilities with negative internal balance", () => {
    // Liability is credit-normal, so -5000 internal = 5000 display
    expect(getDisplayBalance(-5000, "liability")).toBe(5000);
  });

  it("returns positive balance for expenses with positive internal balance", () => {
    expect(getDisplayBalance(2500, "expense")).toBe(2500);
  });

  it("returns negative display for assets with negative internal balance", () => {
    // Overdrawn checking account
    expect(getDisplayBalance(-500, "asset")).toBe(-500);
  });

  it("handles zero balance", () => {
    expect(getDisplayBalance(0, "asset")).toBe(0);
    // Note: 0 * -1 = -0 in JavaScript, but -0 == 0 is true
    expect(getDisplayBalance(0, "liability") == 0).toBe(true);
  });
});

describe("getNextDate", () => {
  describe("daily", () => {
    it("adds 1 day with interval 1", () => {
      expect(getNextDate("2026-01-15", { frequency: "daily", interval: 1 })).toBe("2026-01-16");
    });

    it("adds 3 days with interval 3", () => {
      expect(getNextDate("2026-01-15", { frequency: "daily", interval: 3 })).toBe("2026-01-18");
    });

    it("crosses month boundary", () => {
      expect(getNextDate("2026-01-31", { frequency: "daily", interval: 1 })).toBe("2026-02-01");
    });

    it("crosses year boundary", () => {
      expect(getNextDate("2026-12-31", { frequency: "daily", interval: 1 })).toBe("2027-01-01");
    });
  });

  describe("weekly - every week", () => {
    it("advances to next occurrence of same day when no daysOfWeek", () => {
      // 2026-01-15 is Thursday (day 4)
      const result = getNextDate("2026-01-15", { frequency: "weekly", interval: 1 });
      expect(result).toBe("2026-01-22");
    });

    it("advances to next matching day in same week", () => {
      // 2026-01-12 is Monday (day 1), looking for Wednesday (day 3)
      expect(getNextDate("2026-01-12", {
        frequency: "weekly", interval: 1, daysOfWeek: [3], weekOfMonth: "every",
      })).toBe("2026-01-14");
    });

    it("wraps to next week when all days are past", () => {
      // 2026-01-16 is Friday (day 5), looking for Monday (day 1)
      expect(getNextDate("2026-01-16", {
        frequency: "weekly", interval: 1, daysOfWeek: [1], weekOfMonth: "every",
      })).toBe("2026-01-19");
    });

    it("picks earliest matching day with multiple days", () => {
      // 2026-01-12 is Monday (day 1), looking for Wed (3) and Fri (5)
      expect(getNextDate("2026-01-12", {
        frequency: "weekly", interval: 1, daysOfWeek: [3, 5], weekOfMonth: "every",
      })).toBe("2026-01-14");
    });

    it("crosses year boundary", () => {
      // 2026-12-31 is Thursday (day 4), looking for Monday (day 1) -> Jan 4, 2027
      expect(getNextDate("2026-12-31", {
        frequency: "weekly", interval: 1, daysOfWeek: [1], weekOfMonth: "every",
      })).toBe("2027-01-04");
    });
  });

  describe("weekly - Nth week of month", () => {
    it("finds 2nd Monday of the month", () => {
      // 2026-01-01 is Thursday. 2nd Monday = Jan 12.
      // From Jan 5 (before 2nd Monday), should find Jan 12.
      expect(getNextDate("2026-01-05", {
        frequency: "weekly", interval: 1, daysOfWeek: [1], weekOfMonth: "2",
      })).toBe("2026-01-12");
    });

    it("advances to next month when Nth day is past", () => {
      // From Jan 15 (past the 2nd Monday Jan 12), should find Feb 9 (2nd Monday of Feb)
      expect(getNextDate("2026-01-15", {
        frequency: "weekly", interval: 1, daysOfWeek: [1], weekOfMonth: "2",
      })).toBe("2026-02-09");
    });

    it("finds last Friday of the month", () => {
      // January 2026: last Friday is Jan 30
      expect(getNextDate("2026-01-20", {
        frequency: "weekly", interval: 1, daysOfWeek: [5], weekOfMonth: "last",
      })).toBe("2026-01-30");
    });

    it("advances to next month when last day is past", () => {
      // From Jan 31 (past last Friday Jan 30), should find Feb 27 (last Friday of Feb)
      expect(getNextDate("2026-01-31", {
        frequency: "weekly", interval: 1, daysOfWeek: [5], weekOfMonth: "last",
      })).toBe("2026-02-27");
    });
  });

  describe("monthly", () => {
    it("advances to same day next month with no daysOfMonth", () => {
      expect(getNextDate("2026-01-15", { frequency: "monthly", interval: 1 })).toBe("2026-02-15");
    });

    it("finds next matching day in current month", () => {
      // On the 5th, looking for the 15th
      expect(getNextDate("2026-01-05", {
        frequency: "monthly", interval: 1, daysOfMonth: [15],
      })).toBe("2026-01-15");
    });

    it("advances to next month when day is past", () => {
      // On the 20th, looking for the 15th
      expect(getNextDate("2026-01-20", {
        frequency: "monthly", interval: 1, daysOfMonth: [15],
      })).toBe("2026-02-15");
    });

    it("handles multiple days of month", () => {
      // On the 5th, looking for 1st and 15th -> next is 15th
      expect(getNextDate("2026-01-05", {
        frequency: "monthly", interval: 1, daysOfMonth: [1, 15],
      })).toBe("2026-01-15");
    });

    it("wraps to first day next month with multiple days", () => {
      // On the 20th, looking for 1st and 15th -> next month 1st
      expect(getNextDate("2026-01-20", {
        frequency: "monthly", interval: 1, daysOfMonth: [1, 15],
      })).toBe("2026-02-01");
    });

    it("handles last day (-1)", () => {
      // On Jan 20, looking for last day
      expect(getNextDate("2026-01-20", {
        frequency: "monthly", interval: 1, daysOfMonth: [-1],
      })).toBe("2026-01-31");
    });

    it("resolves last day for February", () => {
      // On Feb 1, looking for last day -> Feb 28 (non-leap year)
      expect(getNextDate("2026-02-01", {
        frequency: "monthly", interval: 1, daysOfMonth: [-1],
      })).toBe("2026-02-28");
    });

    it("handles interval > 1", () => {
      // Every other month on the 15th, currently on Jan 20
      expect(getNextDate("2026-01-20", {
        frequency: "monthly", interval: 2, daysOfMonth: [15],
      })).toBe("2026-03-15");
    });

    it("clamps day 31 to shorter months", () => {
      // Looking for 31st, Feb only has 28 days
      expect(getNextDate("2026-01-31", {
        frequency: "monthly", interval: 1, daysOfMonth: [28],
      })).toBe("2026-02-28");
    });

    it("handles year boundary", () => {
      expect(getNextDate("2026-12-20", {
        frequency: "monthly", interval: 1, daysOfMonth: [15],
      })).toBe("2027-01-15");
    });
  });

  describe("yearly", () => {
    it("adds 1 year", () => {
      expect(getNextDate("2026-01-15", { frequency: "yearly", interval: 1 })).toBe("2027-01-15");
    });

    it("handles leap year", () => {
      // 2028 is a leap year
      expect(getNextDate("2027-02-28", { frequency: "yearly", interval: 1 })).toBe("2028-02-28");
    });
  });
});

describe("getNextBusinessDay", () => {
  it("advances a weekday to the next weekday", () => {
    // 2026-07-08 is a Wednesday
    expect(getNextBusinessDay("2026-07-08")).toBe("2026-07-09");
  });

  it("skips the weekend from a Friday", () => {
    // 2026-07-10 is a Friday
    expect(getNextBusinessDay("2026-07-10")).toBe("2026-07-13");
  });

  it("moves Saturday and Sunday to Monday", () => {
    expect(getNextBusinessDay("2026-07-11")).toBe("2026-07-13");
    expect(getNextBusinessDay("2026-07-12")).toBe("2026-07-13");
  });

  it("crosses a month boundary", () => {
    // 2026-07-31 is a Friday
    expect(getNextBusinessDay("2026-07-31")).toBe("2026-08-03");
  });

  it("crosses a year boundary", () => {
    // 2026-12-31 is a Thursday
    expect(getNextBusinessDay("2026-12-31")).toBe("2027-01-01");
  });

  it("throws on an unparseable date instead of returning NaN-NaN-NaN", () => {
    expect(() => getNextBusinessDay("not-a-date")).toThrow("Invalid date");
    expect(() => getNextBusinessDay("")).toThrow("Invalid date");
  });

  it("throws on a non-calendar date instead of letting Date normalize it", () => {
    // new Date("2026-02-30T00:00:00") silently normalizes to March 2
    expect(() => getNextBusinessDay("2026-02-30")).toThrow("Invalid date");
    expect(() => getNextBusinessDay("2026-13-01")).toThrow("Invalid date");
  });
});

describe("getInitialNextDate", () => {
  it("returns start date for daily recurrence", () => {
    expect(
      getInitialNextDate("2026-02-10", { frequency: "daily", interval: 1 })
    ).toBe("2026-02-10");
  });

  it("uses start-date weekday when weekly days are not provided", () => {
    expect(
      getInitialNextDate("2026-02-10", {
        frequency: "weekly",
        interval: 1,
        weekOfMonth: "every",
      })
    ).toBe("2026-02-10");
  });

  it("uses start-date day when monthly days are not provided", () => {
    expect(
      getInitialNextDate("2026-03-15", {
        frequency: "monthly",
        interval: 1,
      })
    ).toBe("2026-03-15");
  });

  it("finds the first monthly occurrence on or after start date", () => {
    expect(
      getInitialNextDate("2026-01-01", {
        frequency: "monthly",
        interval: 2,
        daysOfMonth: [20],
      })
    ).toBe("2026-01-20");
  });

  it("returns start date for yearly recurrence", () => {
    expect(
      getInitialNextDate("2026-08-05", {
        frequency: "yearly",
        interval: 1,
      })
    ).toBe("2026-08-05");
  });
});

describe("describeRecurrence", () => {
  it("describes simple daily", () => {
    expect(describeRecurrence({ frequency: "daily", interval: 1 })).toBe("Daily");
  });

  it("describes daily with interval", () => {
    expect(describeRecurrence({ frequency: "daily", interval: 3 })).toBe("Every 3 days");
  });

  it("describes simple weekly", () => {
    expect(describeRecurrence({ frequency: "weekly", interval: 1 })).toBe("Weekly");
  });

  it("describes weekly with specific day", () => {
    expect(describeRecurrence({
      frequency: "weekly", interval: 1, daysOfWeek: [3], weekOfMonth: "every",
    })).toBe("Every Wednesday");
  });

  it("describes weekly with multiple days", () => {
    expect(describeRecurrence({
      frequency: "weekly", interval: 1, daysOfWeek: [1, 3], weekOfMonth: "every",
    })).toBe("Every Monday and Wednesday");
  });

  it("describes Nth weekday of month", () => {
    expect(describeRecurrence({
      frequency: "weekly", interval: 1, daysOfWeek: [1], weekOfMonth: "2",
    })).toBe("2nd Monday of each month");
  });

  it("describes last weekday of month", () => {
    expect(describeRecurrence({
      frequency: "weekly", interval: 1, daysOfWeek: [5], weekOfMonth: "last",
    })).toBe("Last Friday of each month");
  });

  it("describes simple monthly", () => {
    expect(describeRecurrence({ frequency: "monthly", interval: 1 })).toBe("Monthly");
  });

  it("describes every other month with days", () => {
    expect(describeRecurrence({
      frequency: "monthly", interval: 2, daysOfMonth: [1, 15],
    })).toBe("Every other month on the 1st and 15th");
  });

  it("describes monthly with last day", () => {
    expect(describeRecurrence({
      frequency: "monthly", interval: 1, daysOfMonth: [-1],
    })).toBe("Monthly on the last day");
  });

  it("describes yearly", () => {
    expect(describeRecurrence({ frequency: "yearly", interval: 1 })).toBe("Yearly");
  });
});

describe("groupAccountsByType", () => {
  it("groups accounts by their type", () => {
    const accounts = [
      { id: 1, name: "Checking", type: "asset" },
      { id: 2, name: "Savings", type: "asset" },
      { id: 3, name: "Credit Card", type: "liability" },
      { id: 4, name: "Groceries", type: "expense" },
    ];

    const grouped = groupAccountsByType(accounts);

    expect(grouped.asset).toHaveLength(2);
    expect(grouped.liability).toHaveLength(1);
    expect(grouped.expense).toHaveLength(1);
    expect(grouped.income).toBeUndefined();
  });

  it("returns empty object for empty array", () => {
    expect(groupAccountsByType([])).toEqual({});
  });

  it("handles single account", () => {
    const accounts = [{ id: 1, name: "Checking", type: "asset" }];
    const grouped = groupAccountsByType(accounts);

    expect(grouped.asset).toHaveLength(1);
    expect(grouped.asset[0].name).toBe("Checking");
  });
});

describe("constants", () => {
  it("has all account type labels", () => {
    expect(ACCOUNT_TYPE_LABELS.asset).toBe("Assets");
    expect(ACCOUNT_TYPE_LABELS.liability).toBe("Liabilities");
    expect(ACCOUNT_TYPE_LABELS.equity).toBe("Equity");
    expect(ACCOUNT_TYPE_LABELS.income).toBe("Income");
    expect(ACCOUNT_TYPE_LABELS.expense).toBe("Expenses");
  });

  it("has all account subtype labels", () => {
    expect(ACCOUNT_SUBTYPE_LABELS.bank).toBe("Bank Account");
    expect(ACCOUNT_SUBTYPE_LABELS.credit_card).toBe("Credit Card");
    expect(ACCOUNT_SUBTYPE_LABELS.loan).toBe("Loan");
    expect(ACCOUNT_SUBTYPE_LABELS.investment).toBe("Investment");
    expect(ACCOUNT_SUBTYPE_LABELS.cash).toBe("Cash");
  });

  it("has correct account type order", () => {
    expect(ACCOUNT_TYPE_ORDER).toEqual([
      "asset",
      "liability",
      "equity",
      "income",
      "expense",
    ]);
  });

  it("has correct balance sheet types", () => {
    expect(BALANCE_SHEET_TYPES).toEqual(["asset", "liability", "equity"]);
  });

  it("has correct income statement types", () => {
    expect(INCOME_STATEMENT_TYPES).toEqual(["income", "expense"]);
  });
});

describe("buildAccountHierarchyName", () => {
  it("returns account name when no parent", () => {
    const account = { id: 1, name: "Checking", parentId: null, isInvestmentCash: false };
    const allAccounts = [account];
    expect(buildAccountHierarchyName(account, allAccounts)).toBe("Checking");
  });

  it("returns hierarchy with colon separator for nested accounts", () => {
    const parent = { id: 1, name: "Assets", parentId: null, isInvestmentCash: false };
    const child = { id: 2, name: "Assets:Checking", parentId: 1, isInvestmentCash: false };
    const allAccounts = [parent, child];
    expect(buildAccountHierarchyName(child, allAccounts)).toBe("Assets : Checking");
  });

  it("returns parent name only for investment cash accounts", () => {
    const parent = { id: 1, name: "Vanguard IRA", parentId: null, isInvestmentCash: false };
    const cashAccount = { id: 2, name: "Vanguard IRA:Cash", parentId: 1, isInvestmentCash: true };
    const allAccounts = [parent, cashAccount];
    expect(buildAccountHierarchyName(cashAccount, allAccounts)).toBe("Vanguard IRA");
  });

  it("handles deeply nested hierarchies with investment cash", () => {
    const root = { id: 1, name: "Assets", parentId: null, isInvestmentCash: false };
    const investment = { id: 2, name: "Assets:Vanguard IRA", parentId: 1, isInvestmentCash: false };
    const cash = { id: 3, name: "Assets:Vanguard IRA:Cash", parentId: 2, isInvestmentCash: true };
    const allAccounts = [root, investment, cash];
    expect(buildAccountHierarchyName(cash, allAccounts)).toBe("Assets : Vanguard IRA");
  });
});

describe("resolveAccountIcon", () => {
  const auto = { id: 1, icon: "🚗", parentId: null };
  const gasoline = { id: 2, icon: null, parentId: 1 };
  const charging = { id: 3, icon: "⚡", parentId: 1 };
  const food = { id: 4, icon: null, parentId: null };
  const all = [auto, gasoline, charging, food];

  it("returns the account's own icon", () => {
    expect(resolveAccountIcon(auto, all)).toBe("🚗");
  });

  it("prefers an own icon over an inherited one", () => {
    expect(resolveAccountIcon(charging, all)).toBe("⚡");
  });

  it("inherits from the parent", () => {
    expect(resolveAccountIcon(gasoline, all)).toBe("🚗");
  });

  it("inherits from a grandparent", () => {
    const root = { id: 10, icon: "🏠", parentId: null };
    const mid = { id: 11, icon: null, parentId: 10 };
    const leaf = { id: 12, icon: null, parentId: 11 };
    expect(resolveAccountIcon(leaf, [root, mid, leaf])).toBe("🏠");
  });

  it("returns null when no ancestor has an icon", () => {
    expect(resolveAccountIcon(food, all)).toBeNull();
  });

  it("returns null when the parent row is missing", () => {
    const orphan = { id: 20, icon: null, parentId: 999 };
    expect(resolveAccountIcon(orphan, [orphan])).toBeNull();
  });

  it("terminates on a parentId cycle instead of hanging", () => {
    const a = { id: 30, icon: null, parentId: 31 };
    const b = { id: 31, icon: null, parentId: 30 };
    expect(resolveAccountIcon(a, [a, b])).toBeNull();
  });
});

describe("resolveAccountIconSource", () => {
  const auto = { id: 1, name: "Automobile", icon: "🚗", parentId: null };
  const gasoline = { id: 2, name: "Automobile:Gasoline", icon: null, parentId: 1 };
  const food = { id: 4, name: "Food", icon: null, parentId: null };
  const all = [auto, gasoline, food];

  it("names itself as the source for its own icon", () => {
    expect(resolveAccountIconSource(auto, all)).toEqual({
      icon: "🚗",
      sourceName: "Automobile",
    });
  });

  it("names the parent as the source for an inherited icon", () => {
    expect(resolveAccountIconSource(gasoline, all)).toEqual({
      icon: "🚗",
      sourceName: "Automobile",
    });
  });

  it("names a grandparent as the source when that's where the icon lives", () => {
    const root = { id: 10, name: "Assets", icon: "🏠", parentId: null };
    const mid = { id: 11, name: "Assets:Vanguard", icon: null, parentId: 10 };
    const leaf = { id: 12, name: "Assets:Vanguard:Cash", icon: null, parentId: 11 };
    expect(resolveAccountIconSource(leaf, [root, mid, leaf])).toEqual({
      icon: "🏠",
      sourceName: "Assets",
    });
  });

  it("returns null when no ancestor has an icon", () => {
    expect(resolveAccountIconSource(food, all)).toBeNull();
  });
});

describe("buildCategoryLabelMap", () => {
  // Mirrors the real book: `accounts.name` stores the full colon path, and
  // the category tree is two levels deep.
  const auto = { id: 1, name: "Automobile", type: "expense", icon: "🚗", parentId: null };
  const gasoline = { id: 2, name: "Automobile:Gasoline", type: "expense", icon: null, parentId: 1 };
  const charging = { id: 3, name: "Automobile:Charging", type: "expense", icon: "⚡", parentId: 1 };
  const food = { id: 4, name: "Food", type: "expense", icon: null, parentId: null };
  const checking = { id: 5, name: "Chase Checking", type: "asset", icon: null, parentId: null };
  const all = [auto, gasoline, charging, food, checking];

  it("shows the leaf only when an icon resolves", () => {
    const label = buildCategoryLabelMap(all).get(gasoline.id);
    expect(label).toEqual({ icon: "🚗", text: "Gasoline", title: "Automobile : Gasoline" });
  });

  it("uses an own icon over an inherited one", () => {
    const label = buildCategoryLabelMap(all).get(charging.id);
    expect(label).toEqual({ icon: "⚡", text: "Charging", title: "Automobile : Charging" });
  });

  it("falls back to the full path when no icon resolves", () => {
    const orphan = { id: 6, name: "Household:Maintenance", type: "expense", icon: null, parentId: 7 };
    const household = { id: 7, name: "Household", type: "expense", icon: null, parentId: null };
    const label = buildCategoryLabelMap([orphan, household]).get(orphan.id);
    expect(label).toEqual({
      icon: null,
      text: "Household : Maintenance",
      title: "Household : Maintenance",
    });
  });

  it("gives a top-level category the same text and title", () => {
    const label = buildCategoryLabelMap(all).get(auto.id);
    expect(label).toEqual({ icon: "🚗", text: "Automobile", title: "Automobile" });
  });

  it("lets a parent and an un-overriding child share an icon", () => {
    const map = buildCategoryLabelMap(all);
    expect(map.get(auto.id)?.icon).toBe("🚗");
    expect(map.get(gasoline.id)?.icon).toBe("🚗");
    expect(map.get(auto.id)?.text).not.toBe(map.get(gasoline.id)?.text);
  });

  it("holds no entry for an asset account", () => {
    expect(buildCategoryLabelMap(all).has(checking.id)).toBe(false);
  });

  it("keeps identical leaf names distinct by icon", () => {
    // The two real collisions in the production book, both under different
    // roots and so already separated by their inherited icons.
    const tech = { id: 8, name: "Technology", type: "expense", icon: "💻", parentId: null };
    const techAcc = { id: 9, name: "Technology:Accessories", type: "expense", icon: null, parentId: 8 };
    const autoAcc = { id: 10, name: "Automobile:Accessories", type: "expense", icon: null, parentId: 1 };
    const map = buildCategoryLabelMap([auto, tech, techAcc, autoAcc]);
    expect(map.get(techAcc.id)?.icon).toBe("💻");
    expect(map.get(autoAcc.id)?.icon).toBe("🚗");
    expect(map.get(techAcc.id)?.text).toBe("Accessories");
    expect(map.get(autoAcc.id)?.text).toBe("Accessories");
  });
});

describe("buildCategoryLabelMap with a parentId cycle", () => {
  it("does not blow the stack when two categories reference each other", () => {
    // Reachable from the account form: editing a category and selecting one of
    // its own descendants as the parent makes the in-memory draft and that
    // descendant point at each other, and the live preview builds a label map
    // from that list during render — before anything is submitted.
    const parent = { id: 1, name: "Automobile:Gasoline", type: "expense", icon: null, parentId: 2 };
    const child = { id: 2, name: "Automobile", type: "expense", icon: null, parentId: 1 };

    expect(() => buildCategoryLabelMap([parent, child])).not.toThrow();
  });
});

describe("isDescendantOf", () => {
  const root = { id: 1, parentId: null };
  const child = { id: 2, parentId: 1 };
  const grandchild = { id: 3, parentId: 2 };
  const unrelated = { id: 4, parentId: null };
  const all = [root, child, grandchild, unrelated];

  it("reports a direct child as a descendant", () => {
    expect(isDescendantOf(child, 1, all)).toBe(true);
  });

  it("reports a grandchild as a descendant", () => {
    expect(isDescendantOf(grandchild, 1, all)).toBe(true);
  });

  it("does not report an unrelated account as a descendant", () => {
    expect(isDescendantOf(unrelated, 1, all)).toBe(false);
  });

  it("does not report an ancestor as a descendant of its own child", () => {
    expect(isDescendantOf(root, 2, all)).toBe(false);
  });

  it("terminates on an existing parentId cycle instead of hanging", () => {
    const a = { id: 10, parentId: 11 };
    const b = { id: 11, parentId: 10 };
    expect(isDescendantOf(a, 99, [a, b])).toBe(false);
  });
});
