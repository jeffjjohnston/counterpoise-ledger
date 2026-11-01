import { describe, expect, it } from "vitest";
import { fillFromPattern, outcomeOf, patternAccounts, patternLabel, rangeHint } from "@/lib/entry-patterns";
import type { EntryPattern } from "@/lib/typesafe/types";
import type { AccountWithBalance } from "@/types";

const CHECKING = 1;
const pattern = (over: Partial<EntryPattern> = {}): EntryPattern => ({
  key: "10:in", splits: [{ accountId: 10, amount: 4210 }, { accountId: CHECKING, amount: -4210 }],
  count: 3, lastDate: "2026-10-01", stable: true, range: { min: 3120, max: 4210 }, ...over,
});

describe("fillFromPattern", () => {
  it("puts money out of the account on the from side", () => {
    expect(fillFromPattern(pattern(), CHECKING)).toEqual({ mode: "simple", fromAccountId: CHECKING, toAccountId: 10, amount: "42.10" });
  });
  it("puts money into the account on the to side", () => {
    const refund = pattern({ key: "10:out", splits: [{ accountId: CHECKING, amount: 700 }, { accountId: 10, amount: -700 }] });
    expect(fillFromPattern(refund, CHECKING)).toEqual({ mode: "simple", fromAccountId: 10, toAccountId: CHECKING, amount: "7.00" });
  });
  it("leaves the amount empty when not stable", () => {
    expect(fillFromPattern(pattern({ stable: false }), CHECKING)).toMatchObject({ amount: "" });
  });
  it("uses journal mode for more than one other account, with the pattern's lines and directions", () => {
    // The form fills these amounts only when the pattern is stable.
    const split = pattern({
      key: "10:in|12:in", stable: false,
      splits: [{ accountId: 10, amount: 450 }, { accountId: 12, amount: 50 }, { accountId: CHECKING, amount: -500 }],
    });
    expect(fillFromPattern(split, CHECKING)).toEqual({
      mode: "journal",
      splits: [{ accountId: 10, amount: 450 }, { accountId: 12, amount: 50 }, { accountId: CHECKING, amount: -500 }],
    });
  });
});

describe("rangeHint", () => {
  it("gives the usual range, or one amount, or nothing when stable", () => {
    expect(rangeHint(pattern({ stable: false }))).toBe("usually $31.20–$42.10");
    expect(rangeHint(pattern({ stable: false, range: { min: 3120, max: 3120 } }))).toBe("usually $31.20");
    expect(rangeHint(pattern())).toBeNull();
  });
});

describe("patternLabel", () => {
  it("names the other accounts and the amount or range", () => {
    const accounts = [{ id: 10, name: "Expenses:Groceries" }] as AccountWithBalance[];
    expect(patternLabel(pattern(), accounts, CHECKING)).toBe("Groceries · $42.10");
    expect(patternLabel(pattern({ stable: false }), accounts, CHECKING)).toBe("Groceries · $31.20–$42.10");
  });
});

describe("patternAccounts", () => {
  it("names the other accounts without an amount", () => {
    const accounts = [{ id: 10, name: "Expenses:Groceries" }, { id: 11, name: "Expenses:Sales Tax" }] as AccountWithBalance[];
    const split = pattern({
      splits: [{ accountId: 10, amount: 4000 }, { accountId: 11, amount: 210 }, { accountId: CHECKING, amount: -4210 }],
    });
    expect(patternAccounts(pattern({ stable: false }), accounts, CHECKING)).toBe("Groceries");
    expect(patternAccounts(split, accounts, CHECKING)).toBe("Groceries, Sales Tax");
  });
});

describe("outcomeOf", () => {
  const fill = fillFromPattern(pattern(), CHECKING);
  it("is kept when the accounts and the filled amount are the same", () => {
    expect(outcomeOf(fill, [{ accountId: 10, amount: 4210 }, { accountId: CHECKING, amount: -4210 }], true, false)).toBe("kept");
  });
  it("is changed_amount when only the amount differs", () => {
    expect(outcomeOf(fill, [{ accountId: 10, amount: 5000 }, { accountId: CHECKING, amount: -5000 }], true, false)).toBe("changed_amount");
  });
  it("is kept when the amount was not filled", () => {
    expect(outcomeOf(fill, [{ accountId: 10, amount: 5000 }, { accountId: CHECKING, amount: -5000 }], false, false)).toBe("kept");
  });
  it("is changed_accounts when an account differs, and picked_other after a chip pick", () => {
    expect(outcomeOf(fill, [{ accountId: 11, amount: 4210 }, { accountId: CHECKING, amount: -4210 }], true, false)).toBe("changed_accounts");
    expect(outcomeOf(fill, [{ accountId: 10, amount: 4210 }, { accountId: CHECKING, amount: -4210 }], true, true)).toBe("picked_other");
  });
});

describe("patternLabel of a stable pattern", () => {
  it("names the latest amount, which the fill uses, not the top of the range", () => {
    const accounts = [{ id: 10, name: "Expenses:Groceries" }] as AccountWithBalance[];
    expect(patternLabel(pattern({ range: { min: 4210, max: 10000 } }), accounts, CHECKING)).toBe("Groceries · $42.10");
  });
});

describe("outcomeOf and direction", () => {
  it("counts a saved refund of the same accounts as changed_accounts", () => {
    const fill = fillFromPattern(pattern({ stable: false }), CHECKING);
    expect(outcomeOf(fill, [{ accountId: CHECKING, amount: 900 }, { accountId: 10, amount: -900 }], false, false))
      .toBe("changed_accounts");
  });
});

describe("outcomeOf for a pattern whose amount varies", () => {
  it("keeps the direction of a simple fill with no amount", () => {
    const fill = fillFromPattern(pattern({ stable: false }), CHECKING);
    expect(outcomeOf(fill, [{ accountId: 10, amount: 3300 }, { accountId: CHECKING, amount: -3300 }], false, false))
      .toBe("kept");
  });
  it("keeps the direction of a journal fill with no amounts", () => {
    const split = pattern({
      key: "10:in|12:in", stable: false,
      splits: [{ accountId: 10, amount: 450 }, { accountId: 12, amount: 50 }, { accountId: CHECKING, amount: -500 }],
    });
    const fill = fillFromPattern(split, CHECKING);
    expect(outcomeOf(fill, [
      { accountId: 10, amount: 900 }, { accountId: 12, amount: 100 }, { accountId: CHECKING, amount: -1000 },
    ], false, false)).toBe("kept");
  });
});
